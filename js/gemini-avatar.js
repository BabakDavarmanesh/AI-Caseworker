'use strict';

// Gemini Live avatar (Vertex AI Live API, e.g. gemini-3.8-live + avatarConfig).
// Used by the Virtual Caseworker page instead of the Azure (Lisa) avatar when
// Settings > Real-Time Avatar Service = Gemini.
//
// - Sign-in: server.py POST /google-live-token returns a short-lived OAuth token
//   from the same service-account key; the browser opens the WebSocket with it.
// - The avatar is used as a talking face only: the interview logic sends each
//   question as text and the system instruction makes Gemini say it verbatim.
//   Listening stays on Azure Speech, so no microphone audio is sent to Gemini.
// - Video arrives continuously (also while idle) as fragmented MP4 with the
//   voice inside (video/mp4, H.264 + AAC) and is played through MediaSource.
// - The voice is routed through a local WebRTC loopback, like Lisa's voice,
//   so the browser's echo cancellation keeps it out of the microphone. Without
//   this the microphone hears the avatar and the page mistakes it for the client.

const GEMINI_AVATAR_INSTRUCTION =
  'You are the voice of a caseworker interview. When you receive text, say it aloud ' +
  'exactly, word for word, in the language it is written in, and nothing else. ' +
  'Never answer, translate, explain or add anything.';

