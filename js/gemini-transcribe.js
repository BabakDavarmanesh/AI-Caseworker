'use strict';

// Mixed-language transcription for the Virtual Caseworker.
//
// Azure Speech recognizes one language at a time. A Persian answer that
// contains English street names, numbers or a postal code ("خیابونمون 123 Main
// Street هست") comes out as nonsense Persian words, and a Persian request
// ("می‌تونی فارسی حرف بزنی؟") during an English session comes out as nonsense
// English. For those turns the audio of the same utterance is sent to Gemini,
// which writes Persian in Persian script and English/numbers/codes in Latin.
//
// The microphone is kept in a rolling 45-second buffer (16 kHz mono) so the
// utterance can be cut out after Azure has finished it.

const AA_MIC_RING_SECONDS = 45;
const AA_MIC_RATE = 16000;

const _aaMicRing = { ctx: null, stream: null, node: null, chunks: [], starting: null };

async function aaMicRingStart() {
  if (_aaMicRing.ctx || _aaMicRing.starting) return _aaMicRing.starting;
  _aaMicRing.starting = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx({ sampleRate: AA_MIC_RATE });
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const silent = ctx.createGain();
      silent.gain.value = 0;   // the processor must be connected to run; keep it inaudible
      node.onaudioprocess = e => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        const end = Date.now();
        _aaMicRing.chunks.push({ start: end - (data.length / ctx.sampleRate) * 1000, end, data, rate: ctx.sampleRate });
        const cutoff = end - AA_MIC_RING_SECONDS * 1000;
        while (_aaMicRing.chunks.length && _aaMicRing.chunks[0].end < cutoff) _aaMicRing.chunks.shift();
      };
      source.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      Object.assign(_aaMicRing, { ctx, stream, node });
    } catch (e) {
      console.warn('[Mixed-language STT] Microphone buffer unavailable; Azure transcripts only.', e);
    } finally {
      _aaMicRing.starting = null;
    }
  })();
  return _aaMicRing.starting;
}

function aaMicRingStop() {
  try { _aaMicRing.node && _aaMicRing.node.disconnect(); } catch (_) {}
  try { _aaMicRing.stream && _aaMicRing.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { _aaMicRing.ctx && _aaMicRing.ctx.close(); } catch (_) {}
  Object.assign(_aaMicRing, { ctx: null, stream: null, node: null, chunks: [] });
}

// Audio between two Date.now() times as a base64 16-bit mono WAV, or ''.
function aaMicRingWav(fromMs, toMs) {
  const parts = _aaMicRing.chunks.filter(c => c.end > fromMs && c.start < toMs);
  if (!parts.length) return '';
  const rate = parts[0].rate;
  const total = parts.reduce((n, c) => n + c.data.length, 0);
  if (total < rate * 0.4) return '';   // under 0.4 s: nothing useful

  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of parts) {
    for (let i = 0; i < c.data.length; i++, o += 2) {
      const x = Math.max(-1, Math.min(1, c.data[i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const AA_TRANSCRIBE_PROMPT =
  'Transcribe exactly what the speaker says in this audio from a client intake interview. ' +
  'The speaker may mix Persian (Farsi), English and French in one sentence. ' +
  'Write Persian words in Persian script. Write English words, street names, city names, personal names, ' +
  'spelled letters, numbers and postal codes in Latin letters and digits exactly as spoken ' +
  '(for example: 123 Main Street, A1A 1A1). Do not translate, summarize, answer or correct anything. ' +
  'If there is no speech, return an empty transcript. ' +
  'Return JSON: {"transcript": string, "language": "fa-IR" | "en-US" | "fr-CA" | "mixed"}';

// Returns { transcript, language } from Gemini, or null on any failure.
// languageCodes: the interview languages, e.g. ['fa-IR', 'en-US'] (a hint only).
async function aaGeminiTranscribe(wavBase64, timeoutMs = 7000, languageCodes = []) {
  const s = loadSettings();
  if (!s.gcpProjectId || !wavBase64) return null;
  const model = (s.geminiModel || 'gemini-3.8-flash').trim();
  const generationConfig = { responseMimeType: 'application/json', temperature: 0 };
  // Low thinking keeps this at ~2 s; the parameter differs between model families.
  generationConfig.thinkingConfig = /^gemini-3/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: 0 };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        projectId: s.gcpProjectId,
        location: s.geminiLocation || 'global',
        model,
        credentialsFile: s.gcpCredentialsFile || 'google-service-account.json',
        request: {
          contents: [{ role: 'user', parts: [{ text: AA_TRANSCRIBE_PROMPT + (languageCodes.length
            ? ` The interview languages are: ${languageCodes.join(', ')}. The speaker uses these languages; do not transcribe into any other language.`
            : '') }, { inlineData: { mimeType: 'audio/wav', data: wavBase64 } }] }],
          generationConfig
        }
      })
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const out = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const transcript = String(out.transcript || '').trim();
    return transcript ? { transcript, language: String(out.language || '') } : null;
  } catch (e) {
    console.warn('[Mixed-language STT] Gemini transcription failed; keeping the Azure transcript.', e.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
