'use strict';

// Client Intake page runtime.
// Page-specific UI/state was extracted from app.js so the shared application file
// keeps common services, storage, Azure helpers, validation, and workflow logic.
// Loaded after app.js from interview.html.

// ─────────────────────────────────────────────────────────────
// CONVERSATION ENGINE — STATE + UI
// ─────────────────────────────────────────────────────────────
let conv = {
  questions: [],
  index:     0,
  phase:     'idle',   // idle | asking | analyzed | done
  analysis:  null,
  workflowCtx: null,
  workflowPrompt: '',
  followUpCount: 0,
  answerTurns: [],
  pendingFollowUp: null,
  awaitingFollowUpAnswer: false,
  followUpAnswersReceived: 0,
  answerReadyForCurrentPrompt: false,
  pendingConfirmation: null,   // { result, value, ambiguousCount } while "Is that correct?" is open
  confirmationRejections: 0,
  rejectedReadbacks: [],
  language: 'en-US'
};


const CLIENT_INTAKE_MAX_FOLLOWUPS = 3;
let _clientIntakeFollowUpToken = 0;
let _clientIntakePromptPlaying = false;

// ─────────────────────────────────────────────────────────────
// INTERVIEW LANGUAGE (Client Intake)
// The caseworker picks the language the questions are asked in. Choices are
// English plus every language that has translations in the Translation Engine.
// Questions/follow-ups are shown and spoken in that language with the English
// text underneath; speech is recognized in that language; the analysis and the
// saved/mapped answer stay in English.
// ─────────────────────────────────────────────────────────────
const CI_LANG_STORAGE_KEY = 'aic_intake_language';
const CI_VOICES = {
  'fa-IR': 'fa-IR-DilaraNeural',  'fr-CA': 'fr-CA-SylvieNeural',  'es-ES': 'es-ES-ElviraNeural',
  'ar-SA': 'ar-SA-ZariyahNeural', 'zh-CN': 'zh-CN-XiaoxiaoNeural', 'pt-BR': 'pt-BR-FranciscaNeural',
  'de-DE': 'de-DE-KatjaNeural',   'it-IT': 'it-IT-ElsaNeural',     'ru-RU': 'ru-RU-SvetlanaNeural',
  'tr-TR': 'tr-TR-EmelNeural',    'uk-UA': 'uk-UA-PolinaNeural',   'hi-IN': 'hi-IN-SwaraNeural'
};
let _ciLocalizeToken = 0;

function clientIntakeLanguage() {
  return (conv && conv.language) || 'en-US';
}

function clientIntakeLangInfo(code) {
  if (!code || code === 'en-US') return { code: 'en-US', name: 'English', native: 'English', iso2: 'gb', dir: 'ltr' };
  return (typeof TX_LANGUAGES !== 'undefined' && TX_LANGUAGES.find(l => l.code === code)) ||
         { code, name: code, native: code, iso2: '', dir: 'ltr' };
}

// Languages with at least one translated question from the current question bank.
function clientIntakeAvailableLanguages() {
  const qs = (conv && conv.questions && conv.questions.length) ? conv.questions : loadQuestions();
  const txs = (typeof loadTranslations === 'function') ? loadTranslations() : {};
  const list = [{ ...clientIntakeLangInfo('en-US'), count: qs.length, total: qs.length }];
  if (typeof TX_LANGUAGES === 'undefined') return list;
  TX_LANGUAGES.forEach(lang => {
    const data = txs[lang.code] || {};
    const count = qs.filter(q => data[q.id] && data[q.id].translated && !data[q.id].error).length;
    if (count > 0) list.push({ ...lang, count, total: qs.length });
  });
  return list;
}

function clientIntakeSavedLanguage() {
  let saved = 'en-US';
  try { saved = localStorage.getItem(CI_LANG_STORAGE_KEY) || 'en-US'; } catch (_) {}
  return saved;
}

function clientIntakeRecognitionLanguage() {
  return clientIntakeLanguage();
}

function clientIntakeLanguageBarHTML() {
  const langs = clientIntakeAvailableLanguages();
  const current = clientIntakeLanguage();
  const chips = langs.map(l => {
    const active = l.code === current;
    const partial = l.code !== 'en-US' && l.count < l.total;
    const flag = l.iso2 && typeof txFlagImg === 'function' ? txFlagImg(l.iso2, 20) : '🇬🇧';
    return `<button type="button" class="ci-lang-chip${active ? ' is-active' : ''}" aria-pressed="${active}"
        onclick="setClientIntakeLanguage('${l.code}')" title="${esc(l.name)}${partial ? ` — ${l.count}/${l.total} questions translated` : ''}">
        <span class="ci-lang-flag">${flag}</span>
        <span class="ci-lang-name" dir="${l.dir || 'ltr'}">${esc(l.native)}</span>
        ${partial ? `<span class="ci-lang-partial">${l.count}/${l.total}</span>` : ''}
      </button>`;
  }).join('');
  const hint = langs.length === 1
    ? `<span class="ci-lang-hint">Translate the questions in the <a href="translation.html">Translation Engine</a> to ask in other languages.</span>`
    : `<span class="ci-lang-hint">The answer is analyzed and saved in English.</span>`;
  return `<div class="ci-lang-bar" id="ci-lang-bar">
      <span class="ci-lang-label">Interview language</span>
      <div class="ci-lang-chips">${chips}</div>
      ${hint}
    </div>`;
}

