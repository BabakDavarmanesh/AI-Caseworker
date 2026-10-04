'use strict';

// ── Intake Rules (field-specific confirmation config) ──────────────────────
let INTAKE_RULES = { fields: {} };

async function loadIntakeRules() {
  try {
    const resp = await fetch('./intake-rules.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    INTAKE_RULES = await resp.json();
    console.log('[IntakeRules] Loaded from file:', Object.keys(INTAKE_RULES.fields));
  } catch(e) {
    console.warn('[IntakeRules] Could not load intake-rules.json (file:// or missing). Using embedded defaults.', e.message);
    INTAKE_RULES = EMBEDDED_INTAKE_RULES;
  }
}

const EMBEDDED_INTAKE_RULES = {
  fields: {
    full_name: {
      matchQuestions: ["what is your full name", "full name", "what is your name"],
      answerType: "person_name", required: true,
      confirmationRequired: true, spellingRequired: true,
      components: ["firstName","middleName","lastName"],
      maxCorrectionAttempts: 4
    },
    country_of_birth: {
      matchQuestions: ["what is your country of birth", "country of birth"],
      answerType: "country", required: true,
      confirmationRequired: true, spellingRequired: false,
      components: ["country"],
      maxCorrectionAttempts: 3
    },
    current_address: {
      matchQuestions: ["what is your current address", "current address", "home address"],
      answerType: "address", required: true,
      confirmationRequired: true, spellingRequired: false,
      components: ["unitNumber","streetNumber","streetName","streetType","city","province","postalCode","country"],
      requiredComponents: ["streetNumber","streetName","city","province","postalCode"],
      maxCorrectionAttempts: 3
    }
  }
};

// ── Conversation Workflow States ───────────────────────────────────────────
const WF_STATE = Object.freeze({
  ASKING:                    'ASKING',
  COLLECTING_ANSWER:         'COLLECTING_ANSWER',
  VALIDATING:                'VALIDATING',
  REQUEST_SPELLING:          'REQUEST_SPELLING',
  COLLECTING_SPELLING:       'COLLECTING_SPELLING',
  CONFIRMING:                'CONFIRMING',
  IDENTIFYING_INCORRECT:     'IDENTIFYING_INCORRECT',
  COLLECTING_CORRECTION:     'COLLECTING_CORRECTION',
  RECONFIRMING:              'RECONFIRMING',
  CONFIRMED:                 'CONFIRMED',
  FAILED:                    'FAILED'
});

const VALID_ACTIONS = Object.freeze([
  'ask_missing_information','request_spelling','confirm_value',
  'ask_incorrect_component','request_correction','confirm_corrected_value',
  'save_and_continue','retry'
]);

// Per-question workflow context (reset for each question)
let _wfCtx = null;

function createWfCtx(question) {
  const fieldKey = question.fieldKey || matchFieldKey(question.question);
  const rules = fieldKey ? (INTAKE_RULES.fields[fieldKey] || null) : null;
  return {
    questionId:           question.id,
    fieldKey,
    rules,
    state:                WF_STATE.ASKING,
    structuredValue:      fieldKey === 'current_address'
      ? { country: 'Canada' }
      : {},
    confirmedComponents:  {},
    correctionHistory:    [],
    rawTranscripts:       [],
    answerAttempts:       0,
    spellingAttempts:     0,
    confirmationAttempts: 0,
    correctionAttempts:   0,
    isConfirmed:          false,
    requiresCaseworkerReview: false,
    lastAiResult:         null,
    noUnitNumber:         false,
    nameVerificationFlow: fieldKey === 'full_name'
      ? 'ask_name -> request_full_spelling -> read_back -> confirm -> repeat_spelling_if_rejected'
      : null
  };
}

function matchFieldKey(questionText) {
  if (!questionText) return null;
  const norm = questionText.toLowerCase().trim();
  for (const [key, rule] of Object.entries(INTAKE_RULES.fields || {})) {
    if ((rule.matchQuestions || []).some(mq => norm.includes(mq))) return key;
  }
  return null;
}

// Shared by both Client Intake and Virtual Caseworker.
// A question uses the strict workflow when its mapped intake field
// requires explicit confirmation in intake-rules.json.
function conversationQuestionNeedsWorkflow(q) {
  const fieldKey = q?.fieldKey || matchFieldKey(q?.question || '');
  return !!(
    fieldKey &&
    INTAKE_RULES.fields[fieldKey]?.confirmationRequired
  );
}

function isConfirmationRequired(ctx) {
  return ctx.rules?.confirmationRequired === true;
}

function isSpellingRequired(ctx) {
  if (ctx?.fieldKey === 'full_name') return true;
  return ctx.rules?.spellingRequired === true;
}

function getMaxCorrections(ctx) {
  if (ctx?.fieldKey === 'full_name') return 4;
  return ctx.rules?.maxCorrectionAttempts ?? 3;
}

// ─── Storage keys ────────────────────────────────────────────
const LS = {
  settings:     'aic_settings',
  questions:    'aic_questions',
  responses:    'aic_responses',
  translations: 'aic_translations'
};

const DEFAULT_SETTINGS = {
  gcpProjectId:      '',
  gcpLocation:       'us',
  gcpProcessorId:    '',
  gcpCredentialsFile:'google-service-account.json',
  geminiModel:       'gemini-3.8-flash',
  geminiLocation:    'global',
  speechRegion:      '',
  speechKey:         '',
  speechVoice:       'en-US-LunaNeural',
  voiceProvider:     'google',            // 'google' = Gemini-TTS, 'azure' = Azure Speech neural voice
  googleTtsModel:    'gemini-2.5-flash-tts',
  googleTtsVoice:    'Kore',
  avatarResourceName:'ai-caseworker-avatar',
  avatarEndpoint:    'https://francecentral.api.cognitive.microsoft.com/',
  avatarRegion:      'francecentral',
  avatarKey:         '',
  avatarCharacter:   'lisa',
  avatarStyle:       'casual-sitting',
  avatarVoice:       'en-US-LunaNeural',
  avatarProvider:    'azure',              // 'azure' = Lisa, 'gemini' = Gemini Live avatar
  geminiAvatarName:  'Kira',
  geminiAvatarVoice: 'zephyr',
  geminiLiveModel:   'gemini-3.8-live',
  geminiLiveLocation:'us-central1'
};

function loadSettings() {
  try {
    // Primary source: config.js in the project folder. This makes settings portable
    // when the whole folder is zipped and shared with another team member.
    const fileSettings = (window.AIC_CONFIG && typeof window.AIC_CONFIG === 'object')
      ? window.AIC_CONFIG
      : {};

    // Browser storage is kept only as a fallback for older copies.
    const saved = JSON.parse(localStorage.getItem(LS.settings) || '{}');
    return Object.assign({}, DEFAULT_SETTINGS, saved, fileSettings);
  } catch {
    return Object.assign({}, DEFAULT_SETTINGS,
      (window.AIC_CONFIG && typeof window.AIC_CONFIG === 'object') ? window.AIC_CONFIG : {});
  }
}
function loadQuestions()    { try { return JSON.parse(localStorage.getItem(LS.questions) || '[]');  } catch { return []; } }
function loadResponses()    { try { return latestResponsePerQuestion(JSON.parse(localStorage.getItem(LS.responses) || '[]')); } catch { return []; } }

// One response per question: when the same question was answered more than
// once (e.g. a new intake session, or a regenerated question bank with new
// ids), only the most recent answer is kept.
function latestResponsePerQuestion(rs) {
  if (!Array.isArray(rs)) return [];
  const keyOf = r => String(r.question || r.questionId || r.id || '')
    .toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
  const timeOf = r => Date.parse(r.answeredAt || r.timestamp || '') || 0;
  const newest = new Map();
  rs.forEach((r, i) => {
    const k = keyOf(r) || `#${i}`;
    const prev = newest.get(k);
    if (!prev || timeOf(r) >= timeOf(prev.r)) newest.set(k, { r, i });
  });
  const keep = new Set([...newest.values()].map(v => v.i));
  return rs.filter((_, i) => keep.has(i));
}
function persistSettings(d) { localStorage.setItem(LS.settings,  JSON.stringify(d)); }
function persistQuestions(q){ localStorage.setItem(LS.questions, JSON.stringify(q)); }
function persistResponses(r){ localStorage.setItem(LS.responses, JSON.stringify(latestResponsePerQuestion(r))); }

// ─── Navigation ───────────────────────────────────────────────
// [show() -> see below]

// ─── Settings ────────────────────────────────────────────────
// [populateSettingsForm() moved below]

// [saveSettings() moved below]

async function testConnection() {
  const el = document.getElementById('settings-test-result');
  el.innerHTML = '<div class="alert alert-info">⏳ Testing Gemini...</div>';
  try {
    await callGPT(
      'You are a test assistant.',
      'Reply with exactly: {"status":"ok"}',
      false
    );
    el.innerHTML = '<div class="alert alert-success">✅ Gemini connected successfully!</div>';
  } catch(e) {
    el.innerHTML = `<div class="alert alert-error">❌ ${esc(e.message)}</div>`;
  }
}

// ─── Utilities ────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc   = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const uid   = () => `q_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

// [toast() moved below]

// Pipeline step helper
function stepState(id, state /* 'step-active' | 'step-done' | null */, caption = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('step-active', 'step-done');
  if (state) el.classList.add(state);

  const cap = el.querySelector('.step-caption');
  if (cap) {
    if (caption) cap.textContent = caption;
    else if (state === 'step-active') cap.textContent = 'Processing…';
    else if (state === 'step-done') cap.textContent = 'Complete';
    else cap.textContent = id === 'step-upload' ? 'Ready' : 'Waiting';
  }
}

// ─── Log console ──────────────────────────────────────────────
let _logEl = null;

function logLine(msg, type = 'info') {
  if (!_logEl) return;
  const d  = document.createElement('div');
  d.className = `log-line log-${type}`;
  const t  = new Date().toLocaleTimeString();
  d.textContent = `[${t}]  ${msg}`;
  _logEl.appendChild(d);
  _logEl.scrollTop = _logEl.scrollHeight;
}

// ─── Pipeline live status line ────────────────────────────────
// A single, friendly, typewriter-style message under the pipeline.
// It is driven ONLY by real processing events: runPipeline() calls
// setPipelinePhase() at the moment each stage actually starts/ends.
// Nothing here advances progress on a timer. The only timers are cosmetic
// "still working" cues (animated dots + a stronger pulse) that fire when a
// real stage has been running longer than expected; they never change the text.
const PIPELINE_PHASES = {
  upload:  { text: 'Uploading your document...',                         step: 'step-upload', slowMs: 6000 },
  extract: { text: 'Extracting content from the document...',            step: 'step-di',     slowMs: 8000 },
  analyze: { text: 'Identifying questions from the extracted content...', step: 'step-gpt',    slowMs: 10000 },
  save:    { text: 'Saving extracted questions...',                      step: 'step-save',   slowMs: 4000 },
  done:    { text: 'Questions are ready.' },
  error:   { text: "We couldn't finish processing. Please try again." }
};

const PS_TYPE_MS        = 32;    // per character (within the 25–40 ms target)
const PS_CATCHUP_MS     = 10;    // finish the current line quickly if a newer phase is already waiting
const PS_FADE_MS        = 160;   // fade-out of the previous message
const PS_HOLD_MS        = 250;   // brief pause before swapping a fully typed message
const PS_PULSE_EVERY_MS = 4500;  // stronger pulse cadence once a stage is slow

const _ps = {
  root: null, text: null, dots: null, sr: null,
  phase: 'idle',      // last requested phase
  shown: null,        // text currently displayed
  shownPhase: null,   // phase the displayed text belongs to
  pending: null,      // newest text waiting to be shown (older ones are dropped)
  pendingPhase: null,
  slowPhase: null,    // phase that has been running longer than expected
  running: false,
  epoch: 0,           // bumped on reset so in-flight typing stops cleanly
  slowTimer: null, pulseTimer: null, pulseClearTimer: null
};

const _psWait = ms => new Promise(r => setTimeout(r, ms));
const _psReducedMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function _psBind() {
  if (_ps.root && document.body.contains(_ps.root)) return true;
  _ps.root = document.getElementById('pipeline-status');
  if (!_ps.root) return false;
  _ps.text = _ps.root.querySelector('.ps-text');
  _ps.dots = _ps.root.querySelector('.ps-dots');
  _ps.sr   = _ps.root.querySelector('.ps-sr');
  return true;
}

function _psClearWorkTimers() {
  clearTimeout(_ps.slowTimer);
  clearInterval(_ps.pulseTimer);
  clearTimeout(_ps.pulseClearTimer);
  _ps.slowTimer = _ps.pulseTimer = _ps.pulseClearTimer = null;
  document.querySelectorAll('.pipeline-step.pulse-strong').forEach(el => el.classList.remove('pulse-strong'));
  if (_ps.root) _ps.root.classList.remove('pulse-strong');
}

// Colour/animation state follows the message that is ON SCREEN, so e.g. the
// green "complete" look never appears while an earlier message is still typing.
function _psApplyState(phase) {
  const cfg = PIPELINE_PHASES[phase] || {};
  _ps.shownPhase = phase;
  _ps.root.classList.toggle('is-working', !!cfg.step);
  _ps.root.classList.toggle('is-success', phase === 'done');
  _ps.root.classList.toggle('is-error', phase === 'error');
  _ps.root.classList.toggle('is-slow', _ps.slowPhase === phase);
}

function _psRender(visibleText, dotsOn) {
  _ps.text.textContent = visibleText;
  _ps.dots.innerHTML = dotsOn ? '<i>.</i><i>.</i><i>.</i>' : '';
}

// Type one message character by character. Resolves when finished or cancelled.
function _psType(msg, epoch) {
  return new Promise(resolve => {
    const hasDots = /\.\.\.$/.test(msg);
    const base = hasDots ? msg.slice(0, -3) : msg;
    const finish = () => {
      if (epoch === _ps.epoch) {
        _psRender(base, hasDots);          // trailing "..." becomes animatable dots
        _ps.root.classList.remove('is-typing');
      }
      resolve();
    };

    if (_ps.sr) _ps.sr.textContent = msg;  // screen readers get the whole sentence once

    if (_psReducedMotion()) { finish(); return; }

    _ps.root.classList.add('is-typing');
    let i = 0;
    const tick = () => {
      if (epoch !== _ps.epoch) { resolve(); return; }
      if (document.hidden) i = msg.length - 1;   // background tabs throttle timers; don't crawl
      i++;
      if (i >= msg.length) { finish(); return; }
      _ps.text.textContent = msg.slice(0, i);
      setTimeout(tick, _ps.pending !== null ? PS_CATCHUP_MS : PS_TYPE_MS);
    };
    tick();
  });
}

// Show whatever is pending; always converges on the newest message.
async function _psRun() {
  _ps.running = true;
  try {
    while (_ps.pending !== null) {
      const next = _ps.pending;
      const nextPhase = _ps.pendingPhase;
      _ps.pending = null;
      if (next === _ps.shown) continue;

      if (_ps.shown) {                              // smoothly retire the previous message
        _ps.root.classList.add('is-swapping');
        await _psWait(PS_FADE_MS);
      }
      _psRender('', false);
      _ps.shown = next;
      _psApplyState(nextPhase);
      _ps.root.classList.remove('is-swapping');

      await _psType(next, _ps.epoch);
      if (_ps.pending !== null) await _psWait(PS_HOLD_MS);
    }
  } finally {
    _ps.running = false;
  }
}

function _psStrongPulse(phase) {
  if (_psReducedMotion()) return;
  const cfg = PIPELINE_PHASES[phase];
  const step = cfg && cfg.step ? document.getElementById(cfg.step) : null;
  if (!step || !step.classList.contains('step-active')) return;

  clearTimeout(_ps.pulseClearTimer);
  [step, _ps.root].forEach(el => {
    el.classList.remove('pulse-strong');
    void el.offsetWidth;                  // restart the CSS animation
    el.classList.add('pulse-strong');
  });
  _ps.pulseClearTimer = setTimeout(() => {
    step.classList.remove('pulse-strong');
    _ps.root.classList.remove('pulse-strong');
  }, 1500);
}

function _psEnterSlow(phase) {
  if (_ps.phase !== phase) return;        // stage already moved on
  _ps.slowPhase = phase;
  if (_ps.shownPhase === phase) _ps.root.classList.add('is-slow');   // same message, travelling dots
  _psStrongPulse(phase);
  _ps.pulseTimer = setInterval(() => {
    if (_ps.phase !== phase) { _psClearWorkTimers(); return; }
    _psStrongPulse(phase);
  }, PS_PULSE_EVERY_MS);
}

// Call this when a REAL stage starts or ends.
function setPipelinePhase(phase) {
  const cfg = PIPELINE_PHASES[phase];
  if (!cfg || !_psBind() || _ps.phase === phase) return;

  _psClearWorkTimers();
  _ps.phase = phase;
  _ps.slowPhase = null;
  _ps.root.dataset.phase = phase;

  if (cfg.slowMs) _ps.slowTimer = setTimeout(() => _psEnterSlow(phase), cfg.slowMs);

  _ps.pending = cfg.text;
  _ps.pendingPhase = phase;
  if (!_ps.running) _psRun();
}

function resetPipelineStatus() {
  if (!_psBind()) return;
  _psClearWorkTimers();
  _ps.epoch++;
  _ps.phase = 'idle';
  _ps.shown = null;
  _ps.shownPhase = null;
  _ps.pending = null;
  _ps.pendingPhase = null;
  _ps.slowPhase = null;
  _ps.root.dataset.phase = 'idle';
  _ps.root.classList.remove('is-working', 'is-slow', 'is-success', 'is-error', 'is-typing', 'is-swapping');
  _psRender('', false);
  if (_ps.sr) _ps.sr.textContent = '';
}

// ─── Google Document AI ──────────────────────────────────────
const DI_SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'pptx', 'html', 'htm',
  'jpg', 'jpeg', 'png', 'bmp', 'tif', 'tiff', 'heif'
]);

const DI_CONTENT_TYPES = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
  htm:  'text/html',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  bmp:  'image/bmp',
  tif:  'image/tiff',
  tiff: 'image/tiff',
  heif: 'image/heif'
};

function getDocumentExtension(file) {
  return (file?.name || '').split('.').pop().toLowerCase();
}

function isSupportedDocument(file) {
  return DI_SUPPORTED_EXTENSIONS.has(getDocumentExtension(file));
}

function getDocumentContentType(file) {
  const ext = getDocumentExtension(file);
  return DI_CONTENT_TYPES[ext] || file.type || 'application/octet-stream';
}

async function analyzeWithDI(file, hooks = {}) {
  return analyzeWithGoogleDocAI(file, hooks);
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Google Document AI. Google needs an OAuth token (not an API key), so the request
// goes through the local server.py, which signs in with the service-account key file
// and forwards the document to Google.
async function analyzeWithGoogleDocAI(file, hooks = {}) {
  const s = loadSettings();
  if (!s.gcpProjectId || !s.gcpProcessorId) {
    throw new Error('Google Document AI not configured — set Project ID and Processor ID in Settings.');
  }

  const mimeType = getDocumentContentType(file);
  logLine(`Uploading ${file.name} to Google Document AI…`, 'info');
  logLine(`Content type: ${mimeType}`, 'info');
  logLine(`Processor: ${s.gcpLocation || 'us'} / ${s.gcpProcessorId}`, 'info');

  const content = arrayBufferToBase64(await file.arrayBuffer());
  if (typeof hooks.onUploadAccepted === 'function') hooks.onUploadAccepted();  // presentation only

  const res = await fetch('/google-docai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId:       s.gcpProjectId,
      location:        s.gcpLocation || 'us',
      processorId:     s.gcpProcessorId,
      credentialsFile: s.gcpCredentialsFile || '',
      request: {
        skipHumanReview: true,
        rawDocument: { mimeType, content }
      }
    })
  });

  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { /* non-JSON error text */ }
  if (!res.ok || data.ok === false) {
    throw new Error(`Google Document AI ${res.status}: ${(data.error || raw || '').substring(0, 300)}`);
  }

  const text = data.text || '';
  logLine(`✓ Extraction complete — ${data.pages ?? '?'} page(s), ${text.length.toLocaleString()} chars.`, 'success');
  return text;
}

async function testGoogleDocAI() {
  const el = document.getElementById('gdocai-test-result');
  if (el) el.innerHTML = '<div class="alert alert-info">⏳ Signing in to Google…</div>';
  try {
    const s = {
      gcpCredentialsFile: (document.getElementById('s-gcp-credentials')?.value || '').trim()
    };
    const res = await fetch('/google-docai/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentialsFile: s.gcpCredentialsFile })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (el) el.innerHTML = `<div class="alert alert-success">✅ Google sign-in works (${esc(data.method || '')}). Save Settings, then try a document.</div>`;
  } catch (e) {
    if (el) el.innerHTML = `<div class="alert alert-error">❌ ${esc(e.message)}</div>`;
  }
}

// ─── Google Gemini ────────────────────────────────────────────
// Gemini runs on Google Cloud Vertex AI (paid from the Google Cloud credit),
// through the local server.py, which signs in with the same service-account
// key file used for Document AI.
// Same name/signature as before so every caller keeps working:
//   callGPT(systemPrompt, userContent, expectJson) -> parsed JSON object, or text.
const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

async function callGPT(systemPrompt, userContent, expectJson = true) {
  const s = loadSettings();
  if (!s.gcpProjectId) {
    throw new Error('Gemini not configured — set the Google Project ID in Settings.');
  }

  const model = (s.geminiModel || GEMINI_DEFAULT_MODEL).trim();

  const body = {
    systemInstruction: { parts: [{ text: String(systemPrompt || '') }] },
    contents: [{ role: 'user', parts: [{ text: String(userContent || '') }] }]
  };
  if (expectJson) {
    body.generationConfig = { responseMimeType: 'application/json' };
  }

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch('/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId:       s.gcpProjectId,
        location:        s.geminiLocation || 'global',
        model,
        credentialsFile: s.gcpCredentialsFile || '',
        request:         body
      })
    });
    // Retry briefly on rate limit / overloaded.
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    break;
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    let msg = txt;
    try { msg = JSON.parse(txt).error?.message || txt; } catch { /* keep raw */ }
    throw new Error(`Gemini ${res.status}: ${String(msg).substring(0, 300)}`);
  }

  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .filter(p => typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('')
    .trim();

  if (!text) {
    const why = cand?.finishReason || data.promptFeedback?.blockReason || 'empty response';
    throw new Error(`No text returned from Gemini (${why}).`);
  }

  if (!expectJson) return text;

  try {
    return JSON.parse(text);
  } catch {
    // Strip ``` fences if the model added them.
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
  }
}

// ─── Question generation prompt ───────────────────────────────
const SYSTEM_GENERATE_QUESTIONS = `You are a strict question extraction engine. Your job is to extract ONLY the questions that are explicitly present in the supplied document content.

Do not create, infer, expand, complete, or add questions that are not explicitly written in the source document. This is extraction, not question generation.

Return a JSON object with this exact structure:
{
  "questions": [
    {
      "id": "q_1",
      "question": "Question text copied from the source as closely as possible",
      "category": "Best-fit category based only on the question itself",
      "type": "open",
      "expectedAnswer": "Brief description of the answer format directly implied by the question",
      "clarificationDefinition": "Short plain-English explanation of what the original question means, without introducing any alternative acceptable answer",
      "required": true,
      "priority": "high",
      "validation": {
        "requiredComponents": [],
        "allowedValues": [],
        "minimum": null,
        "maximum": null
      },
      "sourceText": "Exact or near-exact source text containing this question"
    }
  ]
}

STRICT RULES:
- Extract only explicit client-facing questions found in the document.
- Never add standard intake questions, recommended questions, inferred questions, or questions based on the document topic.
- Never split one source question into multiple Question Bank records.
- Never combine separate source questions into one record.
- Preserve the source order exactly. Do not reorder by priority or category.
- Preserve the original wording as closely as possible. Only remove numbering/bullets when needed.
- The number of Question Bank records must equal the number of explicit questions found in the source. If the source contains 4 questions, return exactly 4 questions.
- If no explicit questions are present, return {"questions": []}.
- type must be exactly one of: open, yesno, date, number, choice, address. Infer this metadata only from the explicit question.
- priority must be exactly one of: high, medium, low. Metadata may be inferred, but it must never cause a new question to be created.
- expectedAnswer may summarize the format directly required by the question, but must not introduce additional information requirements.
- clarificationDefinition may restate the ordinary meaning of the original question in plain English, but it must preserve the same subject/event/field and must NEVER introduce an alternative acceptable date, document, event, status, or value.
- Example: for "date of your first arrival in Canada", clarificationDefinition may say "the date the client first physically entered Canada"; it must not mention a study-permit date as an alternative.
- validation describes machine-checkable requirements; it must NEVER weaken or expand the source question.
- For a date question that asks for a date, use requiredComponents ["day","month","year"] unless the source explicitly asks for only a month, year, or another partial date.
- For an address question, use type "address". For a normal current/residential address, use requiredComponents ["street","city","province","postalCode"] only when the source clearly expects a complete address; otherwise leave requiredComponents empty.
- For a number question such as number of children, set minimum to 0 when negative values would be impossible from the question semantics.
- For choice questions, populate allowedValues ONLY when the allowed choices are explicitly present in the source text. Never invent a list of choices.
- required should default to true unless the source clearly marks the question as optional.
- sourceText must contain the corresponding source question so the extraction can be audited.

Before returning, verify that every output question can be traced to explicit wording in the supplied source content. Delete any output item that cannot be directly traced to the source.`;

function normalizeSourceEvidence(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/^[\s\d.)\-•]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function applyGenericValidationMetadata(q) {
  const questionText = String(q?.question || '').toLowerCase();
  const expectedText = String(q?.expectedAnswer || '').toLowerCase();
  const validation = (q?.validation && typeof q.validation === 'object') ? { ...q.validation } : {};

  validation.requiredComponents = Array.isArray(validation.requiredComponents)
    ? validation.requiredComponents.filter(Boolean)
    : [];
  validation.allowedValues = Array.isArray(validation.allowedValues)
    ? validation.allowedValues.filter(Boolean)
    : [];
  validation.minimum = Number.isFinite(validation.minimum) ? validation.minimum : null;
  validation.maximum = Number.isFinite(validation.maximum) ? validation.maximum : null;

  // Generic type-level requirements. These do not create new questions; they
  // only define when an answer to the extracted question is complete.
  if (q.type === 'date') {
    const explicitlyPartial = /month\s+and\s+year|year\s+only|month\s+only/.test(questionText + ' ' + expectedText);
    if (!explicitlyPartial && validation.requiredComponents.length === 0) {
      validation.requiredComponents = ['day', 'month', 'year'];
    }
  }

  if (q.type === 'address' || /current\s+(residential\s+)?address|home\s+address/.test(questionText)) {
    q.type = 'address';
    if (validation.requiredComponents.length === 0) {
      validation.requiredComponents = ['street', 'city', 'province', 'postalCode'];
    }
  }

  if (q.type === 'number' && /how\s+many\s+children/.test(questionText) && validation.minimum == null) {
    validation.minimum = 0;
  }

  // Choice lists must come from the document. If the model cannot point to an
  // explicit list in the source, an empty list is safer than invented values.
  if (q.type !== 'choice') validation.allowedValues = [];

  q.validation = validation;
  return q;
}

function validateExtractedQuestions(result, sourceContent) {
  const source = normalizeSourceEvidence(sourceContent);
  const seen = new Set();
  const accepted = [];

  for (const q of (result?.questions || [])) {
    const question = normalizeSourceEvidence(q.question);
    const evidence = normalizeSourceEvidence(q.sourceText);

    // Every Question Bank item must carry source evidence that actually occurs
    // in the extracted document. This blocks model-invented intake questions.
    if (!question || !evidence || !source.includes(evidence)) {
      logLine(`Rejected ungrounded question: ${q.question || '(empty)'}`, 'warning');
      continue;
    }

    if (seen.has(question)) continue;
    seen.add(question);
    accepted.push(applyGenericValidationMetadata(q));
  }

  return { questions: accepted };
}

async function generateQuestionsFromContent(content) {
  const truncated = content.substring(0, 28000);
  const userMsg = `STRICT EXTRACTION MODE. Extract only the explicit questions present in the following document content. Do not add any questions of your own. Preserve the source order.\n\nSOURCE DOCUMENT CONTENT:\n${truncated}`;
  const result = await callGPT(SYSTEM_GENERATE_QUESTIONS, userMsg, true);
  return validateExtractedQuestions(result, truncated);
}

// ─── Guardrails: Scope Enforcement (ported from ver8, hardened) ──────────────
// Intercepts client utterances that are NOT intake answers:
//   pr_chances  – asking about chances of PR / visa / approval
//   suggestion  – asking the assistant for advice / recommendations
//   off_topic   – unrelated chit-chat (weather, jokes, ...)
// Clarification questions about the CURRENT intake question are explicitly
// allowed (they are handled by the follow-up clarification logic).
// Fail-open: any error or timeout means "not a violation", so the normal
// intake flow is never blocked by this layer.
const GUARDRAILS_ENABLED = true;           // set false to disable all guardrails
const GUARDRAIL_LLM_TIMEOUT_MS = 4000;     // max wait for the LLM classifier
const GUARDRAIL_CATEGORIES = ['pr_chances', 'suggestion', 'off_topic'];

const GUARDRAIL_OUT_OF_SCOPE_MESSAGES = {
  'en-US': {
    pr_chances: 'This is out of scope. I cannot assess or evaluate your chances for permanent residency. Please provide the related information as per the question and do not deviate from it.',
    suggestion: 'This is out of scope. I cannot provide advice, recommendations, or suggestions. Please provide the related information as per the question and do not deviate from it.',
    off_topic: 'This is out of scope. Please keep to the interview topic and provide the related information as per the question without deviating from it.',
    default: 'This is out of scope. Please provide the related information as per the question and do not deviate from it.'
  },
  'fa-IR': {
    pr_chances: 'این مورد خارج از حیطه وظایف است. من نمی‌توانم شانس اقامت دائم را بررسی کنم. لطفاً اطلاعات مربوط به سؤال را ارائه دهید و از موضوع منحرف نشوید.',
    suggestion: 'این مورد خارج از حیطه وظایف است. من نمی‌توانم توصیه یا پیشنهادی ارائه دهم. لطفاً اطلاعات مربوط به سؤال را ارائه دهید و از موضوع منحرف نشوید.',
    off_topic: 'این مورد خارج از موضوع مصاحبه است. لطفاً اطلاعات مربوط به سؤال را ارائه دهید و از موضوع منحرف نشوید.',
    default: 'این مورد خارج از حیطه وظایف است. لطفاً اطلاعات مربوط به سؤال را ارائه دهید و از موضوع منحرف نشوید.'
  },
  'fr-CA': {
    pr_chances: "Ceci est hors de portée. Je ne peux pas évaluer vos chances de résidence permanente. Veuillez fournir les informations demandées pour cette question sans vous en écarter.",
    suggestion: "Ceci est hors de portée. Je ne peux pas vous donner de conseils, de recommandations ou de suggestions. Veuillez fournir les informations demandées pour cette question sans vous en écarter.",
    off_topic: "Ceci est hors sujet. Veuillez fournir les informations demandées pour cette question sans vous en écarter.",
    default: "Ceci est hors de portée. Veuillez fournir les informations demandées pour cette question sans vous en écarter."
  }
};

function hasGuardrailMessages(lang) {
  return !!GUARDRAIL_OUT_OF_SCOPE_MESSAGES[lang];
}

function getGuardrailMessage(lang = 'en-US', category = 'default') {
  const langTable = GUARDRAIL_OUT_OF_SCOPE_MESSAGES[lang] || GUARDRAIL_OUT_OF_SCOPE_MESSAGES['en-US'];
  return langTable[category] || langTable.default || GUARDRAIL_OUT_OF_SCOPE_MESSAGES['en-US'].default;
}

// Unicode-safe word end. JavaScript \b only understands ASCII letters, so it
// never matches after Persian words; use this lookahead for Persian/French.
const GUARDRAIL_WORD_END = '(?=$|[\\s?؟!.,،؛:;])';

function detectGuardrailViolationFast(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;

  // 1. Chances of Permanent Residency (PR) / immigration approval / visa odds
  const PR_PATTERNS = [
    /\b(chance(s)?\s*(for|of|to\s*get)?\s*p\.?r\.?|p\.?r\.?\s*chance(s)?|permanent\s*residen(cy|t)\s*chance(s)?|chance(s)?\s*(for|of)\s*(getting\s*)?(p\.?r\.?|permanent\s*residen(cy|t)|citizenship|visa|work\s*permit))\b/i,
    /\b(will|can|could)\s*i\s*(ever\s*)?get\s*(p\.?r\.?|permanent\s*residen(cy|t))\b/i,
    /\bam\s*i\s*(eligible|qualified)\s*for\s*(p\.?r\.?|permanent\s*residen(cy|t))\b/i,
    /\b(odds|probability|likelihood)\s*(of|for)\s*(p\.?r\.?|permanent\s*residen(cy|t)|approval|visa)\b/i,
    /\bwhat\s*(are\s*)?my\s*(chances|odds)\s*(for|of|with)?\s*(p\.?r\.?|permanent\s*residen(cy|t))\b/i,
    /(شانس|احتمال)\s*(من\s*)?(برای\s*)?(گرفتن\s*)?(اقامت|پی\s*آر|pr|قبولی|ویزا)/i,
    /(آیا|ایا)\s*(من\s*)?(اقامت|pr|پی\s*آر)\s*(رو\s*|را\s*)?(می‌گیرم|میگیرم|می\s*گیرم)/i,
    /(chances?\s*(pour|d'obtenir|de)\s*(la\s*)?(r\.?p\.?|résidence\s*permanente|visa|citoyenneté)|est-ce\s*que\s*j'ai\s*des\s*chances|mes\s*chances\s*de)/i
  ];
  for (const re of PR_PATTERNS) {
    if (re.test(t)) {
      return { triggered: true, category: 'pr_chances', reason: 'Client asked about PR chances or immigration odds' };
    }
  }

  // 2. Asking for suggestions, recommendations, advice, or opinions.
  // NOTE: "what should I say/write/put/answer" is NOT matched here, because it
  // is usually a clarification of the current question; those go to the LLM
  // classifier, which is instructed to allow clarification questions.
  const SUGGESTION_PATTERNS = [
    /\bwhat\s*(do|would)\s*(you|u)\s*(suggest|recommend|advise)\b/i,
    /\bwhat\s*(do\s*(you|u)\s*)?suggest\b/i,
    /\b((what\s*(is|are|'s)\s*(your|ur)?|any|give\s*me\s*(a|some)?)\s*suggestion(s)?)\b/i,
    /\bwhat('s|\s+is|\s+are)?\s*(your|ur)\s*(suggestion(s)?|advice|recommendation(s)?|opinion(s)?)\b/i,
    /\b(any|have\s*any)\s*(suggestion(s)?|recommendation(s)?|advice)\b/i,
    /\bcan\s*(you|u)\s*(suggest|recommend|advise)\b/i,
    /\bwhat\s*should\s*(i|we)\s*(do|choose|pick)\b/i,
    /\bgive\s*(me\s*)?(some\s*)?(advice|recommendation(s)?|suggestion(s)?)\b/i,
    /\b(need|want)\s*(your|ur)?\s*(advice|suggestion|recommendation)\b/i,
    /\bcan\s*(you|u)\s*(give\s*(me\s*)?)?(advice|guidance|counsel)\b/i,
    /\bhelp\s*me\s*(decide|choose)\b/i,
    /\b(legal|immigration)\s*advice\b/i,
    /\bsuggest\s*(something|me)\b/i,
    /(پیشنهاد(ت|تون|\s*شما)?\s*(چیه|چیست|داری|دارید)|به\s*نظر(ت|تون|\s*شما)?\s*(چیکار|چه\s*کار)\s*کنم|چی\s*(پیشنهاد|توصیه)\s*(می‌کنی|میکنی|می\s*کنی|می‌کنید|میکنید|می\s*کنید)|(به\s*من\s*)?(مشاوره|راهنمایی)\s*(بده|بدید|بدهید|می‌دی|میدی|می\s*دی))/i,
    /(que\s*(me\s*)?(conseillez|suggérez)-vous|des\s*suggestions?|donnez-moi\s*(un\s*)?conseil|qu'est-ce\s*que\s*je\s*devrais\s*(faire|choisir)|votre\s*(avis|opinion|suggestion|recommandation))/i
  ];
  for (const re of SUGGESTION_PATTERNS) {
    if (re.test(t)) {
      return { triggered: true, category: 'suggestion', reason: 'Client asked for advice, suggestion, or recommendation' };
    }
  }

  // 3. Obvious off-topic questions / chit-chat
  const OFF_TOPIC_PATTERNS = [
    /\b(what('s|\s+is)\s+the\s+weather|tell\s+me\s+a\s+joke|who\s+(created|made)\s+you|what\s+time\s+is\s+it|how('s|\s+is)\s+the\s+stock\s+market|who\s+won\s+the|sing\s+a\s+song|write\s+a\s+poem)\b/i,
    new RegExp('(هوا\\s*چطوره|جوک\\s*بگو|شعر\\s*بخون|شعر\\s*بخوان|ساعت\\s*چنده)' + GUARDRAIL_WORD_END, 'i'),
    /(quel\s*temps\s*fait-il|raconte-moi\s*une\s*blague|qui\s*t'a\s*créé|quelle\s*heure\s*est-il)/i
  ];
  for (const re of OFF_TOPIC_PATTERNS) {
    if (re.test(t)) {
      return { triggered: true, category: 'off_topic', reason: 'Client asked an off-topic or conversational question' };
    }
  }

  return null;
}

// Decides whether an utterance looks like a question / request and is worth
// sending to the LLM classifier. Supports both "?" and the Persian "؟".
function guardrailLooksLikeQuery(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  if (/[?؟]/.test(clean)) return true;
  const en = /^(what|how|why|can\s+you|could\s+you|should\s+i|would\s+you|do\s+you|tell\s+me|is\s+there|are\s+there|will\s+i|who|where|give\s+me)\b/i;
  const faFr = new RegExp('^(آیا|ایا|چرا|چطور|چطوری|چگونه|میشه|می‌شه|می\\s*شه|به\\s*نظرت|به\\s*نظر\\s*شما|est-ce|pourquoi|comment|pouvez-vous|quel|quelle)' + GUARDRAIL_WORD_END, 'i');
  return en.test(clean) || faFr.test(clean);
}

const SYSTEM_GUARDRAIL_CLASSIFIER = `You are a strict but careful guardrail classifier for an AI caseworker intake interview.
The caseworker asked: "{QUESTION}"
The client responded: "{TRANSCRIPT}"

Mark the utterance as a violation ONLY if the client is doing one of these instead of answering:
1. pr_chances: asking about their chances of permanent residency (PR), visa approval, or success odds (e.g. "what are my chances for pr", "will I get approved?").
2. suggestion: asking the AI for advice, recommendations, or opinions about what they should do (e.g. "what do you suggest?", "what should I do?", "which option is better for my case?").
3. off_topic: asking about or talking about unrelated matters (weather, jokes, news, personal questions to the AI, etc.).

These are NOT violations (return isViolation=false, category="none"):
- Any attempt to answer the question, even partial, uncertain, informal, or with extra context.
- Clarification questions about the CURRENT question: what it means, which date/document/event it refers to, what format to use, what to put or say for it (e.g. "do you mean my landing date?", "what should I put here?", "منظورتون تاریخ ورود اوله؟").
- Asking to repeat the question, saying they don't know / don't remember, or asking to switch language.

When in doubt, return isViolation=false.

Return JSON ONLY:
{
  "isViolation": boolean,
  "category": "pr_chances" | "suggestion" | "off_topic" | "none",
  "reason": "short explanation"
}`;

function guardrailWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ __guardrailTimeout: true }), ms))
  ]);
}

