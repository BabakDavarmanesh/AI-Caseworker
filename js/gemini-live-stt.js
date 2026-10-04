'use strict';

// Speech-to-text with Gemini Live (Vertex AI) — replaces Azure Speech.
//
// The microphone is streamed (16 kHz PCM) to a Gemini Live session with input
// transcription switched on. Gemini detects where each utterance ends and
// returns its transcript about half a second later; onFinal(text) is called
// once per utterance. The model's own replies are ignored (never played).
//
// - setMuted(true) sends silence instead of the microphone (used while the
//   avatar speaks, so its voice is never transcribed as the client's answer).
// - onSpeechStart(time) fires when local voice energy starts (used to cut the
//   utterance out of the rolling buffer for mixed-language re-transcription).
// - The audio is also written into the rolling microphone buffer of
//   gemini-transcribe.js when that file is loaded (_aaMicRing).
// - languageCodes (e.g. ['fa-IR', 'en-US']) tells Gemini which languages to
//   expect. Without it short replies are often transcribed in the wrong
//   language ("بله، درسته" came out as Hindi, Korean or Spanish).
// - Sessions are reconnected automatically if Google closes them.

const GEMINI_STT_MODEL = 'gemini-live-2.5-flash-native-audio';
const GEMINI_STT_LOCATION = 'us-central1';
const GEMINI_STT_RATE = 16000;
const GEMINI_STT_SETTLE_MS = 600;     // wait for transcript pieces after a turn ends
const GEMINI_STT_VOICE_RMS = 0.015;   // local speech-start detection
const GEMINI_STT_RING_SECONDS = 45;

class GeminiLiveStt {
  constructor({ onFinal, onSpeechStart, onError, languageCodes } = {}) {
    this.languageCodes = GeminiLiveStt.cleanLanguages(languageCodes);
    this.onFinal = onFinal || (() => {});
    this.onSpeechStart = onSpeechStart || (() => {});
    this.onError = onError || (e => console.warn('[Gemini STT]', e));
    this.ws = null;
    this.ready = false;
    this.stopped = false;
    this.muted = false;
    this.pending = '';
    this.settleTimer = null;
    this.turnEnded = false;
    this.inSpeech = false;
    this.lastVoiceAt = 0;
  }

  get isOpen() { return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.ready; }