function setClientIntakeLanguage(code) {
  const available = clientIntakeAvailableLanguages().map(l => l.code);
  if (!available.includes(code)) code = 'en-US';
  if (code === clientIntakeLanguage()) return;
  if (typeof _isListening !== 'undefined' && _isListening && typeof stopListening === 'function') stopListening();
  if (typeof stopCurrentAudio === 'function') stopCurrentAudio();
  conv.language = code;
  try { localStorage.setItem(CI_LANG_STORAGE_KEY, code); } catch (_) {}
  const bar = document.getElementById('ci-lang-bar');
  if (bar) bar.outerHTML = clientIntakeLanguageBarHTML();
  updateClientIntakePromptUi();
  toast(`Interview language: ${clientIntakeLangInfo(code).native}`, 'info');
}

// English prompt -> text in the interview language. Main questions use the
// Translation Engine result (including manual edits); anything else (follow-ups,
// workflow prompts, guardrail notices) is translated on demand and cached.
async function clientIntakeLocalize(textEn, opts = {}) {
  const lang = clientIntakeLanguage();
  if (!textEn || lang === 'en-US') return textEn;
  if (opts.questionId) {
    const tx = ((loadTranslations() || {})[lang] || {})[opts.questionId];
    if (tx && tx.translated && !tx.error && tx.original === textEn) return tx.translated;
    if (tx && tx.translated && !tx.error && !tx.original) return tx.translated;
  }
  try {
    const out = await translateInterviewText(textEn, lang, opts.kind || 'interview question');
    return out || textEn;
  } catch (_) {
    return textEn;
  }
}

// Current prompt in English (main question or active follow-up).
function clientIntakeCurrentPromptEn() {
  return conv.pendingFollowUp?.text || conv.questions[conv.index]?.question || '';
}

function clientIntakeCurrentPromptOpts() {
  const q = conv.questions[conv.index];
  return conv.pendingFollowUp?.text
    ? { kind: 'follow-up question' }
    : { kind: 'interview question', questionId: q?.id };
}

// Updates the question card: localized text on top, English underneath.
async function clientIntakeRenderLocalizedPrompt() {
  const main = document.getElementById('conv-active-question');
  const en = document.getElementById('conv-active-question-en');
  if (!main) return;
  const lang = clientIntakeLanguage();
  const info = clientIntakeLangInfo(lang);
  const promptEn = clientIntakeCurrentPromptEn();

  if (lang === 'en-US') {
    main.removeAttribute('dir');
    main.style.textAlign = '';
    main.classList.remove('is-translating');
    if (en) { en.style.display = 'none'; en.textContent = ''; }
    return;
  }

  const token = ++_ciLocalizeToken;
  main.setAttribute('dir', info.dir || 'ltr');
  main.style.textAlign = info.dir === 'rtl' ? 'right' : 'left';
  if (en) { en.style.display = 'block'; en.innerHTML = `<span class="conv-q-en-tag">EN</span>${esc(promptEn)}`; }

  const opts = clientIntakeCurrentPromptOpts();
  const stored = opts.questionId
    ? (((loadTranslations() || {})[lang] || {})[opts.questionId] || null)
    : null;
  if (stored && stored.translated && !stored.error && (!stored.original || stored.original === promptEn)) {
    main.classList.remove('is-translating');
    main.textContent = stored.translated;           // ready instantly, no flicker
    return;
  }
  main.classList.add('is-translating');
  main.textContent = promptEn;
  const localized = await clientIntakeLocalize(promptEn, opts);
  if (token !== _ciLocalizeToken || clientIntakeCurrentPromptEn() !== promptEn) return;
  main.classList.remove('is-translating');
  main.textContent = localized;
}

function resetGeneralQuestionTurnState() {
  conv.followUpCount = 0;
  conv.answerTurns = [];
  conv.pendingFollowUp = null;
  conv.awaitingFollowUpAnswer = false;
  conv.followUpAnswersReceived = 0;
  conv.answerReadyForCurrentPrompt = false;
  conv.pendingConfirmation = null;
  conv.confirmationRejections = 0;
  conv.rejectedReadbacks = [];
  _clientIntakeFollowUpToken++;
}

function buildAccumulatedClientAnswer() {
  const turns = (conv.answerTurns || []).map((t, i) => `Turn ${i + 1}: ${t}`);
  const notes = (conv.rejectedReadbacks || []).map(v =>
    `Note: the client said the read-back value "${v}" is NOT correct. Use the client's later corrections.`);
  return [...turns, ...notes].join('\n');
}