async function checkGuardrail(transcript, currentQuestion = '', languageCode = 'en-US') {
  const notTriggered = { triggered: false };
  try {
    if (!GUARDRAILS_ENABLED) return notTriggered;
    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) return notTriggered;

    const clean = transcript.trim();

    // 1. Fast regex detection (zero latency)
    const fast = detectGuardrailViolationFast(clean);
    if (fast) {
      console.log('[Guardrail] Fast match violation:', fast.category, clean);
      return {
        triggered: true,
        category: fast.category,
        reason: fast.reason,
        message: getGuardrailMessage(languageCode, fast.category),
        messageEn: getGuardrailMessage('en-US', fast.category)
      };
    }

    // 2. LLM classifier, only for utterances that look like a question/request
    if (!guardrailLooksLikeQuery(clean)) return notTriggered;

    const prompt = SYSTEM_GUARDRAIL_CLASSIFIER
      .replace('{QUESTION}', String(currentQuestion || 'Intake question').replace(/"/g, "'"))
      .replace('{TRANSCRIPT}', clean.replace(/"/g, "'"));

    const result = await guardrailWithTimeout(
      callGPT(prompt, `Current language: ${languageCode}\nUtterance: "${clean}"`, true),
      GUARDRAIL_LLM_TIMEOUT_MS
    );

    if (result && result.__guardrailTimeout) {
      console.warn('[Guardrail] LLM classifier timed out; continuing normally.');
      return notTriggered;
    }

    if (result && result.isViolation === true && GUARDRAIL_CATEGORIES.includes(result.category)) {
      console.log('[Guardrail] LLM classified violation:', result.category, result.reason);
      return {
        triggered: true,
        category: result.category,
        reason: result.reason || 'Out of scope request',
        message: getGuardrailMessage(languageCode, result.category),
        messageEn: getGuardrailMessage('en-US', result.category)
      };
    }
  } catch (e) {
    console.warn('[Guardrail] check error; continuing normally:', e && e.message);
  }
  return notTriggered;
}

// ─── Answer analysis prompt ───────────────────────────────────
const SYSTEM_ANALYZE_ANSWER = `You are an expert multilingual caseworker AI assistant. Analyze the client's answer to a caseworker question.

You will receive: the original question (always in English), expected answer type, the primary transcript (may be in Persian/Farsi, French, or English), speech recognition confidence, lexical form, NBest alternatives, and the answer language code.

CRITICAL RULES:
1. NEVER hallucinate or invent personal information (dates, names, phone numbers, addresses, postcodes, ID numbers).
2. Understand the answer in its original language — do NOT require English.
3. Use NBest alternatives ONLY if one clearly fits the question context better than the primary transcript.
4. If information is still uncertain after reviewing all alternatives, set isAnswerComplete = false.
5. Partial information is valid — extract what you are confident about and ask a targeted follow-up for ONLY the missing piece.
6. NEVER relax, downgrade, reinterpret, or replace the validation requirement. If the required metadata says day/month/year are required, month/year alone is NOT complete. Do not say "at least month and year" or offer a weaker alternative unless the source metadata explicitly allows it.
7. The validation metadata is authoritative for completeness. Missing requiredComponents means isAnswerComplete=false and suggestedFollowUp must ask only for the missing component(s).
8. For number fields, enforce minimum/maximum when provided. Do not accept an impossible or out-of-range number as complete.
9. For choice fields, enforce allowedValues when provided. If allowedValues is empty, do not invent choices; determine completeness only from the explicit question and expected format.
10. For address fields, never fabricate missing address components. Ask only for components that are required and still missing.
11. FOLLOW-UP CLARIFICATION GUARDRAIL:
    - When the client asks what the current question means, clarify ONLY the meaning of the original question.
    - Preserve the exact subject, event, field, and requirement of the original question.
    - Do NOT introduce, suggest, or accept a related alternative date, document, status, event, field, or value unless the question metadata explicitly says it is acceptable.
    - If the client mentions a possible alternative interpretation, explain the original meaning directly and then ask only for the information required by the original question.
    - Do NOT repeat the client's alternative as another acceptable option.
    - Keep clarification follow-ups concise.
    Example: for "What was the date of your first arrival in Canada?" if the client asks whether this means landing date or study-permit date, a correct follow-up is: "By first arrival in Canada, we mean the date you first physically entered Canada. What was the day, month, and year?" Do NOT offer the study-permit date as an alternative.
12. If a Question definition/clarification is supplied in metadata, treat it as authoritative for explaining what the question means. It may clarify meaning but must never weaken validation requirements.
13. suggestedFollowUp must always be in ENGLISH (the system will translate it to the client's language).
12. interpretedAnswer and englishInterpretation must be in English regardless of the client's answer language.
13. englishTranslation must be a faithful English translation of the client's actual words. Do not add facts or interpretation. If the client already spoke English, copy the transcript meaning faithfully in English.
14. mappingExplanation must be a SHORT audit explanation of how the client's words support the mapped value. Do not expose hidden chain-of-thought. Use 1-2 concise factual sentences.
15. normalizedValue is the database/form value. Map strictly:
   - yes/no -> "Yes" or "No"
   - number -> digits only (for example 0, 1, 2)
   - date -> YYYY-MM-DD when fully known
   - choice -> exactly the matching choice value when the available choice is clear from the question/expected format
   - address -> concise normalized address text only when every required address component is present
   - open text -> concise normalized text
   - normalizedValue must always be written in English, whatever language the client spoke (keep proper names; write them in Latin letters).
   If a reliable mapped value cannot be determined, use an empty string and set isAnswerComplete=false.
16. PLAUSIBILITY: Today's date is supplied. A date of birth or any past event (arrival, marriage, graduation, etc.) can NEVER be in the future, and the date must exist on the calendar (no 31 February). If the date is impossible, set isAnswerComplete=false and ask the client to repeat the date. Never "fix" an impossible date yourself.
17. NAMES: Never guess or substitute a person's name. If the transcript does not clearly contain a name (e.g. it looks like random words or a misrecognition), set isAnswerComplete=false and ask the client to repeat and spell the name.
18. CORRECTIONS: When the client's later turns correct earlier turns, the latest turn wins. If a note says the client rejected a read-back value, do NOT return that value again unless the client explicitly restates it.

Return a JSON object with this EXACT structure:
{
  "interpretedAnswer": "English re-statement of what the client meant",
  "englishTranslation": "Faithful English translation of the client's actual words",
  "englishInterpretation": "Full English sentence describing the meaning of the answer",
  "mappingExplanation": "Short auditable explanation connecting the client's words to normalizedValue",
  "isAnswerComplete": true,
  "missingInformation": "What is still needed in English (empty string if complete)",
  "suggestedFollowUp": "English follow-up question for ONLY the missing piece (empty string if complete)",
  "normalizedValue": "Strict standardized value for mapping to the form/database",
  "extracted": {},
  "usedAlternative": false,
  "usedAlternativeReason": ""
}`;


// ── Unified AI Analysis ────────────────────────────────────────────────────
const SYSTEM_UNIFIED_ANALYSIS = `You are an AI Caseworker assistant analyzing client responses.
You must return a JSON object ONLY — no markdown, no explanation.

Valid actions: ask_missing_information, request_spelling, confirm_value, ask_incorrect_component, request_correction, confirm_corrected_value, save_and_continue, retry

Response schema:
{
  "fieldKey": string,
  "action": one of the valid actions above,
  "interpretedAnswer": string (natural language summary in English),
  "englishTranslation": string (faithful English translation of the client's latest substantive answer; no added facts),
  "mappingExplanation": string (1-2 concise factual sentences explaining how the client response supports the structured/mapped value; never hidden chain-of-thought),
  "spokenConfirmation": string (what to say to client — natural, not JSON),
  "isAnswerComplete": boolean,
  "isAnswerValid": boolean,
  "isConfirmed": boolean,
  "confirmationStatus": "unconfirmed" | "confirmed" | "rejected" | "ambiguous",
  "missingInformation": string,
  "suggestedFollowUp": string (in English; caller will translate),
  "normalizedValue": object (structured components; values in English / Latin letters even if the client spoke another language),
  "incorrectComponent": string or null,
  "updatedComponents": array of strings,
  "reason": string
}`;


const SYSTEM_CONFIRMATION_ONLY = `You are a multilingual confirmation classifier.

The client has just been asked whether previously read-back information is correct.

Classify ONLY the client's latest response.

Return exactly this JSON:
{
  "confirmationStatus": "confirmed" | "rejected" | "ambiguous",
  "action": "save_and_continue" | "ask_incorrect_component" | "retry",
  "reason": "brief explanation"
}

Rules:
- confirmed: clear agreement such as yes, yes it is correct, that's right, correct, exactly, بله, درسته, صحیح است, oui, c'est correct.
- rejected: clear disagreement such as no, wrong, incorrect, نه, اشتباهه, non.
- ambiguous: anything else.
- Never request spelling when the client clearly confirms.
- Never reinterpret or modify the stored name/address/country.
- For confirmed, action MUST be save_and_continue.
- For rejected, action MUST be ask_incorrect_component.
- For ambiguous, action MUST be retry.`;

async function analyzeConfirmationOnly(clientAnswer, wfCtx) {
  const userContent = `Field: ${wfCtx?.fieldKey || 'unknown'}
Current value: ${JSON.stringify(wfCtx?.structuredValue || {})}
Client's latest confirmation response: "${clientAnswer}"

Classify the response only.`;

  try {
    const result = await callGPT(
      SYSTEM_CONFIRMATION_ONLY,
      userContent,
      true
    );

    const status = result?.confirmationStatus;

    if (!['confirmed', 'rejected', 'ambiguous'].includes(status)) {
      throw new Error('Invalid confirmation status');
    }

    return {
      fieldKey: wfCtx?.fieldKey || null,
      action:
        status === 'confirmed'
          ? 'save_and_continue'
          : status === 'rejected'
            ? 'ask_incorrect_component'
            : 'retry',
      interpretedAnswer: clientAnswer,
      spokenConfirmation: '',
      isAnswerComplete: true,
      isAnswerValid: true,
      isConfirmed: status === 'confirmed',
      confirmationStatus: status,
      missingInformation: '',
      suggestedFollowUp:
        status === 'ambiguous'
          ? 'Please say yes if the information is correct, or no if it needs to be changed.'
          : '',
      normalizedValue: {},
      incorrectComponent: null,
      updatedComponents: [],
      reason: result?.reason || 'Dedicated LLM confirmation classification'
    };
  } catch (e) {
    console.error('[analyzeConfirmationOnly]', e);
    return {
      fieldKey: wfCtx?.fieldKey || null,
      action: 'retry',
      interpretedAnswer: clientAnswer,
      spokenConfirmation: '',
      isAnswerComplete: true,
      isAnswerValid: false,
      isConfirmed: false,
      confirmationStatus: 'ambiguous',
      missingInformation: '',
      suggestedFollowUp:
        'Please say yes if the information is correct, or no if it needs to be changed.',
      normalizedValue: {},
      incorrectComponent: null,
      updatedComponents: [],
      reason: 'Confirmation classification failed'
    };
  }
}

async function analyzeAnswerUnified(question, expectedAnswer, clientAnswer, wfCtx, sttMeta = null) {
  const fieldKey = wfCtx?.fieldKey || matchFieldKey(question);
  const rules = fieldKey ? (INTAKE_RULES.fields[fieldKey] || null) : null;
  const state = wfCtx?.state || WF_STATE.COLLECTING_ANSWER;
  const currentValue = wfCtx?.structuredValue || {};
  const corrHistory = wfCtx?.correctionHistory || [];

  const fullTranscriptHistory = (wfCtx?.rawTranscripts || [])
    .map((item, index) => `[${index + 1}] ${item.text}`)
    .join('\n');

  const userContent = `Question: ${question}
Expected answer type: ${rules?.answerType || 'general'}
Field key: ${fieldKey || 'unknown'}
Current workflow state: ${state}
Current structured value: ${JSON.stringify(currentValue)}
Correction history: ${JSON.stringify(corrHistory)}

ALL client responses for this question, in order:
${fullTranscriptHistory || `[1] ${clientAnswer}`}

Latest client response:
"${clientAnswer}"

STT confidence: ${sttMeta?.confidence ?? 'unknown'}
STT lexical: ${sttMeta?.lexical || ''}
STT alternatives: ${JSON.stringify(sttMeta?.alternatives?.slice(0,3) || [])}

Use ALL responses above together. Do not discard information from earlier responses.

DEMO NAME HINT:
- One possible demo name is "Mona Esrafilzadeh".
- Treat this only as a spelling/context hint when the transcript or spelling is reasonably close.
- Never replace a clearly different name with Mona Esrafilzadeh.
- When the client spells M-O-N-A and E-S-R-A-F-I-L-Z-A-D-E-H, normalize the name to:
  firstName: "Mona"
  lastName: "Esrafilzadeh"

Based on the current state and the complete transcript history, determine the appropriate action.
For state COLLECTING_ANSWER: extract structured components, check completeness.
For state COLLECTING_SPELLING:
- Carefully interpret letter-by-letter spelling, phonetic spelling such as "B as in Bravo", and natural corrections such as "my first name is Babak".
- For the demo, recognize plausible STT variants of "Mona Esrafilzadeh", including separated letters and approximate transcriptions such as "Mona Esrafil Zadeh" or "Mona Esrafilzade".
- Only use the demo-name hint when the spoken or spelled evidence is close; do not force it for unrelated names.
- Compare the spelling with the current structured value and update every component the client corrected.
- Do not ignore spelling merely because speech recognition produced words instead of isolated letters.
- If spelling is unclear, use action retry and ask for spelling again.

For state CONFIRMING or RECONFIRMING:
- The system has already read the full name back letter by letter.
- Do not generate another confirmation question and do not request spelling again when the client clearly says yes.
- Decide whether the client clearly confirmed, rejected, or gave an ambiguous response.
- Understand English, Persian, and French confirmations, including phrases such as yes, correct, that's right, بله, درسته, oui, and c'est correct.
- Only return save_and_continue when confirmation is clear.
- If ambiguous, return retry rather than guessing.
For state IDENTIFYING_INCORRECT: identify which component the client says is wrong.
For state COLLECTING_CORRECTION: extract the corrected value for the identified component.
For every substantive answer, also return:
- englishTranslation: a faithful English translation of what the client actually said.
- mappingExplanation: a short audit explanation linking the client's words to the normalized/structured value. Do not provide hidden chain-of-thought.

ADDRESS-SPECIFIC RULES:
- Clients may provide address components in ANY order.
- Combine information from every response in the transcript history.
- Extract unitNumber, streetNumber, streetName, streetType, city, province, and postalCode whenever present.
- This workflow collects Canadian addresses only. Always set country to "Canada".
- Never ask the client for their country.
- Never include country in missingInformation or suggestedFollowUp.
- Never ask again for a component already clearly provided in any earlier response.
- Understand common Canadian abbreviations and normalize them:
  - BC or British Columbia -> province: "British Columbia"
  - Dr -> streetType: "Drive"
  - St -> streetType: "Street"
  - Ave -> streetType: "Avenue"
  - Rd -> streetType: "Road"
- A sentence such as "I'm in West Vancouver, unit 1609, 945 Marine Drive, BC, V7T 1A8"
  contains city, unit number, street number, street name, street type, province, and postal code.
- Do not infer a missing city only from a postal code unless the city was explicitly spoken.
- If all required address components are present across the full transcript history, set isAnswerComplete=true and action=confirm_value.
- Country is already known as Canada and is never a missing component.
- suggestedFollowUp must ask ONLY for genuinely missing components other than country.

Return only valid JSON matching the schema.`;

  try {
    const raw = await callGPT(SYSTEM_UNIFIED_ANALYSIS, userContent, true);
    if (!raw || typeof raw !== 'object') throw new Error('Non-object response');
    if (!VALID_ACTIONS.includes(raw.action)) {
      console.warn('[analyzeAnswerUnified] Invalid action:', raw.action, '— using retry');
      raw.action = 'retry';
    }
    return raw;
  } catch(e) {
    console.error('[analyzeAnswerUnified] Error:', e);
    return {
      fieldKey, action:'retry', interpretedAnswer: clientAnswer,
      spokenConfirmation:'', isAnswerComplete:false, isAnswerValid:false,
      isConfirmed:false, confirmationStatus:'unconfirmed',
      missingInformation:'', suggestedFollowUp:'Could you please repeat that?',
      normalizedValue:{}, incorrectComponent:null, updatedComponents:[],
      reason:'AI analysis error'
    };
  }
}

// ── Speech Formatting ──────────────────────────────────────────────────────
function formatNameForSpeech(norm) {
  const parts = [norm.firstName, norm.middleName, norm.lastName].filter(Boolean);
  return parts.join(' ');
}

function spellWord(word) {
  return (word || '').toUpperCase().split('').join('-');
}

function formatNameSpellingForSpeech(norm) {
  const parts = [];
  if (norm.firstName)  parts.push(spellWord(norm.firstName));
  if (norm.middleName) parts.push(spellWord(norm.middleName));
  if (norm.lastName)   parts.push(spellWord(norm.lastName));
  return parts.join(', ');
}

function formatCountryForSpeech(norm) {
  return norm.country || norm.interpretedAnswer || '';
}

function formatAddressForSpeech(norm) {
  const parts = [];

  const street = [
    norm.streetNumber,
    norm.streetName,
    norm.streetType
  ].filter(Boolean).join(' ').trim();

  if (norm.unitNumber) parts.push(`Unit ${norm.unitNumber}`);
  if (street) parts.push(street);
  if (norm.city) parts.push(norm.city);
  if (norm.province) parts.push(norm.province);
  if (norm.postalCode) {
    parts.push(`postal code ${formatPostalCodeForSpeech(norm.postalCode)}`);
  }
  if (norm.country || norm.streetNumber || norm.city || norm.province) {
    parts.push('Canada');
  }

  return parts.join(', ');
}

function formatPostalCodeForSpeech(code) {
  return (code || '').replace(/\s/g,'').toUpperCase().split('').join(', ');
}

function formatConfirmationSpeech(ctx) {
  const v = ctx.structuredValue;
  const fk = ctx.fieldKey;
  if (fk === 'full_name') {
    const name = formatNameForSpeech(v);
    const spell = formatNameSpellingForSpeech(v);
    return `I have your name as ${name}. Let me spell it back to confirm: ${spell}. Is that spelling correct?`;
  }
  if (fk === 'country_of_birth') {
    return `I recorded your country of birth as ${formatCountryForSpeech(v)}. Is that correct?`;
  }
  if (fk === 'current_address') {
    v.country = 'Canada';
    return `Let me confirm your address. ${formatAddressForSpeech(v)}. Is that correct?`;
  }
  return `I have: ${ctx.lastAiResult?.interpretedAnswer || JSON.stringify(v)}. Is that correct?`;
}


// ── Fast local workflow analysis ───────────────────────────────────────────
// Handles deterministic cases in the browser and avoids a GPT round trip.
// Returns null when the answer is ambiguous and GPT should analyze it.

function normalizeLocalSpeech(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectLocalConfirmation(text) {
  const t = normalizeLocalSpeech(text);

  const yesPatterns = [
    /^(yes|yeah|yep|correct|right|that is correct|that's correct|it is correct|sounds right|exactly|sure)$/,
    /^(بله|آره|اره|درسته|صحیحه|درست است)$/,
    /^(oui|correct|c'est correct|exactement|d'accord)$/
  ];

  const noPatterns = [
    /^(no|nope|incorrect|wrong|that is wrong|that's wrong|not correct|it is not correct)$/,
    /^(نه|خیر|اشتباهه|غلطه|درست نیست)$/,
    /^(non|incorrect|c'est faux|ce n'est pas correct)$/
  ];

  if (yesPatterns.some(p => p.test(t))) return 'confirmed';
  if (noPatterns.some(p => p.test(t))) return 'rejected';
  return null;
}

function extractLocalFullName(text) {
  let cleaned = String(text || '').trim();

  cleaned = cleaned
    .replace(/^(my\s+(full\s+)?name\s+is|i\s+am|i'm|this\s+is)\s+/i, '')
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Only use local extraction when it looks like a normal multi-part name.
  const parts = cleaned.split(' ').filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return null;
  if (parts.some(p => !/^[A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/.test(p))) return null;

  return {
    firstName: parts[0],
    middleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : '',
    lastName: parts[parts.length - 1]
  };
}

function extractLocalCountry(text) {
  let cleaned = String(text || '').trim()
    .replace(/^(i\s+was\s+born\s+in|my\s+country\s+of\s+birth\s+is|it\s+is)\s+/i, '')
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length > 60) return null;
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'’ -]+$/.test(cleaned)) return null;
  return { country: cleaned };
}

function detectLocalIncorrectComponent(ctx, text) {
  const t = normalizeLocalSpeech(text);

  const maps = {
    full_name: [
      ['firstName', ['first name', 'given name', 'اسم کوچک', 'نام کوچک', 'prénom']],
      ['middleName', ['middle name', 'اسم وسط', 'نام میانی', 'deuxième prénom']],
      ['lastName', ['last name', 'family name', 'surname', 'اسم فامیل', 'نام خانوادگی', 'فامیلی', 'nom de famille']]
    ],
    current_address: [
      ['unitNumber', ['unit', 'apartment', 'suite', 'واحد', 'appartement']],
      ['streetNumber', ['street number', 'house number', 'شماره پلاک', 'شماره خانه', 'numéro de rue']],
      ['streetName', ['street name', 'street', 'نام خیابان', 'خیابان', 'nom de rue']],
      ['city', ['city', 'شهر', 'ville']],
      ['province', ['province', 'استان']],
      ['postalCode', ['postal code', 'postcode', 'zip code', 'کد پستی', 'code postal']]
    ],
    country_of_birth: [
      ['country', ['country', 'country of birth', 'کشور', 'pays']]
    ]
  };

  for (const [component, words] of (maps[ctx.fieldKey] || [])) {
    if (words.some(w => t.includes(w))) return component;
  }
  return null;
}

function parseLocalSpelling(text, currentValue) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const result = { ...(currentValue || {}) };

  const cleanWord = value => String(value || '')
    .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'’-]/g, '')
    .trim();

  const firstMatch =
    raw.match(/(?:my\s+first\s+name\s+(?:is|isn't)\s+|first\s+name\s+is\s+|it(?:'s|\s+is)\s+)([A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,})/i);

  const lastMatch =
    raw.match(/(?:my\s+last\s+name\s+is\s+|my\s+family\s+name\s+is\s+|my\s+surname\s+is\s+|last\s+name\s+is\s+)([A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,})/i);

  if (firstMatch) result.firstName = cleanWord(firstMatch[1]);
  if (lastMatch) result.lastName = cleanWord(lastMatch[1]);

  if (
    /(?:i\s+do\s+not|i\s+don't|no)\s+have\s+(?:a\s+)?middle\s+name/i.test(raw) ||
    /no\s+middle\s+name/i.test(raw)
  ) {
    result.middleName = '';
    result.hasMiddleName = false;
  }

  const phoneticLetters = [];
  const phoneticRegex =
    /\b([A-Za-z])\b\s*(?:(?:as\s+in|like|for)\s+[A-Za-zÀ-ÖØ-öø-ÿ'’-]+)?/gi;

  let match;
  while ((match = phoneticRegex.exec(raw)) !== null) {
    phoneticLetters.push(match[1].toUpperCase());
  }

  const explicitGroups = [];
  const groupRegex =
    /(?:^|[\s,;:])((?:[A-Za-z]\s*[-.\s]\s*){2,}[A-Za-z])(?=$|[\s,;.!?])/g;

  while ((match = groupRegex.exec(raw)) !== null) {
    const letters = match[1].match(/[A-Za-z]/g);
    if (letters && letters.length >= 2) {
      explicitGroups.push(letters.join('').toUpperCase());
    }
  }

  const uppercaseWords = raw.match(/\b[A-Z]{2,}\b/g) || [];
  let spelledGroups = [...explicitGroups];

  if (!spelledGroups.length && phoneticLetters.length >= 2) {
    spelledGroups = [phoneticLetters.join('')];
  }

  if (!spelledGroups.length && uppercaseWords.length) {
    spelledGroups = uppercaseWords;
  }

  if (spelledGroups.length >= 2) {
    result.firstName = spelledGroups[0];
    result.lastName = spelledGroups[spelledGroups.length - 1];

    if (spelledGroups.length > 2) {
      result.middleName = spelledGroups.slice(1, -1).join(' ');
      result.hasMiddleName = true;
    }
  } else if (spelledGroups.length === 1) {
    const one = spelledGroups[0];

    if (/last\s+name|family\s+name|surname/i.test(raw)) {
      result.lastName = one;
    } else if (/first\s+name|given\s+name/i.test(raw)) {
      result.firstName = one;
    } else if (!result.firstName) {
      result.firstName = one;
    } else if (!result.lastName) {
      result.lastName = one;
    } else {
      result.firstName = one;
    }
  }

  const hasUsefulName =
    cleanWord(result.firstName).length >= 2 ||
    cleanWord(result.lastName).length >= 2;

  if (!hasUsefulName) return null;

  result.firstName = cleanWord(result.firstName);
  result.middleName = cleanWord(result.middleName);
  result.lastName = cleanWord(result.lastName);

  if (result.middleName === '') result.hasMiddleName = false;

  return result;
}

function analyzeWorkflowLocally(ctx, clientTranscript) {
  const state = ctx.state;

  if (state === WF_STATE.COLLECTING_ANSWER || state === WF_STATE.ASKING) {
    if (ctx.fieldKey === 'full_name') {
      const name = extractLocalFullName(clientTranscript);
      if (name) {
        return {
          fieldKey: ctx.fieldKey,
          action: 'request_spelling',
          interpretedAnswer: formatNameForSpeech(name),
          spokenConfirmation: '',
          isAnswerComplete: true,
          isAnswerValid: true,
          isConfirmed: false,
          confirmationStatus: 'unconfirmed',
          missingInformation: '',
          suggestedFollowUp: 'Could you please spell your first and last name slowly, letter by letter? You may say, for example, B as in Bravo.',
          normalizedValue: name,
          incorrectComponent: null,
          updatedComponents: Object.keys(name).filter(k => name[k]),
          reason: 'Handled locally: clear multi-part full name'
        };
      }
    }

    if (ctx.fieldKey === 'country_of_birth') {
      const country = extractLocalCountry(clientTranscript);
      if (country) {
        return {
          fieldKey: ctx.fieldKey,
          action: 'confirm_value',
          interpretedAnswer: country.country,
          spokenConfirmation: '',
          isAnswerComplete: true,
          isAnswerValid: true,
          isConfirmed: false,
          confirmationStatus: 'unconfirmed',
          missingInformation: '',
          suggestedFollowUp: '',
          normalizedValue: country,
          incorrectComponent: null,
          updatedComponents: ['country'],
          reason: 'Handled locally: clear country name'
        };
      }
    }
  }

  if (state === WF_STATE.COLLECTING_SPELLING) {
    const spelled = parseLocalSpelling(clientTranscript, ctx.structuredValue);

    if (spelled) {
      const changedComponents = ['firstName', 'middleName', 'lastName', 'hasMiddleName']
        .filter(key => spelled[key] !== undefined)
        .filter(key => spelled[key] !== ctx.structuredValue?.[key]);

      return {
        fieldKey: ctx.fieldKey,
        action: 'confirm_value',
        interpretedAnswer: formatNameForSpeech(spelled),
        spokenConfirmation: '',
        isAnswerComplete: true,
        isAnswerValid: true,
        isConfirmed: false,
        confirmationStatus: 'unconfirmed',
        missingInformation: '',
        suggestedFollowUp: '',
        normalizedValue: spelled,
        incorrectComponent: null,
        updatedComponents: changedComponents.length
          ? changedComponents
          : ['firstName', 'middleName', 'lastName'],
        reason: changedComponents.length
          ? 'Handled locally: spelling/correction extracted and applied'
          : 'Handled locally: spelling confirmed the existing name'
      };
    }
  }

  if (state === WF_STATE.CONFIRMING || state === WF_STATE.RECONFIRMING) {
    const confirmation = detectLocalConfirmation(clientTranscript);
    if (confirmation) {
      return {
        fieldKey: ctx.fieldKey,
        action: confirmation === 'confirmed' ? 'save_and_continue' : 'ask_incorrect_component',
        interpretedAnswer: clientTranscript,
        spokenConfirmation: '',
        isAnswerComplete: true,
        isAnswerValid: true,
        isConfirmed: confirmation === 'confirmed',
        confirmationStatus: confirmation,
        missingInformation: '',
        suggestedFollowUp: '',
        normalizedValue: {},
        incorrectComponent: null,
        updatedComponents: [],
        reason: 'Handled locally: explicit confirmation response'
      };
    }
  }

  if (state === WF_STATE.IDENTIFYING_INCORRECT) {
    const component = detectLocalIncorrectComponent(ctx, clientTranscript);
    if (component) {
      return {
        fieldKey: ctx.fieldKey,
        action: 'request_correction',
        interpretedAnswer: clientTranscript,
        spokenConfirmation: '',
        isAnswerComplete: true,
        isAnswerValid: true,
        isConfirmed: false,
        confirmationStatus: 'rejected',
        missingInformation: '',
        suggestedFollowUp: '',
        normalizedValue: {},
        incorrectComponent: component,
        updatedComponents: [],
        reason: 'Handled locally: explicit incorrect component'
      };
    }
  }

  return null;
}


// ── Workflow Step Runner ───────────────────────────────────────────────────
async function runWorkflowStep(
  question,
  clientTranscript,
  sttMeta,
  ctx,
  speakFn,
  listenFn,
  options = {}
) {
  ctx.rawTranscripts.push({ state: ctx.state, text: clientTranscript, ts: new Date().toISOString() });

  const useLocalAnalysis = options.useLocalAnalysis === true;
  let aiResult = null;

  // Conversation Engine uses LLM-only analysis. The browser must not decide
  // that a name, spelling, correction, or confirmation is valid by itself.
  if (useLocalAnalysis) {
    aiResult = analyzeWorkflowLocally(ctx, clientTranscript);
  }

  if (aiResult) {
    console.log('[Workflow] Local analysis:', aiResult.reason);
    avSetStatus('Answer understood locally ✓', '#22c55e');
  } else {
    avSetStatus('Analyzing with AI…', '#8b5cf6');

    if (
      ctx.state === WF_STATE.CONFIRMING ||
      ctx.state === WF_STATE.RECONFIRMING
    ) {
      // Confirmation is handled by a dedicated LLM classifier so a clear
      // "yes, it is correct" can never be mistaken for another spelling step.
      aiResult = await analyzeConfirmationOnly(clientTranscript, ctx);
    } else {
      aiResult = await analyzeAnswerUnified(
        question.question,
        question.expectedAnswer,
        clientTranscript,
        ctx,
        sttMeta
      );
    }
  }

  ctx.lastAiResult = aiResult;

  switch(ctx.state) {

    case WF_STATE.COLLECTING_ANSWER:
    case WF_STATE.ASKING: {
      ctx.answerAttempts++;
      if (!aiResult.isAnswerComplete || !aiResult.isAnswerValid) {
        const fu = aiResult.suggestedFollowUp || 'Could you please provide that information again?';
        await speakFn(fu);
        ctx.state = WF_STATE.COLLECTING_ANSWER;
        return { done: false, needListen: true };
      }
      const incomingValue = aiResult.normalizedValue || {};
      const nonEmptyIncoming = Object.fromEntries(
        Object.entries(incomingValue).filter(([, value]) =>
          value !== '' && value !== null && value !== undefined
        )
      );
      ctx.structuredValue = {
        ...ctx.structuredValue,
        ...nonEmptyIncoming
      };

      if (ctx.fieldKey === 'current_address') {
        ctx.structuredValue.country = 'Canada';
      }
      if (ctx.fieldKey === 'current_address') {
        const requiredAddressParts = (
          ctx.rules?.requiredComponents ||
          ['streetNumber', 'streetName', 'city', 'province', 'postalCode']
        ).filter(key => key !== 'country');

        const missingAddressParts = requiredAddressParts.filter(
          key => !String(ctx.structuredValue?.[key] || '').trim()
        );

        if (missingAddressParts.length > 0) {
          const labels = {
            streetNumber: 'street number',
            streetName: 'street name',
            city: 'city',
            province: 'province',
            postalCode: 'postal code'
          };

          const missingText = missingAddressParts
            .map(key => labels[key] || key)
            .join(', ');

          const followUp =
            missingAddressParts.length === 1
              ? `What is your ${missingText}?`
              : `Please provide the missing address details: ${missingText}.`;

          await speakFn(followUp);
          ctx.state = WF_STATE.COLLECTING_ANSWER;
          return { done: false, needListen: true };
        }
      }

      if (isSpellingRequired(ctx) && ctx.spellingAttempts === 0) {
        const spellQ = aiResult.suggestedFollowUp || 'Could you please spell your first and last name slowly, letter by letter? You may say, for example, B as in Bravo.';
        await speakFn(spellQ);
        ctx.state = WF_STATE.COLLECTING_SPELLING;
        return { done: false, needListen: true };
      }
      if (isConfirmationRequired(ctx)) {
        const conf = formatConfirmationSpeech(ctx);
        await speakFn(conf);
        ctx.state = WF_STATE.CONFIRMING;
        return { done: false, needListen: true };
      }
      ctx.isConfirmed = true;
      ctx.state = WF_STATE.CONFIRMED;
      return { done: true, confirmed: true };
    }

    case WF_STATE.COLLECTING_SPELLING: {
      ctx.spellingAttempts++;
      if (aiResult.normalizedValue && Object.keys(aiResult.normalizedValue).length > 0) {
        ctx.structuredValue = { ...ctx.structuredValue, ...(aiResult.normalizedValue || {}) };
      }
      const conf = formatConfirmationSpeech(ctx);
      await speakFn(conf);
      ctx.state = WF_STATE.CONFIRMING;
      return { done: false, needListen: true };
    }

    case WF_STATE.CONFIRMING:
    case WF_STATE.RECONFIRMING: {
      ctx.confirmationAttempts++;
      const cs = aiResult.confirmationStatus;
      if (cs === 'confirmed' || aiResult.action === 'save_and_continue') {
        ctx.isConfirmed = true;
        ctx.state = WF_STATE.CONFIRMED;
        return { done: true, confirmed: true };
      }
      if (cs === 'rejected' || aiResult.action === 'ask_incorrect_component') {
        // Name-specific flow:
        // Name -> spell full name -> read it back -> yes/no.
        // If the client says no, ask for the complete spelling again.
        if (ctx.fieldKey === 'full_name') {
          ctx.correctionAttempts++;

          if (ctx.correctionAttempts >= getMaxCorrections(ctx)) {
            ctx.requiresCaseworkerReview = true;
            ctx.state = WF_STATE.FAILED;
            await speakFn(
              'I was unable to confirm the spelling of your name. It will be flagged for caseworker review.'
            );
            return { done: true, confirmed: false, review: true };
          }

          await speakFn(
            'I am sorry. Please spell your first and last name again slowly, letter by letter. You may say, for example, B as in Bravo.'
          );
          ctx.state = WF_STATE.COLLECTING_SPELLING;
          return { done: false, needListen: true };
        }

        if (ctx.correctionAttempts >= getMaxCorrections(ctx)) {
          ctx.requiresCaseworkerReview = true;
          ctx.state = WF_STATE.FAILED;
          await speakFn('I was unable to confirm this information. It will be flagged for caseworker review.');
          return { done: true, confirmed: false, review: true };
        }

        const compQ = buildIncorrectComponentQuestion(ctx);
        await speakFn(compQ);
        ctx.state = WF_STATE.IDENTIFYING_INCORRECT;
        return { done: false, needListen: true };
      }
      await speakFn('Please say yes if that is correct, or no if something needs to be changed.');
      return { done: false, needListen: true };
    }

    case WF_STATE.IDENTIFYING_INCORRECT: {
      const comp = aiResult.incorrectComponent;
      if (comp) {
        ctx._pendingCorrectionComponent = comp;
        const corrQ = buildCorrectionQuestion(ctx, comp);
        await speakFn(corrQ);
        ctx.state = WF_STATE.COLLECTING_CORRECTION;
      } else {
        await speakFn('I did not catch which part is incorrect. Could you say it again?');
      }
      return { done: false, needListen: true };
    }

    case WF_STATE.COLLECTING_CORRECTION: {
      ctx.correctionAttempts++;
      const comp = ctx._pendingCorrectionComponent;
      const prev = ctx.structuredValue[comp] || '';
      const updated = aiResult.normalizedValue?.[comp] || aiResult.interpretedAnswer || '';
      if (updated) {
        ctx.correctionHistory.push({
          component: comp, previousValue: prev, newValue: updated,
          clientTranscript: clientTranscript, changedAt: new Date().toISOString()
        });
        ctx.structuredValue[comp] = updated;
        if (aiResult.updatedComponents?.length > 0 && aiResult.normalizedValue) {
          for (const c of aiResult.updatedComponents) {
            if (aiResult.normalizedValue[c] !== undefined) {
              ctx.structuredValue[c] = aiResult.normalizedValue[c];
            }
          }
        }
      }
      const reconf = formatConfirmationSpeech(ctx);
      await speakFn(reconf);
      ctx.state = WF_STATE.RECONFIRMING;
      return { done: false, needListen: true };
    }

    default:
      return { done: true, confirmed: false };
  }
}

function buildIncorrectComponentQuestion(ctx) {
  if (ctx.fieldKey === 'full_name') return 'Which part is incorrect: your first name, middle name, or last name?';
  if (ctx.fieldKey === 'country_of_birth') return 'What should I change your country of birth to?';
  if (ctx.fieldKey === 'current_address') return 'Which part is incorrect: the unit number, street address, city, province, or postal code?';
  return 'Which part is incorrect?';
}

function buildCorrectionQuestion(ctx, component) {
  if (ctx.fieldKey === 'full_name') {
    const map = { firstName:'first name', middleName:'middle name', lastName:'last name' };
    return `Please spell your ${map[component] || component}.`;
  }
  if (ctx.fieldKey === 'current_address') {
    const map = { unitNumber:'unit number', streetNumber:'street number', streetName:'street name', city:'city', province:'province', postalCode:'postal code' };
    return `What is your ${map[component] || component}?`;
  }
  return `What is the correct ${component}?`;
}

// ── Response badges helper ─────────────────────────────────────────────────
function getResponseBadges(resp) {
  const badges = [];
  if (resp.isConfirmed) badges.push('<span title="The client said yes when the answer was read back to them" style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600">✓ Confirmed</span>');
  if (resp.requiresCaseworkerReview) badges.push('<span style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600">⚠ Review Required</span>');
  if (resp.correctionAttempts > 0) badges.push(`<span style="background:#dbeafe;color:#2563eb;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600">✏ Corrected (${resp.correctionAttempts}×)</span>`);
  if (!resp.isConfirmed && !resp.requiresCaseworkerReview) badges.push('<span title="The answer was never read back to the client (e.g. saved before the confirmation step existed)" style="background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600">○ Unconfirmed</span>');
  if (resp.structuredValue && Object.keys(resp.structuredValue).length > 0) {
    badges.push(`<span style="background:#f0fdf4;color:#166534;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600">📋 Structured</span>`);
  }
  return badges.join(' ');
}

// ── WF Status Badge update ─────────────────────────────────────────────────
function updateWfStatusBadge(ctx) {
  const el = document.getElementById('av-wf-status');
  if (!el) return;
  const labels = {
    [WF_STATE.ASKING]:                'Asking question',
    [WF_STATE.COLLECTING_ANSWER]:     'Collecting answer',
    [WF_STATE.VALIDATING]:            'Validating',
    [WF_STATE.REQUEST_SPELLING]:      'Requesting spelling',
    [WF_STATE.COLLECTING_SPELLING]:   'Checking spelling',
    [WF_STATE.CONFIRMING]:            'Waiting for confirmation',
    [WF_STATE.IDENTIFYING_INCORRECT]: 'Identifying incorrect part',
    [WF_STATE.COLLECTING_CORRECTION]: 'Collecting correction',
    [WF_STATE.RECONFIRMING]:          'Reconfirming',
    [WF_STATE.CONFIRMED]:             'Confirmed and saved',
    [WF_STATE.FAILED]:                'Flagged for review'
  };
  el.textContent = labels[ctx.state] || ctx.state;
  el.style.color = ctx.state === WF_STATE.CONFIRMED ? '#16a34a' : ctx.state === WF_STATE.FAILED ? '#dc2626' : '#3b82f6';
}


// ── Workflow analysis panel ─────────────────────────────────────────────────
// Shows what the hybrid/local-or-GPT workflow understood after every response.
function avShowWorkflowAnalysis(ctx, latestTranscript) {
  const result = ctx?.lastAiResult || {};
  const box = document.getElementById('av-analysis-box');
  if (!box) return;

  box.style.display = 'block';

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '';
  };

  const setDisplay = (id, visible, displayValue = 'block') => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? displayValue : 'none';
  };

  const allTranscripts = (ctx.rawTranscripts || [])
    .map((t, i) => `[${i + 1}] ${t.text}`)
    .join('\n');

  setText('av-r-original', allTranscripts || latestTranscript || '');
  setText(
    'av-r-interpreted',
    result.interpretedAnswer ||
    formatWorkflowValueForDisplay(ctx) ||
    latestTranscript ||
    ''
  );

  // Show structured/normalized data in a readable form.
  const normalized =
    result.normalizedValue && Object.keys(result.normalizedValue).length
      ? result.normalizedValue
      : ctx.structuredValue;

  const hasNormalized = normalized && Object.keys(normalized).length > 0;
  setDisplay('av-r-normalized-wrap', hasNormalized);

  if (hasNormalized) {
    const el = document.getElementById('av-r-normalized');
    if (el) {
      el.innerHTML = Object.entries(normalized)
        .filter(([, value]) => value !== '' && value != null)
        .map(([key, value]) =>
          `<div style="display:grid;grid-template-columns:110px 1fr;gap:8px;margin-bottom:3px">
             <span style="color:var(--text-muted)">${esc(key)}</span>
             <strong>${esc(String(value))}</strong>
           </div>`
        )
        .join('');
    }
  }

  // Incomplete / status message.
  const incompleteWrap = document.getElementById('av-r-incomplete-wrap');
  if (incompleteWrap) {
    if (result.isAnswerComplete === false || result.isAnswerValid === false) {
      const missing =
        result.missingInformation ||
        result.reason ||
        'The answer needs clarification.';
      incompleteWrap.style.display = 'block';
      incompleteWrap.innerHTML =
        `<div class="a-warning">⚠️ <div><strong>Incomplete:</strong> ${esc(missing)}</div></div>`;
    } else if (ctx.isConfirmed) {
      incompleteWrap.style.display = 'block';
      incompleteWrap.innerHTML =
        `<div style="color:#15803d;font-size:12px;font-weight:600">✓ Confirmed and saved</div>`;
    } else {
      incompleteWrap.style.display = 'block';
      incompleteWrap.innerHTML =
        `<div style="color:#2563eb;font-size:12px">✓ Answer understood — waiting for the next verification step</div>`;
    }
  }

  // Show exactly what the assistant is about to ask next.
  const nextPrompt =
    result.suggestedFollowUp ||
    result.spokenConfirmation ||
    getWorkflowNextPromptPreview(ctx);

  setDisplay('av-r-followup-wrap', !!nextPrompt);
  setText('av-r-followup', nextPrompt || '');

  const correction = document.getElementById('av-corrected-answer');
  if (correction) {
    correction.value =
      formatWorkflowValueForDisplay(ctx) ||
      result.interpretedAnswer ||
      latestTranscript ||
      '';
  }
}

// Final saved value of a structured workflow answer. Shared by Client Intake and
// the Virtual Caseworker (it used to live only in client-intake.js, so saving an
// address on the Virtual Caseworker page failed with "not defined").
function buildStrictFinalWorkflowAnswer(ctx) {
  const value = ctx?.structuredValue || {};

  if (ctx?.fieldKey === 'full_name') {
    // Final answer must contain only first and last name.
    return [value.firstName, value.lastName]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (ctx?.fieldKey === 'country_of_birth') {
    return String(value.country || '').trim();
  }

  if (ctx?.fieldKey === 'current_address') {
    return formatAddressForSpeech(value);
  }

  return formatWorkflowValueForDisplay(ctx) ||
    ctx?.lastAiResult?.interpretedAnswer ||
    '';
}

function formatWorkflowValueForDisplay(ctx) {
  if (!ctx) return '';
  const value = ctx.structuredValue || {};

  if (ctx.fieldKey === 'full_name') {
    return formatNameForSpeech(value);
  }
  if (ctx.fieldKey === 'country_of_birth') {
    return value.country || '';
  }
  if (ctx.fieldKey === 'current_address') {
    return formatAddressForSpeech(value);
  }

  return ctx.lastAiResult?.interpretedAnswer || '';
}

function getWorkflowNextPromptPreview(ctx) {
  if (!ctx) return '';

  switch (ctx.state) {
    case WF_STATE.COLLECTING_SPELLING:
      return ctx.correctionAttempts > 0
        ? 'Please spell your full name again, letter by letter.'
        : 'Could you please spell your first and last name slowly, letter by letter? You may say, for example, B as in Bravo.';
    case WF_STATE.CONFIRMING:
    case WF_STATE.RECONFIRMING:
      return formatConfirmationSpeech(ctx);
    case WF_STATE.IDENTIFYING_INCORRECT:
      return buildIncorrectComponentQuestion(ctx);
    case WF_STATE.COLLECTING_CORRECTION:
      return buildCorrectionQuestion(ctx, ctx._pendingCorrectionComponent || '');
    case WF_STATE.CONFIRMED:
      return '';
    case WF_STATE.FAILED:
      return 'The information will be flagged for caseworker review.';
    default:
      return ctx.lastAiResult?.suggestedFollowUp || '';
  }
}



// ── Language switching inside structured workflows ─────────────────────────
// The regular interview path already checks language-change intent, but
// full name, country, and address use avRunWorkflowQuestion(). This helper
// makes "speak Persian/French/English" work during any workflow state,
// including spelling, confirmation, and correction.
async function avHandleWorkflowLanguageIntent(sttResult, q) {
  if (!sttResult?.text) return { handled: false, sttResult };

  const intent = await detectIntent(sttResult.text, _avSession.language);

  if (
    intent.intent !== 'change_language' ||
    !intent.targetLanguage ||
    !LANGUAGE_CONFIG[intent.targetLanguage]
  ) {
    return { handled: false, sttResult };
  }

  const toLang = intent.targetLanguage;
  const fromLang = _avSession.language;

  _avLangAudit.push({
    eventType: 'language_changed',
    fromLanguage: fromLang,
    toLanguage: toLang,
    originalTranscript: sttResult.text,
    workflowState: _wfCtx?.state || null,
    timestamp: new Date().toISOString()
  });

  _avSession.language = toLang;
  updateLangIndicator(toLang);

  avSetStatus('Switching language…', '#8b5cf6');

  // Confirm the switch in the requested language.
  await avSpeakLocalized(LANGUAGE_CONFIG[toLang].confirmation, toLang);
  await waitForAvatarSilence(700, 15000, 800);

  // Repeat the prompt appropriate to the CURRENT workflow state rather
  // than always repeating the original question.
  let promptEn = q.question;

  if (_wfCtx) {
    switch (_wfCtx.state) {
      case WF_STATE.COLLECTING_SPELLING:
        promptEn = _wfCtx.correctionAttempts > 0
          ? 'Please spell your full name again, letter by letter.'
          : 'Could you please spell your first and last name slowly, letter by letter? You may say, for example, B as in Bravo.';
        break;

      case WF_STATE.CONFIRMING:
      case WF_STATE.RECONFIRMING:
        promptEn = formatConfirmationSpeech(_wfCtx);
        break;

      case WF_STATE.IDENTIFYING_INCORRECT:
        promptEn = buildIncorrectComponentQuestion(_wfCtx);
        break;

      case WF_STATE.COLLECTING_CORRECTION:
        promptEn = buildCorrectionQuestion(
          _wfCtx,
          _wfCtx._pendingCorrectionComponent || ''
        );
        break;

      case WF_STATE.COLLECTING_ANSWER:
      case WF_STATE.ASKING:
      default:
        promptEn = q.question;
        break;
    }
  }

  const translatedPrompt = await translateInterviewText(
    promptEn,
    toLang,
    'workflow_prompt'
  );

  const qText = document.getElementById('av-q-text');
  if (qText) qText.textContent = translatedPrompt || promptEn;
  updateTextDirection(toLang);

  avSetStatus('Repeating in selected language…', '#8b5cf6');
  await avSpeakLocalized(translatedPrompt || promptEn, toLang);
  await waitForAvatarSilence(700, 20000, 800);

  avSetStatus('Listening…', '#dc2626');
  const nextStt = await avListen(20000, 3000, toLang);

  return {
    handled: true,
    sttResult: nextStt
  };
}

async function avResolveWorkflowLanguageSwitch(sttResult, q) {
  let current = sttResult;
  let switchCount = 0;

  // Allow a second switch, for example Persian -> French, without looping
  // forever if recognition repeatedly returns the same language command.
  while (current?.text && switchCount < 2) {
    const outcome = await avHandleWorkflowLanguageIntent(current, q);
    if (!outcome.handled) return current;

    switchCount++;
    current = outcome.sttResult;
  }

  return current;
}


// ── avRunWorkflowQuestion — structured interview with state machine ─────────
async function avRunWorkflowQuestion(q) {
  _wfCtx = createWfCtx(q);
  _wfCtx.state = WF_STATE.COLLECTING_ANSWER;

  // Reset the visible answer and analysis boxes for the new workflow question.
  const answerBox = document.getElementById('av-answer');
  if (answerBox) answerBox.value = '';

  const analysisBox = document.getElementById('av-analysis-box');
  if (analysisBox) analysisBox.style.display = 'none';

  const translated = await translateInterviewText(q.question, _avSession.language, 'question');
  avSetStatus('Asking question…', '#3b82f6');
  await avSpeakLocalized(translated || q.question, _avSession.language);
  await waitForAvatarSilence(700, 20000, 1000);
  avSetStatus('Listening…', '#dc2626');

  let continueLoop = true;
  while (continueLoop) {
    let stt = await avListen(20000, 3000, _avSession.language);

    // A language command is not an answer to the current question.
    // Switch language, repeat the current workflow prompt, and capture
    // the actual answer in the newly selected language.
    stt = await avResolveWorkflowLanguageSwitch(stt, q);

    if (!stt || !stt.text) {
      const retryMsg = 'I did not hear a response. Could you please answer the question?';
      const retryT = await translateInterviewText(retryMsg, _avSession.language, 'followUp');
      avSetStatus('Repeating question…', '#f59e0b');
      await avSpeakLocalized(retryT || retryMsg, _avSession.language);
      await waitForAvatarSilence(700, 15000, 800);
      avSetStatus('Listening…', '#dc2626');

      let stt2 = await avListen(20000, 3000, _avSession.language);
      stt2 = await avResolveWorkflowLanguageSwitch(stt2, q);

      if (!stt2?.text) break;
      continueLoop = await _avWorkflowHandleTranscript(q, stt2.text, stt2);
    } else {
      continueLoop = await _avWorkflowHandleTranscript(q, stt.text, stt);
    }
  }

  const saved = buildWorkflowResponse(q, _wfCtx);
  _avWorkflowAutoSave(saved);
  updateWfStatusBadge(_wfCtx);

  // Automatically move to the next interview question after the workflow
  // finishes successfully. Previously the response was saved, but the
  // interview index never advanced, so the UI remained on the same question.
  if (_wfCtx.state === WF_STATE.CONFIRMED && _avInterview.active) {
    avSetStatus('Confirmed — moving to the next question…', '#22c55e');

    // Give the client a brief visual pause to see the confirmed result.
    await sleep(700);

    _avCurrentAnalysis = null;
    _avTranscripts = [];
    _avInterview.index++;

    const nextBtn = document.getElementById('av-btn-next');
    const repeatBtn = document.getElementById('av-btn-repeat');
    if (nextBtn) nextBtn.disabled = true;
    if (repeatBtn) repeatBtn.disabled = true;

    await avAskCurrentQuestion();
  }
}

async function _avWorkflowHandleTranscript(q, text, stt) {
  const ctx = _wfCtx;

  // Immediately show every recognized client response in the answer box.
  // Workflow questions such as full name, country of birth, and address use
  // this function instead of avRunQuestion(), so without this update the
  // transcript was analyzed but never displayed to the user.
  const answerBox = document.getElementById('av-answer');
  if (answerBox && text) {
    const previous = answerBox.value.trim();
    answerBox.value = previous ? `${previous}\n${text.trim()}` : text.trim();
    answerBox.scrollTop = answerBox.scrollHeight;
    answerBox.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const speakFn = async (msg) => {
    const t = await translateInterviewText(msg, _avSession.language, 'followUp');
    avSetStatus('Avatar speaking…', '#3b82f6');
    await avSpeakLocalized(t || msg, _avSession.language);
    await waitForAvatarSilence(700, 20000, 800);
    avSetStatus('Listening…', '#dc2626');
  };

  const result = await runWorkflowStep(
    q,
    text,
    stt,
    ctx,
    speakFn,
    null,
    { useLocalAnalysis: true }
  );
  updateWfStatusBadge(ctx);

  // Display the transcript, interpretation, structured value, completeness,
  // and next verification/follow-up step for both local and GPT analysis.
  avShowWorkflowAnalysis(ctx, text);

  if (result.done) return false;
  return true;
}

function buildWorkflowResponse(q, ctx) {
  return {
    questionId:           q.id,
    question:             q.question,
    category:             q.category || 'General',
    type:                 q.type || 'open',
    fieldKey:             ctx.fieldKey,
    structuredValue:      ctx.structuredValue,
    isAnswerComplete:     true,
    isAnswerValid:        true,
    isConfirmed:          ctx.isConfirmed,
    confirmationStatus:   ctx.isConfirmed ? 'confirmed' : (ctx.requiresCaseworkerReview ? 'review' : 'unconfirmed'),
    confirmationAttempts: ctx.confirmationAttempts,
    correctionAttempts:   ctx.correctionAttempts,
    incorrectComponents:  ctx.correctionHistory.map(c => c.component),
    correctionHistory:    ctx.correctionHistory,
    requiresCaseworkerReview: ctx.requiresCaseworkerReview,
    rawTranscripts:       ctx.rawTranscripts,
    confirmedAt:          ctx.isConfirmed ? new Date().toISOString() : null,
    originalClientAnswer: ctx.rawTranscripts[0]?.text || '',
    aiInterpretedAnswer:  ctx.lastAiResult?.interpretedAnswer || '',
    language:             _avSession.language,
    answeredAt:           new Date().toISOString()
  };
}

function _avWorkflowAutoSave(response) {
  const rs = loadResponses();
  const idx = rs.findIndex(r => r.questionId === response.questionId);
  if (idx >= 0) rs[idx] = response; else rs.push(response);
  persistResponses(rs);
}

async function analyzeAnswer(question, expectedAnswer, clientAnswer, sttMeta = null, answerLanguage = 'en-US', validation = null, answerType = null, clarificationDefinition = '') {
  // sttMeta: { confidence, lexical, alternatives } from detailed STT output
  let sttBlock = '';
  if (sttMeta) {
    const confPct = sttMeta.confidence != null ? Math.round(sttMeta.confidence * 100) + '%' : 'N/A';
    sttBlock = `
Speech recognition confidence: ${confPct}
Lexical (phonetic) form: ${sttMeta.lexical || '(none)'}
NBest alternatives (ranked by confidence):
${(sttMeta.alternatives || []).map((a, i) =>
  `  ${i + 1}. "${a.display}" [lexical: "${a.lexical}", confidence: ${Math.round((a.confidence || 0) * 100)}%]`
).join('\n') || '  (none)'}`;
  }
  const langNote = answerLanguage && answerLanguage !== 'en-US'
    ? `\nAnswer language: ${answerLanguage} — understand the answer in this language and produce English interpretation.`
    : '';
  const validationRules = validation && typeof validation === 'object' ? validation : {};
  const userMsg = `Question (in English): ${question}
Answer type: ${answerType || 'open'}
Expected answer type/format: ${expectedAnswer || 'open text'}
Question definition/clarification (use only to explain the original meaning; never introduce alternatives): ${clarificationDefinition || '(not supplied — preserve the ordinary meaning of the original question exactly)'}
Validation metadata (authoritative; do not weaken it): ${JSON.stringify(validationRules)}
Today's date (YYYY-MM-DD): ${todayIsoDate()}
Primary transcript (language: ${answerLanguage}): ${clientAnswer}${langNote}${sttBlock}

Analyze and return JSON.`;
  return callGPT(SYSTEM_ANALYZE_ANSWER, userMsg, true);
}

// ── Deterministic answer validation + read-back (shared) ───────────────────
// The LLM decides completeness; these checks catch impossible values it may
// still accept (e.g. a date of birth in the future) and build the
// "Is that correct?" read-back used before an answer is saved.

function todayIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseIsoDateParts(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

function formatIsoDateForSpeech(value) {
  const p = parseIsoDateParts(value);
  if (!p || p.month < 1 || p.month > 12) return String(value || '');
  return `${p.day} ${MONTH_NAMES_EN[p.month - 1]} ${p.year}`;
}

function isBirthDateQuestion(q) {
  return /\b(birth|born|dob)\b/i.test(`${q?.question || ''} ${q?.expectedAnswer || ''}`);
}

// Questions whose date may legitimately be in the future (expiry, plans…).
function isFutureDateAllowed(q) {
  return /expir|valid\s+(until|through|to)|\buntil\b|end\s+date|planned|plan\s+to|intend|\bwill\b|future|upcoming|\bnext\b/i
    .test(`${q?.question || ''} ${q?.expectedAnswer || ''}`);
}

function isPersonNameQuestion(q) {
  const text = String(q?.question || '');
  if (q?.type === 'name') return true;
  if (['yes_no', 'boolean', 'number', 'date', 'address', 'choice'].includes(q?.type)) return false;
  if (/^\s*(have|has|did|do|does|are|is|were|was)\b/i.test(text)) return false;
  if (/(company|employer|school|business|organi[sz]ation|institution|street|city|program|course|user\s*name|file)\s+name/i.test(text)) return false;
  return /\bname\b/i.test(text);
}

function answerValueAsText(result) {
  const v = result?.normalizedValue;
  if (v && typeof v === 'object') {
    return Object.values(v).filter(x => x !== '' && x != null).join(' ').trim();
  }
  return String(v || result?.interpretedAnswer || '').trim();
}

// Returns { ok: true } or { ok: false, message, followUp } (English).
function validateIntakeAnswerValue(q, result) {
  const value = answerValueAsText(result);
  const parts = parseIsoDateParts(value);

  if (!parts) {
    if (q?.type === 'date' && value) {
      return {
        ok: false,
        message: `The date "${value}" is not a complete day, month, and year.`,
        followUp: 'Could you please tell me the full date — the day, the month, and the year?'
      };
    }
    return { ok: true };
  }

  const { year, month, day } = parts;
  const dt = new Date(year, month - 1, day);
  const isRealDate = dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day;
  if (!isRealDate) {
    return {
      ok: false,
      message: `"${value}" is not a real calendar date.`,
      followUp: 'That date does not exist on the calendar. Could you please repeat the date — the day, the month, and the year?'
    };
  }

  const spoken = formatIsoDateForSpeech(value);
  const today = todayIsoDate();
  const birth = isBirthDateQuestion(q);

  if (value > today && !isFutureDateAllowed(q)) {
    return {
      ok: false,
      message: birth
        ? `Date of birth ${spoken} is in the future.`
        : `${spoken} is in the future, but this question asks about a past date.`,
      followUp: birth
        ? `I heard ${spoken}, but a date of birth cannot be in the future. Could you please tell me your date of birth again — the day, the month, and the year?`
        : `I heard ${spoken}, but that date is in the future. Could you please tell me the correct date — the day, the month, and the year?`
    };
  }

  if (birth && year < new Date().getFullYear() - 120) {
    return {
      ok: false,
      message: `Date of birth ${spoken} is more than 120 years ago.`,
      followUp: `I heard ${spoken}, which does not seem right for a date of birth. Could you please tell me your date of birth again — the day, the month, and the year?`
    };
  }

  return { ok: true };
}

// English read-back asked before saving: { value, prompt }.
function buildAnswerReadback(q, result) {
  const value = answerValueAsText(result);
  if (parseIsoDateParts(value)) {
    const spoken = formatIsoDateForSpeech(value);
    return { value, prompt: `I have the date as ${spoken}. Is that correct?` };
  }
  if (isPersonNameQuestion(q) && /[A-Za-z]/.test(value)) {
    const spelled = value.split(/\s+/).filter(Boolean).map(spellWord).join(', ');
    return { value, prompt: `I have the name as ${value}, spelled ${spelled}. Is that correct?` };
  }
  return { value, prompt: `I have your answer as: ${value}. Is that correct?` };
}

// ─────────────────────────────────────────────────────────────
// QUESTION ENGINE — UI
// ─────────────────────────────────────────────────────────────
let _selectedFiles = [];

function escapeUploadLabel(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function onFileSelect(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  addSelectedFiles(files);
  // Allow choosing the same file again later if needed.
  input.value = '';
}

function onDragOver(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.add('drag-over');
}

function onDragLeave() {
  document.getElementById('upload-zone').classList.remove('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.remove('drag-over');
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  addSelectedFiles(files);
}

function addSelectedFiles(files) {
  const supported = [];
  const unsupported = [];

  for (const f of files) {
    if (isSupportedDocument(f)) supported.push(f);
    else unsupported.push(f.name);
  }

  if (unsupported.length) {
    toast(`Unsupported file type: ${unsupported.join(', ')}`, 'error');
  }

  if (!supported.length) return;

  // Avoid accidental duplicates based on name + size + lastModified.
  const existing = new Set(_selectedFiles.map(f => `${f.name}|${f.size}|${f.lastModified}`));
  for (const f of supported) {
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    if (!existing.has(key)) {
      _selectedFiles.push(f);
      existing.add(key);
    }
  }

  renderSelectedFiles();
}

function renderSelectedFiles() {
  const indicator = document.getElementById('file-indicator');
  const label = document.getElementById('file-name-label');

  if (!_selectedFiles.length) {
    indicator.style.display = 'none';
    label.innerHTML = '';
    document.getElementById('btn-generate').disabled = true;
    document.getElementById('btn-clear-file').style.display = 'none';
    stepState('step-upload', null);
    return;
  }

  indicator.style.display = 'flex';
  indicator.style.alignItems = 'flex-start';
  label.innerHTML = _selectedFiles.map((f, i) => {
    const kb = (f.size / 1024).toFixed(1);
    return `<div style="margin:2px 0">${i + 1}. ${escapeUploadLabel(f.name)} <span style="opacity:.7">(${kb} KB)</span></div>`;
  }).join('');

  document.getElementById('btn-generate').disabled = false;
  document.getElementById('btn-clear-file').style.display = 'inline-flex';
  document.getElementById('engine-result').style.display = 'none';
  stepState('step-upload', 'step-done', `${_selectedFiles.length} file${_selectedFiles.length === 1 ? '' : 's'} selected`);
}

// Animated show/hide of the upload area on the Question Engine page.
// No-op on pages without it.
function setUploadAreaCollapsed(collapsed) {
  const el = document.getElementById('upload-collapsible');
  if (!el) return;
  el.classList.toggle('is-collapsed', !!collapsed);
  el.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
  const clearBtn = document.getElementById('btn-clear-file');
  if (clearBtn) clearBtn.innerHTML = collapsed ? '↺ Upload another document' : '✕ Clear';
}

function clearFile() {
  setUploadAreaCollapsed(false);
  _selectedFiles = [];
  document.getElementById('document-input').value = '';
  document.getElementById('file-indicator').style.display = 'none';
  document.getElementById('file-name-label').innerHTML = '';
  document.getElementById('btn-generate').disabled = true;
  document.getElementById('btn-clear-file').style.display = 'none';
  document.getElementById('engine-result').style.display = 'none';
  document.getElementById('log-console').style.display = 'none';
  document.getElementById('engine-status').textContent = '';
  resetPipelineStatus();
  ['step-upload','step-di','step-gpt','step-save'].forEach(id => stepState(id, null));
}

async function runPipeline() {
  if (!_selectedFiles.length) return;

  // The technical log is no longer part of the normal UI. It still collects
  // messages; add ?debug to the page URL to show it while troubleshooting.
  _logEl = document.getElementById('log-console');
  _logEl.innerHTML = '';
  _logEl.style.display = new URLSearchParams(location.search).has('debug') ? 'block' : 'none';

  const btnGen   = document.getElementById('btn-generate');
  const statusEl = document.getElementById('engine-status');

  btnGen.disabled    = true;
  btnGen.innerHTML   = '<span class="spinner"></span> Processing…';
  statusEl.textContent = '';
  document.getElementById('engine-result').style.display = 'none';
  const engineCard = document.getElementById('engine-card');
  if (engineCard) engineCard.classList.add('is-working');   // neon blue border ON

  const selectedCaption = `${_selectedFiles.length} file${_selectedFiles.length === 1 ? '' : 's'} selected`;
  resetPipelineStatus();

  try {
    // Step 0 — Upload: the file really is being sent to the document service now
    stepState('step-upload', 'step-active', 'Uploading…');
    setPipelinePhase('upload');

    // Step 1 — Google Document AI
    // Fires once, as soon as the first upload has been accepted: upload is finished,
    // extraction has genuinely begun. (Later files in a batch stay in this stage.)
    let extractionStarted = false;
    const onUploadAccepted = () => {
      if (extractionStarted) return;
      extractionStarted = true;
      stepState('step-upload', 'step-done', selectedCaption);
      stepState('step-di', 'step-active', 'Reading documents…');
      setPipelinePhase('extract');
    };

    const extractedDocuments = [];
    for (let i = 0; i < _selectedFiles.length; i++) {
      const file = _selectedFiles[i];
      logLine(`Reading ${i + 1}/${_selectedFiles.length}: ${file.name}`, 'info');
      const content = await analyzeWithDI(file, { onUploadAccepted });
      extractedDocuments.push(`\n\n===== DOCUMENT ${i + 1}: ${file.name} =====\n\n${content}`);
    }
    const markdown = extractedDocuments.join('\n');
    stepState('step-di', 'step-done', `${_selectedFiles.length} document${_selectedFiles.length === 1 ? '' : 's'} extracted`);

    // Step 2 — Gemini strict question extraction
    stepState('step-gpt', 'step-active', 'Finding questions…');
    setPipelinePhase('analyze');
    logLine('Sending content to Gemini for strict question extraction…', 'info');
    const gptResult = await generateQuestionsFromContent(markdown);
    stepState('step-gpt', 'step-done', 'Questions found');

    const questions = (gptResult.questions || []).map(q => ({ ...q, id: uid() }));
    logLine(`✓ ${questions.length} questions extracted.`, 'success');

    // Step 3 — Save
    stepState('step-save', 'step-active', 'Saving questions…');
    setPipelinePhase('save');
    persistQuestions(questions);
    stepState('step-save', 'step-done', 'Saved');
    setPipelinePhase('done');
    logLine(`✓ Saved ${questions.length} questions to localStorage.`, 'success');

    // Show results
    renderEnginePreview(questions);
    document.getElementById('engine-result').style.display = 'block';
    statusEl.textContent = `✓ ${questions.length} questions extracted and saved.`;
    toast(`${questions.length} questions saved to Question Bank!`, 'success');
    // Fold the upload area away (animated) now that the question bank is ready.
    setTimeout(() => setUploadAreaCollapsed(true), 650);

  } catch (err) {
    logLine('ERROR: ' + err.message, 'error');
    setPipelinePhase('error');
    statusEl.textContent = '';      // the status line under the pipeline carries the message
    toast(err.message.substring(0, 100), 'error');
    ['step-di','step-gpt','step-save'].forEach(id => stepState(id, null));
    // The file is still selected; if the failure happened mid-upload, don't leave Upload pulsing.
    stepState('step-upload', 'step-done', selectedCaption);
  } finally {
    btnGen.disabled  = false;
    btnGen.innerHTML = '✨ Generate Questions';
    if (engineCard) engineCard.classList.remove('is-working'); // neon blue border OFF
  }
}

function renderEnginePreview(questions) {
  const list = document.getElementById('engine-result-list');
  const show5 = questions.slice(0, 5);
  list.innerHTML = show5.map((q, i) => questionCardHTML(q, i + 1, false)).join('');
  if (questions.length > 5) {
    list.innerHTML += `<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:13px">
      … and ${questions.length - 5} more questions in the Question Bank
    </div>`;
  }
}

// ─────────────────────────────────────────────────────────────
// QUESTION BANK — UI
// ─────────────────────────────────────────────────────────────
const TYPE_BADGE  = { open:'badge-blue', yesno:'badge-green', date:'badge-purple', number:'badge-orange', choice:'badge-gray', address:'badge-blue' };
const PRI_BADGE   = { high:'badge-red', medium:'badge-orange', low:'badge-gray' };

function questionCardHTML(q, num, withActions) {
  const tb = TYPE_BADGE[q.type]     || 'badge-gray';
  const pb = PRI_BADGE[q.priority]  || 'badge-gray';
  const reqBadge = q.required ? '<span class="badge badge-red">Required</span>' : '';
  const hint     = q.expectedAnswer
    ? `<span style="font-size:11.5px;color:var(--text-muted)">💡 ${esc(q.expectedAnswer.substring(0,70))}${q.expectedAnswer.length>70?'…':''}</span>`
    : '';
  const actions  = withActions ? `
    <div class="q-actions">
      <button class="btn btn-secondary btn-sm" onclick="startEditQ('${q.id}')">✏️</button>
      <button class="btn btn-danger btn-sm"    onclick="deleteQ('${q.id}')">🗑</button>
    </div>` : '';

  return `
    <div class="question-card" id="qcard-${q.id}">
      <div class="q-card-header">
        <div class="q-num">${num}</div>
        <div class="q-text" id="qtext-${q.id}">${esc(q.question)}</div>
        ${actions}
      </div>
      <div class="q-meta">
        <span class="badge badge-gray">${esc(q.category||'General')}</span>
        <span class="badge ${tb}">${q.type||'open'}</span>
        <span class="badge ${pb}">${q.priority||'medium'}</span>
        ${reqBadge}
        ${hint}
      </div>
    </div>`;
}

function renderQuestionBank() {
  const qs = loadQuestions();
  const el = document.getElementById('question-bank-content');

  if (!qs.length) {
    el.innerHTML = `<div class="card"><div class="empty-state">
      <div class="ei">📋</div>
      <h3>No questions yet</h3>
      <p>Upload a document in Question Engine to generate questions.</p>
      <button class="btn btn-primary" style="margin-top:16px" onclick="show('question-engine')">Go to Question Engine</button>
    </div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="card">
      <div class="row-between" style="margin-bottom:12px">
        <span style="font-size:13px;color:var(--text-muted)">${qs.length} question${qs.length!==1?'s':''} saved</span>
      </div>
      <div class="question-list" id="qbank-list">
        ${qs.map((q,i) => questionCardHTML(q, i+1, true)).join('')}
      </div>
    </div>`;
}

function startEditQ(id) {
  const qs = loadQuestions();
  const q  = qs.find(x => x.id === id);
  if (!q) return;
  document.getElementById('edit-q-id').value       = id;
  document.getElementById('edit-q-textarea').value = q.question;
  document.getElementById('edit-q-hint').value     = q.expectedAnswer || '';
  const modal = document.getElementById('edit-q-modal');
  modal.style.display = 'flex';
  document.getElementById('edit-q-textarea').focus();
}

function closeEditModal() {
  const modal = document.getElementById('edit-q-modal');   // only exists on Question Bank
  if (modal) modal.style.display = 'none';
}

function saveEditQ() {
  const id      = document.getElementById('edit-q-id').value;
  const newText = document.getElementById('edit-q-textarea').value.trim();
  const newHint = document.getElementById('edit-q-hint').value.trim();
  if (!newText) { toast('Question text cannot be empty', 'error'); return; }
  const qs = loadQuestions();
  const q  = qs.find(x => x.id === id);
  if (q) {
    q.question       = newText;
    q.expectedAnswer = newHint;
    persistQuestions(qs);
    toast('Question updated ✓', 'success');
  }
  closeEditModal();
  renderQuestionBank();
}

// Close modal on backdrop click
document.addEventListener('click', e => {
  const modal = document.getElementById('edit-q-modal');
  if (modal && e.target === modal) closeEditModal();
});
// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeEditModal();
});

function deleteQ(id) {
  if (!confirm('Delete this question?')) return;
  persistQuestions(loadQuestions().filter(x => x.id !== id));
  renderQuestionBank();
  toast('Question deleted', 'info');
}

function clearAllQuestions() {
  if (!confirm('Clear all questions? This cannot be undone.')) return;
  persistQuestions([]);
  renderQuestionBank();
  toast('All questions cleared', 'info');
}

// ─────────────────────────────────────────────────────────────
// CLIENT INTAKE PAGE RUNTIME
// ─────────────────────────────────────────────────────────────
// Moved to js/client-intake.js. Shared analysis/workflow helpers remain here.

// ─────────────────────────────────────────────────────────────
// RESPONSE AUDIT / MAPPING HELPERS
// ─────────────────────────────────────────────────────────────
function responseSpeech(r) {
  if (r.detectedClientSpeech) return String(r.detectedClientSpeech).trim();

  if (Array.isArray(r.rawTranscripts) && r.rawTranscripts.length) {
    return r.rawTranscripts
      .map(x => x?.text || '')
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (Array.isArray(r.transcripts) && r.transcripts.length) {
    return r.transcripts
      .filter(x => !x?.eventType)
      .map(x => x?.text || '')
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  return String(r.originalClientAnswer || r.originalAnswer || '').trim();
}

// ── English translation of a saved answer ──────────────────────────────────
// Structured (workflow) answers end with a yes/no confirmation step, whose AI
// result has no translation, so their saved "English Translation" used to be
// the last reply only ("درست هستش"). After saving, all of the client's words
// for the question are translated and the saved record is updated.
const SYSTEM_TRANSLATE_CLIENT_SPEECH = `You translate a client's spoken answers from an immigration intake interview into English.
Translate faithfully and completely. Keep names, street names, numbers, dates and postal codes exactly as given.
Do not add, explain, summarize or correct anything. If the text is already English, return it unchanged.
Return JSON: {"englishTranslation": string}`;

async function translateClientSpeechToEnglish(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (!/[^\x00-\x7F]/.test(clean)) return clean;   // plain ASCII: already English

  // Direct request with low thinking: ~2-3 s instead of ~8 s through callGPT().
  const s = loadSettings();
  const model = (s.geminiModel || GEMINI_DEFAULT_MODEL).trim();
  const res = await fetch('/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: s.gcpProjectId,
      location: s.geminiLocation || 'global',
      model,
      credentialsFile: s.gcpCredentialsFile || 'google-service-account.json',
      request: {
        systemInstruction: { parts: [{ text: SYSTEM_TRANSLATE_CLIENT_SPEECH }] },
        contents: [{ role: 'user', parts: [{ text: `Client's words:\n${clean}` }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          thinkingConfig: /^gemini-3/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: 0 }
        }
      }
    })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
  const out = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  return String(out?.englishTranslation || '').trim();
}

// Question ids whose English translation is being made right now (shown as
// "Translating..." on the Responses page).
const _translationPending = new Set();

// Translates in the background and patches the saved response, so saving and
// moving to the next question are not delayed.
function updateSavedResponseTranslation(questionId, speech) {
  const clean = String(speech || '').trim();
  if (!questionId || !clean) return;
  const refresh = () => {
    if (document.getElementById('responses-content') && typeof renderResponses === 'function') renderResponses();
  };
  _translationPending.add(questionId);
  translateClientSpeechToEnglish(clean).then(translation => {
    _translationPending.delete(questionId);
    if (!translation) { refresh(); return; }
    const rs = loadResponses();
    const r = rs.find(x => x.questionId === questionId);
    if (!r || String(r.detectedClientSpeech || '').trim() !== clean) return;   // answer changed meanwhile
    r.englishTranslation = translation;
    r.englishInterpretation = translation;
    persistResponses(rs);
    refresh();
  }).catch(e => {
    _translationPending.delete(questionId);
    console.warn('[Translation] Could not translate the saved answer:', e.message || e);
    refresh();
  });
}

// Repairs answers saved before the fix above: an "English Translation" that
// still contains Persian/Arabic script is translated again (once per page load).
const _translationRepairRequested = new Set();
function repairSavedTranslations(responses) {
  (responses || []).forEach(r => {
    const speech = String(r.detectedClientSpeech || '').trim();
    const current = String(r.englishTranslation || '');
    if (!r.questionId || !speech || _translationRepairRequested.has(r.questionId)) return;
    if (!/[؀-ۿ]/.test(current) && current) return;      // already English
    if (!/[^\x00-\x7F]/.test(speech)) return;                       // nothing to translate
    _translationRepairRequested.add(r.questionId);
    updateSavedResponseTranslation(r.questionId, speech);
  });
}

function responseEnglishTranslation(r) {
  return String(
    r.englishTranslation ||
    r.englishInterpretation ||
    r.aiInterpretedAnswer ||
    responseSpeech(r) ||
    ''
  ).trim();
}

function responseMappingExplanation(r) {
  const explicit = String(
    r.mappingExplanation ||
    r.aiMappingExplanation ||
    ''
  ).trim();

  if (explicit) return explicit;

  const mapped = responseMappedDisplay(r);
  if (!mapped) return '';

  if (r.type === 'yesno') {
    return `The client's response maps to the ${mapped} option.`;
  }
  if (r.type === 'number') {
    return `The client's response indicates the numeric value ${mapped}.`;
  }
  if (r.type === 'choice') {
    return `The client's response matches the "${mapped}" choice.`;
  }
  return `The client's response was normalized to "${mapped}".`;
}

function responseMappedAnswer(r) {
  if (r.mappedAnswer !== undefined && r.mappedAnswer !== null && r.mappedAnswer !== '') {
    return typeof r.mappedAnswer === 'object'
      ? JSON.stringify(r.mappedAnswer)
      : String(r.mappedAnswer);
  }

  const normalized = r.normalizedValue;
  if (normalized !== undefined && normalized !== null && normalized !== '') {
    if (typeof normalized === 'object') {
      if (normalized.value !== undefined && normalized.value !== '') {
        return String(normalized.value);
      }
      return JSON.stringify(normalized);
    }
    return String(normalized);
  }

  const structured = r.structuredValue;
  if (structured && typeof structured === 'object' && Object.keys(structured).length) {
    return JSON.stringify(structured);
  }

  return String(
    r.caseworkerCorrectedAnswer ||
    r.aiInterpretedAnswer ||
    ''
  ).trim();
}

// Display-only: turns a structured value (e.g. an address object or its JSON
// string) into one readable line. The stored/CRM value is not changed.
function responseStructuredObject(r) {
  const s = r.structuredValue;
  if (s && typeof s === 'object' && Object.keys(s).length) return s;
  const raw = responseMappedAnswer(r);
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { const o = JSON.parse(raw); if (o && typeof o === 'object') return o; } catch (_) {}
  }
  return null;
}

function formatStructuredForDisplay(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const v = k => (obj[k] === undefined || obj[k] === null) ? '' : String(obj[k]).trim();
  const isAddress = ['streetName', 'city', 'postalCode', 'province', 'streetNumber'].some(k => v(k));
  if (isAddress) {
    const street = [v('streetNumber'), v('streetName'), v('streetType')].filter(Boolean).join(' ');
    const unit = v('unitNumber') ? `Unit ${v('unitNumber')}` : '';
    const floor = v('floor') ? `Floor ${v('floor')}` : '';
    const regionLine = [v('province'), v('postalCode')].filter(Boolean).join(' ');
    return [unit, floor, street, v('city'), regionLine, v('country')].filter(Boolean).join(', ');
  }
  return Object.values(obj)
    .filter(x => x !== '' && x !== null && x !== undefined && typeof x !== 'object')
    .map(String).join(', ');
}

function responseMappedDisplay(r) {
  const obj = responseStructuredObject(r);
  return obj ? formatStructuredForDisplay(obj) : responseMappedAnswer(r);
}

function renderMappedAnswerCell(r) {
  const mapped = responseMappedDisplay(r);
  let structuredHtml = '';

  const structured = responseStructuredObject(r);
  if (structured) {
    structuredHtml =
      `<table style="margin-top:7px;font-size:11px;border-collapse:collapse;width:100%">${
        Object.entries(structured)
          .filter(([,v]) => v !== '' && v !== null && v !== undefined)
          .map(([k,v]) =>
            `<tr>
              <td style="color:var(--text-muted);padding:1px 7px 1px 0;white-space:nowrap">${esc(k)}</td>
              <td style="font-weight:500">${esc(String(v))}</td>
            </tr>`
          ).join('')
      }</table>`;
  }

  return `
    <div class="mapped-answer-main" style="font-weight:700">${esc(mapped || '—')}</div>
    ${structuredHtml}
  `;
}

// ─────────────────────────────────────────────────────────────
// DEMO INTAKE DATA & CRM SYNC SUITE
// ─────────────────────────────────────────────────────────────
const DEMO_INTAKE_QUESTIONS = [
  { id: 'q_name', fieldKey: 'full_name', question: 'What is your full name?', category: 'Personal Information', type: 'open', expectedAnswer: 'Full legal name', required: true },
  { id: 'q_arrival', fieldKey: 'first_arrival_date', question: 'What was your first arrival date in Canada?', category: 'Immigration & Status', type: 'date', expectedAnswer: 'Date of first entry into Canada (YYYY-MM-DD)', required: true },
  { id: 'q_street', fieldKey: 'street_name', question: 'What is your street name?', category: 'Contact Information', type: 'address', expectedAnswer: 'Street name (e.g. Robson Street)', required: true },
  { id: 'q_unit', fieldKey: 'unit_number', question: 'What is your unit number?', category: 'Contact Information', type: 'open', expectedAnswer: 'Apartment or unit number if applicable', required: false },
  { id: 'q_city', fieldKey: 'city', question: 'What is your city?', category: 'Contact Information', type: 'open', expectedAnswer: 'City of residence', required: true },
  { id: 'q_province', fieldKey: 'province', question: 'What is your province?', category: 'Contact Information', type: 'open', expectedAnswer: 'Province or territory in Canada', required: true },
  { id: 'q_postal', fieldKey: 'postal_code', question: 'What is your postal code?', category: 'Contact Information', type: 'open', expectedAnswer: 'Canadian postal code (e.g. V6B 2B6)', required: true },
  { id: 'q_country', fieldKey: 'country', question: 'What is your country?', category: 'Contact Information', type: 'country', expectedAnswer: 'Country of residence (Canada)', required: true },
  { id: 'q_marital', fieldKey: 'marital_status', question: 'What is your marital status?', category: 'Personal Information', type: 'choice', expectedAnswer: 'Married, Single, Divorced, Common-law, Widowed', required: true },
  { id: 'q_children', fieldKey: 'number_of_children', question: 'How many children do you have?', category: 'Family Information', type: 'number', expectedAnswer: 'Number of dependent children (numeric)', required: true }
];

function loadDemoIntakeQuestions() {
  persistQuestions(DEMO_INTAKE_QUESTIONS);
  renderQuestionBank();
  toast('Demo intake questions loaded (10 questions matching CRM intake fields)', 'success');
}

const DEMO_INTAKE_RESPONSES = [
  {
    id: 'resp_name',
    fieldKey: 'full_name',
    question: 'What is your full name?',
    category: 'Personal Information',
    type: 'open',
    detectedClientSpeech: 'My name is Amir Hosseini',
    englishTranslation: 'My name is Amir Hosseini',
    mappingExplanation: 'Extracted full legal name: Amir Hosseini',
    mappedAnswer: 'Amir Hosseini',
    structuredValue: { firstName: 'Amir', lastName: 'Hosseini' },
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 3600000).toISOString()
  },
  {
    id: 'resp_arrival',
    fieldKey: 'first_arrival_date',
    question: 'What was your first arrival date in Canada?',
    category: 'Immigration & Status',
    type: 'date',
    detectedClientSpeech: 'I arrived on September 12, 2023 at Vancouver airport.',
    englishTranslation: 'I arrived on September 12, 2023 at Vancouver airport.',
    mappingExplanation: 'Normalized date to standard ISO 2023-09-12.',
    mappedAnswer: '2023-09-12',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 3300000).toISOString()
  },
  {
    id: 'resp_street',
    fieldKey: 'street_name',
    question: 'What is your street name?',
    category: 'Contact Information',
    type: 'address',
    detectedClientSpeech: 'Robson Street',
    englishTranslation: 'Robson Street',
    mappingExplanation: 'Verified street name: Robson Street.',
    mappedAnswer: 'Robson Street',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 3000000).toISOString()
  },
  {
    id: 'resp_unit',
    fieldKey: 'unit_number',
    question: 'What is your unit number?',
    category: 'Contact Information',
    type: 'open',
    detectedClientSpeech: 'Suite 402',
    englishTranslation: 'Suite 402',
    mappingExplanation: 'Extracted unit / suite number: Suite 402.',
    mappedAnswer: 'Suite 402',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 2700000).toISOString()
  },
  {
    id: 'resp_city',
    fieldKey: 'city',
    question: 'What is your city?',
    category: 'Contact Information',
    type: 'open',
    detectedClientSpeech: 'Vancouver',
    englishTranslation: 'Vancouver',
    mappingExplanation: 'Normalized city: Vancouver.',
    mappedAnswer: 'Vancouver',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 2400000).toISOString()
  },
  {
    id: 'resp_province',
    fieldKey: 'province',
    question: 'What is your province?',
    category: 'Contact Information',
    type: 'open',
    detectedClientSpeech: 'British Columbia',
    englishTranslation: 'British Columbia',
    mappingExplanation: 'Normalized province: British Columbia.',
    mappedAnswer: 'British Columbia',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 2100000).toISOString()
  },
  {
    id: 'resp_postal',
    fieldKey: 'postal_code',
    question: 'What is your postal code?',
    category: 'Contact Information',
    type: 'open',
    detectedClientSpeech: 'V 6 B 2 B 6',
    englishTranslation: 'V6B 2B6',
    mappingExplanation: 'Canadian postal code standard format: V6B 2B6.',
    mappedAnswer: 'V6B 2B6',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 1800000).toISOString()
  },
  {
    id: 'resp_country',
    fieldKey: 'country',
    question: 'What is your country?',
    category: 'Contact Information',
    type: 'country',
    detectedClientSpeech: 'Canada',
    englishTranslation: 'Canada',
    mappingExplanation: 'Country: Canada.',
    mappedAnswer: 'Canada',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 1500000).toISOString()
  },
  {
    id: 'resp_marital',
    fieldKey: 'marital_status',
    question: 'What is your marital status?',
    category: 'Personal Information',
    type: 'choice',
    detectedClientSpeech: 'I am married, my spouse lives with me.',
    englishTranslation: 'I am married, my spouse lives with me.',
    mappingExplanation: 'Mapped to relationship status choice "Married".',
    mappedAnswer: 'Married',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 1200000).toISOString()
  },
  {
    id: 'resp_children',
    fieldKey: 'number_of_children',
    question: 'How many children do you have?',
    category: 'Family Information',
    type: 'number',
    detectedClientSpeech: 'We have 2 young kids.',
    englishTranslation: 'We have 2 young kids.',
    mappingExplanation: 'Extracted numeric children count: 2.',
    mappedAnswer: '2',
    isAnswerComplete: true,
    isConfirmed: true,
    answeredAt: new Date(Date.now() - 900000).toISOString()
  }
];

function loadDemoIntakeResponses() {
  persistResponses(DEMO_INTAKE_RESPONSES);
  localStorage.removeItem('aic_current_crm_client_id');
  renderResponses();
  toast('Demo intake responses loaded (all 9 fields + name ready for CRM review)', 'success');
}

// Extract 9 required intake fields from saved responses
function extractIntakeFields(responses = []) {
  const fields = {
    fullName: '',
    firstArrivalDateInCanada: '',
    streetName: '',
    unitNumber: '',
    city: '',
    province: '',
    postalCode: '',
    country: 'Canada',
    maritalStatus: '',
    numberOfChildren: ''
  };

  if (!Array.isArray(responses) || !responses.length) {
    return fields;
  }

  // Pass 1: Check for combined address structuredValue if present
  for (const r of responses) {
    const sv = r.structuredValue;
    if (sv && typeof sv === 'object') {
      if (sv.streetName && !fields.streetName) {
        fields.streetName = String(sv.streetNumber ? `${sv.streetNumber} ${sv.streetName}` : sv.streetName).trim();
      }
      if (sv.unitNumber && !fields.unitNumber) fields.unitNumber = String(sv.unitNumber).trim();
      if (sv.city && !fields.city) fields.city = String(sv.city).trim();
      if (sv.province && !fields.province) fields.province = String(sv.province).trim();
      if (sv.postalCode && !fields.postalCode) fields.postalCode = String(sv.postalCode).trim();
      if (sv.country && fields.country === 'Canada') fields.country = String(sv.country).trim();
      if (sv.firstName || sv.lastName) {
        fields.fullName = [sv.firstName, sv.lastName].filter(Boolean).join(' ');
      }
    }
  }

  // Pass 2: Inspect individual questions and fieldKeys
  for (const r of responses) {
    const fk = String(r.fieldKey || '').toLowerCase();
    const q  = String(r.question || '').toLowerCase();
    const val = String(responseMappedAnswer(r) || responseEnglishTranslation(r) || '').trim();
    if (!val) continue;

    if (fk === 'full_name' || q.includes('full name') || (q.includes('your name') && !q.includes('street'))) {
      if (!fields.fullName) fields.fullName = val;
    } else if (fk === 'first_arrival_date' || q.includes('arrival date') || q.includes('arrive in canada') || q.includes('landed') || (q.includes('arriv') && q.includes('canada'))) {
      if (!fields.firstArrivalDateInCanada) fields.firstArrivalDateInCanada = val;
    } else if (fk === 'street_name' || q.includes('street name') || (q.includes('street') && !q.includes('number'))) {
      if (!fields.streetName) fields.streetName = val;
    } else if (fk === 'unit_number' || q.includes('unit number') || q.includes('unit') || q.includes('apartment') || q.includes('suite')) {
      if (!fields.unitNumber) fields.unitNumber = val;
    } else if (fk === 'city' || q.includes('city') || q.includes('town')) {
      if (!fields.city) fields.city = val;
    } else if (fk === 'province' || q.includes('province') || q.includes('territory')) {
      if (!fields.province) fields.province = val;
    } else if (fk === 'postal_code' || q.includes('postal code') || q.includes('postcode') || q.includes('zip')) {
      if (!fields.postalCode) fields.postalCode = val;
    } else if (fk === 'country' || (q.includes('country') && !q.includes('birth') && !q.includes('citizenship'))) {
      if (!fields.country || fields.country === 'Canada') fields.country = val;
    } else if (fk === 'marital_status' || q.includes('marital') || q.includes('married') || q.includes('single') || q.includes('spouse')) {
      if (!fields.maritalStatus) fields.maritalStatus = val;
    } else if (fk === 'number_of_children' || q.includes('children') || q.includes('kids') || q.includes('dependents')) {
      const num = parseInt(val, 10);
      fields.numberOfChildren = isNaN(num) ? val : num;
    }
  }

  // Fallback defaults for cleaner demo display if partially missing
  if (!fields.country) fields.country = 'Canada';
  return fields;
}

// Automated field mapping from intake fields to Dynamics CRM fields
function mapIntakeToCrm(fields) {
  return {
    address1_line1: fields.streetName || '',
    address1_line2: fields.unitNumber || '',
    address1_city: fields.city || '',
    address1_stateorprovince: fields.province || '',
    address1_postalcode: fields.postalCode || '',
    address1_country: fields.country || 'Canada',
    firstarrivaldate: fields.firstArrivalDateInCanada || '',
    familystatuscode: fields.maritalStatus || '',
    numberofchildren: fields.numberOfChildren !== '' && fields.numberOfChildren !== undefined
      ? (isNaN(Number(fields.numberOfChildren)) ? fields.numberOfChildren : Number(fields.numberOfChildren))
      : '',
    fullname: fields.fullName || '',
    crm_metadata: {
      source: 'AI Caseworker Intake',
      status: 'Approved',
      reviewedBy: 'Caseworker',
      approvedAt: new Date().toISOString()
    }
  };
}

// Render the Caseworker Review & CRM status panel
function renderCaseworkerCrmPanel() {
  const panel = document.getElementById('caseworker-crm-panel');
  if (!panel) return;

  const rs = loadResponses();
  if (!rs.length) {
    panel.innerHTML = '';
    return;
  }

  const fields = extractIntakeFields(rs);
  const currentCrmId = localStorage.getItem('aic_current_crm_client_id');

  const statusBadge = currentCrmId
    ? `<span class="badge badge-green" style="font-size:12px;padding:4px 10px">✓ Synced to Mock CRM: <b>${esc(currentCrmId)}</b></span>`
    : `<span class="badge badge-blue" style="font-size:12px;padding:4px 10px">Ready for Caseworker Review & Approval</span>`;

  panel.innerHTML = `
    <div class="card" style="margin-bottom:20px;border-left:4px solid var(--primary)">
      <div class="row-between" style="align-items:flex-start;margin-bottom:12px">
        <div>
          <div style="font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px">
            <span>🛡️ Caseworker Review & CRM Sync</span>
            ${statusBadge}
          </div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:2px">
            Client: <b>${esc(fields.fullName || 'Name not collected')}</b> • 9 Intake fields extracted and prepared for Dynamics CRM mapping.
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="openCaseworkerReviewModal()">
            📋 Review & Approve
          </button>
          <button class="btn btn-success btn-sm" onclick="submitCaseworkerApprovalQuick()">
            🚀 Quick Send to CRM
          </button>
          <a class="btn btn-secondary btn-sm" href="crm.html">
            🏢 View Mock CRM
          </a>
        </div>
      </div>

      <!-- Quick 9 Fields Breakdown -->
      <div class="crm-field-grid">
        <div class="crm-field-card">
          <div class="crm-field-label">
            <span>First Arrival Date</span>
            <span class="crm-target-tag">firstarrivaldate</span>
          </div>
          <div class="crm-field-val">${esc(fields.firstArrivalDateInCanada || '—')}</div>
        </div>

        <div class="crm-field-card">
          <div class="crm-field-label">
            <span>Street Name</span>
            <span class="crm-target-tag">address1_line1</span>
          </div>
          <div class="crm-field-val">${esc(fields.streetName || '—')}</div>
        </div>

        <div class="crm-field-card">
          <div class="crm-field-label">
            <span>Unit Number</span>
            <span class="crm-target-tag">address1_line2</span>
          </div>
          <div class="crm-field-val">${esc(fields.unitNumber || '—')}</div>
        </div>

        <div class="crm-field-card">
          <div class="crm-field-label">
            <span>City & Province</span>
            <span class="crm-target-tag">city / province</span>
          </div>
          <div class="crm-field-val">${esc(fields.city || '—')}${fields.city && fields.province ? ', ' : ''}${esc(fields.province || '')}</div>
        </div>

        <div class="crm-field-card">
          <div class="crm-field-label">
            <span>Postal Code & Country</span>
            <span class="crm-target-tag">postalcode / country</span>
          </div>
          <div class="crm-field-val">${esc(fields.postalCode || '—')} • ${esc(fields.country || 'Canada')}</div>
        </div>

        <div class="crm-field-card">
          <div class="crm-field-label">
            <span>Marital Status & Children</span>
            <span class="crm-target-tag">familystatus / children</span>
          </div>
          <div class="crm-field-val">${esc(fields.maritalStatus || '—')} • ${fields.numberOfChildren === '' ? '—' : esc(String(fields.numberOfChildren))} children</div>
        </div>
      </div>
    </div>`;
}

// Open Caseworker Review & Field Mapping Modal
function openCaseworkerReviewModal() {
  const rs = loadResponses();
  if (!rs.length) {
    toast('No responses yet — complete a Client Intake first (or load the demo intake).', 'info');
    return;
  }
  const fields = extractIntakeFields(rs);

  const elName = document.getElementById('cr-name');
  const elArrival = document.getElementById('cr-arrival');
  const elStreet = document.getElementById('cr-street');
  const elUnit = document.getElementById('cr-unit');
  const elCity = document.getElementById('cr-city');
  const elProv = document.getElementById('cr-province');
  const elPostal = document.getElementById('cr-postal');
  const elCountry = document.getElementById('cr-country');
  const elMarital = document.getElementById('cr-marital');
  const elChildren = document.getElementById('cr-children');

  // Only values the client actually gave. Missing fields stay empty for the
  // caseworker to fill in — never demo data.
  if (elName) elName.value = fields.fullName || '';
  if (elArrival) elArrival.value = fields.firstArrivalDateInCanada || '';
  if (elStreet) elStreet.value = fields.streetName || '';
  if (elUnit) elUnit.value = fields.unitNumber || '';
  if (elCity) elCity.value = fields.city || '';
  if (elProv) elProv.value = fields.province || '';
  if (elPostal) elPostal.value = fields.postalCode || '';
  if (elCountry) elCountry.value = fields.country || 'Canada';
  if (elMarital) elMarital.value = fields.maritalStatus || '';
  if (elChildren) elChildren.value = fields.numberOfChildren ?? '';

  updateReviewPayloadPreview();
  const modal = document.getElementById('caseworker-review-modal');
  if (modal) modal.style.display = 'flex';
}

function closeCaseworkerReviewModal() {
  const modal = document.getElementById('caseworker-review-modal');
  if (modal) modal.style.display = 'none';
}

// Live update mapping table and JSON preview in Review Modal
function updateReviewPayloadPreview() {
  const getVal = id => (document.getElementById(id)?.value || '').trim();

  const current = {
    fullName: getVal('cr-name'),
    firstArrivalDateInCanada: getVal('cr-arrival'),
    streetName: getVal('cr-street'),
    unitNumber: getVal('cr-unit'),
    city: getVal('cr-city'),
    province: getVal('cr-province'),
    postalCode: getVal('cr-postal'),
    country: getVal('cr-country') || 'Canada',
    maritalStatus: getVal('cr-marital'),
    numberOfChildren: getVal('cr-children') !== '' ? Number(getVal('cr-children')) : ''
  };

  const mapped = mapIntakeToCrm(current);

  const mappings = [
    { label: 'Street Name', target: 'address1_line1', val: mapped.address1_line1 },
    { label: 'Unit Number', target: 'address1_line2', val: mapped.address1_line2 },
    { label: 'City', target: 'address1_city', val: mapped.address1_city },
    { label: 'Province', target: 'address1_stateorprovince', val: mapped.address1_stateorprovince },
    { label: 'Postal Code', target: 'address1_postalcode', val: mapped.address1_postalcode },
    { label: 'Country', target: 'address1_country', val: mapped.address1_country },
    { label: 'First Arrival Date', target: 'firstarrivaldate', val: mapped.firstarrivaldate },
    { label: 'Marital Status', target: 'familystatuscode', val: mapped.familystatuscode },
    { label: 'Number of Children', target: 'numberofchildren', val: mapped.numberofchildren },
    { label: 'Client Name', target: 'fullname', val: mapped.fullname }
  ];

  const tbody = document.getElementById('cr-mapping-tbody');
  if (tbody) {
    tbody.innerHTML = mappings.map(m => `
      <tr>
        <td style="font-weight:500">${esc(m.label)}</td>
        <td><span class="crm-target-tag">${esc(m.target)}</span></td>
        <td style="font-weight:600;color:var(--text)">${esc(String(m.val || '—'))}</td>
      </tr>
    `).join('');
  }

  const jsonBox = document.getElementById('cr-json-preview');
  if (jsonBox) {
    jsonBox.textContent = JSON.stringify(mapped, null, 2);
  }
}

// Submit Caseworker Approval and dispatch payload to Mock CRM
async function submitCaseworkerApproval() {
  const check = document.getElementById('cr-approve-check');
  if (check && !check.checked) {
    toast('Please confirm approval with the checkbox before syncing', 'warning');
    return;
  }

  const getVal = id => (document.getElementById(id)?.value || '').trim();
  const current = {
    fullName: getVal('cr-name'),
    firstArrivalDateInCanada: getVal('cr-arrival'),
    streetName: getVal('cr-street'),
    unitNumber: getVal('cr-unit'),
    city: getVal('cr-city'),
    province: getVal('cr-province'),
    postalCode: getVal('cr-postal'),
    country: getVal('cr-country') || 'Canada',
    maritalStatus: getVal('cr-marital'),
    numberOfChildren: getVal('cr-children') !== '' ? Number(getVal('cr-children')) : ''
  };

  const payload = mapIntakeToCrm(current);
  await sendApprovedDataToCrm(payload);
}

// Quick send from the page banner
async function submitCaseworkerApprovalQuick() {
  const rs = loadResponses();
  if (!rs.length) {
    toast('No responses yet — complete a Client Intake first (or load the demo intake).', 'info');
    return;
  }
  const fields = extractIntakeFields(rs);
  const payload = mapIntakeToCrm(fields);
  await sendApprovedDataToCrm(payload);
}

// Dispatch to Mock CRM API: POST /api/clients
async function sendApprovedDataToCrm(payload) {
  toast('Sending approved client data to Mock CRM…', 'info');

  try {
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Success handling
    const clientId = data.clientId || 'CRM-1001';
    localStorage.setItem('aic_current_crm_client_id', clientId);

    // Save to local cached list as well
    const cached = JSON.parse(localStorage.getItem('aic_mock_crm_clients') || '[]');
    const record = Object.assign({}, payload, { clientId, createdAt: new Date().toISOString() });
    cached.push(record);
    localStorage.setItem('aic_mock_crm_clients', JSON.stringify(cached));

    // Tag responses
    const rs = loadResponses();
    rs.forEach(r => { r.crmClientId = clientId; r.crmSyncStatus = 'synced'; });
    persistResponses(rs);

    closeCaseworkerReviewModal();

    // Display Success Modal
    const succModal = document.getElementById('crm-success-modal');
    if (succModal) {
      document.getElementById('success-client-id').textContent = clientId;
      document.getElementById('success-json-response').textContent = JSON.stringify(data, null, 2);
      const link = document.getElementById('success-crm-link');
      if (link) link.href = `crm.html?id=${encodeURIComponent(clientId)}`;
      succModal.style.display = 'flex';
    }

    renderResponses();
    toast(`Client ${clientId} created successfully in Mock CRM!`, 'success');

  } catch (err) {
    // Graceful offline fallback
    console.warn('POST /api/clients error, using offline mock fallback:', err.message);
    const cached = JSON.parse(localStorage.getItem('aic_mock_crm_clients') || '[]');
    const clientId = `CRM-${1001 + cached.length}`;
    localStorage.setItem('aic_current_crm_client_id', clientId);

    const record = Object.assign({}, payload, { clientId, createdAt: new Date().toISOString() });
    cached.push(record);
    localStorage.setItem('aic_mock_crm_clients', JSON.stringify(cached));

    const rs = loadResponses();
    rs.forEach(r => { r.crmClientId = clientId; r.crmSyncStatus = 'synced'; });
    persistResponses(rs);

    closeCaseworkerReviewModal();

    const succModal = document.getElementById('crm-success-modal');
    if (succModal) {
      document.getElementById('success-client-id').textContent = clientId;
      document.getElementById('success-json-response').textContent = JSON.stringify({
        success: true,
        clientId: clientId,
        message: "Client created successfully (cached locally)",
        client: record
      }, null, 2);
      const link = document.getElementById('success-crm-link');
      if (link) link.href = `crm.html?id=${encodeURIComponent(clientId)}`;
      succModal.style.display = 'flex';
    }

    renderResponses();
    toast(`Client ${clientId} created in Mock CRM (offline mode)`, 'success');
  }
}

function closeCrmSuccessModal() {
  const modal = document.getElementById('crm-success-modal');
  if (modal) modal.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// RESPONSES — UI
// ─────────────────────────────────────────────────────────────
function renderResponses() {
  const timeOf = r => Date.parse(r.answeredAt || r.timestamp || '') || 0;
  const rs = loadResponses().sort((a, b) => timeOf(a) - timeOf(b));
  repairSavedTranslations(rs);
  const el = document.getElementById('responses-content');

  // Render top caseworker CRM panel
  renderCaseworkerCrmPanel();

  if (!rs.length) {
    el.innerHTML = `<div class="card"><div class="empty-state">
      <div class="ei">📊</div>
      <h3>No responses yet</h3>
      <p>Complete a conversation session or load sample intake responses to test Caseworker Review and Mock CRM sync.</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
        <button class="btn btn-primary" onclick="loadDemoIntakeResponses()">✨ Load Demo Intake (9 Fields)</button>
        <a class="btn btn-secondary" href="interview.html">Start Client Intake</a>
      </div>
    </div></div>`;
    return;
  }


  const rows = rs.map((r, i) => {
    const speech = responseSpeech(r) || '—';
    const translation = _translationPending.has(r.questionId)
      ? '⏳ Translating to English…'
      : (responseEnglishTranslation(r) || '—');
    const explanation = responseMappingExplanation(r) || '—';

    return `
    <tr>
      <td style="font-weight:600;color:var(--text-muted)">${i+1}</td>

      <td style="min-width:220px">
        <div style="font-weight:600;max-width:260px">${esc(r.question || '')}</div>
        <div style="margin-top:5px">
          <span class="badge badge-gray" style="font-size:10px">${esc(r.category||'')}</span>
        </div>
      </td>

      <td style="min-width:210px;max-width:280px">
        <div style="white-space:pre-wrap;direction:auto">${esc(speech)}</div>
      </td>

      <td style="min-width:210px;max-width:280px">
        <div style="white-space:pre-wrap">${esc(translation)}</div>
      </td>

      <td style="min-width:230px;max-width:320px">
        <div style="white-space:pre-wrap">${esc(explanation)}</div>
      </td>

      <td style="min-width:150px;max-width:240px">
        ${renderMappedAnswerCell(r)}
      </td>

      <td style="min-width:115px">
        <span class="badge ${r.requiresCaseworkerReview ? 'badge-orange' : (r.isAnswerComplete ? 'badge-green' : 'badge-orange')}">
          ${r.requiresCaseworkerReview ? '⚠ Review' : (r.isAnswerComplete ? '✓ Complete' : '⚠ Incomplete')}
        </span>
        ${r.missingInformation
          ? `<div style="font-size:11px;color:var(--text-muted);margin-top:5px;max-width:180px">${esc(String(r.missingInformation).substring(0,120))}</div>`
          : ''}
      </td>

      <td style="font-size:12px;color:var(--text-muted);white-space:nowrap">
        ${r.answeredAt || r.timestamp ? new Date(r.answeredAt || r.timestamp).toLocaleString() : '—'}
      </td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="card" style="max-width:none">
      <div class="row-between" style="margin-bottom:14px">
        <span style="font-size:13px;color:var(--text-muted)">
          ${rs.length} response${rs.length!==1?'s':''} recorded
        </span>
        <span style="font-size:11.5px;color:var(--text-muted)">
          Speech → Translation → AI mapping → Caseworker Approval → Dynamics CRM Sync
        </span>
      </div>

      <div class="table-wrap" style="overflow-x:auto">
        <table style="min-width:1420px">
          <thead>
            <tr>
              <th>#</th>
              <th>Question</th>
              <th>Detected Client Speech</th>
              <th>English Translation</th>
              <th>AI Analysis</th>
              <th>Mapped Answer</th>
              <th>Status</th>
              <th>Answered At</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function exportResponses() {
  const rs = loadResponses();
  if (!rs.length) { toast('No responses to export', 'info'); return; }
  const blob = new Blob([JSON.stringify(rs, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `ai-caseworker-responses-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Responses exported', 'success');
}

function clearAllResponses() {
  if (!confirm('Clear all responses? This cannot be undone.')) return;
  persistResponses([]);
  localStorage.removeItem('aic_current_crm_client_id');
  renderResponses();
  toast('All responses cleared', 'info');
}

// ─── Navigation ───────────────────────────────────────────────
const PAGE_ROUTES = {
  'question-engine': 'question-engine.html',
  'question-bank': 'question-bank.html',
  'translation': 'translation.html',
  'conversation': 'interview.html',
  'assistant': 'ai-assistant.html',
  'responses': 'responses.html',
  'crm': 'crm.html',
  'settings': 'settings.html'
};

function show(name) {
  const target = PAGE_ROUTES[name];
  if (target) window.location.href = target;
}

// ─── Toast ────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const c  = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
  el.innerHTML = `<span>${icons[type]||''}</span> ${esc(msg)}`;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── Settings ─────────────────────────────────────────────────
function populateSettingsForm() {
  const s = loadSettings();
  document.getElementById('s-gcp-project').value        = s.gcpProjectId     || '';
  document.getElementById('s-gcp-location').value       = s.gcpLocation      || 'us';
  document.getElementById('s-gcp-processor').value      = s.gcpProcessorId   || '';
  document.getElementById('s-gcp-credentials').value    = s.gcpCredentialsFile || 'google-service-account.json';
  document.getElementById('s-gemini-location').value    = s.geminiLocation   || 'global';
  document.getElementById('s-gemini-model').value       = s.geminiModel      || 'gemini-3.8-flash';
  document.getElementById('s-speech-region').value      = s.speechRegion       || '';
  document.getElementById('s-speech-key').value         = s.speechKey          || '';
  const speechVoiceEl = document.getElementById('s-speech-voice');
  if (speechVoiceEl) speechVoiceEl.value = s.speechVoice || 'en-US-LunaNeural';
  const vpEl = document.getElementById('s-voice-provider');
  if (vpEl) vpEl.value = s.voiceProvider || 'google';
  const gtmEl = document.getElementById('s-google-tts-model');
  if (gtmEl) gtmEl.value = s.googleTtsModel || 'gemini-2.5-flash-tts';
  const gtvEl = document.getElementById('s-google-tts-voice');
  if (gtvEl) gtvEl.value = s.googleTtsVoice || 'Kore';

  document.getElementById('s-avatar-resource').value  = s.avatarResourceName || 'ai-caseworker-avatar';
  document.getElementById('s-avatar-endpoint').value  = s.avatarEndpoint || 'https://francecentral.api.cognitive.microsoft.com/';
  document.getElementById('s-avatar-region').value    = s.avatarRegion || 'francecentral';
  document.getElementById('s-avatar-key').value       = s.avatarKey || '';
  document.getElementById('s-avatar-character').value = s.avatarCharacter || 'lisa';
  document.getElementById('s-avatar-style').value     = s.avatarStyle || 'casual-sitting';
  document.getElementById('s-avatar-voice').value     = s.avatarVoice || 'en-US-LunaNeural';
  const setIf = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setIf('s-avatar-provider', s.avatarProvider || 'azure');
  setIf('s-gemini-avatar-name', s.geminiAvatarName || 'Kira');
  setIf('s-gemini-avatar-voice', s.geminiAvatarVoice || 'zephyr');
  setIf('s-gemini-live-model', s.geminiLiveModel || 'gemini-3.8-live');
  setIf('s-gemini-live-location', s.geminiLiveLocation || 'us-central1');
}

async function saveSettings() {
  const settings = {
    gcpProjectId:      document.getElementById('s-gcp-project').value.trim(),
    gcpLocation:       document.getElementById('s-gcp-location').value || 'us',
    gcpProcessorId:    document.getElementById('s-gcp-processor').value.trim(),
    gcpCredentialsFile:document.getElementById('s-gcp-credentials').value.trim() || 'google-service-account.json',
    geminiLocation:    document.getElementById('s-gemini-location').value.trim() || 'global',
    geminiModel:       document.getElementById('s-gemini-model').value.trim() || 'gemini-3.8-flash',
    speechRegion:       document.getElementById('s-speech-region').value.trim(),
    speechKey:          document.getElementById('s-speech-key').value.trim(),
    speechVoice:        (document.getElementById('s-speech-voice')?.value || 'en-US-LunaNeural').trim(),
    voiceProvider:      document.getElementById('s-voice-provider')?.value || 'google',
    googleTtsModel:     (document.getElementById('s-google-tts-model')?.value || 'gemini-2.5-flash-tts').trim(),
    googleTtsVoice:     (document.getElementById('s-google-tts-voice')?.value || 'Kore').trim(),
    avatarResourceName: document.getElementById('s-avatar-resource').value.trim(),
    avatarEndpoint:     document.getElementById('s-avatar-endpoint').value.trim(),
    avatarRegion:       document.getElementById('s-avatar-region').value.trim(),
    avatarKey:          document.getElementById('s-avatar-key').value.trim(),
    avatarCharacter:    (document.getElementById('s-avatar-character').value || 'lisa').trim(),
    avatarStyle:        (document.getElementById('s-avatar-style').value || 'casual-sitting').trim(),
    avatarVoice:        (document.getElementById('s-avatar-voice').value || 'en-US-LunaNeural').trim(),
    avatarProvider:     document.getElementById('s-avatar-provider')?.value || 'azure',
    geminiAvatarName:   (document.getElementById('s-gemini-avatar-name')?.value || 'Kira').trim(),
    geminiAvatarVoice:  (document.getElementById('s-gemini-avatar-voice')?.value || 'zephyr').trim(),
    geminiLiveModel:    (document.getElementById('s-gemini-live-model')?.value || 'gemini-3.8-live').trim(),
    geminiLiveLocation: (document.getElementById('s-gemini-live-location')?.value || 'us-central1').trim()
  };

  // Keep current-session behavior unchanged.
  persistSettings(settings);
  window.AIC_CONFIG = settings;

  // Also save to config.js in this same folder through the local Python server.
  // That file is then included when the folder is zipped/shared.
  try {
    const res = await fetch('/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(msg || `HTTP ${res.status}`);
    }

    toast('Settings saved to config.js', 'success');
  } catch (e) {
    toast('Saved in browser, but could not write config.js: ' + e.message, 'error');
  }
}

// ─── Speech globals ───────────────────────────────────────────
let _isListening   = false;
let _currentAudio  = null;

// ─── Azure Avatar globals ─────────────────────────────────────
let _avatarSynthesizer    = null;
let _avatarPeerConnection = null;
let _avatarReady          = false;
let _avatarConnecting     = false;
let _avatarIsListening    = false;

// Fetch Azure Avatar WebRTC relay credentials. When this app is run with
// server.py, use the local proxy first so browser CORS restrictions cannot
// turn a valid Azure response into a generic "Failed to fetch" error.
// A direct Azure fallback is kept so the project can still work when hosted
// without the local proxy.
async function fetchAvatarRelayToken(settings) {
  const s = settings || loadSettings();

  if (!s.avatarResourceName || !s.avatarRegion || !s.avatarKey) {
    throw new Error('Avatar Resource Name, Region, and API Key are required.');
  }

  // Preferred path for this portable demo: local Python proxy.
  try {
    const proxyResp = await fetch('/avatar-relay-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceName: s.avatarResourceName,
        region: s.avatarRegion,
        endpoint: s.avatarEndpoint || '',
        key: s.avatarKey
      })
    });

    if (proxyResp.ok) {
      return await proxyResp.json();
    }

    // 404 means this page is not being served by the bundled server.py.
    // Other proxy errors are retained and only surfaced if direct calls fail.
    var proxyErrorText = await proxyResp.text().catch(() => '');
    var proxyError = `Local avatar proxy failed (${proxyResp.status})${proxyErrorText ? ': ' + proxyErrorText.slice(0, 180) : ''}`;
  } catch (e) {
    var proxyError = `Local avatar proxy unavailable: ${e.message || e}`;
  }

  const directCandidates = [
    `https://${s.avatarResourceName}.cognitiveservices.azure.com/tts/cognitiveservices/avatar/relay/token/v1`,
    `https://${s.avatarRegion}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1`
  ];

  const directErrors = [];
  for (const relayUrl of directCandidates) {
    try {
      const resp = await fetch(relayUrl, {
        method: 'GET',
        headers: { 'Ocp-Apim-Subscription-Key': s.avatarKey }
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        directErrors.push(`${relayUrl} -> HTTP ${resp.status}${body ? ': ' + body.slice(0, 120) : ''}`);
        continue;
      }

      return await resp.json();
    } catch (e) {
      directErrors.push(`${relayUrl} -> ${e.message || e}`);
    }
  }

  throw new Error([proxyError, ...directErrors].filter(Boolean).join(' | '));
}

function normalizeAvatarIceInfo(iceData) {
  const urls = iceData?.Urls || iceData?.urls || [];
  const username = iceData?.Username || iceData?.username;
  const credential =
    iceData?.Password || iceData?.password || iceData?.Credential || iceData?.credential;
  const turnUrl = Array.isArray(urls)
    ? (urls.find(url => String(url).toLowerCase().startsWith('turn:')) || urls[0])
    : null;

  if (!turnUrl || !username || !credential) {
    throw new Error('Avatar relay token response did not contain complete ICE/TURN information.');
  }

  return { urls, username, credential, turnUrl };
}

function htmlEncodeForSSML(text) {
  return String(text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── Audio / Avatar stop ──────────────────────────────────────
function stopCurrentAudio() {
  if (_avatarReady && _avatarSynthesizer) {
    try { _avatarSynthesizer.stopSpeakingAsync(); } catch(e) {}
  }
  if (_currentAudio) {
    _currentAudio.pause(); _currentAudio.currentTime = 0; _currentAudio = null;
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  setAvatarSpeaking(false);
}

// ─── Avatar session management ────────────────────────────────
async function startAvatarSession() {
  const s = loadSettings();
  if (!s.avatarKey || !s.avatarRegion) {
    toast('Configure Azure Speech Region & Key in Settings → Azure Talking Avatar', 'error'); return;
  }
  if (_avatarConnecting || _avatarReady) return;
  _avatarConnecting = true;

  const btn = document.getElementById('btn-connect-avatar');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="av-spinner"></span> Connecting…'; }

  try {
    // Keep the Azure Portal endpoint in settings for an exact copy of the
    // resource configuration, but initialize Speech SDK with subscription + region.
    // This is the standard Speech SDK setup for a regional Speech resource.
    const portalEndpoint = (s.avatarEndpoint || '').replace(/\/+$/, '');
    console.log('[Avatar] Portal endpoint:', portalEndpoint);

    const speechConfig =
      SpeechSDK.SpeechConfig.fromSubscription(s.avatarKey, s.avatarRegion);

    speechConfig.speechSynthesisVoiceName =
      s.avatarVoice || 'en-US-LunaNeural';

    const videoFormat = new SpeechSDK.AvatarVideoFormat();
    videoFormat.width = 1920; videoFormat.height = 1080; videoFormat.bitrate = 1000000;
    videoFormat.setCropRange(new SpeechSDK.Coordinate(600, 0), new SpeechSDK.Coordinate(1320, 1080));

    const avatarConfig = new SpeechSDK.AvatarConfig(
      s.avatarCharacter || 'lisa', s.avatarStyle || 'casual-sitting', videoFormat
    );
    avatarConfig.backgroundColor = '#FFFFFFFF';

    _avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);
    _avatarSynthesizer.avatarEventReceived = (s, e) => console.log('[Avatar]', e.description);

    const iceData = await fetchAvatarRelayToken(s);
    const ice = normalizeAvatarIceInfo(iceData);

    _avatarPeerConnection = new RTCPeerConnection({
      iceServers: [{
        urls: [ice.turnUrl],
        username: ice.username,
        credential: ice.credential
      }]
    });

    _avatarPeerConnection.ontrack = (event) => {
      const remoteDiv = document.getElementById('remoteVideo');
      for (let i = 0; i < remoteDiv.childNodes.length; i++) {
        if (remoteDiv.childNodes[i].localName === event.track.kind)
          remoteDiv.removeChild(remoteDiv.childNodes[i]);
      }
      const el = document.createElement(event.track.kind);
      el.id = event.track.kind; el.srcObject = event.streams[0]; el.autoplay = false;
      el.addEventListener('loadeddata', () => el.play());
      if (event.track.kind === 'video') {
        el.playsInline = true; el.style.cssText = 'width:100%;height:100%;object-fit:cover';
        el.addEventListener('play', () => {
          const ov = document.getElementById('avatar-overlay');
          if (ov) { ov.classList.add('hidden'); setTimeout(() => { ov.style.display='none'; }, 500); }
          const db = document.getElementById('btn-disconnect-avatar');
          if (db) db.style.display = '';
        });
      } else { el.muted = true; }
      remoteDiv.appendChild(el);
    };

    _avatarPeerConnection.createDataChannel('eventChannel');
    _avatarPeerConnection.addTransceiver('video', { direction: 'sendrecv' });
    _avatarPeerConnection.addTransceiver('audio', { direction: 'sendrecv' });

    _avatarPeerConnection.oniceconnectionstatechange = () => {
      const st = _avatarPeerConnection.iceConnectionState;
      console.log('[Avatar WebRTC]', st);
      if (st === 'connected') {
        _avatarReady = true; _avatarConnecting = false;
        setAvatarStatus('Ready', false);
      }
      if (st === 'disconnected' || st === 'failed') {
        _avatarReady = false; _avatarConnecting = false;
        const ov = document.getElementById('avatar-overlay');
        if (ov) { ov.style.display=''; ov.classList.remove('hidden'); }
        const db = document.getElementById('btn-disconnect-avatar');
        if (db) db.style.display = 'none';
        if (btn) { btn.disabled = false; btn.innerHTML = '▶ Connect Avatar'; }
        setAvatarStatus('AI Caseworker', false);
      }
    };

    const result = await _avatarSynthesizer.startAvatarAsync(_avatarPeerConnection);
    if (result.reason === SpeechSDK.ResultReason.Canceled) {
      const d = SpeechSDK.CancellationDetails.fromResult(result);
      throw new Error(d.errorDetails || 'Avatar start canceled');
    }

  } catch (err) {
    console.error('[Avatar]', err);
    toast('Avatar connection failed: ' + err.message, 'error');
    _avatarConnecting = false; _avatarReady = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '▶ Connect Avatar'; }
  }
}

function stopAvatarSession() {
  if (_avatarSynthesizer) { try { _avatarSynthesizer.close(); } catch(e) {} _avatarSynthesizer = null; }
  _avatarPeerConnection = null; _avatarReady = false; _avatarConnecting = false;
  const ov = document.getElementById('avatar-overlay');
  if (ov) { ov.style.display=''; ov.classList.remove('hidden'); }
  const rv = document.getElementById('remoteVideo');
  if (rv) rv.innerHTML = '';
  const btn = document.getElementById('btn-connect-avatar');
  if (btn) { btn.disabled = false; btn.innerHTML = '▶ Connect Avatar'; }
  const db = document.getElementById('btn-disconnect-avatar');
  if (db) db.style.display = 'none';
  setAvatarStatus('AI Caseworker', false);
}

async function speakWithAvatar(text) {
  if (!_avatarSynthesizer || !_avatarReady) throw new Error('Avatar not connected');
  const s = loadSettings();
  const voice = s.avatarVoice || 'en-US-LunaNeural';
  const audioEl = document.getElementById('audio');
  if (audioEl) audioEl.muted = false;
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='${voice}'><mstts:leadingsilence-exact value='0'/>${htmlEncodeForSSML(text)}</voice></speak>`;
  return new Promise((resolve, reject) => {
    setAvatarSpeaking(true);
    _avatarSynthesizer.speakSsmlAsync(ssml,
      (r) => {
        setAvatarSpeaking(false);
        if (r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) resolve();
        else {
          const d = SpeechSDK.CancellationDetails.fromResult(r);
          reject(new Error(d?.errorDetails || 'Avatar speak failed'));
        }
      },
      (err) => { setAvatarSpeaking(false); reject(err); }
    );
  });
}

async function ensureAvatarConnected() {
  const s = loadSettings();
  if (!s.avatarKey || !s.avatarRegion) return;
  if (_avatarReady) return;
  if (_avatarConnecting) {
    let w = 0;
    while (_avatarConnecting && w < 20000) { await sleep(300); w += 300; }
    return;
  }
  startAvatarSession();
  let w = 0;
  while (!_avatarReady && w < 20000) { await sleep(300); w += 300; }
}

function setAvatarStatus(text, speaking) {
  const lbl = document.getElementById('avatar-label');
  if (lbl) lbl.textContent = text;
  const wrap = document.getElementById('avatar-wrap');
  if (!wrap) return;
  if (speaking) wrap.classList.add('speaking'); else wrap.classList.remove('speaking');
}

function setAvatarSpeaking(speaking, label) {
  if (speaking) setAvatarStatus(label || 'Speaking…', true);
  else setAvatarStatus(_avatarIsListening ? 'Listening…' : 'AI Caseworker', false);
}

function setAvatarListening(on) {
  _avatarIsListening = on;
  const lbl = document.getElementById('avatar-label');
  const wrap = document.getElementById('avatar-wrap');
  if (!wrap) return;
  if (on) { wrap.classList.remove('speaking'); if (lbl) lbl.textContent = 'Listening…'; }
  else { if (lbl) lbl.textContent = 'AI Caseworker'; }
}

// ─── Azure Speech Neural TTS ────────────────────────────────────
async function speakWithAzureSpeech(text) {
  const s = loadSettings();
  if (!s.speechKey || !s.speechRegion) {
    throw new Error('Azure Speech is not configured. Add Speech Region and Speech API Key in Settings.');
  }
  if (typeof SpeechSDK === 'undefined') {
    throw new Error('Azure Speech SDK is not loaded.');
  }

  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
    s.speechKey,
    s.speechRegion
  );
  speechConfig.speechSynthesisLanguage = 'en-US';
  speechConfig.speechSynthesisVoiceName = s.speechVoice || 'en-US-LunaNeural';

  const audioConfig = SpeechSDK.AudioConfig.fromDefaultSpeakerOutput();
  const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, audioConfig);

  return new Promise((resolve, reject) => {
    setAvatarSpeaking(true, 'Speaking…');
    synthesizer.speakTextAsync(
      text,
      result => {
        setAvatarSpeaking(false);
        synthesizer.close();
        if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
          resolve();
          return;
        }
        const details = SpeechSDK.CancellationDetails.fromResult(result);
        reject(new Error(details?.errorDetails || 'Azure Speech synthesis failed.'));
      },
      error => {
        setAvatarSpeaking(false);
        synthesizer.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function testAzureSpeechTTS() {
  const el = document.getElementById('speech-tts-test-result');
  if (!el) return;
  el.innerHTML = '<div class="alert alert-info">⏳ Testing Azure Speech Neural Voice…</div>';
  try {
    await speakWithAzureSpeech('Hello, I am your AI caseworker. How can I help you today?');
    const voice = loadSettings().speechVoice || 'en-US-LunaNeural';
    el.innerHTML = `<div class="alert alert-success">✅ Azure Speech voice works: ${esc(voice)}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">❌ ${esc(e.message || String(e))}</div>`;
  }
}

async function testAvatarConnection() {
  const el = document.getElementById('avatar-test-result');
  if (!el) return;
  const s = loadSettings();

  el.innerHTML = '<div class="alert alert-info">⏳ Testing Azure Talking Avatar resource…</div>';

  if (!s.avatarResourceName || !s.avatarEndpoint || !s.avatarRegion || !s.avatarKey) {
    el.innerHTML = '<div class="alert alert-error">❌ Enter Avatar Resource Name, Endpoint, Region, and API Key first.</div>';
    return;
  }

  try {
    // The portal endpoint is kept as an explicit setting so the configuration
    // exactly matches what Azure shows for this Speech resource.
    const portalEndpoint = s.avatarEndpoint.replace(/\/+$/, '');

    console.log('[Avatar Test] Portal endpoint:', portalEndpoint);

    const relay = await fetchAvatarRelayToken(s);
    normalizeAvatarIceInfo(relay);

    el.innerHTML =
      `<div class="alert alert-success">✅ Avatar resource connected — ` +
      `${esc(s.avatarResourceName)} / ${esc(s.avatarRegion)}<br>` +
      `<span style="font-size:12px">Portal endpoint: ${esc(portalEndpoint)}</span></div>`;
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">❌ ${esc(e.message || String(e))}</div>`;
  }
}

// ─── Google Gemini-TTS (Cloud Text-to-Speech) ─────────────────
// Used for the interview voice when Settings > Voice service = Google. Requests go
// through server.py (POST /google-tts) with the same service-account key file.
const GOOGLE_TTS_STYLE = 'Speak warmly, clearly and calmly, at a relaxed pace, like a kind and patient social-services caseworker.';
// App language codes -> Gemini-TTS language codes where they differ.
const GOOGLE_TTS_LANG = { 'ar-SA': 'ar-001', 'zh-CN': 'cmn-CN' };

function useGoogleVoice(s) {
  s = s || loadSettings();
  return s.voiceProvider !== 'azure' && !!s.gcpProjectId;
}

// Gemini-TTS returns the audio only after the whole clip is generated, which
// takes 3–17 s. Clips are cached (same text = instant replay) and can be
// requested ahead of time with prefetchGoogleTTS() while the question is shown.
const _googleTtsCache = new Map();   // key -> Promise<base64 mp3>
const GOOGLE_TTS_CACHE_MAX = 60;

function fetchGoogleTtsAudio(text, lang) {
  const s = loadSettings();
  if (!s.gcpProjectId) return Promise.reject(new Error('Google Project ID is not set in Settings.'));
  const clean = String(text || '').trim();
  const languageCode = GOOGLE_TTS_LANG[lang] || lang || 'en-US';
  const model = s.googleTtsModel || 'gemini-2.5-flash-tts';
  const voiceName = s.googleTtsVoice || 'Kore';
  const key = [model, voiceName, languageCode, clean].join('|');

  if (_googleTtsCache.has(key)) return _googleTtsCache.get(key);

  const request = fetch('/google-tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId:       s.gcpProjectId,
      credentialsFile: s.gcpCredentialsFile || '',
      model,
      voiceName,
      languageCode,
      prompt:          GOOGLE_TTS_STYLE,
      text:            clean
    })
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.audioContent) {
      throw new Error(`Google voice ${res.status}: ${data.error?.message || data.error || 'no audio returned'}`);
    }
    return data.audioContent;
  });

  _googleTtsCache.set(key, request);
  request.catch(() => _googleTtsCache.delete(key));   // never cache failures
  if (_googleTtsCache.size > GOOGLE_TTS_CACHE_MAX) {
    _googleTtsCache.delete(_googleTtsCache.keys().next().value);
  }
  return request;
}

// ── Streaming Gemini voice (server.py POST /google-tts-stream) ──
// Audio arrives as raw 16-bit PCM (24 kHz mono) and is played chunk by chunk,
// so speech starts after ~0.7 s instead of after the whole clip is generated.
// A clip is cached while and after it streams: a prefetch that is still running
// is simply joined by Play, and replays are instant.
const GOOGLE_TTS_STREAM_RATE = 24000;
const _googleTtsStreams = new Map();   // key -> clip
const GOOGLE_TTS_STREAM_CACHE_MAX = 40;
let _googleTtsAudioCtx = null;

function googleTtsStreamClip(text, lang) {
  const s = loadSettings();
  const clean = String(text || '').trim();
  const languageCode = GOOGLE_TTS_LANG[lang] || lang || 'en-US';
  const model = s.googleTtsModel || 'gemini-2.5-flash-tts';
  const voiceName = s.googleTtsVoice || 'Kore';
  const key = [model, voiceName, languageCode, clean].join('|');
  if (_googleTtsStreams.has(key)) return _googleTtsStreams.get(key);

  const clip = { chunks: [], done: false, error: null, listeners: new Set() };
  const notify = () => clip.listeners.forEach(fn => fn());
  _googleTtsStreams.set(key, clip);
  if (_googleTtsStreams.size > GOOGLE_TTS_STREAM_CACHE_MAX) {
    _googleTtsStreams.delete(_googleTtsStreams.keys().next().value);
  }

  (async () => {
    try {
      if (!s.gcpProjectId) throw new Error('Google Project ID is not set in Settings.');
      const res = await fetch('/google-tts-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId:       s.gcpProjectId,
          credentialsFile: s.gcpCredentialsFile || '',
          model, voiceName, languageCode,
          prompt:          GOOGLE_TTS_STYLE,
          text:            clean
        })
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(`Google voice stream ${res.status}: ${data.error?.message || 'no audio'}`);
      }
      const reader = res.body.getReader();
      let carry = null;   // odd trailing byte between network chunks
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let bytes = value;
        if (carry) { bytes = new Uint8Array(carry.length + value.length); bytes.set(carry); bytes.set(value, carry.length); carry = null; }
        if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.slice(0, -1); }
        if (bytes.byteOffset % 2) bytes = bytes.slice();   // Int16Array needs 2-byte alignment
        if (bytes.length) { clip.chunks.push(bytes); notify(); }
      }
      if (!clip.chunks.length) throw new Error('Google voice stream returned no audio');
    } catch (e) {
      clip.error = e;
      if (!clip.chunks.length) _googleTtsStreams.delete(key);   // never cache failures
    } finally {
      clip.done = true;
      notify();
    }
  })();

  return clip;
}