class GeminiLiveAvatar {
  constructor(hostEl, settings) {
    this.host = hostEl;
    this.settings = settings || {};
    this.isGeminiAvatar = true;
    this.ws = null;
    this.video = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];          // ArrayBuffer chunks and turn-end markers
    this.initSegment = null;  // first chunk (ftyp/moov), re-used after a reconnect
    this.turn = null;         // active speak() call
    this.pendingTurnEnds = 0; // cut-off turns whose end has not arrived yet
    this.generating = false;  // Gemini is still producing the last text sent
    this.genWaiters = [];
    this.closed = false;
    this.monitorId = null;
    this.firstVideoWaiters = [];
  }

  // ── Connection ────────────────────────────────────────────────
  async connect() {
    this.closed = false;
    this._ensureVideo();
    this._resetMediaSource();
    await this._setupEchoSafeAudio();

    const s = this.settings;
    if (!s.gcpProjectId) throw new Error('Google Project ID is not set in Settings.');
    const res = await fetch('/google-live-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentialsFile: s.gcpCredentialsFile || 'google-service-account.json' })
    });
    const auth = await res.json().catch(() => ({}));
    if (!res.ok || !auth.accessToken) {
      throw new Error(`Gemini avatar sign-in failed: ${auth.error?.message || res.status}`);
    }

    const loc = s.geminiLiveLocation || 'us-central1';
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
    const url = `wss://${host}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent` +
      `?access_token=${encodeURIComponent(auth.accessToken)}`;
    const model = `projects/${s.gcpProjectId}/locations/${loc}/publishers/google/models/${s.geminiLiveModel || 'gemini-3.8-live'}`;

    const setup = {
      model,
      generationConfig: {
        responseModalities: ['VIDEO'],
        // No languageCode: the avatar speaks each text in the language it is written in.
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.geminiAvatarVoice || 'zephyr' } } }
      },
      avatarConfig: { avatarName: s.geminiAvatarName || 'Kira' },
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: GEMINI_AVATAR_INSTRUCTION }] }
    };

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ready = false;
      const timer = setTimeout(() => { if (!ready) { reject(new Error('Gemini avatar did not respond.')); try { ws.close(); } catch (_) {} } }, 20000);

      ws.onopen = () => ws.send(JSON.stringify({ setup }));
      ws.onmessage = ev => {
        const msg = this._parse(ev.data);
        if (!msg) return;
        if (msg.setupComplete && !ready) { ready = true; clearTimeout(timer); resolve(); return; }
        this._onMessage(msg);
      };
      ws.onerror = () => {};
      ws.onclose = ev => {
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        this.pendingTurnEnds = 0;
        this.generating = false;
        this.genWaiters.splice(0).forEach(fn => fn());
        if (!ready) reject(new Error(`Gemini avatar connection closed (${ev.code}) ${ev.reason || ''}`.trim()));
        this._finishTurn();   // never leave a speak() hanging
      };
    });

    this._startMonitor();
    // The avatar streams idle video right away; wait for the first frame.
    await this._waitForFirstVideo(15000);
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    this._finishTurn();
    if (this.monitorId) { cancelAnimationFrame(this.monitorId); this.monitorId = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    try { if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream(); } catch (_) {}
    if (this.video) {
      try { this.video.pause(); } catch (_) {}
      if (this.video.src && this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
    }
    this.queue = [];
    this.sourceBuffer = null;
    this.mediaSource = null;
    const g = this.audioGraph;
    this.audioGraph = null;
    if (g) {
      try { g.pc1 && g.pc1.close(); } catch (_) {}
      try { g.pc2 && g.pc2.close(); } catch (_) {}
      try { g.ctx.close(); } catch (_) {}
      if (g.audioEl) { try { g.audioEl.pause(); } catch (_) {} g.audioEl.remove(); }
    }
  }

  // ── Speaking ──────────────────────────────────────────────────
  // Resolves when the avatar has finished saying the text on screen.
  async speak(text) {
    const clean = String(text || '').trim();
    if (!clean || this.closed) return;
    if (!this.isOpen) await this.connect();   // sessions can expire; reconnect transparently

    // Never send new text while Gemini is still producing the previous turn
    // (e.g. right after an interruption): that makes the server end the old
    // turn twice (interrupted + turnComplete) and the new one would look done.
    if (this.generating) {
      await new Promise(resolve => { this.genWaiters.push(resolve); setTimeout(resolve, 15000); });
      if (!this.isOpen) await this.connect();
    }

    if (this.turn && this.turn.targetTime == null) this.pendingTurnEnds++;
    this._finishTurn();
    return new Promise(resolve => {
      this.turn = { resolve, targetTime: null, deadline: Date.now() + 60000 };
      this.generating = true;
      this.ws.send(JSON.stringify({ realtimeInput: { text: clean } }));
    });
  }

  // Same shape as the Azure AvatarSynthesizer method the page already calls.
  stopSpeakingAsync(onDone) {
    if (this.turn) {
      // Gemini cannot be cut off mid-sentence. The avatar is NOT muted (a
      // false interruption must never make her silent): she finishes the
      // sentence while the page listens to the client.
      if (this.turn.targetTime == null) this.pendingTurnEnds++;
      this._finishTurn();
    }
    if (typeof onDone === 'function') onDone();
  }

  // ── Internals ─────────────────────────────────────────────────
  _parse(data) {
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  _onMessage(msg) {
    const sc = msg.serverContent;
    if (!sc) return;
    for (const part of (sc.modelTurn?.parts || [])) {
      const inline = part.inlineData;
      if (inline && String(inline.mimeType || '').startsWith('video/mp4')) {
        const bin = atob(inline.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (!this.initSegment) this.initSegment = bytes.buffer;
        this.queue.push(bytes.buffer);
        this._pump();
      }
    }
    if ((sc.turnComplete || sc.interrupted) && this.generating) {
      // One end per text sent (a duplicate interrupted/turnComplete is ignored).
      // Marks where this turn's video ends; speak() resolves once playback reaches it.
      this.generating = false;
      this.genWaiters.splice(0).forEach(fn => fn());
      this.queue.push({ turnEnd: true });
      this._pump();
    }
  }

  _ensureVideo() {
    let video = document.getElementById('aa-video');
    if (!video) {
      video = document.createElement('video');
      video.id = 'aa-video';
      video.style.cssText =
        'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;object-position:center center;background:#fff;';
      this.host.appendChild(video);
    }
    video.classList.add('gemini-avatar');   // portrait video: shown whole (css/app.css)
    video.style.objectFit = 'contain';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;   // the avatar's voice is inside the video
    this.video = video;
  }

  // video audio -> Web Audio -> local WebRTC loopback -> <audio>. Chrome/Edge
  // apply echo cancellation to WebRTC playback, exactly as with Lisa's voice.
  async _setupEchoSafeAudio() {
    if (this.audioGraph || !window.RTCPeerConnection) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    let ctx = null, src = null, gain = null;
    try {
      ctx = new Ctx();
      src = ctx.createMediaElementSource(this.video);   // the element's audio now goes only into this graph
      gain = ctx.createGain();
      src.connect(gain);
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);

      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      pc1.onicecandidate = e => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
      pc2.onicecandidate = e => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };

      let audioEl = document.getElementById('aa-gemini-audio');
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'aa-gemini-audio';
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        this.host.appendChild(audioEl);
      }
      const gotTrack = new Promise(resolve => {
        pc2.ontrack = e => {
          audioEl.srcObject = e.streams[0] || new MediaStream([e.track]);
          audioEl.play().catch(() => {});
          resolve();
        };
      });
      dest.stream.getAudioTracks().forEach(t => pc1.addTrack(t, dest.stream));
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);
      await Promise.race([
        gotTrack,
        new Promise((_, reject) => setTimeout(() => reject(new Error('audio loopback timeout')), 5000))
      ]);
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      this.audioGraph = { ctx, gain, pc1, pc2, audioEl };
    } catch (e) {
      console.warn('[Gemini avatar] Echo-safe audio unavailable; playing the video sound directly.', e);
      // Once captured by Web Audio the element is silent unless the graph plays it.
      if (ctx && gain) {
        try { gain.connect(ctx.destination); this.audioGraph = { ctx, gain, pc1: null, pc2: null, audioEl: null }; } catch (_) {}
      } else if (ctx) {
        try { ctx.close(); } catch (_) {}
      }
    }
  }

  _resetMediaSource() {
    if (!window.MediaSource) throw new Error('This browser cannot play the Gemini avatar (MediaSource missing).');
    this.queue = this.initSegment ? [this.initSegment] : [];
    this.sourceBuffer = null;
    const ms = new MediaSource();
    this.mediaSource = ms;
    if (this.video.src && this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
    this.video.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      if (this.mediaSource !== ms) return;
      const type = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
      const sb = ms.addSourceBuffer(MediaSource.isTypeSupported(type) ? type : 'video/mp4');
      sb.mode = 'sequence';
      sb.addEventListener('updateend', () => this._afterAppend());
      this.sourceBuffer = sb;
      this._pump();
    }, { once: true });
  }

  _pump() {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    while (this.queue.length) {
      const item = this.queue[0];
      if (item && item.turnEnd) {
        this.queue.shift();
        this._markTurnEnd();
        continue;
      }
      this.queue.shift();
      try {
        sb.appendBuffer(item);
      } catch (e) {
        if (e.name === 'QuotaExceededError') { this.queue.unshift(item); this._trim(true); }
        else console.warn('[Gemini avatar] append failed', e);
      }
      return;   // wait for updateend
    }
  }

  _afterAppend() {
    const v = this.video;
    if (v && v.paused && !this.closed) this._play();
    if (v && !this.firstVideoSeen && v.buffered.length) {
      this.firstVideoSeen = true;
      this.firstVideoWaiters.splice(0).forEach(fn => fn());
    }
    if (this._trim(false)) return;   // remove() also fires updateend
    this._pump();
  }

  // Keeps ~5 s of history so memory stays flat during long sessions.
  _trim(force) {
    const v = this.video, sb = this.sourceBuffer;
    if (!v || !sb || sb.updating || !v.buffered.length) return false;
    const start = v.buffered.start(0);
    const end = v.currentTime - (force ? 1 : 5);
    if ((force || v.currentTime > 6) && end > start + 0.5) {
      try { sb.remove(start, end); return true; } catch (_) {}
    }
    return false;
  }

  _play() {
    this.video.play().catch(err => {
      if (err && err.name === 'NotAllowedError') {
        // Browser autoplay rule: start muted and ask for one click to enable sound.
        this._soundBlocked = true;
        this.video.muted = true;
        this.video.play().catch(() => {});
        this._showSoundButton();
      }
    });
  }

  _showSoundButton() {
    if (document.getElementById('aa-gemini-sound')) return;
    const btn = document.createElement('button');
    btn.id = 'aa-gemini-sound';
    btn.className = 'btn btn-primary';
    btn.textContent = '🔊 Click to enable the avatar\'s voice';
    btn.style.cssText = 'position:absolute;left:50%;top:24px;transform:translateX(-50%);z-index:5;font-size:16px;padding:12px 22px;';
    const enable = () => {
      this._soundBlocked = false;
      if (this.video) { this.video.muted = false; this.video.play().catch(() => {}); }
      const g = this.audioGraph;
      if (g) { g.ctx.resume().catch(() => {}); g.audioEl.play().catch(() => {}); }
      btn.remove();
      document.removeEventListener('pointerdown', enable, true);
      document.removeEventListener('keydown', enable, true);
    };
    btn.onclick = enable;
    // Any click or key press on the page also counts as permission for sound.
    document.addEventListener('pointerdown', enable, true);
    document.addEventListener('keydown', enable, true);
    this.host.appendChild(btn);
  }

  _markTurnEnd() {
    const v = this.video;
    if (this.pendingTurnEnds > 0) {
      // The end of a turn that was cut off: restore the voice once the video
      // passes this point. It must not end the current speak() call.
      this.pendingTurnEnds--;
      this._speechEndAt = v && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      return;
    }
    if (this.turn) {
      this.turn.targetTime = v && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      const remaining = Math.max(0, this.turn.targetTime - (v ? v.currentTime : 0));
      this.turn.deadline = Date.now() + remaining * 1000 + 3000;
    }
  }

  _finishTurn() {
    const turn = this.turn;
    this.turn = null;
    if (turn) turn.resolve();
  }

  _jumpToLiveEdge() {
    const v = this.video;
    if (v && v.buffered.length) {
      const end = v.buffered.end(v.buffered.length - 1);
      if (end - v.currentTime > 0.1) v.currentTime = end - 0.05;
    }
  }

  _waitForFirstVideo(timeoutMs) {
    if (this.firstVideoSeen) return Promise.resolve();
    return new Promise(resolve => {
      this.firstVideoWaiters.push(resolve);
      setTimeout(resolve, timeoutMs);
    });
  }

  // Runs every frame: ends speak() when its video has played, keeps idle
  // playback close to the live edge, and restores sound after an interruption.
  _startMonitor() {
    if (this.monitorId) cancelAnimationFrame(this.monitorId);
    const tick = () => {
      const v = this.video;
      if (v && !this.closed) {
        const turn = this.turn;
        if (turn && turn.targetTime != null && v.currentTime >= turn.targetTime - 0.08) this._finishTurn();
        else if (turn && Date.now() > turn.deadline) this._finishTurn();

        if (v.buffered.length && !v.paused) {
          const ahead = v.buffered.end(v.buffered.length - 1) - v.currentTime;
          // Skipping ahead to the live edge is only safe while she is silent.
          const speechPlaying = !!this.turn || this.generating || this.pendingTurnEnds > 0 ||
            (this._speechEndAt != null && v.currentTime < this._speechEndAt);
          if (speechPlaying) v.playbackRate = 1.0;
          else if (ahead > 1.0) { v.currentTime = v.buffered.end(v.buffered.length - 1) - 0.05; v.playbackRate = 1.0; }
          else if (ahead > 0.4) v.playbackRate = Math.min(1.2, 1.0 + ahead * 0.5);
          else v.playbackRate = 1.0;
        }
      }
      this.monitorId = requestAnimationFrame(tick);
    };
    this.monitorId = requestAnimationFrame(tick);
  }
}

// Browsers may block sound (and microphone audio processing) until the user has
// clicked the page. If a silent test clip is blocked, show a Start button over
// the avatar panel and wait for one click before the session starts.
async function geminiAvatarEnsureSoundAllowed(hostEl) {
  const blocked = await new Promise(resolve => {
    try {
      // 1 sample of silence, 8 kHz mono 8-bit WAV.
      const probe = new Audio('data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA');
      probe.volume = 0;
      probe.play()
        .then(() => { probe.pause(); resolve(false); })
        .catch(err => resolve(!!err && err.name === 'NotAllowedError'));
    } catch (_) { resolve(false); }
  });
  if (!blocked) return;

  await new Promise(resolve => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = '▶ Start the interview';
    btn.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;font-size:18px;padding:14px 28px;';
    btn.onclick = () => { btn.remove(); resolve(); };
    hostEl.appendChild(btn);
  });
}

function useGeminiAvatar(settings) {
  return (settings || loadSettings()).avatarProvider === 'gemini';
}