function saveGeneralConversationAndAdvance(q, ai, options = {}) {
  const turns = [...(conv.answerTurns || [])];
  const firstAnswer = turns[0] || '';
  const allAnswers = turns.join(' | ');
  const needsReview = !!options.needsReview;
  const confirmed = !!options.confirmed;

  const response = {
    questionId: q.id,
    question: q.question,
    category: q.category || 'General',
    type: q.type || 'open',
    detectedClientSpeech: allAnswers,
    clientAnswerTurns: turns,
    followUpCount: conv.followUpCount || 0,
    englishTranslation: ai.englishTranslation || ai.englishInterpretation || ai.interpretedAnswer || firstAnswer,
    mappingExplanation: ai.mappingExplanation || 'The client response was interpreted and mapped to the normalized value.',
    mappedAnswer: ai.normalizedValue || ai.interpretedAnswer || '',
    originalClientAnswer: firstAnswer,
    aiInterpretedAnswer: ai.interpretedAnswer || allAnswers,
    englishInterpretation: ai.englishInterpretation || ai.interpretedAnswer || allAnswers,
    caseworkerCorrectedAnswer: ai.normalizedValue || ai.interpretedAnswer || allAnswers,
    isAnswerComplete: !needsReview && ai.isAnswerComplete !== false,
    requiresCaseworkerReview: needsReview,
    reviewReason: needsReview ? (options.reviewReason || ai.missingInformation || 'Answer remained incomplete after the maximum number of follow-up questions.') : '',
    isConfirmed: confirmed,
    confirmationStatus: confirmed ? 'confirmed' : (needsReview ? 'review' : 'unconfirmed'),
    confirmationRejections: conv.confirmationRejections || 0,
    rejectedValues: [...(conv.rejectedReadbacks || [])],
    missingInformation: ai.missingInformation || '',
    suggestedFollowUp: ai.suggestedFollowUp || '',
    normalizedValue: ai.normalizedValue || '',
    interviewLanguage: clientIntakeLanguage(),
    answeredAt: new Date().toISOString()
  };

  const responses = loadResponses();
  const idx = responses.findIndex(r => r.questionId === q.id);
  if (idx >= 0) responses[idx] = response;
  else responses.push(response);
  persistResponses(responses);

  conv.index++;
  conv.analysis = null;
  conv.workflowCtx = null;
  conv.workflowPrompt = '';
  resetGeneralQuestionTurnState();
  conv.phase = conv.index >= conv.questions.length ? 'done' : 'asking';
  renderConv();
}

function getClientIntakePromptText() {
  const prompt = conv.pendingFollowUp?.text || conv.questions[conv.index]?.question || '';
  // After a guardrail intervention, Play Question reads the out-of-scope notice
  // once before the same prompt. It only applies to the exact prompt it was
  // created for, so it can never leak into another question.
  const g = conv.guardrailNotice;
  if (g && g.text && g.index === conv.index && g.prompt === prompt) {
    return `${g.text} ${prompt}`;
  }
  return prompt;
}

function clientIntakeShowGuardrail(answer, guardrail) {
  const q = conv.questions[conv.index];
  const prompt = conv.pendingFollowUp?.text || q?.question || '';
  const message = guardrail.messageEn || getGuardrailMessage('en-US', guardrail.category);

  conv.guardrailNotice = { text: message, index: conv.index, prompt, category: guardrail.category };

  // The same prompt must receive a NEW client response; nothing is consumed.
  conv.answerReadyForCurrentPrompt = false;
  _convSttMeta = null;
  const answerEl = document.getElementById('client-answer');
  if (answerEl) answerEl.value = '';

  resetConversationAnalysisUi();
  const box = document.getElementById('analysis-box');
  if (box) box.classList.add('visible');

  const origEl = document.getElementById('r-original');
  if (origEl) origEl.textContent = answer;
  const interpEl = document.getElementById('r-interpreted');
  if (interpEl) interpEl.innerHTML = '<span style="color:#dc2626;font-weight:700">⚠️ Out of Scope (Guardrail)</span>';

  const incWrap = document.getElementById('r-incomplete-wrap');
  if (incWrap) {
    incWrap.style.display = 'block';
    incWrap.innerHTML = `
      <div class="a-warning" style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;">🛡️
        <div><strong>Guardrail: ${esc(guardrail.reason || 'Out of scope')}</strong><br>${esc(message)}<br>
        <span style="color:#475569">Not saved and not counted as a follow-up. Press Play Question to read this notice and the question again.</span></div>
      </div>`;
  }

  const saveBtn = document.getElementById('btn-save-next');
  if (saveBtn) saveBtn.style.display = 'none';

  toast('Out of scope: please answer the current question.', 'warning');
  clientIntakePrefetchPrompt();   // notice + question is a new clip
}

// Exact text Play Question speaks for the current prompt, in the interview
// language (guardrail notice included). Shared by playback and prefetch so the
// prefetched audio is the same clip that is played.
async function clientIntakeSpokenPrompt() {
  const lang = clientIntakeLanguage();
  if (lang === 'en-US') {
    const text = getClientIntakePromptText();
    return text ? { text, lang } : null;
  }
  const promptEn = clientIntakeCurrentPromptEn();
  if (!promptEn) return null;
  const localized = await clientIntakeLocalize(promptEn, clientIntakeCurrentPromptOpts());
  let notice = '';
  const g = conv.guardrailNotice;
  if (g && g.text && g.index === conv.index && g.prompt === promptEn) {
    notice = (typeof hasGuardrailMessages === 'function' && hasGuardrailMessages(lang))
      ? getGuardrailMessage(lang, g.category)
      : await clientIntakeLocalize(g.text, { kind: 'assistant notice' });
  }
  return { text: [notice, localized].filter(Boolean).join(' '), lang };
}

// Generates the Gemini audio while the caseworker reads the question, so
// Play Question starts immediately instead of waiting 3–17 s.
async function clientIntakePrefetchPrompt() {
  if (typeof prefetchGoogleTTS !== 'function') return;
  try {
    const spoken = await clientIntakeSpokenPrompt();
    if (spoken) prefetchGoogleTTS(spoken.text, spoken.lang);

    // The next main question too, so it is ready right after this one is saved.
    const next = conv.questions[conv.index + 1];
    if (next?.question) {
      const lang = clientIntakeLanguage();
      const nextText = await clientIntakeLocalize(next.question, { kind: 'interview question', questionId: next.id });
      prefetchGoogleTTS(nextText, lang);
    }
  } catch (_) {}
}