// Plays a (possibly still streaming) clip. Resolves when playback ends or is
// stopped; rejects only if the stream failed before any audio arrived.
function playGoogleTtsClip(clip) {
  if (!_googleTtsAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    _googleTtsAudioCtx = new Ctx({ sampleRate: GOOGLE_TTS_STREAM_RATE });
  }
  const ctx = _googleTtsAudioCtx;
  if (ctx.state === 'suspended') ctx.resume();

  return new Promise((resolve, reject) => {
    const sources = new Set();
    let next = 0;            // index of the next chunk to schedule
    let playAt = 0;          // AudioContext time for the next chunk
    let stopped = false;
    let started = false;

    const finish = (err) => {
      if (stopped) return;
      stopped = true;
      clip.listeners.delete(pump);
      sources.forEach(src => { try { src.stop(); } catch (_) {} });
      setAvatarSpeaking(false);
      if (_currentAudio === player) _currentAudio = null;
      err ? reject(err) : resolve();
    };

    // stopCurrentAudio() calls pause() on whatever is playing.
    const player = { pause: () => finish(), currentTime: 0 };
    _currentAudio = player;

    const maybeEnd = () => {
      if (clip.done && next >= clip.chunks.length && sources.size === 0) {
        if (!started && clip.error) finish(clip.error);
        else finish();
      }
    };

    function pump() {
      if (stopped) return;
      while (next < clip.chunks.length) {
        const bytes = clip.chunks[next++];
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
        const buf = ctx.createBuffer(1, pcm.length, GOOGLE_TTS_STREAM_RATE);
        const out = buf.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        // Small lead on the first chunk (and after any network stall) absorbs jitter.
        playAt = Math.max(playAt, ctx.currentTime + 0.12);
        src.start(playAt);
        playAt += buf.duration;
        sources.add(src);
        src.onended = () => { sources.delete(src); maybeEnd(); };
        if (!started) { started = true; setAvatarSpeaking(true, 'Speaking…'); }
      }
      maybeEnd();
    }

    clip.listeners.add(pump);
    pump();
  });
}