  async start() {
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ sampleRate: GEMINI_STT_RATE });
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    const silent = this.ctx.createGain();
    silent.gain.value = 0;   // the processor only runs while connected; keep it inaudible
    this.node.onaudioprocess = e => this._onAudio(e.inputBuffer.getChannelData(0));
    source.connect(this.node);
    this.node.connect(silent);
    silent.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    await this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.settleTimer);
    try { this.ws && this.ws.close(); } catch (_) {}
    this.ws = null;
    this.ready = false;
    try { this.node && this.node.disconnect(); } catch (_) {}
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { this.ctx && this.ctx.close(); } catch (_) {}
  }

  static cleanLanguages(codes) {
    return [...new Set((codes || []).map(c => String(c || '').trim()).filter(Boolean))];
  }

  // Changes the expected languages; the session reconnects with the new list.
  setLanguages(codes) {
    const next = GeminiLiveStt.cleanLanguages(codes);
    if (next.join(',') === this.languageCodes.join(',')) return;
    this.languageCodes = next;
    if (this.ws) { try { this.ws.close(); } catch (_) {} }   // onclose reconnects
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (muted) this.inSpeech = false;
  }

  // Ends the current utterance now (e.g. the caseworker pressed Stop) and
  // resolves with whatever is still being transcribed, within ~2 s.
  async flush(maxWaitMs = 2000) {
    if (this.isOpen) {
      try { this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (_) {}
    }
    const until = Date.now() + maxWaitMs;
    // Give Gemini a moment to start sending the last transcript.
    await new Promise(r => setTimeout(r, 700));
    while ((this.pending || this.settleTimer) && Date.now() < until) {
      await new Promise(r => setTimeout(r, 100));
    }
    this._emit();
  }

  async _connect() {
    const s = loadSettings();
    if (!s.gcpProjectId) throw new Error('Set the Google Project ID in Settings first.');
    const res = await fetch('/google-live-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentialsFile: s.gcpCredentialsFile || 'google-service-account.json' })
    });
    const auth = await res.json().catch(() => ({}));
    if (!res.ok || !auth.accessToken) throw new Error(`Gemini speech sign-in failed: ${auth.error?.message || res.status}`);

    const url = `wss://${GEMINI_STT_LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent` +
      `?access_token=${encodeURIComponent(auth.accessToken)}`;
    const setup = {
      model: `projects/${s.gcpProjectId}/locations/${GEMINI_STT_LOCATION}/publishers/google/models/${GEMINI_STT_MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      inputAudioTranscription: this.languageCodes.length ? { languageCodes: this.languageCodes } : {},
      systemInstruction: { parts: [{ text: 'You are a silent transcription helper. Never speak or reply. Output nothing.' }] }
    };

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.ready = false;
      const timer = setTimeout(() => { reject(new Error('Gemini speech did not respond.')); try { ws.close(); } catch (_) {} }, 15000);
      ws.onopen = () => ws.send(JSON.stringify({ setup }));
      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch (_) { return; }
        if (msg.setupComplete && !this.ready) { this.ready = true; clearTimeout(timer); resolve(); return; }
        this._onMessage(msg);
      };
      ws.onerror = () => {};
      ws.onclose = ev => {
        clearTimeout(timer);
        const wasReady = this.ready;
        if (this.ws === ws) { this.ws = null; this.ready = false; }
        if (!wasReady) { reject(new Error(`Gemini speech connection closed (${ev.code}) ${ev.reason || ''}`.trim())); return; }
        this._emit();
        // Sessions have a time limit; reconnect silently while still in use.
        if (!this.stopped) setTimeout(() => { if (!this.stopped) this._connect().catch(e => this.onError(e)); }, 300);
      };
    });
  }

  _onAudio(f32) {
    const now = Date.now();
    const data = new Float32Array(f32);

    // Rolling buffer for mixed-language re-transcription (gemini-transcribe.js).
    if (typeof _aaMicRing !== 'undefined') {
      _aaMicRing.chunks.push({ start: now - (data.length / GEMINI_STT_RATE) * 1000, end: now, data, rate: GEMINI_STT_RATE });
      const cutoff = now - GEMINI_STT_RING_SECONDS * 1000;
      while (_aaMicRing.chunks.length && _aaMicRing.chunks[0].end < cutoff) _aaMicRing.chunks.shift();
    }

    // Local speech-start detection.
    if (!this.muted) {
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      if (rms > GEMINI_STT_VOICE_RMS) {
        if (!this.inSpeech) { this.inSpeech = true; this.onSpeechStart(now - (data.length / GEMINI_STT_RATE) * 1000); }
        this.lastVoiceAt = now;
      } else if (this.inSpeech && now - this.lastVoiceAt > 900) {
        this.inSpeech = false;
      }
    }

    if (!this.isOpen) return;
    const pcm = new Int16Array(data.length);
    if (!this.muted) {
      for (let i = 0; i < data.length; i++) {
        const x = Math.max(-1, Math.min(1, data[i]));
        pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
      }
    }
    const bytes = new Uint8Array(pcm.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${GEMINI_STT_RATE}`, data: btoa(bin) } } }));
    } catch (_) {}
  }

  _onMessage(msg) {
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      this.pending += sc.inputTranscription.text;
      if (this.turnEnded) this._scheduleEmit(300);   // late pieces after the turn ended
    }
    if (sc.turnComplete || sc.generationComplete || sc.interrupted) {
      this.turnEnded = true;
      this._scheduleEmit(GEMINI_STT_SETTLE_MS);
    }
  }

  _scheduleEmit(ms) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this._emit(); }, ms);
  }

  _emit() {
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.turnEnded = false;
    const text = this.pending.replace(/\s+/g, ' ').trim();
    this.pending = '';
    if (text) {
      try { this.onFinal(text); } catch (e) { this.onError(e); }
    }
  }
}