async function playClientIntakePrompt() {
  if (_clientIntakePromptPlaying) return;

  const prompt = getClientIntakePromptText();
  if (!prompt) return;

  const btn = document.getElementById('btn-play-q');
  _clientIntakePromptPlaying = true;

  if (btn) {
    btn.disabled = true;
    btn.dataset.originalLabel = btn.innerHTML;
    btn.innerHTML = '🔊 Playing…';
  }

  try {
    const spoken = await clientIntakeSpokenPrompt();
    if (!spoken) return;
    if (spoken.lang === 'en-US') {
      await speakText(spoken.text);
    } else {
      await speakTextInLanguage(spoken.text, spoken.lang, CI_VOICES[spoken.lang]);
    }
  } finally {
    _clientIntakePromptPlaying = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.originalLabel || '🔊 Play Question';
      delete btn.dataset.originalLabel;
    }
  }
}

function updateClientIntakePromptUi() {
  const q = conv.questions[conv.index];
  if (!q) return;

  const main = document.getElementById('conv-active-question');
  const label = document.getElementById('conv-active-label');
  const expected = document.getElementById('conv-active-expected');

  if (conv.pendingFollowUp?.text) {
    if (main) main.textContent = conv.pendingFollowUp.text;
    if (label && conv.pendingFollowUp.confirmation) {
      label.textContent = `CONFIRM ANSWER · ${String(q.category || 'General').toUpperCase()}`;
    } else if (label) {
      const n = conv.pendingFollowUp.count || conv.followUpCount || 1;
      label.textContent = `FOLLOW-UP ${n}/${CLIENT_INTAKE_MAX_FOLLOWUPS} · ${String(q.category || 'General').toUpperCase()}`;
    }
    if (expected) expected.style.display = 'none';
  } else {
    if (main) main.textContent = q.question || '';
    if (label) label.textContent = `${conv.index + 1} / ${conv.questions.length} · ${String(q.category || 'General').toUpperCase()}`;
    if (expected) expected.style.display = q.expectedAnswer ? 'block' : 'none';
  }

  clientIntakeRenderLocalizedPrompt();
  clientIntakePrefetchPrompt();
}

function initConversation() {
  _convSttMeta = null;
  _convFirstSuccessfulCaptureDone = false;
  const qs = loadQuestions();
  const el = document.getElementById('conversation-content');

  if (!qs.length) {
    el.innerHTML = `<div class="card"><div class="empty-state">
      <div class="ei">💬</div>
      <h3>No questions available</h3>
      <p>Generate questions first using the Question Engine.</p>
      <button class="btn btn-primary" style="margin-top:16px" onclick="show('question-engine')">Go to Question Engine</button>
    </div></div>`;
    return;
  }

  conv = { questions: qs, index: 0, phase: 'asking', analysis: null, workflowCtx: null, workflowPrompt: '', followUpCount: 0, answerTurns: [], pendingFollowUp: null, awaitingFollowUpAnswer: false, followUpAnswersReceived: 0, answerReadyForCurrentPrompt: false, pendingConfirmation: null, confirmationRejections: 0, rejectedReadbacks: [], language: 'en-US' };
  const savedLang = clientIntakeSavedLanguage();
  if (clientIntakeAvailableLanguages().some(l => l.code === savedLang)) conv.language = savedLang;
  renderConv();
}

// [renderConv() moved below]

function resetConversationAnalysisUi() {
  const ids = ['r-normalized-wrap', 'r-incomplete-wrap', 'r-followup-wrap'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  const normalized = document.getElementById('r-normalized');
  if (normalized) normalized.innerHTML = '';

  const followup = document.getElementById('r-followup');
  if (followup) followup.textContent = '';

  const status = document.getElementById('conv-workflow-status');
  if (status) status.style.display = 'none';
}

function renderConversationWorkflowResult(q, ctx, latestAnswer, nextPrompt, done) {
  const box = document.getElementById('analysis-box');
  if (box) box.classList.add('visible');

  const allText = (ctx.rawTranscripts || [])
    .map((t, i) => `[${i + 1}] ${t.text}`)
    .join('\n');

  const interpreted =
    buildStrictFinalWorkflowAnswer(ctx) ||
    ctx.lastAiResult?.interpretedAnswer ||
    latestAnswer;

  const originalEl = document.getElementById('r-original');
  const interpretedEl = document.getElementById('r-interpreted');
  const correctedEl = document.getElementById('corrected-answer');

  if (originalEl) originalEl.textContent = allText || latestAnswer;
  if (interpretedEl) interpretedEl.textContent = interpreted;
  if (correctedEl) correctedEl.value = interpreted;

  const normalizedWrap = document.getElementById('r-normalized-wrap');
  const normalizedEl = document.getElementById('r-normalized');
  const value = ctx.structuredValue || {};
  const hasValue = Object.keys(value).some(k => value[k] !== '' && value[k] != null);

  if (normalizedWrap) normalizedWrap.style.display = hasValue ? 'block' : 'none';

  if (normalizedEl && hasValue) {
    normalizedEl.innerHTML = Object.entries(value)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) =>
        `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;margin-bottom:4px">
          <span style="color:var(--text-muted)">${esc(k)}</span>
          <strong>${esc(String(v))}</strong>
        </div>`
      )
      .join('');
  }

  const incompleteWrap = document.getElementById('r-incomplete-wrap');
  if (incompleteWrap) {
    incompleteWrap.style.display = 'block';

    if (ctx.state === WF_STATE.CONFIRMED) {
      incompleteWrap.innerHTML =
        '<div style="color:#15803d;font-size:13px;font-weight:600">✓ Confirmed and ready to save</div>';
    } else if (ctx.state === WF_STATE.FAILED) {
      incompleteWrap.innerHTML =
        '<div class="a-warning">⚠️ <div><strong>Review required:</strong> The information could not be confirmed.</div></div>';
    } else {
      incompleteWrap.innerHTML =
        '<div style="color:#2563eb;font-size:13px">Verification is still in progress. Do not save yet.</div>';
    }
  }

  const followWrap = document.getElementById('r-followup-wrap');
  const followEl = document.getElementById('r-followup');

  if (followWrap) followWrap.style.display = nextPrompt ? 'block' : 'none';
  if (followEl) followEl.textContent = nextPrompt || '';

  const workflowPrompt = document.getElementById('conv-workflow-prompt');
  if (workflowPrompt) {
    workflowPrompt.style.display = 'none';
    workflowPrompt.innerHTML = '';
  }

  const saveBtn = document.getElementById('btn-save-next');
  if (saveBtn) {
    saveBtn.style.display = 'none';
    saveBtn.disabled = true;
  }

  const analyzeBtn = document.getElementById('btn-analyze');
  if (analyzeBtn) {
    analyzeBtn.innerHTML = '🔍 Analyze Answer';
    analyzeBtn.style.display = done ? 'none' : 'inline-flex';
  }

  const answerLabel = document.getElementById('client-answer-label');
  if (answerLabel) {
    answerLabel.textContent = "Client's Answer";
  }

  box?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}