// Starts generating a clip in the background so a later Play is instant.
function prefetchGoogleTTS(text, lang) {
  if (!String(text || '').trim() || !useGoogleVoice()) return;
  googleTtsStreamClip(text, lang);
}

async function speakWithGoogleTTS(text, lang) {
  const clean = String(text || '').trim();
  if (!clean) return;

  // Streaming first; the older whole-clip endpoint is the fallback.
  try {
    return await playGoogleTtsClip(googleTtsStreamClip(clean, lang));
  } catch (e) {
    console.warn('Google voice stream failed, using whole-clip request:', e.message);
  }

  const audioContent = await fetchGoogleTtsAudio(clean, lang);

  const audio = new Audio('data:audio/mp3;base64,' + audioContent);
  _currentAudio = audio;
  return new Promise(resolve => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      setAvatarSpeaking(false);
      if (_currentAudio === audio) _currentAudio = null;
      resolve();
    };
    audio.onplay  = () => setAvatarSpeaking(true, 'Speaking…');
    audio.onended = done;
    audio.onerror = done;
    audio.onpause = done;   // stopCurrentAudio() pauses it
    audio.play().catch(done);
  });
}

async function testGoogleVoice() {
  const el = document.getElementById('google-tts-test-result');
  if (el) el.innerHTML = '<div class="alert alert-info">⏳ Testing Gemini voice…</div>';
  try {
    useVoiceFieldsOnScreen();
    await speakWithGoogleTTS('Hello, I am your AI caseworker. How can I help you today?', 'en-US');
    const s = loadSettings();
    if (el) el.innerHTML = `<div class="alert alert-success">✅ Gemini voice works: ${esc(s.googleTtsVoice || 'Kore')} (${esc(s.googleTtsModel || 'gemini-2.5-flash-tts')})</div>`;
  } catch (e) {
    if (el) el.innerHTML = `<div class="alert alert-error">❌ ${esc(e.message || String(e))}</div>`;
  }
}

// Lets "Test Gemini Voice" use the values on screen before Save Settings.
function useVoiceFieldsOnScreen() {
  const v = id => (document.getElementById(id)?.value || '').trim();
  const patch = {};
  if (v('s-gcp-project'))       patch.gcpProjectId   = v('s-gcp-project');
  if (v('s-google-tts-model'))  patch.googleTtsModel = v('s-google-tts-model');
  if (v('s-google-tts-voice'))  patch.googleTtsVoice = v('s-google-tts-voice');
  window.AIC_CONFIG = Object.assign({}, window.AIC_CONFIG || {}, patch);
}

// ─── speakTextInLanguage: speaks with a native voice for non-English text ───
// English keeps using speakText() exactly as before.
async function speakWithAzureSpeechVoice(text, lang, voiceName) {
  const s = loadSettings();
  if (!s.speechKey || !s.speechRegion) throw new Error('Azure Speech is not configured.');
  if (typeof SpeechSDK === 'undefined') throw new Error('Azure Speech SDK is not loaded.');
  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(s.speechKey, s.speechRegion);
  speechConfig.speechSynthesisLanguage = lang;
  if (voiceName) speechConfig.speechSynthesisVoiceName = voiceName;
  const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, SpeechSDK.AudioConfig.fromDefaultSpeakerOutput());
  return new Promise((resolve, reject) => {
    setAvatarSpeaking(true, 'Speaking…');
    synthesizer.speakTextAsync(text, result => {
      setAvatarSpeaking(false);
      synthesizer.close();
      if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) { resolve(); return; }
      const details = SpeechSDK.CancellationDetails.fromResult(result);
      reject(new Error(details?.errorDetails || 'Azure Speech synthesis failed.'));
    }, error => {
      setAvatarSpeaking(false);
      synthesizer.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function speakTextInLanguage(text, lang, voiceName) {
  if (!lang || lang === 'en-US') return speakText(text);
  stopCurrentAudio();
  const s = loadSettings();
  if (useGoogleVoice(s)) {
    try { return await speakWithGoogleTTS(text, lang); }
    catch (e) { console.warn('Google voice (' + lang + ') failed:', e.message); }
  }
  if (s.speechKey && s.speechRegion) {
    try { return await speakWithAzureSpeechVoice(text, lang, voiceName); }
    catch (e) { console.warn('Azure Speech (' + lang + ') failed:', e.message); }
  }
  // Fallback: browser voice for that language, if the browser has one.
  return new Promise(resolve => {
    if (!window.speechSynthesis) { resolve(); return; }
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang;
    utt.rate = 0.9;
    utt.onstart = () => setAvatarSpeaking(true);
    utt.onend   = () => { setAvatarSpeaking(false); resolve(); };
    utt.onerror = () => { setAvatarSpeaking(false); resolve(); };
    speechSynthesis.speak(utt);
  });
}

// ─── speakText (priority: Avatar → Google Gemini voice → Azure Speech Neural → Browser) ───
async function speakText(text) {
  const s = loadSettings();
  stopCurrentAudio();

  if (_avatarReady) {
    try { return await speakWithAvatar(text); }
    catch(e) { console.warn('Avatar speak failed:', e.message); }
  }

  if (useGoogleVoice(s)) {
    try { return await speakWithGoogleTTS(text, 'en-US'); }
    catch(e) { console.warn('Google voice failed:', e.message); }
  }

  if (s.speechKey && s.speechRegion) {
    try { return await speakWithAzureSpeech(text); }
    catch(e) { console.warn('Azure Speech Neural TTS failed:', e.message); }
  }

  // Last-resort fallback. This is the robotic browser voice.
  return new Promise(resolve => {
    if (!window.speechSynthesis) { resolve(); return; }
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'en-US';
    utt.rate = 0.9;
    utt.onstart = () => setAvatarSpeaking(true);
    utt.onend   = () => { setAvatarSpeaking(false); resolve(); };
    utt.onerror = () => { setAvatarSpeaking(false); resolve(); };
    speechSynthesis.speak(utt);
  });
}

// ─── Mic / listening helpers (Azure Speech SDK) ──────────────
let _sdkRecognizer = null;
let _convListenFinish = null;
let _convMicWarmedUp = false;
let _convFirstSuccessfulCaptureDone = false;

// Demo-only name hints. These improve STT accuracy but must never override
// what the client actually says or spells.
const DEMO_NAME_HINTS = [
  'Mona',
  'Esrafilzadeh',
  'Mona Esrafilzadeh'
];

async function warmUpConversationMicrophone() {
  if (_convMicWarmedUp || !navigator.mediaDevices?.getUserMedia) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });

    // Permission is now granted and the audio device is initialized.
    stream.getTracks().forEach(track => track.stop());
    _convMicWarmedUp = true;

    // Give the browser/audio driver a brief moment to release the warm-up stream.
    await new Promise(resolve => setTimeout(resolve, 250));
  } catch (e) {
    console.warn('[Conversation Mic] Warm-up failed; Speech SDK will use the default mic.', e);
  }
}

function updateMicUI(on) {
  const btn = document.getElementById('btn-mic');
  if (!btn) return;
  btn.textContent = on ? '⏹ Stop' : '🎙 Speak';
  btn.className   = on ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm';
}

function stopListening() {
  if (typeof _convListenFinish === 'function') {
    _convListenFinish();
    return;
  }

  _isListening = false;
  if (_sdkRecognizer) {
    try { _sdkRecognizer.stopContinuousRecognitionAsync(); } catch(e) {}
    try { _sdkRecognizer.close(); } catch(e) {}
    _sdkRecognizer = null;
  }
  updateMicUI(false);
  setAvatarListening(false);
}

// _convSttMeta accumulates merged STT metadata across follow-up listens
let _convSttMeta = null;



function isConversationConfirmationTurn() {
  const state = conv.workflowCtx?.state;

  if (
    state === WF_STATE.CONFIRMING ||
    state === WF_STATE.RECONFIRMING
  ) {
    return true;
  }

  // The UI prompt is a second source of truth. On some machines the state
  // can briefly remain COLLECTING_SPELLING even though the next prompt is
  // already a confirmation question.
  const promptText = [
    conv.workflowPrompt || '',
    document.getElementById('conv-workflow-prompt')?.textContent || '',
    document.getElementById('r-followup')?.textContent || ''
  ]
    .join(' ')
    .toLowerCase();

  const asksForConfirmation =
    /\b(confirm|is that correct|is this correct|is .* correct|spelling correct)\b/i
      .test(promptText);

  return (
    conv.workflowCtx?.fieldKey === 'full_name' &&
    asksForConfirmation
  );
}

async function listenForConversationConfirmation(previousText = '') {
  const s = loadSettings();

  if (!s.speechKey || !s.speechRegion) {
    toast(
      'Configure Azure Speech Key & Region in Settings → Azure Talking Avatar',
      'error'
    );
    return previousText;
  }

  await warmUpConversationMicrophone();

  return new Promise((resolve) => {
    let completed = false;
    let recognizer = null;

    const textarea =
      document.getElementById('client-answer');

    const finish = (captured = '') => {
      if (completed) return;
      completed = true;

      _isListening = false;
      updateMicUI(false);
      setAvatarListening(false);
      _convListenFinish = null;
      _sdkRecognizer = null;

      if (recognizer) {
        try { recognizer.close(); } catch (_) {}
        recognizer = null;
      }

      const combined = previousText
        ? [previousText.trim(), captured.trim()]
            .filter(Boolean)
            .join(' ')
        : captured.trim();

      if (textarea) textarea.value = combined;

      if (captured) {
        _convSttMeta = {
          text: combined,
          rawJson: null,
          confidence: null,
          lexical: '',
          alternatives: []
        };
      }

      resolve(combined || previousText);
    };

    _convListenFinish = () => finish('');
    _isListening = true;
    updateMicUI(true);
    setAvatarListening(true);

    try {
      // IMPORTANT:
      // Confirmation uses a completely fresh, minimal SpeechConfig.
      // No phrase list, no detailed output, no spelling properties.
      const speechConfig =
        SpeechSDK.SpeechConfig.fromSubscription(
          s.speechKey,
          s.speechRegion
        );

      // Client Intake: recognize speech in the interview language chosen at the top.
      speechConfig.speechRecognitionLanguage =
        (typeof clientIntakeRecognitionLanguage === 'function')
          ? clientIntakeRecognitionLanguage()
          : 'en-US';

      const audioConfig =
        SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();

      recognizer =
        new SpeechSDK.SpeechRecognizer(
          speechConfig,
          audioConfig
        );

      _sdkRecognizer = recognizer;

      console.log(
        '[Conversation STT] Confirmation recognizer started: minimal one-shot profile'
      );

      recognizer.recognizeOnceAsync(
        result => {
          if (
            result.reason ===
              SpeechSDK.ResultReason.RecognizedSpeech &&
            result.text
          ) {
            finish(result.text.trim());
            return;
          }

          if (
            result.reason ===
              SpeechSDK.ResultReason.Canceled
          ) {
            const details =
              SpeechSDK.CancellationDetails.fromResult(
                result
              );

            console.warn(
              '[Conversation STT] Confirmation canceled:',
              details?.reason,
              details?.errorDetails || ''
            );

            if (details?.errorDetails) {
              toast(
                'Speech recognition error: ' +
                  String(details.errorDetails).slice(0, 120),
                'error'
              );
            }
          }

          finish('');
        },
        error => {
          console.error(
            '[Conversation STT] Confirmation start error:',
            error
          );

          toast(
            'Speech recognition error: ' +
              String(error).slice(0, 120),
            'error'
          );

          finish('');
        }
      );
    } catch (error) {
      console.error(
        '[Conversation STT] Confirmation setup error:',
        error
      );

      toast(
        'Speech recognition error: ' +
          String(error).slice(0, 120),
        'error'
      );

      finish('');
    }
  });
}