// buildStrictFinalWorkflowAnswer() lives in app.js (shared with the Virtual Caseworker).

function saveConfirmedConversationWorkflowAndAdvance(q, ctx) {
  const corrected =
    (document.getElementById('corrected-answer')?.value || '').trim();

  const strictFinalValue = buildStrictFinalWorkflowAnswer(ctx);

  // For workflow questions, the editable Final Answer starts with the strict
  // structured value. For names this is only "FirstName LastName".
  const finalValue = corrected || strictFinalValue;

  const response = {
    questionId: q.id,
    question: q.question,
    category: q.category || 'General',
    type: q.type || 'open',
    fieldKey: ctx.fieldKey,
    structuredValue: ctx.structuredValue,
    originalClientAnswer: ctx.rawTranscripts[0]?.text || '',
    aiInterpretedAnswer: strictFinalValue,
    caseworkerCorrectedAnswer: finalValue,
    isAnswerComplete: true,
    isAnswerValid: true,
    isConfirmed: true,
    confirmationStatus: 'confirmed',
    confirmationAttempts: ctx.confirmationAttempts,
    correctionAttempts: ctx.correctionAttempts,
    correctionHistory: ctx.correctionHistory,
    rawTranscripts: ctx.rawTranscripts,
    normalizedValue: ctx.structuredValue,
    missingInformation: '',
    suggestedFollowUp: '',
    englishTranslation: ctx.lastAiResult?.englishTranslation || '',
    interviewLanguage: clientIntakeLanguage(),
    confirmedAt: new Date().toISOString(),
    answeredAt: new Date().toISOString()
  };

  const responses = loadResponses();
  const idx = responses.findIndex(r => r.questionId === q.id);

  if (idx >= 0) responses[idx] = response;
  else responses.push(response);

  persistResponses(responses);

  conv.index++;
  conv.analysis = null;
  conv.workflowCtx = null;
  conv.workflowPrompt = '';
  conv.pendingFollowUp = null;
  conv.phase =
    conv.index >= conv.questions.length ? 'done' : 'asking';

  renderConv();
}