async function listenForAnswer(previousText = '') {
  const isConfirmationTurn =
    isConversationConfirmationTurn();

  // Client Intake recording is fully manual. Even confirmation turns use the
  // continuous recognizer and end only when the user presses Stop.
  const s = loadSettings();
  if (!s.speechKey || !s.speechRegion) {
    toast('Configure Azure Speech Key & Region in Settings → Azure Talking Avatar', 'error');
    return previousText;
  }

  // The first attempt used to end too early while Chrome was still opening
  // and authorizing the microphone. Warm it up before starting Azure STT.
  await warmUpConversationMicrophone();

  return new Promise((resolve) => {
    let finished = false;
    let hasSpeech = false;
    let finalParts = [];
    let latestPartial = '';
    let latestMeta = null;
    let silenceTimer = null;
    let initialTimer = null;
    let hardStopTimer = null;

    const textarea = document.getElementById('client-answer');

    const visibleText = () => {
      const current = [finalParts.join(' ').trim(), latestPartial.trim()]
        .filter(Boolean)
        .join(' ')
        .trim();

      return previousText
        ? [previousText.trim(), current].filter(Boolean).join(' ')
        : current;
    };

    const updateVisibleText = () => {
      if (textarea) textarea.value = visibleText();
    };

    const cleanupRecognizer = () => {
      clearTimeout(silenceTimer);
      clearTimeout(initialTimer);
      clearTimeout(hardStopTimer);

      _isListening = false;
      updateMicUI(false);
      setAvatarListening(false);
      _convListenFinish = null;

      const recognizer = _sdkRecognizer;
      _sdkRecognizer = null;

      if (!recognizer) return;

      try {
        recognizer.stopContinuousRecognitionAsync(
          () => {
            try { recognizer.close(); } catch (_) {}
          },
          () => {
            try { recognizer.close(); } catch (_) {}
          }
        );
      } catch (_) {
        try { recognizer.close(); } catch (_) {}
      }
    };

    const finish = () => {
      if (finished) return;
      finished = true;

      const captured = finalParts.join(' ').trim() || latestPartial.trim();
      const combined = previousText
        ? [previousText.trim(), captured].filter(Boolean).join(' ')
        : captured;

      cleanupRecognizer();

      if (captured) {
        _convFirstSuccessfulCaptureDone = true;
        // Mark that the currently displayed question/follow-up has received a
        // fresh spoken response. doAnalyze() uses this to reject stale/duplicate
        // analysis calls, especially after Follow-up 3/3 is displayed.
        if (typeof conv !== 'undefined') {
          conv.answerReadyForCurrentPrompt = true;
        }

        const meta = latestMeta || {
          text: captured,
          rawJson: null,
          confidence: null,
          lexical: '',
          alternatives: []
        };

        if (!_convSttMeta) {
          _convSttMeta = { ...meta, text: combined };
        } else {
          _convSttMeta.text = combined;
          _convSttMeta.lexical = [
            _convSttMeta.lexical,
            meta.lexical
          ].filter(Boolean).join(' ');
          _convSttMeta.alternatives = [...(meta.alternatives || [])];
          _convSttMeta.confidence = meta.confidence != null
            ? Math.min(_convSttMeta.confidence ?? 1, meta.confidence)
            : _convSttMeta.confidence;
        }
      }

      if (textarea) textarea.value = combined;
      resolve(combined || previousText);
    };

    const restartEndSilenceTimer = () => {};

    _convListenFinish = finish;
    _isListening = true;
    updateMicUI(true);
    setAvatarListening(true);

    try {
      const speechConfig =
        SpeechSDK.SpeechConfig.fromSubscription(s.speechKey, s.speechRegion);

      // Client Intake: recognize speech in the interview language chosen at the top.
      speechConfig.speechRecognitionLanguage =
        (typeof clientIntakeRecognitionLanguage === 'function')
          ? clientIntakeRecognitionLanguage()
          : 'en-US';

      try {
        speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;
      } catch (_) {}

      try {
        speechConfig.setProperty(
          'SpeechServiceResponse_RequestDetailedResultTrueFalse',
          'true'
        );
        speechConfig.setProperty(
          'SpeechServiceConnection_InitialSilenceTimeoutMs',
          '15000'
        );
        const isSpellingStep =
          conv.workflowCtx?.state === WF_STATE.COLLECTING_SPELLING;

        speechConfig.setProperty(
          'Speech_SegmentationSilenceTimeoutMs',
          isSpellingStep ? '7000' : '3000'
        );
      } catch (_) {}

      const audioConfig =
        SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();

      _sdkRecognizer =
        new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

      // Bias Azure Speech toward the known demo name without forcing it.
      // Never attach the name phrase list during confirmation.
      try {
        if (
          !isConversationConfirmationTurn() &&
          SpeechSDK.PhraseListGrammar?.fromRecognizer
        ) {
          const phraseList =
            SpeechSDK.PhraseListGrammar.fromRecognizer(_sdkRecognizer);

          DEMO_NAME_HINTS.forEach(name => phraseList.addPhrase(name));

          if (typeof phraseList.setWeight === 'function') {
            phraseList.setWeight(
              conv.workflowCtx?.state === WF_STATE.COLLECTING_SPELLING
                ? 2.0
                : 1.7
            );
          }

          console.log(
            '[Conversation STT] Demo name phrase hints applied:',
            DEMO_NAME_HINTS
          );
        }
      } catch (e) {
        console.warn('[Conversation STT] Phrase hints unavailable:', e);
      }

      _sdkRecognizer.recognizing = (_, event) => {
        if (finished) return;

        const partial = (event.result?.text || '').trim();
        if (!partial) return;

        hasSpeech = true;
        latestPartial = partial;
        updateVisibleText();
        restartEndSilenceTimer();
      };

      _sdkRecognizer.recognized = (_, event) => {
        if (finished) return;

        if (
          event.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
          event.result.text
        ) {
          const part = event.result.text.trim();

          if (part) {
            hasSpeech = true;
            finalParts.push(part);
            latestPartial = '';
            latestMeta = parseSttDetail(event.result);
            updateVisibleText();
            restartEndSilenceTimer();
          }
        }
      };

      _sdkRecognizer.canceled = async (_, event) => {
        const errorText =
          String(event.errorDetails || '');

        console.warn(
          '[Conversation STT] canceled:',
          event.reason,
          errorText
        );

        const shouldRetryAsConfirmation =
          errorText.includes('1007') &&
          isConversationConfirmationTurn();

        if (shouldRetryAsConfirmation) {
          if (finished) return;
          finished = true;

          cleanupRecognizer();

          console.warn(
            '[Conversation STT] Retrying websocket 1007 with minimal confirmation recognizer'
          );

          await sleep(500);

          const retryText =
            await listenForConversationConfirmation(previousText);

          if (textarea) textarea.value = retryText || previousText;
          resolve(retryText || previousText);
          return;
        }

        if (
          event.reason === SpeechSDK.CancellationReason.Error &&
          errorText
        ) {
          toast(
            'Speech recognition error: ' +
              errorText.slice(0, 120),
            'error'
          );
        }

        finish();
      };

      _sdkRecognizer.sessionStopped = () => {
        if (!finished) finish();
      };

      _sdkRecognizer.startContinuousRecognitionAsync(
        () => {
          const isSpellingStep =
            conv.workflowCtx?.state === WF_STATE.COLLECTING_SPELLING &&
            !isConversationConfirmationTurn();

          console.log(
            '[Conversation STT] Continuous recognition started; profile:',
            isSpellingStep
              ? 'spelling — 7s end silence'
              : (_convFirstSuccessfulCaptureDone
                  ? 'normal — 3s end silence'
                  : 'first capture — 5s end silence'),
            {
              state: conv.workflowCtx?.state,
              confirmationDetected:
                isConversationConfirmationTurn()
            }
          );

        },
        (err) => {
          console.error('[Conversation STT] start error:', err);
          toast(
            'Speech recognition error: ' + String(err).slice(0, 120),
            'error'
          );
          finish();
        }
      );
    } catch (err) {
      console.error('[Conversation STT] setup error:', err);
      toast(
        'Speech recognition error: ' + String(err).slice(0, 120),
        'error'
      );
      finish();
    }
  });
}

async function toggleListen() {
  if (_isListening) {
    // Recording ends only when the user explicitly presses Stop.
    stopListening();

    // finish() updates the read-only answer field synchronously. Defer analysis
    // one tick so the recognition cleanup/UI state can settle first.
    setTimeout(() => {
      const answer = (document.getElementById('client-answer')?.value || '').trim();
      const analyzeBtn = document.getElementById('btn-analyze');

      if (answer && analyzeBtn && !analyzeBtn.disabled) {
        doAnalyze();
      }
    }, 0);
    return;
  }

  await listenForAnswer('');
}


// ─── renderConv (manual conversation + speech) ─────────────────
function renderConv() {
  const el = document.getElementById('conversation-content');

  if (conv.phase === 'done') {
    el.innerHTML = `<div class="card"><div class="conv-complete">
      <div class="ci">🎉</div><h2>Interview Complete!</h2>
      <p>All ${conv.questions.length} questions answered and saved.</p>
      <div class="row" style="justify-content:center;gap:10px">
        <button class="btn btn-primary" onclick="show('responses')">📊 View Responses</button>
        <button class="btn btn-secondary" onclick="initConversation()">🔄 Start Again</button>
      </div>
    </div></div>`;
    return;
  }

  const q     = conv.questions[conv.index];
  const total = conv.questions.length;
  const pct   = Math.round((conv.index / total) * 100);
el.innerHTML = `
    ${typeof clientIntakeLanguageBarHTML === 'function' ? clientIntakeLanguageBarHTML() : ''}

    <!-- Progress -->
    <div class="conv-progress">
      <span class="conv-progress-label">Question ${conv.index+1} of ${total}</span>
      <div class="conv-progress-bar-wrap">
        <div class="conv-progress-bar" style="width:${pct}%"></div>
      </div>
      <span class="conv-pct-label">${pct}%</span>
    </div>

    <!-- Current question -->
    <div class="conv-q-box">
      <div id="conv-active-label" class="conv-q-label">${conv.index+1} / ${total} &nbsp;·&nbsp; ${esc(q.category||'General')}</div>
      <div id="conv-active-question" class="conv-q-main">${esc(q.question)}</div>
      <div id="conv-active-question-en" class="conv-q-en" style="display:none"></div>
      <div class="conv-q-hints">
        <span>⭐ Priority: <strong>${q.priority||'medium'}</strong></span>
        ${q.required ? '<span>🔴 Required</span>' : '<span style="color:var(--text-light)">⚪ Optional</span>'}
      </div>
      ${q.expectedAnswer ? `<div id="conv-active-expected" class="conv-q-expected">💡 Expected: ${esc(q.expectedAnswer)}</div>` : `<div id="conv-active-expected" style="display:none"></div>`}
      <div style="margin-top:13px;display:flex;gap:8px;flex-wrap:wrap">
        <button id="btn-play-q" class="btn btn-secondary btn-sm"
          onclick="playClientIntakePrompt()">🔊 Play Question</button>
        <button id="btn-mic" class="btn btn-secondary btn-sm"
          onclick="toggleListen()">🎙 Speak</button>
      </div>
    </div>

    <!-- Answer input -->
    <div class="conv-answer-box">
      <div id="conv-workflow-prompt"
        style="display:none;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:6px;padding:9px 11px;margin-bottom:10px;font-size:13px"></div>
      <label id="client-answer-label" style="margin-bottom:8px;display:block;font-weight:600">Client's Answer</label>
      <textarea id="client-answer" dir="auto" readonly aria-readonly="true" placeholder="The client's spoken answer will appear here…" style="min-height:90px;background:#f8fafc;cursor:default"></textarea>
      <div class="row mt-12">
        <button id="btn-analyze" class="btn btn-primary" onclick="doAnalyze()">🔍 Analyze Answer</button>
      </div>
    </div>

    <!-- Analysis box -->
    <div class="conv-analysis-box" id="analysis-box">
      <div class="card-title" style="color:var(--success);margin-bottom:14px">🧠 AI Analysis</div>
      <div class="a-row"><div class="a-label">Original Answer</div><div class="a-value" id="r-original"></div></div>
      <div class="a-row"><div class="a-label">AI Interpreted</div><div class="a-value" id="r-interpreted"></div></div>
      <div id="r-normalized-wrap" style="display:none" class="a-row">
        <div class="a-label">Normalized Value</div><div class="a-value" id="r-normalized"></div>
      </div>
      <div id="r-incomplete-wrap" style="display:none"></div>
      <div id="r-followup-wrap" style="display:none" class="a-row">
        <div class="a-label">Suggested Follow-up</div>
        <div class="a-value" id="r-followup" style="color:var(--warning)"></div>
      </div>
      <hr class="divider">
      <div class="a-row">
        <div class="a-label">Final Answer <span style="font-weight:400">(edit this only if correction is needed)</span></div>
        <textarea id="corrected-answer" style="min-height:64px" placeholder="Edit if needed…"></textarea>
      </div>
      <div class="mt-12">
        <button id="btn-save-next" class="btn btn-success" onclick="saveAndNext()" style="display:none" disabled>✅ Save &amp; Next</button>
      </div>
    </div>`;

  if (typeof updateClientIntakePromptUi === 'function') updateClientIntakePromptUi();
}

// ─── Init ─────────────────────────────────────────────────────

// ─── Dedicated Avatar Page ────────────────────────────────────
let _av = {
  synthesizer: null,
  peerConn:    null,
  ready:       false,
  connecting:  false
};

function avSetStatus(text, color) {
  const el  = document.getElementById('av-status-text');
  const dot = document.getElementById('av-dot');
  if (el)  el.innerHTML = `<span id="av-dot" style="width:8px;height:8px;border-radius:50%;background:${color||'#cbd5e1'};flex-shrink:0;${color==='#22c55e'?'animation:dotPulse .7s ease-in-out infinite alternate':''}"></span> ${text}`;
}

function avSetButtons(connected) {
  const start = document.getElementById('av-btn-start');
  const stop  = document.getElementById('av-btn-stop');
  const speak = document.getElementById('av-btn-speak');
  const ss    = document.getElementById('av-btn-stop-speak');
  if (start) start.disabled = connected;
  if (stop)  stop.disabled  = !connected;
  if (speak) speak.disabled = !connected;
  if (ss)    ss.disabled    = !connected;
}

function initAvatarPage() {
  const s   = loadSettings();
  const cfg = document.getElementById('av-config-info');
  if (cfg) {
    if (s.avatarKey && s.avatarRegion && s.avatarResourceName) {
      cfg.innerHTML = `<strong>Resource:</strong> ${s.avatarResourceName}<br>
        <strong>Region:</strong> ${s.avatarRegion}<br>
        <span style="color:var(--success)">✓ Credentials configured</span>`;
    } else {
      cfg.innerHTML = `<span style="color:var(--danger)">⚠ No Azure Speech credentials.<br>Go to Settings → Azure Talking Avatar.</span>`;
    }
  }
  avSetButtons(_av.ready);
  if (_av.ready) avSetStatus('Connected', '#22c55e');
  // Only show interview panel if an active session exists
  const panel = document.getElementById('av-interview-panel');
  if (panel) panel.style.display = _av.ready ? 'flex' : 'none';
}

async function avStartSession() {
  const s = loadSettings();
  if (!s.avatarKey || !s.avatarRegion || !s.avatarResourceName) {
    toast('Configure Resource Name, Region & Speech Key in Settings → Azure Talking Avatar', 'error'); return;
  }
  if (_av.connecting || _av.ready) return;
  _av.connecting = true;

  const btn = document.getElementById('av-btn-start');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Connecting…'; }
  avSetStatus('Getting relay info…', '#f59e0b');

  try {
    // 1. ICE relay token
    const iceInfo = await fetchAvatarRelayToken(s);
    const ice = normalizeAvatarIceInfo(iceInfo);

    // 2. WebRTC peer connection
    _av.peerConn = new RTCPeerConnection({
      iceServers: [{ urls: [ice.turnUrl], username: ice.username, credential: ice.credential }]
    });

    _av.peerConn.ontrack = (event) => {
      if (event.track.kind === 'video') {
        document.getElementById('av-placeholder')?.remove();
        const container = document.getElementById('av-remote-video');
        let vid = document.getElementById('av-vid');
        if (!vid) {
          vid = document.createElement('video');
          vid.id = 'av-vid'; vid.autoplay = true; vid.playsInline = true;
          vid.style.cssText = 'width:100%;height:100%;object-fit:cover;';
          if (container) container.appendChild(vid);
        }
        vid.srcObject = event.streams[0];
        const ov = document.getElementById('av-overlay');
        if (ov) ov.style.display = 'none';
      }
      if (event.track.kind === 'audio') {
        let aud = document.getElementById('av-aud');
        if (!aud) {
          aud = document.createElement('audio');
          aud.id = 'av-aud'; aud.autoplay = true;
          document.body.appendChild(aud);
        }
        aud.srcObject = event.streams[0];
      }
    };

    _av.peerConn.oniceconnectionstatechange = () => {
      const st = _av.peerConn.iceConnectionState;
      avSetStatus('WebRTC: ' + st, '#f59e0b');
      if (st === 'disconnected' || st === 'failed') {
        _av.ready = false; _av.connecting = false;
        avSetStatus('Disconnected', '#ef4444');
        avSetButtons(false);
        if (btn) { btn.disabled = false; btn.innerHTML = '▶ Start Session'; }
        const ov = document.getElementById('av-overlay');
        if (ov) ov.style.display = '';
      }
    };

    _av.peerConn.addTransceiver('video', { direction: 'sendrecv' });
    _av.peerConn.addTransceiver('audio', { direction: 'sendrecv' });

    // 3. SpeechConfig — exact match to working sample
    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(s.avatarKey, s.avatarRegion);
    speechConfig.speechSynthesisLanguage = 'en-US';
    speechConfig.speechSynthesisVoiceName = s.avatarVoice || 'en-US-LunaNeural';

    // 4. AvatarConfig — exact match to working sample
    const avatarConfig = new SpeechSDK.AvatarConfig(s.avatarCharacter || 'lisa', s.avatarStyle || 'casual-sitting');
    avatarConfig.backgroundColor = '#FFFFFFFF';

    _av.synthesizer = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);

    // 5. Start
    avSetStatus('Connecting avatar…', '#f59e0b');
    const result = await _av.synthesizer.startAvatarAsync(_av.peerConn);
    if (result.reason !== SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
      const d = SpeechSDK.CancellationDetails.fromResult(result);
      throw new Error(d.errorDetails || 'Avatar connection failed');
    }

    _av.ready = true; _av.connecting = false;
    avSetStatus('Connected', '#22c55e');
    avSetButtons(true);
    if (btn) { btn.disabled = false; btn.innerHTML = '▶ Start Session'; }

    // Auto-start interview: welcome + questions
    avStartInterview();

  } catch(err) {
    _av.connecting = false; _av.ready = false;
    avSetStatus('Error: ' + err.message.slice(0, 80), '#ef4444');
    toast('Avatar error: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '▶ Start Session'; }
  }
}

function avStopSession() {
  if (_av.synthesizer) { try { _av.synthesizer.close(); } catch(e) {} _av.synthesizer = null; }
  _av.peerConn = null; _av.ready = false; _av.connecting = false;
  _avInterview = { questions: [], index: 0, active: false };
  const rv = document.getElementById('av-remote-video');
  if (rv) rv.innerHTML = '';
  const ov = document.getElementById('av-overlay');
  if (ov) ov.style.display = '';
  const panel = document.getElementById('av-interview-panel');
  if (panel) panel.style.display = 'none';
  const abox = document.getElementById('av-analysis-box');
  if (abox) abox.style.display = 'none';
  avSetStatus('Disconnected', '#ef4444');
  avSetButtons(false);
  const btn = document.getElementById('av-btn-start');
  if (btn) { btn.disabled = false; btn.innerHTML = '▶ Start Session'; }
}

async function avSpeak() {
  if (!_av.synthesizer || !_av.ready) { toast('Avatar not connected', 'error'); return; }
  const text = (document.getElementById('av-speak-text')?.value || '').trim();
  if (!text) { toast('Enter some text first', 'info'); return; }

  const btn = document.getElementById('av-btn-speak');
  const ss  = document.getElementById('av-btn-stop-speak');
  if (btn) btn.disabled = true;
  if (ss)  ss.disabled  = false;
  avSetStatus('Speaking…', '#3b82f6');

  try {
    const result = await _av.synthesizer.speakTextAsync(text);
    if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
      avSetStatus('Connected', '#22c55e');
    } else {
      const d = SpeechSDK.CancellationDetails.fromResult(result);
      toast('Speak failed: ' + (d?.errorDetails || 'unknown'), 'error');
      avSetStatus('Connected', '#22c55e');
    }
  } catch(err) {
    toast('Speak error: ' + err, 'error');
    avSetStatus('Connected', '#22c55e');
  } finally {
    if (btn) btn.disabled = false;
    if (ss)  ss.disabled  = true;
  }
}

function avStopSpeaking() {
  if (_av.synthesizer) {
    _av.synthesizer.stopSpeakingAsync(
      () => { avSetStatus('Connected', '#22c55e'); },
      (e) => console.warn('stopSpeaking error:', e)
    );
  }
  const ss = document.getElementById('av-btn-stop-speak');
  if (ss) ss.disabled = true;
}

// ─── Avatar mic recording ────────────────────────────────────────────────────
let _avMicActive = false;
let _avMicRecorder = null;

let _avRecognizer = null;

// Stop any active recognizer
function avStopListening() {
  _avMicActive = false;
  const listenInd = document.getElementById('av-listen-indicator');
  if (listenInd) listenInd.style.display = 'none';
  if (_avRecognizer) {
    try { _avRecognizer.close(); } catch(e) {}
    _avRecognizer = null;
  }
}

// Core listen function — used by both manual mic button and auto-listen
// initialSilenceMs: how long to wait for first word before giving up
// endSilenceMs: how long silence after speech before stopping
// Parses Azure Speech detailed JSON into a structured STT metadata object
function parseSttDetail(result) {
  const text = result.text || '';
  let rawJson = null, confidence = null, lexical = '', alternatives = [];
  try {
    rawJson = result.properties.getProperty(SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult);
    if (rawJson) {
      const d = JSON.parse(rawJson);
      confidence   = d?.NBest?.[0]?.Confidence ?? null;
      lexical      = d?.NBest?.[0]?.Lexical    ?? '';
      alternatives = (d?.NBest || []).map(n => ({
        display:    n.Display    || '',
        lexical:    n.Lexical    || '',
        confidence: n.Confidence ?? 0
      }));
    }
  } catch(e) { console.warn('[parseSttDetail]', e); }
  return { text, rawJson, confidence, lexical, alternatives };
}

function avListen(initialSilenceMs, endSilenceMs, languageCode) {
  return new Promise((resolve) => {
    let finished = false;
    let hasSpeech = false;
    let finalParts = [];
    let latestPartial = '';
    let latestMeta = null;
    let silenceTimer = null;
    let initialTimer = null;
    let hardStopTimer = null;

    const answerBox = document.getElementById('av-answer');

    const updateVisibleTranscript = () => {
      const committed = finalParts.join(' ').trim();
      const visible = [committed, latestPartial].filter(Boolean).join(' ').trim();
      if (answerBox && visible) {
        answerBox.value = visible;
        answerBox.scrollTop = answerBox.scrollHeight;
      }
    };

    const cleanup = () => {
      clearTimeout(silenceTimer);
      clearTimeout(initialTimer);
      clearTimeout(hardStopTimer);
      _avMicActive = false;

      const listenInd = document.getElementById('av-listen-indicator');
      if (listenInd) listenInd.style.display = 'none';

      if (_avRecognizer) {
        try {
          _avRecognizer.stopContinuousRecognitionAsync(
            () => {
              try { _avRecognizer?.close(); } catch(e) {}
              _avRecognizer = null;
            },
            () => {
              try { _avRecognizer?.close(); } catch(e) {}
              _avRecognizer = null;
            }
          );
        } catch(e) {
          try { _avRecognizer.close(); } catch(_) {}
          _avRecognizer = null;
        }
      }
    };

    const finish = (result = null) => {
      if (finished) return;
      finished = true;

      const finalText = finalParts.join(' ').trim() || latestPartial.trim();
      cleanup();

      if (!finalText) {
        resolve(null);
        return;
      }

      const meta = latestMeta || {
        text: finalText,
        rawJson: null,
        confidence: null,
        lexical: '',
        alternatives: []
      };
      meta.text = finalText;

      if (answerBox) {
        answerBox.value = finalText;
        answerBox.scrollTop = answerBox.scrollHeight;
        answerBox.dispatchEvent(new Event('input', { bubbles: true }));
      }

      resolve(meta);
    };

    const restartSilenceTimer = () => {
      clearTimeout(silenceTimer);
      // Keep listening until the client has been silent for the requested time.
      silenceTimer = setTimeout(() => finish(), Math.max(endSilenceMs || 3000, 3000));
    };

    try {
      const s = loadSettings();
      if (!s.speechKey || !s.speechRegion) {
        resolve(null);
        return;
      }

      _avMicActive = true;
      const listenInd = document.getElementById('av-listen-indicator');
      if (listenInd) listenInd.style.display = 'flex';
      avSetStatus('Listening… speak naturally', '#dc2626');

      const lang = languageCode || _avSession.language || 'en-US';
      const recognitionLang = (LANGUAGE_CONFIG[lang] || {}).recognitionLanguage || lang;
      const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(s.speechKey, s.speechRegion);
      speechConfig.speechRecognitionLanguage = recognitionLang;

      try {
        speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;
      } catch(e) {}

      try {
        speechConfig.setProperty(
          SpeechSDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
          String(initialSilenceMs || 20000)
        );
      } catch(e) {
        speechConfig.setProperty(
          'SpeechServiceConnection_InitialSilenceTimeoutMs',
          String(initialSilenceMs || 20000)
        );
      }

      // Prevent Azure from splitting the utterance too aggressively.
      try {
        speechConfig.setProperty(
          SpeechSDK.PropertyId.Speech_SegmentationSilenceTimeoutMs,
          '3000'
        );
      } catch(e) {
        try {
          speechConfig.setProperty('Speech_SegmentationSilenceTimeoutMs', '3000');
        } catch(_) {}
      }

      try {
        speechConfig.setProperty(
          'SpeechServiceResponse_RequestDetailedResultTrueFalse',
          'true'
        );
      } catch(e) {}

      const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
      _avRecognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

      _avRecognizer.recognizing = (_, e) => {
        if (finished) return;
        const partial = (e.result?.text || '').trim();
        if (!partial) return;

        hasSpeech = true;
        latestPartial = partial;
        updateVisibleTranscript();
        restartSilenceTimer();
      };

      _avRecognizer.recognized = (_, e) => {
        if (finished) return;

        if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech && e.result.text) {
          hasSpeech = true;
          const part = e.result.text.trim();

          if (part) {
            finalParts.push(part);
            latestPartial = '';
            latestMeta = parseSttDetail(e.result);
            updateVisibleTranscript();
            restartSilenceTimer();
          }
        }
      };

      _avRecognizer.canceled = (_, e) => {
        console.warn('[avListen] canceled:', e.reason, e.errorDetails || '');
        finish();
      };

      _avRecognizer.sessionStopped = () => {
        if (!finished) finish();
      };

      _avRecognizer.startContinuousRecognitionAsync(
        () => {
          console.log('[avListen] continuous recognizer started');

          // Stop when no first word arrives within initialSilenceMs.
          initialTimer = setTimeout(() => {
            if (!hasSpeech) finish();
          }, initialSilenceMs || 20000);

          // Safety cap so a session cannot listen forever.
          hardStopTimer = setTimeout(() => finish(), 60000);
        },
        (err) => {
          console.error('[avListen] start error:', err);
          cleanup();
          resolve(null);
        }
      );

    } catch(outerErr) {
      console.error('[avListen] setup error:', outerErr);
      cleanup();
      resolve(null);
    }
  });
}

// Manual mic button — single press to record, 3s end-silence, 15s initial
async function avToggleMic() {
  if (_avMicActive) { avStopListening(); avSetStatus('Connected', '#22c55e'); return; }

  avSetStatus('Listening…', '#3b82f6');
  const stt = await avListen(15000, 3000, _avSession.language);
  if (stt && stt.text) {
    const ta = document.getElementById('av-answer');
    if (ta) ta.value = stt.text;
    avSetStatus('Connected — answer captured', '#22c55e');
  } else {
    avSetStatus('Connected — no speech detected', '#f59e0b');
  }
}

// Auto-listen after avatar speaks a question:
//   • 20s initial silence → no answer → repeat question
//   • 3s end-silence after speech → transcribe answer
// ═══════════════════════════════════════════════════════════
//  Avatar Interview Flow  (with auto follow-up loop)
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
//  TRANSLATION ENGINE
// ═══════════════════════════════════════════════════════════

const TX_LANGUAGES = [
  { code:'fa-IR', name:'Persian',    native:'فارسی',     iso2:'ir', dir:'rtl' },
  { code:'fr-CA', name:'French',     native:'Français',  iso2:'fr', dir:'ltr' },
  { code:'es-ES', name:'Spanish',    native:'Español',   iso2:'es', dir:'ltr' },
  { code:'ar-SA', name:'Arabic',     native:'العربية',   iso2:'sa', dir:'rtl' },
  { code:'zh-CN', name:'Chinese',    native:'中文',       iso2:'cn', dir:'ltr' },
  { code:'pt-BR', name:'Portuguese', native:'Português', iso2:'br', dir:'ltr' },
  { code:'de-DE', name:'German',     native:'Deutsch',   iso2:'de', dir:'ltr' },
  { code:'it-IT', name:'Italian',    native:'Italiano',  iso2:'it', dir:'ltr' },
  { code:'ru-RU', name:'Russian',    native:'Русский',   iso2:'ru', dir:'ltr' },
  { code:'tr-TR', name:'Turkish',    native:'Türkçe',    iso2:'tr', dir:'ltr' },
  { code:'uk-UA', name:'Ukrainian',  native:'Українська',iso2:'ua', dir:'ltr' },
  { code:'hi-IN', name:'Hindi',      native:'हिन्दी',      iso2:'in', dir:'ltr' },
];
function txFlagImg(iso2, size) {
  const s = size || 32;
  return `<img src="https://flagcdn.com/w${s}/${iso2}.png" width="${s}" style="border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,.2);vertical-align:middle" alt="${iso2}" onerror="this.style.display='none'">`;
}

function loadTranslations() {
  try { return JSON.parse(localStorage.getItem(LS.translations) || '{}'); } catch { return {}; }
}
function saveTranslations(data) {
  localStorage.setItem(LS.translations, JSON.stringify(data));
}

let _txRunning = false;
// Visual state for the Translation Control Center (presentation only).
let _txActiveLang = null;       // language currently being translated
let _txProgress = null;         // { done, total } — real per-question progress
let _txJustCompleted = null;    // language that just finished (success animation)
let _txCardsAnimated = false;   // staggered fade-up only on the first render

// Derives a language's display state from the existing stored translations.
function txLangState(lang, txs, total) {
  const data   = txs[lang.code];
  const count  = data ? Object.keys(data).length : 0;
  const errors = data ? Object.values(data).filter(t => t && t.error).length : 0;
  const hasAll = count >= total;
  let state = 'pending';
  if (_txRunning && _txActiveLang === lang.code) state = 'translating';
  else if (errors > 0) state = 'error';
  else if (hasAll && total > 0) state = 'complete';
  const pct = total ? Math.round(Math.min(count, total) / total * 100) : 0;
  return { count, errors, hasAll, state, pct };
}

function txSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function txRenderSummary(states, totalQuestions) {
  const n = s => states.filter(x => x.state === s).length;
  txSetText('tx-stat-total', TX_LANGUAGES.length);
  txSetText('tx-stat-complete', n('complete'));
  txSetText('tx-stat-active', n('translating'));
  txSetText('tx-stat-pending', n('pending'));
  txSetText('tx-stat-error', n('error'));
  const errWrap = document.getElementById('tx-stat-error-wrap');
  if (errWrap) errWrap.hidden = n('error') === 0;
  const summary = document.getElementById('tx-summary');
  if (summary) summary.classList.toggle('is-active', n('translating') > 0);

  txSetText('tx-flow-source-meta', `${totalQuestions} question${totalQuestions === 1 ? '' : 's'}`);
  txSetText('tx-flow-target-meta', `${n('complete')} of ${TX_LANGUAGES.length} languages ready`);
  const active = TX_LANGUAGES.find(l => l.code === _txActiveLang);
  txSetText('tx-flow-engine-meta', _txRunning && active ? `Translating to ${active.native}` : 'Idle');
  const flow = document.getElementById('tx-flow');
  if (flow) flow.classList.toggle('is-active', !!(_txRunning && active));
}

function renderTranslationEngine() {
  const grid = document.getElementById('tx-lang-grid');
  if (!grid) return;
  const qs   = loadQuestions();
  const txs  = loadTranslations();
  const total = qs.length;
  const states = TX_LANGUAGES.map(lang => ({ lang, ...txLangState(lang, txs, total) }));
  txRenderSummary(states, total);

  if (!qs.length) {
    grid.innerHTML = `<div class="card tx-empty" style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-muted)">
      No questions in Question Bank.<br>Generate questions first in the Question Engine.
    </div>`;
    return;
  }

  const enter = !_txCardsAnimated;
  _txCardsAnimated = true;
  grid.classList.toggle('tx-busy', !!_txRunning);

  grid.innerHTML = states.map((st, i) => {
    const { lang, count, errors, hasAll, state } = st;
    let pct = st.pct;
    let countText = `${Math.min(count, total)}/${total}`;
    if (state === 'translating' && _txProgress) {
      pct = Math.round(_txProgress.done / _txProgress.total * 100);
      countText = `${_txProgress.done}/${_txProgress.total}`;
    }
    const statusText = {
      pending:     count > 0 ? 'Partially translated' : 'Not translated',
      translating: 'Translating…',
      complete:    'Complete',
      error:       `${errors} failed`
    }[state];

    let mainBtn;
    if (state === 'translating') {
      mainBtn = `<button class="btn btn-sm tx-btn tx-btn-busy" disabled><span class="spinner"></span> Translating…</button>`;
    } else if (state === 'complete') {
      mainBtn = `<button class="btn btn-secondary btn-sm tx-btn" onclick="startTranslation('${lang.code}')">↻ Re-translate</button>`;
    } else if (state === 'error') {
      mainBtn = `<button class="btn btn-sm tx-btn tx-btn-retry" onclick="startTranslation('${lang.code}')">↻ Retry</button>`;
    } else {
      mainBtn = `<button class="btn btn-primary btn-sm tx-btn" onclick="startTranslation('${lang.code}')">▶ Translate</button>`;
    }
    const viewBtn = hasAll && state !== 'translating'
      ? `<button class="btn btn-secondary btn-sm tx-icon-btn" title="View translations" onclick="viewTranslation('${lang.code}')">👁</button>` : '';
    const delBtn = count > 0 && state !== 'translating'
      ? `<button class="btn btn-danger btn-sm tx-icon-btn" title="Delete translations" onclick="deleteLangTranslation('${lang.code}')">🗑</button>` : '';

    const classes = ['tx-card', `is-${state}`];
    if (enter) classes.push('tx-enter');
    if (_txJustCompleted === lang.code && state === 'complete') classes.push('just-completed');

    return `
    <div class="${classes.join(' ')}" data-lang="${lang.code}" style="--i:${i}">
      <div class="tx-card-top">
        <div class="tx-flag">${txFlagImg(lang.iso2, 40)}<span class="tx-flag-check">✓</span></div>
        <div class="tx-names">
          <div class="tx-native" dir="${lang.dir || 'ltr'}">${lang.native}</div>
          <div class="tx-english">${lang.name}</div>
        </div>
      </div>
      <div class="tx-track"><div class="tx-fill" style="width:${pct}%"></div></div>
      <div class="tx-status-row">
        <span class="tx-status"><i class="tx-dot"></i>${statusText}</span>
        <span class="tx-count">${countText}</span>
      </div>
      <div class="tx-actions">${mainBtn}${viewBtn}${delBtn}</div>
    </div>`;
  }).join('');
  _txJustCompleted = null;
}

// Spotlight + active card progress (real data from the translation loop).
function txSpotlightStart(lang, total) {
  const flag = document.getElementById('tx-spot-flag');
  if (flag) flag.innerHTML = txFlagImg(lang.iso2, 40);
  txSetText('tx-spot-sub', `${lang.name} · ${lang.code} · ${total} question${total === 1 ? '' : 's'}`);
  txSetText('tx-spot-pct', '0%');
}

function txUpdateActiveProgress(langCode, done, total) {
  const pct = total ? Math.round(done / total * 100) : 0;
  txSetText('tx-spot-pct', `${pct}%`);
  const card = document.querySelector(`.tx-card[data-lang="${langCode}"]`);
  if (!card) return;
  const fill = card.querySelector('.tx-fill');
  if (fill) fill.style.width = pct + '%';
  const cnt = card.querySelector('.tx-count');
  if (cnt) cnt.textContent = `${done}/${total}`;
}

// A small glowing dot travels from the spotlight progress bar to the language card.
function txSendFlowDot(langCode) {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Starts at the tip of the spotlight progress bar (or the spotlight flag).
    const bar = document.getElementById('tx-progress-bar');
    const flag = document.getElementById('tx-spot-flag');
    const to = document.querySelector(`.tx-card[data-lang="${langCode}"] .tx-flag`);
    if (!to || typeof document.body.animate !== 'function') return;
    let x0, y0;
    const br = bar && bar.getBoundingClientRect();
    if (br && br.height > 0 && br.width > 2) {
      x0 = br.right; y0 = br.top + br.height / 2;
    } else if (flag && flag.getBoundingClientRect().width > 0) {
      const fr = flag.getBoundingClientRect();
      x0 = fr.left + fr.width / 2; y0 = fr.bottom - 4;
    } else {
      return;
    }
    const b = to.getBoundingClientRect();
    const x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
    const dot = document.createElement('span');
    dot.className = 'tx-travel-dot';
    dot.style.left = x0 + 'px';
    dot.style.top = y0 + 'px';
    document.body.appendChild(dot);
    const anim = dot.animate([
      { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
      { opacity: 1, offset: .15 },
      { transform: `translate(calc(${x1 - x0}px - 50%), calc(${y1 - y0}px - 50%)) scale(1)`, opacity: .9, offset: .85 },
      { transform: `translate(calc(${x1 - x0}px - 50%), calc(${y1 - y0}px - 50%)) scale(1.6)`, opacity: 0 }
    ], { duration: 950, easing: 'cubic-bezier(.4,0,.2,1)' });
    anim.onfinish = () => dot.remove();
    anim.oncancel = () => dot.remove();
  } catch (_) { /* decorative only */ }
}

async function startTranslation(langCode) {
  if (_txRunning) { toast('Translation already running…', 'info'); return; }
  const qs = loadQuestions();
  if (!qs.length) { toast('No questions to translate', 'error'); return; }
  const lang = TX_LANGUAGES.find(l => l.code === langCode);
  if (!lang) return;

  _txRunning = true;
  const wrap  = document.getElementById('tx-progress-wrap');
  const bar   = document.getElementById('tx-progress-bar');
  const label = document.getElementById('tx-progress-label');
  const cnt   = document.getElementById('tx-progress-count');
  wrap.style.display = 'block';
  document.getElementById('tx-viewer').style.display = 'none';

  const txs   = loadTranslations();
  if (!txs[langCode]) txs[langCode] = {};
  const total = qs.length;
  let done = 0;

  // Control Center visuals: mark the active language, spotlight it, send first dot.
  _txActiveLang = langCode;
  _txProgress = { done: 0, total };
  txSpotlightStart(lang, total);
  renderTranslationEngine();
  txSendFlowDot(langCode);

  const sys = `You are a professional translator for a social-services caseworker interview system. Translate the following question into ${lang.name} (${lang.native}, ${langCode}). Use simple, respectful, conversational language. Preserve all meaning, numbers, dates, and field names. For ${langCode === 'fa-IR' ? 'Persian: use natural Iranian Persian' : langCode === 'ar-SA' ? 'Arabic: use Modern Standard Arabic' : langCode === 'fr-CA' ? 'French: use Canadian French' : langCode}. Return ONLY the translated question text.`;

  for (const q of qs) {
    label.textContent = `Translating to ${lang.native}…`;
    cnt.textContent   = `${done} / ${total} questions`;
    bar.style.width   = (done / total * 100) + '%';
    try {
      const translated = await callGPT(sys, q.question, false);
      txs[langCode][q.id] = {
        original:   q.question,
        translated: (typeof translated === 'string' ? translated : q.question).trim(),
        hint:       q.expectedAnswer || '',
        timestamp:  new Date().toISOString()
      };
      saveTranslations(txs);
    } catch(e) {
      console.warn('[TX]', e);
      txs[langCode][q.id] = { original: q.question, translated: q.question, hint: q.expectedAnswer || '', error: true };
    }
    done++;
    bar.style.width = (done / total * 100) + '%';
    cnt.textContent = `${done} / ${total} questions`;
    if (_txProgress) _txProgress.done = done;
    txUpdateActiveProgress(langCode, done, total);
    if (done < total) txSendFlowDot(langCode);
    await new Promise(r => setTimeout(r, 120)); // brief pause between calls
  }

  _txRunning = false;
  _txActiveLang = null;
  _txProgress = null;
  _txJustCompleted = langCode;
  wrap.style.display = 'none';
  toast(`✓ Translated ${done} questions to ${lang.native}`, 'success');
  renderTranslationEngine();
  viewTranslation(langCode);
}

// One row in the translation viewer (read mode).
function txRowHTML(lang, q, i, tx) {
  const dir = lang.dir || 'ltr';
  const badges =
    (tx.error ? '<span class="tx-row-badge is-error">⚠ Translation failed</span>' : '') +
    (tx.edited ? '<span class="tx-row-badge is-edited">✎ Edited</span>' : '');
  return `<div class="tx-row" id="txrow-${q.id}">
        <span class="tx-row-num">${i + 1}</span>
        <div class="tx-row-body">
          <div class="tx-row-text" dir="${dir}" style="text-align:${dir === 'rtl' ? 'right' : 'left'}">${esc(tx.translated)}</div>
          <div class="tx-row-orig">${esc(tx.original)}</div>
          ${badges ? `<div class="tx-row-badges">${badges}</div>` : ''}
        </div>
        <button class="btn btn-secondary btn-sm tx-row-edit" title="Edit translation"
          onclick="editTxItem('${lang.code}','${q.id}')">✏️ Edit</button>
      </div>`;
}

function viewTranslation(langCode) {
  const lang = TX_LANGUAGES.find(l => l.code === langCode);
  const txs  = loadTranslations();
  const qs   = loadQuestions();
  const data  = txs[langCode] || {};
  const viewer = document.getElementById('tx-viewer');
  const title  = document.getElementById('tx-viewer-title');
  const list   = document.getElementById('tx-viewer-list');
  viewer.style.display = 'block';
  viewer.dataset.lang = langCode;
  title.innerHTML = `${txFlagImg(lang.iso2, 24)} ${lang.native} (${lang.name}) — ${Object.keys(data).length} questions`;
  list.innerHTML = `<div class="card tx-viewer-card" style="padding:0;overflow:hidden">` +
    qs.map((q, i) => {
      const tx = data[q.id];
      if (!tx) return '';
      return txRowHTML(lang, q, i, tx);
    }).join('') + '</div>';
  viewer.scrollIntoView({ behavior:'smooth', block:'start' });
}