async function doAnalyze() {
  // Stop any previous prompt before analyzing a new response.
  stopCurrentAudio();

  const answerEl = document.getElementById('client-answer');
  const answer = (answerEl?.value || '').trim();

  if (!answer) {
    toast('Please enter or speak the client’s response first.', 'error');
    return;
  }

  // A displayed follow-up must receive a NEW client response before it can be
  // analyzed. This prevents the previous answer (or a duplicate Analyze call)
  // from consuming the final follow-up and advancing to the next question.
  if (conv.awaitingFollowUpAnswer && !conv.answerReadyForCurrentPrompt) {
    toast('Waiting for the client’s answer to the current follow-up.', 'error');
    return;
  }

  // Guardrail: out-of-scope responses (PR chances, advice, off-topic) are not
  // analyzed, not saved, and do NOT consume a follow-up. Fail-open on error.
  conv.guardrailNotice = '';
  if (typeof checkGuardrail === 'function') {
    const gBtn = document.getElementById('btn-analyze');
    const gQ = conv.questions[conv.index];
    if (gBtn) { gBtn.disabled = true; gBtn.innerHTML = '<span class="spinner"></span> Checking…'; }
    let guardrail = null;
    try {
      guardrail = await checkGuardrail(answer, gQ?.question, clientIntakeLanguage());
    } finally {
      if (gBtn) { gBtn.disabled = false; gBtn.innerHTML = '🔍 Analyze Answer'; }
    }
    if (guardrail && guardrail.triggered) {
      clientIntakeShowGuardrail(answer, guardrail);
      return;
    }
  }

  const answeringFollowUp = !!conv.awaitingFollowUpAnswer;
  if (answeringFollowUp) {
    conv.awaitingFollowUpAnswer = false;
    // A yes/no reply to the "Is that correct?" read-back is not a follow-up answer.
    if (!conv.pendingConfirmation) {
      conv.followUpAnswersReceived = (conv.followUpAnswersReceived || 0) + 1;
    }
  }
  conv.answerReadyForCurrentPrompt = false;

  const q = conv.questions[conv.index];
  const btn = document.getElementById('btn-analyze');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';

  resetConversationAnalysisUi();

  try {
    if (conversationQuestionNeedsWorkflow(q)) {
      if (
        !conv.workflowCtx ||
        conv.workflowCtx.questionId !== q.id
      ) {
        conv.workflowCtx = createWfCtx(q);
        conv.workflowCtx.state = WF_STATE.COLLECTING_ANSWER;
      }

      const ctx = conv.workflowCtx;
      let capturedPrompt = '';

      const speakFn = async (message) => {
        // Capture the next workflow prompt only.
        // The UI is rendered first; speech starts immediately afterward.
        capturedPrompt = message;
        conv.workflowPrompt = message;
      };

      const stepResult = await runWorkflowStep(
        q,
        answer,
        _convSttMeta,
        ctx,
        speakFn,
        null,
        { useLocalAnalysis: false }
      );

      const nextPrompt =
        ctx.state === WF_STATE.CONFIRMED
          ? ''
          : (
              ctx.fieldKey === 'full_name' &&
              (
                ctx.state === WF_STATE.CONFIRMING ||
                ctx.state === WF_STATE.RECONFIRMING
              )
                ? formatConfirmationSpeech(ctx)
                : (
                    capturedPrompt ||
                    getWorkflowNextPromptPreview(ctx) ||
                    ctx.lastAiResult?.suggestedFollowUp ||
                    ''
                  )
            );

      conv.analysis = {
        ...(ctx.lastAiResult || {}),
        interpretedAnswer:
          formatWorkflowValueForDisplay(ctx) ||
          ctx.lastAiResult?.interpretedAnswer ||
          answer,
        normalizedValue: ctx.structuredValue,
        isAnswerComplete: stepResult.done && ctx.state === WF_STATE.CONFIRMED,
        isConfirmed: ctx.isConfirmed,
        workflowState: ctx.state
      };

      conv.phase = stepResult.done ? 'analyzed' : 'asking';

      renderConversationWorkflowResult(
        q,
        ctx,
        answer,
        nextPrompt,
        stepResult.done
      );

      if (nextPrompt && !stepResult.done) {
        conv.pendingFollowUp = {
          text: nextPrompt,
          count: Math.min((conv.followUpCount || 0) + 1, CLIENT_INTAKE_MAX_FOLLOWUPS),
          workflow: true
        };
        conv.followUpCount = conv.pendingFollowUp.count;
        conv.awaitingFollowUpAnswer = true;
        conv.answerReadyForCurrentPrompt = false;
        updateClientIntakePromptUi();
        if (answerEl) answerEl.value = '';
      } else {
        conv.pendingFollowUp = null;
      }

      _convSttMeta = null;

      // When the client confirms the value, save automatically and move to
      // the next question. No separate Submit Confirmation or Save & Next
      // click is required.
      if (
        stepResult.done &&
        ctx.state === WF_STATE.CONFIRMED &&
        ctx.isConfirmed
      ) {
        toast('Confirmed and saved', 'success');
        await sleep(500);
        saveConfirmedConversationWorkflowAndAdvance(q, ctx);
        return;
      }

      // Capture the next spelling/correction/confirmation response separately.
      if (!stepResult.done && answerEl) {
        answerEl.value = '';
        answerEl.focus();
      }

      return;
    }

    // An "Is that correct?" read-back is open: this response is yes / no.
    if (conv.pendingConfirmation) {
      await clientIntakeHandleConfirmation(q, answer, answerEl);
      return;
    }

    await clientIntakeAnalyzeGeneral(q, answer, answerEl);

  } catch (err) {
    toast('Analysis failed: ' + err.message.substring(0, 120), 'error');
  } finally {
    btn.disabled = false;

    if (!conversationQuestionNeedsWorkflow(q)) {
      btn.innerHTML = '🔍 Analyze Answer';
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ANSWER CONFIRMATION (general questions)
// A complete, valid answer is read back ("I have … Is that correct?") and is
// saved only after the client says yes. "No" sends it back for correction.
// ─────────────────────────────────────────────────────────────
function clientIntakeAskConfirmation(q, result, answerEl) {
  const readback = buildAnswerReadback(q, result);
  conv.pendingConfirmation = { result, value: readback.value, ambiguousCount: 0 };
  conv.pendingFollowUp = { text: readback.prompt, confirmation: true };
  conv.awaitingFollowUpAnswer = true;
  conv.answerReadyForCurrentPrompt = false;
  updateClientIntakePromptUi();

  const incompleteWrap = document.getElementById('r-incomplete-wrap');
  if (incompleteWrap) {
    incompleteWrap.style.display = 'block';
    incompleteWrap.innerHTML =
      '<div style="color:#2563eb;font-size:13px">Waiting for the client to confirm this answer. Press Play Question to read it back.</div>';
  }
  const saveBtn = document.getElementById('btn-save-next');
  if (saveBtn) saveBtn.style.display = 'none';

  if (answerEl) answerEl.value = '';
  document.querySelector('.conv-q-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Answer understood — please confirm it with the client', 'info');
}

function clientIntakeAskAgain(text) {
  conv.pendingFollowUp = { text, confirmation: !!conv.pendingConfirmation };
  conv.awaitingFollowUpAnswer = true;
  conv.answerReadyForCurrentPrompt = false;
  updateClientIntakePromptUi();
  const answerEl = document.getElementById('client-answer');
  if (answerEl) answerEl.value = '';
}

async function clientIntakeHandleConfirmation(q, answer, answerEl) {
  const pc = conv.pendingConfirmation;

  // Plain yes/no is classified locally; anything longer goes to the LLM.
  let status = detectLocalConfirmation(answer);
  const plainReply = !!status;
  if (!status) {
    const cls = await analyzeConfirmationOnly(answer, {
      fieldKey: q.fieldKey || null,
      structuredValue: { question: q.question, value: pc.value }
    });
    status = cls.confirmationStatus;
  }

  if (status === 'confirmed') {
    conv.pendingConfirmation = null;
    conv.pendingFollowUp = null;
    toast('Confirmed and saved', 'success');
    await sleep(500);
    if (conv.questions[conv.index]?.id === q.id) {
      saveGeneralConversationAndAdvance(q, pc.result, { confirmed: true });
    }
    return;
  }

  if (status === 'rejected') {
    conv.pendingConfirmation = null;
    conv.confirmationRejections = (conv.confirmationRejections || 0) + 1;
    if (pc.value) conv.rejectedReadbacks.push(pc.value);

    if (conv.confirmationRejections >= CLIENT_INTAKE_MAX_FOLLOWUPS) {
      conv.pendingFollowUp = null;
      toast('Answer could not be confirmed — flagged for review', 'warning');
      saveGeneralConversationAndAdvance(q, pc.result, {
        needsReview: true,
        reviewReason: `The client rejected the read-back ${conv.confirmationRejections} times.`
      });
      return;
    }

    // "No, it's 1990" carries the correction: analyze it straight away.
    if (!plainReply) {
      await clientIntakeAnalyzeGeneral(q, answer, answerEl);
      return;
    }

    clientIntakeAskAgain(`I'm sorry about that. Could you please give me the correct answer? ${q.question}`);
    toast('Client said the answer is not correct — asking again', 'info');
    return;
  }

  // Ambiguous reply: ask for a clear yes / no (max 3 times, then review).
  pc.ambiguousCount++;
  if (pc.ambiguousCount >= CLIENT_INTAKE_MAX_FOLLOWUPS) {
    conv.pendingConfirmation = null;
    conv.pendingFollowUp = null;
    toast('Answer could not be confirmed — flagged for review', 'warning');
    saveGeneralConversationAndAdvance(q, pc.result, {
      needsReview: true,
      reviewReason: 'The client did not clearly confirm the read-back answer.'
    });
    return;
  }
  const readback = buildAnswerReadback(q, pc.result);
  clientIntakeAskAgain(`Please answer yes or no. ${readback.prompt}`);
}

async function clientIntakeAnalyzeGeneral(q, answer, answerEl) {
  // Normal questions: analyze the accumulated answer across the original
  // response plus any follow-up responses. This lets the AI combine partial
  // information instead of treating each follow-up as a brand-new answer.
  if (!Array.isArray(conv.answerTurns)) conv.answerTurns = [];
  conv.answerTurns.push(answer);

  const accumulatedAnswer = buildAccumulatedClientAnswer();
  const result = await analyzeAnswer(
    q.question,
    q.expectedAnswer || q.type,
    accumulatedAnswer,
    _convSttMeta,
    clientIntakeLanguage(),
    q.validation || {},
    q.type || 'open',
    q.clarificationDefinition || ''
  );

  // Deterministic checks the LLM may miss (future date of birth, 31 Feb…).
  // An invalid value is treated as incomplete so a follow-up is asked.
  if (result.isAnswerComplete !== false) {
    const check = validateIntakeAnswerValue(q, result);
    if (!check.ok) {
      result.isAnswerComplete = false;
      result.validationError = check.message;
      result.missingInformation = check.message;
      result.suggestedFollowUp = check.followUp;
    }
  }

  conv.analysis = result;
  conv.phase = 'analyzed';

  const box = document.getElementById('analysis-box');
  box.classList.add('visible');

  document.getElementById('r-original').textContent =
    conv.answerTurns.join('\n\n');
  document.getElementById('r-interpreted').textContent =
    result.interpretedAnswer || answer;
  document.getElementById('corrected-answer').value =
    result.interpretedAnswer || answer;

  if (result.normalizedValue) {
    document.getElementById('r-normalized-wrap').style.display = 'block';
    document.getElementById('r-normalized').innerHTML =
      `<code>${esc(result.normalizedValue)}</code>`;
  }

  if (!result.isAnswerComplete && result.missingInformation) {
    document.getElementById('r-incomplete-wrap').style.display = 'block';
    document.getElementById('r-incomplete-wrap').innerHTML = `
      <div class="a-warning">⚠️ <div><strong>Incomplete Answer:</strong> ${esc(result.missingInformation)}</div></div>`;
  }

  // Complete and valid answer: read it back and wait for the client's
  // yes / no before saving and moving to the next question.
  if (result.isAnswerComplete !== false) {
    const followWrap = document.getElementById('r-followup-wrap');
    if (followWrap) followWrap.style.display = 'none';
    clientIntakeAskConfirmation(q, result, answerEl);
    return;
  }

  // Incomplete answer: ask up to three real follow-up questions.
  if (conv.followUpCount < CLIENT_INTAKE_MAX_FOLLOWUPS && result.suggestedFollowUp) {
    conv.followUpCount += 1;

    conv.pendingFollowUp = {
      text: result.suggestedFollowUp,
      count: conv.followUpCount,
      workflow: false
    };
    conv.awaitingFollowUpAnswer = true;
    conv.answerReadyForCurrentPrompt = false;

    // The active follow-up is shown in the main question card at the top.
    // Recording and playback are fully manual: Play Question / Speak / Stop.
    updateClientIntakePromptUi();

    const followWrap = document.getElementById('r-followup-wrap');
    if (followWrap) followWrap.style.display = 'none';

    const saveBtn = document.getElementById('btn-save-next');
    if (saveBtn) saveBtn.style.display = 'none';

    if (answerEl) answerEl.value = '';
    document.querySelector('.conv-q-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Do not advance merely because the third follow-up has been DISPLAYED.
  // Advance only after the client has actually answered all three follow-ups.
  if ((conv.followUpAnswersReceived || 0) < CLIENT_INTAKE_MAX_FOLLOWUPS && conv.pendingFollowUp) {
    conv.awaitingFollowUpAnswer = true;
    conv.answerReadyForCurrentPrompt = false;
    updateClientIntakePromptUi();
    if (answerEl) answerEl.value = '';
    return;
  }

  // Three follow-up ANSWERS have now been received (or the model could not
  // form another useful follow-up). Flag the response for later review.
  conv.pendingFollowUp = null;
  conv.awaitingFollowUpAnswer = false;
  updateClientIntakePromptUi();
  const followWrap = document.getElementById('r-followup-wrap');
  if (followWrap) followWrap.style.display = 'block';
  const followEl = document.getElementById('r-followup');
  if (followEl) {
    followEl.textContent = `Maximum ${CLIENT_INTAKE_MAX_FOLLOWUPS} follow-ups reached. This answer will be flagged for human review.`;
  }

  const incompleteWrap = document.getElementById('r-incomplete-wrap');
  if (incompleteWrap) {
    incompleteWrap.style.display = 'block';
    incompleteWrap.innerHTML = `
      <div class="a-warning">⚠️ <div><strong>Needs Human Review:</strong> ${esc(result.missingInformation || 'The answer is still incomplete.')}</div></div>`;
  }

  const saveBtn = document.getElementById('btn-save-next');
  if (saveBtn) saveBtn.style.display = 'none';

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const unresolvedQ = q;
  const unresolvedResult = result;
  setTimeout(() => {
    if (conv.questions[conv.index]?.id === unresolvedQ.id) {
      saveGeneralConversationAndAdvance(unresolvedQ, unresolvedResult, { needsReview: true });
    }
  }, 900);
}

function saveAndNext() {
  _convSttMeta = null;

  const q = conv.questions[conv.index];
  const clientAnswer =
    (document.getElementById('client-answer')?.value || '').trim();
  const corrected =
    (document.getElementById('corrected-answer')?.value || '').trim();
  const ai = conv.analysis || {};

  let response;

  if (conversationQuestionNeedsWorkflow(q)) {
    const ctx = conv.workflowCtx;

    if (!ctx || ctx.state !== WF_STATE.CONFIRMED || !ctx.isConfirmed) {
      toast(
        'This answer must be spelled and confirmed before it can be saved.',
        'error'
      );
      return;
    }

    response = {
      questionId: q.id,
      question: q.question,
      category: q.category || 'General',
      type: q.type || 'open',
      fieldKey: ctx.fieldKey,
      structuredValue: ctx.structuredValue,
      originalClientAnswer: ctx.rawTranscripts[0]?.text || '',
      aiInterpretedAnswer:
        formatWorkflowValueForDisplay(ctx) ||
        ctx.lastAiResult?.interpretedAnswer ||
        '',
      caseworkerCorrectedAnswer:
        corrected ||
        formatWorkflowValueForDisplay(ctx) ||
        '',
      isAnswerComplete: true,
      isAnswerValid: true,
      isConfirmed: true,
      confirmationStatus: 'confirmed',
      confirmationAttempts: ctx.confirmationAttempts,
      correctionAttempts: ctx.correctionAttempts,
      correctionHistory: ctx.correctionHistory,
      rawTranscripts: ctx.rawTranscripts,
      normalizedValue: ctx.structuredValue,
      missingInformation: '',
      suggestedFollowUp: '',
      confirmedAt: new Date().toISOString(),
      answeredAt: new Date().toISOString()
    };
  } else {
    response = {
      questionId: q.id,
      question: q.question,
      category: q.category || 'General',
      type: q.type || 'open',
      detectedClientSpeech: clientAnswer,
      englishTranslation: ai.englishTranslation || ai.englishInterpretation || ai.interpretedAnswer || clientAnswer,
      mappingExplanation: ai.mappingExplanation || 'The client response was interpreted and mapped to the normalized value.',
      mappedAnswer: ai.normalizedValue || corrected || ai.interpretedAnswer || clientAnswer,

      originalClientAnswer: clientAnswer,
      aiInterpretedAnswer: ai.interpretedAnswer || clientAnswer,
      englishInterpretation: ai.englishInterpretation || ai.interpretedAnswer || clientAnswer,
      caseworkerCorrectedAnswer:
        corrected || ai.interpretedAnswer || clientAnswer,
      isAnswerComplete: ai.isAnswerComplete !== false,
      missingInformation: ai.missingInformation || '',
      suggestedFollowUp: ai.suggestedFollowUp || '',
      normalizedValue: ai.normalizedValue || '',
      answeredAt: new Date().toISOString()
    };
  }

  const responses = loadResponses();
  const idx = responses.findIndex(r => r.questionId === q.id);

  if (idx >= 0) responses[idx] = response;
  else responses.push(response);

  persistResponses(responses);

  conv.index++;
  conv.analysis = null;
  conv.workflowCtx = null;
  conv.workflowPrompt = '';
  resetGeneralQuestionTurnState();
  conv.phase =
    conv.index >= conv.questions.length ? 'done' : 'asking';

  renderConv();
}

function skipQ() {
  _convSttMeta = null;
  resetGeneralQuestionTurnState();
  conv.workflowCtx = null;
  conv.workflowPrompt = '';
  conv.index++;
  conv.analysis = null;
  conv.phase    = conv.index >= conv.questions.length ? 'done' : 'asking';
  renderConv();
}