// ── Manual correction of a single translation ─────────────────
function editTxItem(langCode, qid) {
  const lang = TX_LANGUAGES.find(l => l.code === langCode);
  const tx = (loadTranslations()[langCode] || {})[qid];
  const row = document.getElementById(`txrow-${qid}`);
  if (!lang || !tx || !row) return;
  const dir = lang.dir || 'ltr';
  row.classList.add('is-editing');
  row.querySelector('.tx-row-body').innerHTML = `
    <textarea class="tx-row-input" id="txedit-${qid}" dir="${dir}" rows="2"
      style="text-align:${dir === 'rtl' ? 'right' : 'left'}"
      onkeydown="if(event.key==='Escape'){cancelTxItem('${langCode}','${qid}')} else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){saveTxItem('${langCode}','${qid}')}">${esc(tx.translated)}</textarea>
    <div class="tx-row-orig">${esc(tx.original)}</div>
    <div class="tx-row-edit-actions">
      <button class="btn btn-primary btn-sm" onclick="saveTxItem('${langCode}','${qid}')">✓ Save</button>
      <button class="btn btn-secondary btn-sm" onclick="cancelTxItem('${langCode}','${qid}')">Cancel</button>
      <span class="tx-row-hint">Ctrl+Enter to save · Esc to cancel</span>
    </div>`;
  const btn = row.querySelector('.tx-row-edit');
  if (btn) btn.style.visibility = 'hidden';
  const input = document.getElementById(`txedit-${qid}`);
  if (input) {
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 56) + 'px';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function txRestoreRow(langCode, qid) {
  const lang = TX_LANGUAGES.find(l => l.code === langCode);
  const qs = loadQuestions();
  const i = qs.findIndex(q => q.id === qid);
  const tx = (loadTranslations()[langCode] || {})[qid];
  const row = document.getElementById(`txrow-${qid}`);
  if (!lang || !tx || !row || i < 0) return;
  row.outerHTML = txRowHTML(lang, qs[i], i, tx);
}

function cancelTxItem(langCode, qid) {
  txRestoreRow(langCode, qid);
}

function saveTxItem(langCode, qid) {
  // A running translation keeps its own copy of all translations and saves it
  // after every question, which would overwrite a manual edit made meanwhile.
  if (_txRunning) {
    toast('Please wait until the current translation finishes, then save your edit.', 'warning');
    return;
  }
  const input = document.getElementById(`txedit-${qid}`);
  if (!input) return;
  const value = input.value.trim();
  if (!value) {
    toast('Translation cannot be empty.', 'error');
    input.focus();
    return;
  }
  const txs = loadTranslations();
  const item = (txs[langCode] || {})[qid];
  if (!item) return;
  if (value !== item.translated) {
    if (!item.edited) item.machineTranslated = item.translated;   // keep the AI version for audit
    item.translated = value;
    item.edited = true;
    item.editedAt = new Date().toISOString();
    delete item.error;                                            // manually fixed
    saveTranslations(txs);
    toast('Translation updated', 'success');
  }
  txRestoreRow(langCode, qid);
  const row = document.getElementById(`txrow-${qid}`);
  if (row) { row.classList.add('just-saved'); setTimeout(() => row.classList.remove('just-saved'), 1200); }
  renderTranslationEngine();   // card state / summary may change (e.g. error -> complete)
}

function closeTxViewer() {
  document.getElementById('tx-viewer').style.display = 'none';
}

function deleteLangTranslation(langCode) {
  const lang = TX_LANGUAGES.find(l => l.code === langCode);
  if (!confirm(`Delete all ${lang.native} translations?`)) return;
  const txs = loadTranslations();
  delete txs[langCode];
  saveTranslations(txs);
  document.getElementById('tx-viewer').style.display = 'none';
  renderTranslationEngine();
  toast(`${lang.native} translations deleted`, 'info');
}

function clearAllTranslations() {
  if (!confirm('Delete ALL translations? This cannot be undone.')) return;
  localStorage.removeItem(LS.translations);
  document.getElementById('tx-viewer').style.display = 'none';
  renderTranslationEngine();
  toast('All translations cleared', 'info');
}

function exportTranslations() {
  const qs  = loadQuestions();
  const txs = loadTranslations();
  const out = {
    exportedAt: new Date().toISOString(),
    questionCount: qs.length,
    languages: {}
  };
  TX_LANGUAGES.forEach(lang => {
    if (txs[lang.code]) {
      out.languages[lang.code] = {
        name:      lang.name,
        native:    lang.native,
        questions: qs.map(q => ({
          id:         q.id,
          original:   q.question,
          translated: (txs[lang.code][q.id] || {}).translated || '',
          hint:       q.expectedAnswer || ''
        }))
      };
    }
  });
  const blob = new Blob([JSON.stringify(out, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `question-translations-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  toast('Translations exported', 'success');
}

// ═══════════════════════════════════════════════════════════
//  MULTILINGUAL SUPPORT
// ═══════════════════════════════════════════════════════════

const LANGUAGE_CONFIG = {
  'en-US': {
    code: 'en-US', name: 'English',
    recognitionLanguage: 'en-US',
    voiceName: 'en-US-Ava:DragonHDLatestNeural',
    direction: 'ltr',
    confirmation: 'Certainly. We can continue in English.'
  },
  'fa-IR': {
    code: 'fa-IR', name: 'فارسی',
    recognitionLanguage: 'fa-IR',
    voiceName: 'fa-IR-DilaraNeural',
    direction: 'rtl',
    confirmation: 'بله، حتماً. از این لحظه به زبان فارسی با شما صحبت می‌کنم.'
  },
  'fr-CA': {
    code: 'fr-CA', name: 'Français',
    recognitionLanguage: 'fr-CA',
    voiceName: 'fr-CA-SylvieNeural',
    direction: 'ltr',
    confirmation: 'Oui, bien sûr. À partir de maintenant, je vais vous parler en français.'
  }
};

let _avSession      = { language: 'en-US' };
let _avLangAudit    = [];
const _avTxCache    = {};   // translation cache

// ── SSML helper ────────────────────────────────────────────
function buildLocalizedSsml(text, lang) {
  const cfg = LANGUAGE_CONFIG[lang] || LANGUAGE_CONFIG['en-US'];
  const safe = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${cfg.code}"><voice name="${cfg.voiceName}">${safe}</voice></speak>`;
}

// ── Speak with correct voice per language ──────────────────
async function avSpeakLocalized(text, lang) {
  if (!_av.synthesizer || !_av.ready) return null;
  const l = lang || _avSession.language || 'en-US';
  const ssml = buildLocalizedSsml(text, l);
  try {
    if (typeof _av.synthesizer.speakSsmlAsync === 'function') {
      return await _av.synthesizer.speakSsmlAsync(ssml);
    }
  } catch(e) { console.warn('[avSpeakLocalized] SSML failed:', e.message); }
  try { return await _av.synthesizer.speakTextAsync(text); } catch(e) { return null; }
}

// ── Language indicator + RTL ───────────────────────────────
function updateLangIndicator(lang) {
  const el = document.getElementById('av-lang-indicator');
  if (el) el.textContent = 'Language: ' + ((LANGUAGE_CONFIG[lang] || {}).name || lang);
  updateTextDirection(lang);
}

function updateTextDirection(lang) {
  const dir = (LANGUAGE_CONFIG[lang] || {}).direction || 'ltr';
  ['av-q-text','av-answer','av-corrected-answer',
   'av-r-original','av-r-interpreted','av-r-followup'].forEach(id => {
    const e = document.getElementById(id);
    if (e) { e.style.direction = dir; e.style.textAlign = dir === 'rtl' ? 'right' : 'left'; }
  });
}

// ── Translation with caching ───────────────────────────────
async function translateInterviewText(text, targetLang, textType) {
  if (!text || targetLang === 'en-US') return text;
  const key = `${targetLang}:${textType}:${text}`;
  if (_avTxCache[key]) return _avTxCache[key];
  const langName = (LANGUAGE_CONFIG[targetLang] || {}).name || targetLang;
  const sys = `You are a professional translator for a social-services caseworker interview. Translate the ${textType || 'text'} into ${langName} (${targetLang}). Preserve exact meaning; use simple respectful conversational language; do NOT change dates/numbers/names; for fa-IR use natural Iranian Persian; for fr-CA use clear Canadian French. Return ONLY the translated text.`;
  try {
    const r = await callGPT(sys, text, false);
    const t = (typeof r === 'string') ? r.trim() : text;
    _avTxCache[key] = t;
    return t;
  } catch(e) { console.warn('[translateInterviewText]', e); return text; }
}

// ── Intent detection ───────────────────────────────────────
const SYSTEM_DETECT_INTENT = `You are a multilingual intent classifier for an AI caseworker interview.
Classify the utterance into ONE of:
  answer_question  – answering the interview question
  change_language  – wants to switch language
  repeat_question  – asks to repeat the question
  need_help        – needs help / doesn't understand
  stop_interview   – wants to stop
  unrelated        – anything else
Supported languages for change_language:
  en-US  English    fa-IR  Persian/Farsi    fr-CA  French
Return ONLY valid JSON:
{"intent":"answer_question","targetLanguage":null,"confidence":0.95}`;

async function detectIntent(transcript, currentLang) {
  if (!transcript) return { intent:'answer_question', targetLanguage:null, confidence:0.5 };
  // keyword fast-path
  const t = transcript.toLowerCase();
  const KW = {
    'fa-IR': [
      'persian', 'farsi', 'speak persian', 'speak farsi',
      'can you speak persian', 'can you speak farsi',
      'فارسی', 'فارسی صحبت کن', 'فارسی حرف بزن', 'به فارسی',
      'میشه فارسی صحبت کنی', 'می شه فارسی صحبت کنی'
    ],
    'fr-CA': [
      'french', 'français', 'francais', 'speak french',
      'can you speak french', 'parlez français', 'parlez-vous français',
      'en français', 'je ne comprends pas'
    ],
    'en-US': [
      'english please', 'back to english', 'switch to english',
      'speak english', 'in english', 'continue in english',
      'انگلیسی صحبت کن', 'به انگلیسی'
    ]
  };
  for (const [lang, words] of Object.entries(KW)) {
    if (lang !== currentLang && words.some(w => t.includes(w))) {
      return { intent:'change_language', targetLanguage:lang, confidence:0.92 };
    }
  }
  try {
    const r = await callGPT(SYSTEM_DETECT_INTENT, `Current language: ${currentLang}\nUser said: "${transcript}"`, true);
    return r;
  } catch(e) {
    console.warn('[detectIntent] GPT failed:', e.message);
    return { intent:'answer_question', targetLanguage:null, confidence:0.5 };
  }
}

// ── Execute language switch: confirm → translate question → listen ──────────
async function avExecuteLanguageSwitch(toLang, switchTranscript, q) {
  if (!LANGUAGE_CONFIG[toLang]) return null;
  const fromLang = _avSession.language;
  // Audit (not saved as an answer)
  _avLangAudit.push({ eventType:'language_changed', fromLanguage:fromLang, toLanguage:toLang,
    originalTranscript:switchTranscript, timestamp:new Date().toISOString() });
  _avSession.language = toLang;
  updateLangIndicator(toLang);
  // Speak confirmation
  avSetStatus('Switching language…', '#8b5cf6');
  const conf = LANGUAGE_CONFIG[toLang].confirmation;
  await avSpeakLocalized(conf, toLang);
  await waitForAvatarSilence(700, 15000, 800);
  // Translate & repeat question
  avSetStatus('Translating question…', '#8b5cf6');
  const tq = await translateInterviewText(q.question, toLang, 'question');
  document.getElementById('av-q-text').textContent = tq;
  await avSpeakLocalized(tq, toLang);
  await waitForAvatarSilence(700, 20000, 800);
  // Listen in new language
  avSetStatus('Listening…', '#dc2626');
  return await avListen(20000, 3000, toLang);
}

const AVATAR_WELCOME = "Hello, and welcome! My name is Lisa, and I'm your AI assistant. It's a pleasure to meet you. Before we get started, I'd like to ask you a few questions so I can better understand your situation and make sure we provide the services and support that best meet your needs. This should only take a few minutes.";
const MAX_FOLLOWUPS  = 3;

let _avInterview       = { questions: [], index: 0, active: false };
let _avCurrentAnalysis = null;   // last GPT result for current question
let _avTranscripts     = [];     // [{attempt, text}] for audit

async function avSpeakText(text) {
  // kept for welcome message (always English); interview questions use avSpeakLocalized
  if (!_av.synthesizer || !_av.ready) return null;
  try { return await _av.synthesizer.speakTextAsync(text); }
  catch(e) { console.warn('avSpeakText error', e); return null; }
}

// Update analysis panel UI
function avShowAnalysis(mergedText, result) {
  const box = document.getElementById('av-analysis-box');
  if (box) box.style.display = 'block';

  const set  = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const show = (id, on)  => { const el = document.getElementById(id); if (el) el.style.display = on ? 'block' : 'none'; };

  // Show all captured transcripts
  const allText = _avTranscripts.map((t,i) => `[${i+1}] ${t.text}`).join('\n');
  set('av-r-original', allText || mergedText);
  set('av-r-interpreted', result.interpretedAnswer || mergedText);

  const ca = document.getElementById('av-corrected-answer');
  if (ca) ca.value = result.interpretedAnswer || mergedText;

  // Normalized
  show('av-r-normalized-wrap', !!result.normalizedValue);
  if (result.normalizedValue) {
    const el = document.getElementById('av-r-normalized');
    if (el) el.innerHTML = `<code>${esc(result.normalizedValue)}</code>`;
  }

  // Incomplete warning
  const iw = document.getElementById('av-r-incomplete-wrap');
  if (iw) {
    if (!result.isAnswerComplete && result.missingInformation) {
      iw.style.display = 'block';
      iw.innerHTML = `<div class="a-warning">⚠️ <div><strong>Incomplete:</strong> ${esc(result.missingInformation)}</div></div>`;
    } else if (result.isAnswerComplete) {
      iw.style.display = 'block';
      iw.innerHTML = `<div style="color:#15803d;font-size:12px">✓ Answer is complete</div>`;
    } else {
      iw.style.display = 'none';
    }
  }

  // Follow-up
  show('av-r-followup-wrap', !!result.suggestedFollowUp);
  set('av-r-followup', result.suggestedFollowUp || '');
}

// ── waitForAvatarSilence ──────────────────────────────────────────────────────
// Uses WebAudio to detect when the avatar's audio stream goes silent for
// `quietMs` consecutive ms. Falls back to `maxWaitMs` if silence never detected.
// This replaces all avEstimatePlayMs guesswork — it works regardless of
// whether speakTextAsync resolves before or after audio finishes playing.
//
// `minWaitMs` prevents triggering on brief gaps between synthesis chunks.
async function waitForAvatarSilence(quietMs = 700, maxWaitMs = 60000, minWaitMs = 1200) {
  // Always enforce a minimum wait so we don't trigger before audio even starts
  await new Promise(r => setTimeout(r, minWaitMs));

  const aud = document.getElementById('av-aud');
  if (!aud || !aud.srcObject) {
    // No audio stream connected — small fallback delay
    await new Promise(r => setTimeout(r, 1500));
    return;
  }

  return new Promise(resolve => {
    let actx, src, analyser, timer, fallback;
    const done = () => {
      clearInterval(timer); clearTimeout(fallback);
      try { actx?.close(); } catch(e) {}
      resolve();
    };
    try {
      actx     = new AudioContext();
      actx.resume().catch(() => {});
      src      = actx.createMediaStreamSource(aud.srcObject);
      analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
    } catch(e) {
      console.warn('[waitForAvatarSilence] AudioContext failed:', e);
      setTimeout(resolve, 1500);
      return;
    }
    const buf = new Float32Array(analyser.fftSize);
    let silentSince = null;
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      if (rms < 0.006) {
        if (!silentSince) silentSince = Date.now();
        if (Date.now() - silentSince >= quietMs) done();
      } else {
        silentSince = null;
      }
    }, 40);
    fallback = setTimeout(done, maxWaitMs);
  });
}

// Legacy estimate — kept for non-avatar (ttsOnly) mode where no audio element exists.
// AvatarSynthesizer resolves when audio is SENT to WebRTC, not when PLAYED.
function avEstimatePlayMs(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.max(2500, words * 400 + 800);
}

// Core question loop — language-aware: speak → wait → listen → intent-check → analyze → follow-up
async function avRunQuestion(q) {
  // Check if this question needs structured confirmation workflow
  const fieldKey = q.fieldKey || matchFieldKey(q.question);
  const needsWorkflow = fieldKey && INTAKE_RULES.fields[fieldKey]?.confirmationRequired;
  if (needsWorkflow) {
    return await avRunWorkflowQuestion(q);
  }

  let accumulated = '';
  _avTranscripts     = [];
  _avCurrentAnalysis = null;

  const ta = document.getElementById('av-answer');
  if (ta) ta.value = '';
  document.getElementById('av-btn-next').disabled    = true;
  document.getElementById('av-btn-repeat').disabled  = true;
  const box = document.getElementById('av-analysis-box');
  if (box) box.style.display = 'none';

  for (let attempt = 0; attempt <= MAX_FOLLOWUPS; attempt++) {
    if (!_avInterview.active) return;

    const isFirst = attempt === 0;
    // Build text to speak (in English for analysis; translate for client)
    const toSpeakEn = isFirst
      ? q.question
      : (_avCurrentAnalysis?.suggestedFollowUp || 'Could you please provide more detail about your answer?');
    const toSpeak = await translateInterviewText(toSpeakEn, _avSession.language, isFirst ? 'question' : 'follow_up');

    // ── Speak ──────────────────────────────────────────────
    avSetStatus(isFirst ? 'Speaking question…' : `Follow-up ${attempt}/${MAX_FOLLOWUPS}…`, '#3b82f6');
    await avSpeakLocalized(toSpeak, _avSession.language);
    await waitForAvatarSilence(700, 25000, 800);

    // ── Listen ─────────────────────────────────────────────
    avSetStatus('Listening…', '#dc2626');
    let sttResult = await avListen(20000, 3000, _avSession.language);

    // On follow-up, retry once if STT returned nothing
    if (!sttResult && !isFirst) {
      avSetStatus('Listening (retry)…', '#f59e0b');
      await new Promise(r => setTimeout(r, 400));
      sttResult = await avListen(15000, 3000, _avSession.language);
    }

    if (!sttResult) {
      if (isFirst) {
        avSetStatus('No response — repeating question…', '#f59e0b');
        await avSpeakLocalized(toSpeak, _avSession.language);
        await waitForAvatarSilence(700, 25000, 800);
        avSetStatus('Listening…', '#dc2626');
        sttResult = await avListen(20000, 3000, _avSession.language);
        if (!sttResult) {
          avSetStatus('No response — caseworker review needed', '#f59e0b');
          toast('No response received. Please assist the client.', 'info');
          document.getElementById('av-btn-next').disabled   = false;
          document.getElementById('av-btn-repeat').disabled = false;
          return;
        }
      } else {
        avSetStatus('No follow-up response — using best answer so far', '#f59e0b');
        break;
      }
    }

    // ── Intent check — handle language-switch before treating as answer ────
    // Cascade: client may say "Persian please" at any point
    let langSwitchCount = 0;
    while (sttResult && langSwitchCount < 2) {
      const intentResult = await detectIntent(sttResult.text, _avSession.language);
      if (intentResult.intent !== 'change_language' || !LANGUAGE_CONFIG[intentResult.targetLanguage]) break;
      langSwitchCount++;
      // Handle switch — audit is recorded inside; returns new sttResult or null
      sttResult = await avExecuteLanguageSwitch(intentResult.targetLanguage, sttResult.text, q);
    }
    if (!sttResult) break;   // no answer after language switch

    // ── Merge answer transcript ────────────────────────────
    const spokenText = sttResult.text || '';
    _avTranscripts.push({
      attempt: attempt + 1,
      text: spokenText,
      language: _avSession.language,
      confidence: sttResult.confidence
    });
    accumulated = accumulated ? accumulated.trim() + ' ' + spokenText.trim() : spokenText.trim();
    if (ta) ta.value = accumulated;

    const sttMeta = {
      confidence:   sttResult.confidence,
      lexical:      sttResult.lexical,
      alternatives: sttResult.alternatives
    };

    // ── Analyze ────────────────────────────────────────────
    avSetStatus(`Analyzing… (attempt ${attempt + 1})`, '#8b5cf6');
    try {
      const result = await analyzeAnswer(
        q.question, q.expectedAnswer || q.type, accumulated, sttMeta, _avSession.language,
        q.validation || {}, q.type || 'open'
      );
      _avCurrentAnalysis = result;
      avShowAnalysis(accumulated, result);

      if (result.isAnswerComplete !== false) {
        avSetStatus('Connected — answer complete ✓', '#22c55e');
        document.getElementById('av-btn-next').disabled   = false;
        document.getElementById('av-btn-repeat').disabled = false;
        return;
      }
      if (attempt >= MAX_FOLLOWUPS) {
        avSetStatus(`⚠ Max follow-ups reached — caseworker review`, '#f59e0b');
        toast(`Answer incomplete after ${MAX_FOLLOWUPS} follow-ups. Please review and correct.`, 'info');
        document.getElementById('av-btn-next').disabled   = false;
        document.getElementById('av-btn-repeat').disabled = false;
        return;
      }
      avSetStatus(`Incomplete — preparing follow-up ${attempt + 1}…`, '#f59e0b');
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      _avCurrentAnalysis = { interpretedAnswer: accumulated };
      avShowAnalysis(accumulated, _avCurrentAnalysis);
      avSetStatus('Analysis error — caseworker review', '#ef4444');
      toast('Analysis failed: ' + e.message.slice(0, 80), 'error');
      document.getElementById('av-btn-next').disabled   = false;
      document.getElementById('av-btn-repeat').disabled = false;
      return;
    }
  }

  document.getElementById('av-btn-next').disabled   = false;
  document.getElementById('av-btn-repeat').disabled = false;
}


// Manual language-switch button (for testing; voice-based is primary)
async function avManualLangSwitch(toLang) {
  if (!_avInterview.active) {
    // Not in interview — just update indicator and direction
    _avSession.language = toLang;
    updateLangIndicator(toLang);
    return;
  }
  const q = _avInterview.questions[_avInterview.index];
  if (!q) return;
  await avExecuteLanguageSwitch(toLang, '[manual switch]', q);
}

async function avStartInterview() {
  const qs = loadQuestions();
  _avInterview = { questions: qs, index: 0, active: true };
  // Reset language to English at the start of each interview
  _avSession   = { language: 'en-US' };
  _avLangAudit = [];
  updateLangIndicator('en-US');

  const panel = document.getElementById('av-interview-panel');
  if (panel) panel.style.display = 'flex';

  avSetStatus('Speaking welcome…', '#3b82f6');
  await avSpeakText(AVATAR_WELCOME);
  // Wait for welcome audio to actually finish — works whether speakTextAsync
  // resolves immediately (void) or after playback (Promise).
  await waitForAvatarSilence(700, 60000, 2000);
  avSetStatus('Welcome done — loading questions…', '#3b82f6');

  if (qs.length === 0) {
    avSetStatus('Connected — no questions in bank', '#f59e0b');
    toast('No questions in Question Bank. Generate questions first.', 'info');
    return;
  }

  await avAskCurrentQuestion();
}

async function avAskCurrentQuestion() {
  const { questions, index } = _avInterview;
  if (index >= questions.length) {
    avSetStatus('Interview complete ✓', '#22c55e');
    document.getElementById('av-q-text').textContent     = '✅ All questions completed.';
    document.getElementById('av-q-progress').textContent = 'Done';
    document.getElementById('av-btn-next').disabled      = true;
    document.getElementById('av-btn-repeat').disabled    = true;
    const box = document.getElementById('av-analysis-box');
    if (box) box.style.display = 'none';
    await avSpeakText('Thank you for your time. We have completed all the questions. Someone from our team will follow up with you shortly.');
    return;
  }

  const q = questions[index];
  document.getElementById('av-q-progress').textContent = `${index + 1} / ${questions.length}`;
  // Translate question for display (avRunQuestion translates for speech)
  const displayQ = await translateInterviewText(q.question, _avSession.language, 'question');
  document.getElementById('av-q-text').textContent = displayQ;
  updateTextDirection(_avSession.language);

  await avRunQuestion(q);
}

async function avNextQuestion() {
  const rawAnswer       = (document.getElementById('av-answer')?.value       || '').trim();
  const correctedAnswer = (document.getElementById('av-corrected-answer')?.value || '').trim();
  const finalAnswer     = correctedAnswer || rawAnswer;
  const q   = _avInterview.questions[_avInterview.index];
  const ai  = _avCurrentAnalysis || {};

  if (q) {
    const responses = loadResponses();
    const existing  = responses.findIndex(r => r.questionId === q.id);
    const entry = {
      questionId:                q.id,
      question:                  q.question,
      category:                  q.category || '',
      language:                  _avSession.language,
      languageAudit:             [..._avLangAudit],
      transcripts:               _avTranscripts,
      detectedClientSpeech:      rawAnswer,
      englishTranslation:        ai.englishTranslation || ai.englishInterpretation || ai.interpretedAnswer || rawAnswer,
      mappingExplanation:        ai.mappingExplanation || 'The client response was interpreted and mapped to the normalized value.',
      mappedAnswer:              ai.normalizedValue || finalAnswer,

      originalAnswer:            rawAnswer,
      originalClientAnswer:      rawAnswer,
      aiInterpretedAnswer:       ai.interpretedAnswer       || rawAnswer,
      englishInterpretation:     ai.englishInterpretation   || ai.interpretedAnswer || rawAnswer,
      caseworkerCorrectedAnswer: finalAnswer,
      isAnswerComplete:          ai.isAnswerComplete        !== false,
      missingInformation:        ai.missingInformation      || '',
      normalizedValue:           ai.normalizedValue         || '',
      followUpCount:             Math.max(0, _avTranscripts.filter(t => !t.eventType).length - 1),
      timestamp:                 new Date().toISOString()
    };
    if (existing >= 0) responses[existing] = entry; else responses.push(entry);
    persistResponses(responses);
  }

  _avCurrentAnalysis = null;
  _avTranscripts     = [];
  const box = document.getElementById('av-analysis-box');
  if (box) box.style.display = 'none';

  _avInterview.index++;
  document.getElementById('av-btn-next').disabled   = true;
  document.getElementById('av-btn-repeat').disabled = true;
  await avAskCurrentQuestion();
}

async function avRepeatQuestion() {
  const q = _avInterview.questions[_avInterview.index];
  if (!q) return;
  // Translate for display
  const displayQ = await translateInterviewText(q.question, _avSession.language, 'question');
  document.getElementById('av-q-text').textContent = displayQ;
  updateTextDirection(_avSession.language);
  avSetStatus('Re-running question…', '#3b82f6');
  await avRunQuestion(q);
}

window.addEventListener('DOMContentLoaded', () => {
  const s = loadSettings();
  const page = document.body?.dataset?.page || '';

  if (!s.gcpProjectId) {
    const se = document.getElementById('engine-status');
    if (se) se.textContent = 'Configure Google Document AI and Gemini in Settings first.';
  }

  loadIntakeRules().catch(e => console.warn('[Init] loadIntakeRules failed:', e));

  if (page === 'question-bank') renderQuestionBank();
  if (page === 'translation') renderTranslationEngine();
  if (page === 'conversation') initConversation();
  if (page === 'assistant') aaInit();
  if (page === 'responses') renderResponses();
  if (page === 'settings') populateSettingsForm();
});


// ─── AI Assistant: automatic country-of-birth interview ─────────────────────

const AA_LANGUAGE_CONFIG = {
  ...LANGUAGE_CONFIG,

  'ar-SA': {
    code: 'ar-SA',
    name: 'العربية',
    recognitionLanguage: 'ar-SA',
    voiceName: 'ar-SA-ZariyahNeural',
    direction: 'rtl',
    confirmation: 'بالتأكيد. سأتحدث معك باللغة العربية من الآن فصاعداً.'
  },

  'es-MX': {
    code: 'es-MX',
    name: 'Español',
    recognitionLanguage: 'es-MX',
    voiceName: 'es-MX-DaliaNeural',
    direction: 'ltr',
    confirmation: 'Claro. A partir de ahora continuaré en español.'
  },

  'zh-CN': {
    code: 'zh-CN',
    name: '中文',
    recognitionLanguage: 'zh-CN',
    voiceName: 'zh-CN-XiaoxiaoNeural',
    direction: 'ltr',
    confirmation: '当然可以。从现在开始，我会用中文和您交谈。'
  },

  'hi-IN': {
    code: 'hi-IN',
    name: 'हिन्दी',
    recognitionLanguage: 'hi-IN',
    voiceName: 'hi-IN-SwaraNeural',
    direction: 'ltr',
    confirmation: 'ज़रूर। अब से मैं आपसे हिंदी में बात करूँगी।'
  },

  'uk-UA': {
    code: 'uk-UA',
    name: 'Українська',
    recognitionLanguage: 'uk-UA',
    voiceName: 'uk-UA-PolinaNeural',
    direction: 'ltr',
    confirmation: 'Звичайно. Відтепер я розмовлятиму з вами українською.'
  }
};

function aaLanguageConfig(languageCode) {
  return AA_LANGUAGE_CONFIG[languageCode] ||
    AA_LANGUAGE_CONFIG['en-US'];
}

const AA_COUNTRY_PROMPTS = {
  'en-US': {
    question: 'What is your country of birth?',
    switchAndQuestion: 'Of course. I will continue in English. What is your country of birth?',
    confirm: country => `I recorded your country of birth as ${country}. Is that correct?`,
    retry: 'Please tell me the name of your country of birth.',
    yesNo: 'Please say yes if that is correct, or no if it needs to be changed.',
    complete: 'Thank you. Your country of birth has been confirmed. This conversation is complete.'
  },
  'fa-IR': {
    question: 'کشور محل تولد شما کجاست؟',
    switchAndQuestion: 'بله، حتماً. کشور محل تولد شما کجاست؟',
    confirm: country => `کشور محل تولد شما ${country} ثبت شد. آیا درست است؟`,
    retry: 'لطفاً نام کشور محل تولدتان را بگویید.',
    yesNo: 'اگر درست است بگویید بله، و اگر نیاز به اصلاح دارد بگویید نه.',
    complete: 'ممنون. کشور محل تولد شما تأیید شد و این مکالمه به پایان رسید.'
  },
  'fr-CA': {
    question: 'Quel est votre pays de naissance?',
    switchAndQuestion: 'Bien sûr. Quel est votre pays de naissance?',
    confirm: country => `J’ai enregistré votre pays de naissance comme ${country}. Est-ce exact?`,
    retry: 'Veuillez indiquer le nom de votre pays de naissance.',
    yesNo: 'Dites oui si c’est exact, ou non si cela doit être corrigé.',
    complete: 'Merci. Votre pays de naissance a été confirmé. La conversation est terminée.'
  },
  'ar-SA': {
    question: 'ما هو بلد ميلادك؟',
    switchAndQuestion: 'بالتأكيد. ما هو بلد ميلادك؟',
    confirm: country => `تم تسجيل بلد ميلادك على أنه ${country}. هل هذا صحيح؟`,
    retry: 'يرجى ذكر اسم بلد ميلادك.',
    yesNo: 'قل نعم إذا كان صحيحاً، أو لا إذا كان يحتاج إلى تصحيح.',
    complete: 'شكراً لك. تم تأكيد بلد ميلادك وانتهت المحادثة.'
  },
  'es-MX': {
    question: '¿Cuál es su país de nacimiento?',
    switchAndQuestion: 'Claro. ¿Cuál es su país de nacimiento?',
    confirm: country => `Registré su país de nacimiento como ${country}. ¿Es correcto?`,
    retry: 'Por favor, diga el nombre de su país de nacimiento.',
    yesNo: 'Diga sí si es correcto, o no si necesita corregirse.',
    complete: 'Gracias. Su país de nacimiento ha sido confirmado. La conversación ha terminado.'
  },
  'zh-CN': {
    question: '您的出生国家是哪里？',
    switchAndQuestion: '当然可以。您的出生国家是哪里？',
    confirm: country => `我记录的出生国家是${country}。正确吗？`,
    retry: '请告诉我您的出生国家名称。',
    yesNo: '如果正确请说是，如果需要更正请说不是。',
    complete: '谢谢。您的出生国家已确认，对话结束。'
  },
  'hi-IN': {
    question: 'आपका जन्म देश कौन सा है?',
    switchAndQuestion: 'ज़रूर। आपका जन्म देश कौन सा है?',
    confirm: country => `मैंने आपका जन्म देश ${country} दर्ज किया है। क्या यह सही है?`,
    retry: 'कृपया अपने जन्म देश का नाम बताइए।',
    yesNo: 'यदि सही है तो हाँ कहें, और यदि सुधार चाहिए तो नहीं कहें।',
    complete: 'धन्यवाद। आपका जन्म देश पुष्टि हो गया है। बातचीत पूरी हुई।'
  },
  'uk-UA': {
    question: 'Яка країна вашого народження?',
    switchAndQuestion: 'Звичайно. Яка країна вашого народження?',
    confirm: country => `Я записала країну вашого народження як ${country}. Це правильно?`,
    retry: 'Будь ласка, назвіть країну вашого народження.',
    yesNo: 'Скажіть так, якщо правильно, або ні, якщо потрібно виправити.',
    complete: 'Дякую. Країну вашого народження підтверджено. Розмову завершено.'
  }
};

function aaCountryPrompts() {
  return AA_COUNTRY_PROMPTS[_aa.language] ||
    AA_COUNTRY_PROMPTS['en-US'];
}

const AA_COUNTRY_ALIASES = {
  'canada': 'Canada',
  'کانادا': 'کانادا',
  'كندا': 'كندا',
  'iran': 'Iran',
  'ایران': 'ایران',
  'ايران': 'إيران',
  'ایرون': 'ایران',
  'تو ایران': 'ایران',
  'در ایران': 'ایران',
  'من ایران به دنیا اومدم': 'ایران',
  'من در ایران به دنیا اومدم': 'ایران',
  'من ایران به دنیا آمدم': 'ایران',
  'من در ایران متولد شدم': 'ایران',
  'afghanistan': 'Afghanistan',
  'افغانستان': 'افغانستان',
  'syria': 'Syria',
  'سوریه': 'سوریه',
  'سوريا': 'سوريا',
  'france': 'France',
  'فرانسه': 'فرانسه',
  'فرنسا': 'فرنسا',
  'china': 'China',
  'چین': 'چین',
  'الصين': 'الصين',
  'india': 'India',
  'هند': 'هند',
  'pakistan': 'Pakistan',
  'پاکستان': 'پاکستان',
  'ukraine': 'Ukraine',
  'اوکراین': 'اوکراین',
  'أوكرانيا': 'أوكرانيا',
  'united states': 'United States',
  'usa': 'United States',
  'america': 'United States',
  'آمریکا': 'آمریکا',
  'الولايات المتحدة': 'الولايات المتحدة',
  'united kingdom': 'United Kingdom',
  'uk': 'United Kingdom',
  'england': 'United Kingdom',
  'بریتانیا': 'بریتانیا',
  'المملكة المتحدة': 'المملكة المتحدة',

  // Nationalities and common Speech-to-Text variants.
  'iranian': 'Iran',
  'iraninan': 'Iran',
  'irannian': 'Iran',
  'persian': 'Iran',
  'ایرانی': 'ایران',
  'إيراني': 'إيران',
  'canadian': 'Canada',
  'afghan': 'Afghanistan',
  'afghanistani': 'Afghanistan',
  'syrian': 'Syria',
  'french': 'France',
  'chinese': 'China',
  'indian': 'India',
  'pakistani': 'Pakistan',
  'ukrainian': 'Ukraine',
  'american': 'United States',
  'british': 'United Kingdom'
};

function aaExtractCountryLocally(transcript) {
  const raw = String(transcript || '').trim();
  if (!raw) return null;

  const normalized = aaNormalizeCommandText(raw);

  const aliases = Object.entries(AA_COUNTRY_ALIASES)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [alias, display] of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const latinWord = /^[a-z\s]+$/i.test(alias);

    if (latinWord) {
      const regex = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, 'i');
      if (regex.test(` ${normalized} `)) return display;
    } else if (normalized.includes(alias)) {
      return display;
    }
  }

  const cleaned = raw
    .replace(/[.,!?]+$/g, '')
    .trim();

  const normalizedCleaned =
    aaNormalizeCommandText(cleaned);

  // Confirmation or rejection language must never be interpreted as a
  // country, even when it is a short phrase such as "yes correct".
  const confirmationOrRejectionWords =
    /\b(yes|yeah|yep|correct|right|exactly|sure|no|nope|wrong|incorrect)\b/i;

  const nonLatinConfirmationWords =
    /(بله|آره|اره|درسته|صحیحه|نه|خیر|اشتباهه|غلطه|oui|non|نعم|لا)/i;

  if (
    confirmationOrRejectionWords.test(normalizedCleaned) ||
    nonLatinConfirmationWords.test(normalizedCleaned)
  ) {
    return null;
  }

  const sentenceWords =
    /\b(i|i'm|im|am|was|born|from|my|country|nationality|citizen)\b/i;

  const isBareCountryLike =
    cleaned.length >= 2 &&
    cleaned.length <= 30 &&
    !/\d/.test(cleaned) &&
    cleaned.split(/\s+/).length <= 3 &&
    !sentenceWords.test(cleaned);

  return isBareCountryLike ? cleaned : null;
}


const SYSTEM_COUNTRY_NORMALIZER = `You extract and normalize a country of birth from one short client response.

Return exactly this JSON:
{
  "country": "canonical English country name or empty string",
  "confidence": "high" | "medium" | "low"
}

Rules:
- Convert nationality adjectives to the country: Iranian -> Iran, Canadian -> Canada, French -> France.
- Correct obvious speech-recognition or spelling mistakes when the meaning is clear: "iraninan" -> Iran.
- In this interview context, "I am Iranian" means country of birth Iran.
- Do not repeat the client's full sentence.
- Return an empty country when no country can be identified.
- Use only the country name in the country field.`;

async function aaNormalizeCountryWithLLM(transcript) {
  try {
    const result = await callGPT(
      SYSTEM_COUNTRY_NORMALIZER,
      `Client response: "${transcript}"`,
      true
    );

    const country = String(result?.country || '').trim();
    const confidence = String(result?.confidence || '').toLowerCase();

    if (
      country &&
      country.length <= 60 &&
      (confidence === 'high' || confidence === 'medium')
    ) {
      return country;
    }
  } catch (error) {
    console.warn('[AI Assistant Country Normalizer]', error);
  }

  return null;
}

function aaDetectConfirmationLocally(transcript) {
  let value = aaNormalizeCommandText(transcript);

  // Make common STT variations harmless:
  // "that's" -> "thats", "correcct" -> "correct", repeated spaces removed.
  value = value
    .replace(/['’]/g, '')
    .replace(/\bcor+e*c+t+\b/g, 'correct')
    .replace(/\bri+g+h+t+\b/g, 'right')
    .replace(/\bexa+c+t+l*y+\b/g, 'exactly')
    .replace(/\s+/g, ' ')
    .trim();

  // A negative response always wins, even when the same sentence contains
  // a country correction, such as "No, it is Italy."
  const negativePatterns = [
    /^(no|nope)\b/,
    /\b(not correct|isnt correct|is not correct|incorrect|wrong)\b/,
    /^(نه|خیر)\b/,
    /\b(اشتباهه|غلطه|درست نیست)\b/,
    /^non\b/,
    /\b(ce n est pas correct|c est faux)\b/,
    /^لا\b/,
    /\b(خطأ|غير صحيح)\b/,
    /^no es correcto\b/,
    /^(不是|不对)/,
    /^नहीं\b/,
    /^ні\b/,
    /\bнеправильно\b/
  ];

  if (negativePatterns.some(pattern => pattern.test(value))) {
    return 'rejected';
  }

  // Natural English confirmation. This intentionally accepts common STT
  // variants such as:
  // "yes that correct", "yes that's correct", "yes it correct",
  // and a misspelled transcript such as "yes that correcct".
  const startsWithYes =
    /^(yes|yeah|yep|sure)\b/.test(value);

  const containsPositiveMeaning =
    /\b(correct|right|exactly|fine|good)\b/.test(value);

  const simplePositive =
    /^(yes|yeah|yep|sure|correct|right|exactly)$/.test(value);

  if (
    simplePositive ||
    (startsWithYes && containsPositiveMeaning) ||
    /^(yes|yeah|yep|sure)\s+(it|that|this)\s+(is\s+)?correct$/.test(value) ||
    /^(that|this|it)\s+(is\s+)?(correct|right)$/.test(value)
  ) {
    return 'confirmed';
  }

  const multilingualPositivePatterns = [
    /^(بله|آره|اره|درسته|صحیحه|درست است)$/,
    /^(oui|oui correct|c est correct|exactement|d accord)$/,
    /^(نعم|صحيح|صحيحة)$/,
    /^(sí|si|correcto)$/,
    /^(是|对)$/,
    /^(हाँ|जी हाँ)$/,
    /^(так|правильно)$/
  ];

  if (
    multilingualPositivePatterns.some(pattern => pattern.test(value))
  ) {
    return 'confirmed';
  }

  return null;
}

async function aaSaveCountryAndComplete(country) {
  const responses = loadResponses();
  const response = {
    questionId: _aa.question.id,
    question: _aa.question.question,
    fieldKey: 'country_of_birth',
    structuredValue: { country },
    originalClientAnswer: _aa.ctx.rawTranscripts?.[0]?.text || country,
    aiInterpretedAnswer: country,
    caseworkerCorrectedAnswer: country,
    isConfirmed: true,
    confirmationStatus: 'confirmed',
    rawTranscripts: _aa.ctx.rawTranscripts || [],
    answeredAt: new Date().toISOString()
  };

  const existingIndex =
    responses.findIndex(item => item.questionId === response.questionId);

  if (existingIndex >= 0) responses[existingIndex] = response;
  else responses.push(response);

  persistResponses(responses);

  aaSetStatus('complete');
  await aaSpeakLocalized(aaCountryPrompts().complete, _aa.language);
  _aa.active = false;
}



function aaNormalizeCommandText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u200c|\u200f|\u202a|\u202b|\u202c/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ۀ/g, 'ه')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[.,!?;:،؟]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aaDetectLanguageCommandLocally(transcript) {
  const value = String(transcript || '')
    .toLowerCase()
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const commands = [
    {
      code: 'fa-IR',
      words: [
        'persian', 'farsi', 'speak persian', 'speak farsi',
        'فارسی', 'فارسی صحبت کن', 'به فارسی',
        'میشه فارسی صحبت کنی', 'می شه فارسی صحبت کنی',
        'لطفا فارسی صحبت کن', 'لطفاً فارسی صحبت کن',
        'فارسی حرف بزن', 'با من فارسی صحبت کن'
      ]
    },
    {
      code: 'ar-SA',
      words: [
        'arabic', 'speak arabic', 'in arabic',
        'عربی', 'عربي', 'تحدث بالعربية', 'باللغة العربية'
      ]
    },
    {
      code: 'fr-CA',
      words: [
        'french', 'speak french', 'in french',
        'français', 'francais', 'parlez français'
      ]
    },
    {
      code: 'es-MX',
      words: [
        'spanish', 'speak spanish', 'in spanish',
        'español', 'habla español'
      ]
    },
    {
      code: 'zh-CN',
      words: [
        'chinese', 'mandarin', 'speak chinese',
        '中文', '普通话', '说中文'
      ]
    },
    {
      code: 'hi-IN',
      words: [
        'hindi', 'speak hindi', 'in hindi',
        'हिंदी', 'हिन्दी'
      ]
    },
    {
      code: 'uk-UA',
      words: [
        'ukrainian', 'speak ukrainian',
        'українська', 'говоріть українською'
      ]
    },
    {
      code: 'en-US',
      words: [
        'english', 'speak english', 'back to english',
        'can you speak english', 'can you speak english again',
        'please speak english', 'switch to english',
        'english again', 'continue in english',
        'انگلیسی', 'به انگلیسی', 'انگلیسی صحبت کن',
        'میشه انگلیسی صحبت کنی', 'می شه انگلیسی صحبت کنی',
        'دوباره انگلیسی صحبت کن', 'برگرد به انگلیسی'
      ]
    }
  ];

  for (const item of commands) {
    if (item.words.some(word => value.includes(word))) {
      return item.code;
    }
  }

  return null;
}

const _aa = {
  active: false,
  starting: false,
  peer: null,
  synth: null,
  recognizer: null,
  ctx: null,
  question: null,
  language: 'en-US',
  currentPromptEn: 'What is your country of birth?',
  loopToken: 0
};

function aaAvatarDisplayName() {
  const s = loadSettings();
  return s.avatarProvider === 'gemini' ? (s.geminiAvatarName || 'Kira') : 'Lisa';
}

function aaSetStatus(state, detail = '') {
  const status = document.getElementById('aa-status');
  const dot = document.getElementById('aa-status-dot');

  const states = {
    starting:  { label: 'Starting…', color: '#f59e0b' },
    speaking:  { label: `${aaAvatarDisplayName()} is speaking`, color: '#2563eb' },
    listening: { label: 'Listening…', color: '#dc2626' },
    analyzing: { label: 'Analyzing…', color: '#8b5cf6' },
    complete:  { label: 'Complete', color: '#16a34a' },
    error:     { label: 'Error', color: '#dc2626' },
    stopped:   { label: 'Stopped', color: '#64748b' }
  };

  const config = states[state] || states.stopped;

  if (status) status.textContent = config.label;
  if (dot) dot.style.background = config.color;
}

function aaShowError(message) {
  console.error('[AI Assistant]', message);
  toast('AI Assistant error: ' + message, 'error');
}

function aaHideMessages() {
  // No visible text panels in AI Assistant.
}

function aaInit() {
  if (_aa.active || _aa.starting) return;
  aaAutoStart();
}

function aaCountryQuestion() {
  return {
    id: 'assistant-country-of-birth',
    question: 'What is your country of birth?',
    expectedAnswer: 'Country name',
    category: 'Personal Information',
    type: 'open',
    priority: 'high',
    required: true,
    fieldKey: 'country_of_birth'
  };
}

function aaVoiceForLanguage(languageCode) {
  return aaLanguageConfig(languageCode).voiceName ||
    'en-US-Ava:DragonHDLatestNeural';
}

async function aaSpeakEnglishPrompt(promptEn) {
  const translated = await translateInterviewText(
    promptEn,
    _aa.language,
    'assistant_prompt'
  );

  const spokenText = translated || promptEn;
  await aaSpeakLocalized(spokenText, _aa.language);
}

async function aaSpeakLocalized(message, languageCode, options = {}) {
  if (!_aa.synth || !message) return;

  aaSetStatus('speaking', message);

  const audioEl = document.getElementById('aa-audio');
  if (audioEl) {
    audioEl.muted = false;
    audioEl.volume = 1;
    try { await audioEl.play(); } catch (_) {}
  }

  const voice = aaVoiceForLanguage(languageCode);
  const lang = languageCode || 'en-US';
  const safeMessage = esc(message);

  const leadingPauseMs = Math.max(
    0,
    Number(options.leadingPauseMs || 0)
  );

  const leadingBreak = leadingPauseMs > 0
    ? `<break time="${leadingPauseMs}ms"/>`
    : '';

  const ssml = `<speak version="1.0"
    xmlns="http://www.w3.org/2001/10/synthesis"
    xml:lang="${lang}">
    <voice name="${voice}">${leadingBreak}${safeMessage}</voice>
  </speak>`;

  await _aa.synth.speakSsmlAsync(ssml);
}


async function aaWaitForAudioReady(timeoutMs = 5000) {
  const audio = document.getElementById('aa-audio');
  if (!audio) return;

  audio.muted = false;
  audio.volume = 1;

  const startedAt = Date.now();

  while (
    (!audio.srcObject || audio.readyState < 1) &&
    Date.now() - startedAt < timeoutMs
  ) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  try {
    await audio.play();
  } catch (error) {
    console.warn('[AI Assistant Audio] Initial play was blocked:', error);
  }

  // Give the WebRTC audio track a brief moment to become audible.
  await new Promise(resolve => setTimeout(resolve, 450));
}

async function aaAutoStart() {
  if (_aa.active || _aa.starting) return;

  aaHideMessages();
  _aa.starting = true;
  _aa.language = 'en-US';
  _aa.loopToken++;
  const token = _aa.loopToken;

  aaSetStatus('starting', 'Connecting to Lisa');

  const settings = loadSettings();
  if (
    !settings.avatarKey ||
    !settings.avatarRegion ||
    !settings.avatarResourceName
  ) {
    _aa.starting = false;
    aaShowError('Configure Azure Speech settings first.');
    return;
  }

  try {
    const relayData = await fetchAvatarRelayToken(settings);
    const ice = normalizeAvatarIceInfo(relayData);

    _aa.peer = new RTCPeerConnection({
      iceServers: [{
        urls: [ice.turnUrl],
        username: ice.username,
        credential: ice.credential
      }]
    });

    _aa.peer.ontrack = event => {
      if (event.track.kind === 'video') {
        const host = document.getElementById('aa-remote-video');
        let video = document.getElementById('aa-video');

        if (!video) {
          video = document.createElement('video');
          video.id = 'aa-video';
          video.autoplay = true;
          video.playsInline = true;
          video.muted = true;
          video.style.cssText =
            'position:absolute;left:0;top:-2px;width:100%;height:calc(100% + 6px);min-height:726px;object-fit:contain;background:#fff;clip-path:inset(0 0 4px 0);';
          host.appendChild(video);
        }

        video.srcObject = event.streams[0];
        video.play().catch(error =>
          console.warn('[AI Assistant Video] play() blocked:', error)
        );

        const overlay = document.getElementById('aa-overlay');
        if (overlay) overlay.style.display = 'none';
      }

      if (event.track.kind === 'audio') {
        const audioEl = document.getElementById('aa-audio');
        if (!audioEl) return;

        audioEl.srcObject = event.streams[0];
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioEl.volume = 1;

        const resumeAudio = async () => {
          try {
            await audioEl.play();
          } catch (error) {
            console.warn('[AI Assistant Audio] autoplay blocked:', error);
          }
        };

        audioEl.onloadedmetadata = resumeAudio;
        audioEl.oncanplay = resumeAudio;
        setTimeout(resumeAudio, 250);
        setTimeout(resumeAudio, 1000);
      }
    };

    _aa.peer.addTransceiver('video', { direction: 'sendrecv' });
    _aa.peer.addTransceiver('audio', { direction: 'sendrecv' });

    const speechConfig =
      SpeechSDK.SpeechConfig.fromSubscription(
        settings.avatarKey,
        settings.avatarRegion
      );

    speechConfig.speechSynthesisLanguage = 'en-US';
    speechConfig.speechSynthesisVoiceName =
      settings.avatarVoice || 'en-US-LunaNeural';

    const avatarConfig =
      new SpeechSDK.AvatarConfig(settings.avatarCharacter || 'lisa', settings.avatarStyle || 'casual-sitting');

    avatarConfig.backgroundColor = '#FFFFFFFF';

    _aa.synth =
      new SpeechSDK.AvatarSynthesizer(
        speechConfig,
        avatarConfig
      );

    const startResult =
      await _aa.synth.startAvatarAsync(_aa.peer);

    if (
      startResult.reason !==
      SpeechSDK.ResultReason.SynthesizingAudioCompleted
    ) {
      const details =
        SpeechSDK.CancellationDetails.fromResult(startResult);

      throw new Error(
        details.errorDetails || 'Avatar connection failed.'
      );
    }

    if (token !== _aa.loopToken) return;

    _aa.question = aaCountryQuestion();
    _aa.ctx = createWfCtx(_aa.question);
    _aa.ctx.state = WF_STATE.COLLECTING_ANSWER;
    _aa.active = true;
    _aa.starting = false;

    await aaWaitForAudioReady();

    await aaSpeakLocalized(
      "Hello, and welcome! My name is Lisa, and I'm your AI assistant. It's a pleasure to meet you. Before we get started, I'd like to ask you a few questions so I can better understand your situation and make sure we provide the services and support that best meet your needs. This should only take a few minutes.",
      'en-US',
      { leadingPauseMs: 450 }
    );

    _aa.currentPromptEn = 'What is your country of birth?';
    await aaSpeakLocalized(
      aaCountryPrompts().question,
      _aa.language
    );

    await aaConversationLoop(token);
  } catch (error) {
    console.error('[AI Assistant]', error);
    _aa.starting = false;
    _aa.active = false;
    aaShowError(error.message || 'Unable to start the AI Assistant.');
  }
}

async function aaListen(languageCode) {
  const settings = loadSettings();

  return new Promise((resolve, reject) => {
    let finished = false;
    let finalParts = [];
    let latestPartial = '';
    let silenceTimer = null;
    let hardTimer = null;

    const finish = () => {
      if (finished) return;
      finished = true;

      clearTimeout(silenceTimer);
      clearTimeout(hardTimer);

      const transcript =
        finalParts.join(' ').trim() || latestPartial.trim();

      const recognizer = _aa.recognizer;
      _aa.recognizer = null;

      // Move the UI and workflow forward immediately after the browser's
      // three-second silence timer. Do not wait several additional seconds
      // for Azure's stop callback.
      if (transcript) {
        aaSetStatus('analyzing');
      }

      resolve(transcript);

      if (!recognizer) return;

      try {
        recognizer.stopContinuousRecognitionAsync(
          () => {
            try { recognizer.close(); } catch (_) {}
          },
          () => {
            try { recognizer.close(); } catch (_) {}
          }
        );
      } catch (_) {
        try { recognizer.close(); } catch (_) {}
      }
    };

    const restartSilenceTimer = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, 3000);
    };

    try {
      const speechConfig =
        SpeechSDK.SpeechConfig.fromSubscription(
          settings.speechKey,
          settings.speechRegion
        );

      speechConfig.speechRecognitionLanguage =
        aaLanguageConfig(languageCode).recognitionLanguage ||
        languageCode ||
        'en-US';

      try {
        speechConfig.outputFormat =
          SpeechSDK.OutputFormat.Detailed;

        speechConfig.setProperty(
          'SpeechServiceConnection_InitialSilenceTimeoutMs',
          '15000'
        );

        speechConfig.setProperty(
          'Speech_SegmentationSilenceTimeoutMs',
          '3000'
        );
      } catch (_) {}

      const audioConfig =
        SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();

      let recognizer;

      // Keep source-language detection active for every response.
      // This allows the client to switch back to English while the current
      // interview language is Persian, or switch to another supported language
      // without first speaking in the currently selected language.
      if (
        SpeechSDK.AutoDetectSourceLanguageConfig?.fromLanguages &&
        SpeechSDK.SpeechRecognizer?.FromConfig
      ) {
        try {
          speechConfig.setProperty(
            SpeechSDK.PropertyId
              ?.SpeechServiceConnection_LanguageIdMode ||
              'SpeechServiceConnection_LanguageIdMode',
            'AtStart'
          );

          const preferredLanguages = [
            _aa.language,
            'en-US',
            'fa-IR',
            'fr-CA',
            'ar-SA'
          ].filter(
            (language, index, all) =>
              language && all.indexOf(language) === index
          );

          const autoDetectConfig =
            SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(
              preferredLanguages
            );

          recognizer = SpeechSDK.SpeechRecognizer.FromConfig(
            speechConfig,
            autoDetectConfig,
            audioConfig
          );

          console.log(
            '[AI Assistant STT] Auto language detection enabled:',
            preferredLanguages
          );
        } catch (error) {
          console.warn(
            '[AI Assistant STT] Auto-detect unavailable; using current language',
            error
          );
        }
      }

      if (!recognizer) {
        recognizer = new SpeechSDK.SpeechRecognizer(
          speechConfig,
          audioConfig
        );
      }

      _aa.recognizer = recognizer;

      try {
        const phraseList =
          SpeechSDK.PhraseListGrammar.fromRecognizer(recognizer);

        [
          'speak Persian',
          'speak Farsi',
          'فارسی صحبت کن',
          'به فارسی',
          'میشه فارسی صحبت کنی',
          'لطفا فارسی صحبت کن',
          'فارسی حرف بزن',
          'با من فارسی صحبت کن',
          'speak French',
          'French please',
          'parlez français',
          'speak English',
          'English please',
          'can you speak English',
          'can you speak English again',
          'please speak English',
          'switch to English',
          'back to English',
          'English again',
          'انگلیسی صحبت کن',
          'دوباره انگلیسی صحبت کن',
          'برگرد به انگلیسی',
          'speak Arabic',
          'Arabic please',
          'تحدث بالعربية',
          'باللغة العربية',
          'speak Spanish',
          'Spanish please',
          'habla español',
          'speak Chinese',
          'speak Mandarin',
          '说中文',
          'speak Hindi',
          'speak Ukrainian',
          'Canada',
          'Iran',
          'Afghanistan',
          'Syria',
          'Ukraine',
          'India',
          'Pakistan',
          'China',
          'France'
        ].forEach(phrase => phraseList.addPhrase(phrase));

        if (typeof phraseList.setWeight === 'function') {
          phraseList.setWeight(1.8);
        }
      } catch (_) {}

      recognizer.recognizing = (_, event) => {
        latestPartial = (event.result?.text || '').trim();
        if (latestPartial) restartSilenceTimer();
      };

      recognizer.recognized = (_, event) => {
        if (
          event.result.reason ===
            SpeechSDK.ResultReason.RecognizedSpeech &&
          event.result.text
        ) {
          finalParts.push(event.result.text.trim());
          latestPartial = '';
          restartSilenceTimer();
        }
      };

      recognizer.canceled = (_, event) => {
        console.warn(
          '[AI Assistant STT]',
          event.errorDetails || event.reason
        );
        finish();
      };

      recognizer.sessionStopped = finish;

      recognizer.startContinuousRecognitionAsync(
        () => {
          aaSetStatus('listening');

          hardTimer = setTimeout(finish, 60000);
        },
        reject
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function aaHandleLanguageSwitch(transcript) {
  let targetLanguage =
    aaDetectLanguageCommandLocally(transcript);

  if (!targetLanguage) {
    const intent = await detectIntent(
      transcript,
      _aa.language
    );

    if (
      intent.intent === 'change_language' &&
      intent.targetLanguage
    ) {
      const targetMap = {
        english: 'en-US',
        'en-us': 'en-US',
        persian: 'fa-IR',
        farsi: 'fa-IR',
        'fa-ir': 'fa-IR',
        french: 'fr-CA',
        'fr-ca': 'fr-CA',
        arabic: 'ar-SA',
        'ar-sa': 'ar-SA',
        spanish: 'es-MX',
        'es-mx': 'es-MX',
        chinese: 'zh-CN',
        mandarin: 'zh-CN',
        'zh-cn': 'zh-CN',
        hindi: 'hi-IN',
        'hi-in': 'hi-IN',
        ukrainian: 'uk-UA',
        'uk-ua': 'uk-UA'
      };

      const rawTarget =
        String(intent.targetLanguage).trim();

      targetLanguage =
        targetMap[rawTarget.toLowerCase()] ||
        rawTarget;
    }
  }

  if (
    !targetLanguage ||
    !AA_LANGUAGE_CONFIG[targetLanguage]
  ) {
    return false;
  }

  _aa.language = targetLanguage;

  // One TTS call instead of two: confirm the switch and ask the current
  // question immediately in the selected language.
  await aaSpeakLocalized(
    aaCountryPrompts().switchAndQuestion,
    _aa.language
  );

  return true;
}

async function aaConversationLoop(token) {
  while (
    _aa.active &&
    token === _aa.loopToken &&
    _aa.ctx?.state !== WF_STATE.CONFIRMED
  ) {
    const transcript = await aaListen(_aa.language);

    if (
      !_aa.active ||
      token !== _aa.loopToken
    ) {
      return;
    }

    if (!transcript) {
      await aaSpeakEnglishPrompt(
        'I did not hear a response. Could you please answer the question?'
      );
      continue;
    }

    if (await aaHandleLanguageSwitch(transcript)) {
      continue;
    }

    aaSetStatus('analyzing');

    _aa.ctx.rawTranscripts = _aa.ctx.rawTranscripts || [];
    _aa.ctx.rawTranscripts.push({
      text: transcript,
      timestamp: new Date().toISOString()
    });

    // Fast path 1: country collection.
    if (
      _aa.ctx.state === WF_STATE.COLLECTING_ANSWER ||
      _aa.ctx.state === WF_STATE.ASKING
    ) {
      let country = aaExtractCountryLocally(transcript);

      if (!country) {
        country = await aaNormalizeCountryWithLLM(transcript);
      }

      if (country) {
        _aa.ctx.structuredValue = { country };
        _aa.ctx.state = WF_STATE.CONFIRMING;
        _aa.currentPromptEn = 'Confirm country of birth';

        await aaSpeakLocalized(
          aaCountryPrompts().confirm(country),
          _aa.language
        );

        continue;
      }
    }

    // Fast path 2: strict confirmation and correction handling.
    if (
      _aa.ctx.state === WF_STATE.CONFIRMING ||
      _aa.ctx.state === WF_STATE.RECONFIRMING
    ) {
      const confirmation =
        aaDetectConfirmationLocally(transcript);

      // A value is saved only after an explicit positive confirmation.
      if (confirmation === 'confirmed') {
        _aa.ctx.state = WF_STATE.CONFIRMED;
        _aa.ctx.isConfirmed = true;

        await aaSaveCountryAndComplete(
          _aa.ctx.structuredValue?.country || ''
        );
        return;
      }

      // Extract a possible corrected country from the complete response.
      // Example: "No, my country of birth is Iran."
      const mentionedCountry =
        confirmation === null
          ? (
              aaExtractCountryLocally(transcript) ||
              await aaNormalizeCountryWithLLM(transcript)
            )
          : (
              confirmation === 'rejected'
                ? (
                    aaExtractCountryLocally(transcript) ||
                    await aaNormalizeCountryWithLLM(transcript)
                  )
                : null
            );

      if (confirmation === 'rejected') {
        if (mentionedCountry) {
          _aa.ctx.structuredValue = {
            country: mentionedCountry
          };
          _aa.ctx.state = WF_STATE.RECONFIRMING;
          _aa.ctx.isConfirmed = false;
          _aa.currentPromptEn = 'Confirm corrected country of birth';

          await aaSpeakLocalized(
            aaCountryPrompts().confirm(mentionedCountry),
            _aa.language
          );

          continue;
        }

        // No replacement country was included, so ask for it again.
        _aa.ctx.state = WF_STATE.COLLECTING_ANSWER;
        _aa.ctx.structuredValue = {};
        _aa.ctx.isConfirmed = false;
        _aa.currentPromptEn = 'What is your country of birth?';

        await aaSpeakLocalized(
          aaCountryPrompts().retry,
          _aa.language
        );

        continue;
      }

      // A country name by itself is not confirmation. It is treated as a
      // correction/repetition and must always be read back again.
      if (mentionedCountry) {
        _aa.ctx.structuredValue = {
          country: mentionedCountry
        };
        _aa.ctx.state = WF_STATE.RECONFIRMING;
        _aa.ctx.isConfirmed = false;
        _aa.currentPromptEn = 'Confirm country of birth';

        await aaSpeakLocalized(
          aaCountryPrompts().confirm(mentionedCountry),
          _aa.language
        );

        continue;
      }

      await aaSpeakLocalized(
        aaCountryPrompts().yesNo,
        _aa.language
      );

      continue;
    }

    // Only unusual or ambiguous answers use the general LLM workflow.
    let nextPromptEn = '';

    const stepResult = await runWorkflowStep(
      _aa.question,
      transcript,
      null,
      _aa.ctx,
      async message => {
        nextPromptEn = message;
      },
      null,
      { useLocalAnalysis: false }
    );

    if (
      !_aa.active ||
      token !== _aa.loopToken
    ) {
      return;
    }

    if (
      stepResult.done &&
      _aa.ctx.state === WF_STATE.CONFIRMED &&
      _aa.ctx.isConfirmed
    ) {
      await aaSaveCountryAndComplete(
        _aa.ctx.structuredValue?.country ||
        _aa.ctx.lastAiResult?.interpretedAnswer ||
        ''
      );
      return;
    }

    _aa.currentPromptEn =
      nextPromptEn ||
      getWorkflowNextPromptPreview(_aa.ctx) ||
      _aa.ctx.lastAiResult?.suggestedFollowUp ||
      'Could you please clarify your country of birth?';

    const localizedFallback =
      _aa.ctx.state === WF_STATE.CONFIRMING
        ? aaCountryPrompts().confirm(
            _aa.ctx.structuredValue?.country || ''
          )
        : aaCountryPrompts().retry;

    await aaSpeakLocalized(
      localizedFallback,
      _aa.language
    );
  }
}

function aaStop() {
  _aa.loopToken++;
  _aa.active = false;
  _aa.starting = false;

  if (_aa.recognizer) {
    try {
      _aa.recognizer.stopContinuousRecognitionAsync();
    } catch (_) {}
    try { _aa.recognizer.close(); } catch (_) {}
  }

  if (_aa.synth) {
    try { _aa.synth.close(); } catch (_) {}
  }

  if (_aa.peer) {
    try { _aa.peer.close(); } catch (_) {}
  }

  _aa.peer = null;
  _aa.synth = null;
  _aa.recognizer = null;
  _aa.ctx = null;
  _aa.question = null;

  const video = document.getElementById('aa-video');
  if (video) {
    try { video.srcObject = null; } catch (_) {}
    video.remove();
  }

  const audio = document.getElementById('aa-audio');
  if (audio) {
    try { audio.pause(); } catch (_) {}
    if (audio.srcObject) {
      try {
        audio.srcObject.getTracks().forEach(track => track.stop());
      } catch (_) {}
    }
    try { audio.srcObject = null; } catch (_) {}
  }

  const overlay = document.getElementById('aa-overlay');
  if (overlay) overlay.style.display = 'flex';

  aaSetStatus('stopped', '');
}
