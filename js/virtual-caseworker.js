'use strict';

// Client intake runtime for the AI Assistant page.
// Keeps avatar, microphone/STT, transcript, and automatic interview orchestration separate from app.js.
// Loaded after app.js so it can reuse shared question/workflow helpers.

// ═══════════════════════════════════════════════════════════════════════════════
// AI ASSISTANT V2 — full question-bank driven real-time client session
// The avatar page is the primary client-session flow. It automatically:
// Ask -> Listen -> Detect end of speech -> Analyze -> Follow up / Next question.
// ═══════════════════════════════════════════════════════════════════════════════

const AA_END_SILENCE_MS = 1700;
const AA_INITIAL_SILENCE_MS = 8000;
const AA_SWITCH_DETECT_LANGUAGES = ['en-US', 'fa-IR', 'fr-CA'];
const AA_SWITCH_DECISION_GRACE_MS = 220;
const AA_SWITCH_DETECT_COOLDOWN_MS = 1400;
const AA_MAX_FOLLOWUPS = 3;
const AA_BARGE_IN_MIN_MS = 280;
const AA_BARGE_IN_END_SILENCE_MS = 900;
const AA_BARGE_IN_IGNORE_ECHO_RATIO = 0.55;


// Version 7 turn architecture: one authoritative phase and one routing decision
// per client utterance. Speech can be either a language-control utterance or an
// intake answer, never both.
const AA_PHASE = Object.freeze({
  STARTING: 'starting',
  SPEAKING: 'speaking',
  LISTENING: 'listening',
  ANALYZING: 'analyzing',
  COMPLETE: 'complete',
  STOPPED: 'stopped',
  ERROR: 'error'
});

function aaSetPhase(phase, detail = '') {
  aaEnsurePersistentState();

  // Ignore duplicate UI transitions. This prevents Speech SDK callbacks from
  // making the header flicker between Listening / Analyzing / Speaking.
  if (_aa.phase === phase && _aa.phaseDetail === detail) return;

  _aa.phase = phase;
  _aa.phaseDetail = detail;
  aaSetStatus(phase, detail);
}

function aaProgressLabel() {
  const total = Array.isArray(_aa.questions) ? _aa.questions.length : 0;
  const current = total ? Math.min((_aa.index || 0) + 1, total) : 0;
  return total ? `Question ${current} of ${total}` : 'No questions';
}

function aaUpdateProgressUi() {
  const label = document.getElementById('aa-progress');
  if (label) label.textContent = aaProgressLabel();

  const qEl = document.getElementById('aa-current-question');
  if (qEl) qEl.textContent = _aa.question?.question || '';
}

function aaResetQuestionRuntime(question) {
  _aa.question = question;
  _aa.followupCount = 0;
  _aa.genericTranscripts = [];
  _aa.pendingConfirm = null;      // read-back waiting for the client's yes / no
  _aa.rejectedReadbacks = [];
  _aa.confirmRejections = 0;
  _aa.reviewReason = '';

  if (conversationQuestionNeedsWorkflow(question)) {
    _aa.ctx = createWfCtx(question);
    _aa.ctx.state = WF_STATE.COLLECTING_ANSWER;
  } else {
    _aa.ctx = null;
  }

  _aa.currentPromptEn = question?.question || '';
  aaUpdateProgressUi();
}

function aaPersistResponse(response) {
  const responses = loadResponses();
  const idx = responses.findIndex(r => r.questionId === response.questionId);
  if (idx >= 0) responses[idx] = response;
  else responses.push(response);
  persistResponses(responses);
}

function aaSaveWorkflowResponse(question, ctx) {
  const strict = buildStrictFinalWorkflowAnswer(ctx);
  const detectedSpeech = (ctx.rawTranscripts || [])
    .map(x => x?.text || '')
    .filter(Boolean)
    .join(' ')
    .trim();

  aaPersistResponse({
    questionId: question.id,
    question: question.question,
    category: question.category || 'General',
    type: question.type || 'open',
    fieldKey: ctx.fieldKey,
    structuredValue: ctx.structuredValue,

    detectedClientSpeech: detectedSpeech,
    englishTranslation:
      ctx.lastAiResult?.englishTranslation ||
      ctx.lastAiResult?.interpretedAnswer ||
      detectedSpeech,
    mappingExplanation:
      ctx.lastAiResult?.mappingExplanation ||
      `The confirmed client response was mapped to the structured ${ctx.fieldKey || 'field'} value.`,
    mappedAnswer: strict || ctx.structuredValue || '',

    // Legacy compatibility fields.
    originalClientAnswer: ctx.rawTranscripts?.[0]?.text || detectedSpeech,
    aiInterpretedAnswer: strict || ctx.lastAiResult?.interpretedAnswer || '',
    englishInterpretation: ctx.lastAiResult?.englishTranslation || ctx.lastAiResult?.interpretedAnswer || '',
    caseworkerCorrectedAnswer: strict || ctx.lastAiResult?.interpretedAnswer || '',

    isAnswerComplete: ctx.state === WF_STATE.CONFIRMED,
    isAnswerValid: ctx.state === WF_STATE.CONFIRMED,
    isConfirmed: !!ctx.isConfirmed,
    confirmationStatus: ctx.isConfirmed ? 'confirmed' : (ctx.requiresCaseworkerReview ? 'review' : 'unconfirmed'),
    confirmationAttempts: ctx.confirmationAttempts || 0,
    correctionAttempts: ctx.correctionAttempts || 0,
    correctionHistory: ctx.correctionHistory || [],
    rawTranscripts: ctx.rawTranscripts || [],
    normalizedValue: ctx.structuredValue || {},
    missingInformation: ctx.lastAiResult?.missingInformation || '',
    suggestedFollowUp: ctx.lastAiResult?.suggestedFollowUp || '',
    requiresCaseworkerReview: !!ctx.requiresCaseworkerReview,
    language: _aa.language,
    answeredAt: new Date().toISOString()
  });
}

function aaSaveGenericResponse(question, analysis, transcripts, review = false) {
  const combined = (transcripts || []).join(' ').trim();
  const mapped = analysis?.normalizedValue ?? '';

  aaPersistResponse({
    questionId: question.id,
    question: question.question,
    category: question.category || 'General',
    type: question.type || 'open',

    detectedClientSpeech: combined,
    englishTranslation:
      analysis?.englishTranslation ||
      analysis?.englishInterpretation ||
      analysis?.interpretedAnswer ||
      combined,
    mappingExplanation:
      analysis?.mappingExplanation ||
      `The client's response was interpreted and mapped to the normalized value.`,
    mappedAnswer: mapped,

    // Keep legacy fields for compatibility with other pages/export code.
    originalClientAnswer: combined,
    aiInterpretedAnswer: analysis?.interpretedAnswer || combined,
    englishInterpretation: analysis?.englishInterpretation || analysis?.interpretedAnswer || combined,
    caseworkerCorrectedAnswer: mapped !== '' ? String(mapped) : (analysis?.interpretedAnswer || combined),

    isAnswerComplete: analysis?.isAnswerComplete !== false && !review,
    missingInformation: analysis?.missingInformation || '',
    suggestedFollowUp: analysis?.suggestedFollowUp || '',
    normalizedValue: mapped,
    requiresCaseworkerReview: review,
    reviewReason: review ? (_aa.reviewReason || analysis?.missingInformation || 'Needs caseworker review.') : '',
    isConfirmed: !!analysis?.isConfirmed,
    confirmationStatus: analysis?.isConfirmed ? 'confirmed' : (review ? 'review' : 'unconfirmed'),
    rejectedValues: [...(_aa.rejectedReadbacks || [])],
    followUpCount: _aa.followupCount || 0,
    language: _aa.language,
    answeredAt: new Date().toISOString()
  });
}

async function aaMoveToNextQuestion(token) {
  _aa.index = (_aa.index || 0) + 1;

  if (!_aa.active || token !== _aa.loopToken) return false;

  if (_aa.index >= _aa.questions.length) {
    aaSetPhase(AA_PHASE.COMPLETE);
    const message = 'Thank you. The assessment is complete. Your responses are ready for the caseworker to review.';
    await aaSpeakEnglishPrompt(message);
    _aa.active = false;
    return false;
  }

  const next = _aa.questions[_aa.index];
  aaResetQuestionRuntime(next);
  await aaSpeakEnglishPrompt(next.question);
  return true;
}

async function aaRestartMainRecognizer(targetLanguage) {
  _aa.bargeTranscript = '';
  _aa.preListenFinal = [];
  _aa.preListenPartial = '';
  _aa.preListenLanguage = '';

  await aaStopPersistentRecognizer();
  if (_aa.active) {
    await aaStartPersistentRecognizer(targetLanguage);
  }
}

function aaNormalizeSwitchTarget(value) {
  const targetMap = {
    english: 'en-US', 'en-us': 'en-US',
    persian: 'fa-IR', farsi: 'fa-IR', 'fa-ir': 'fa-IR',
    french: 'fr-CA', 'fr-ca': 'fr-CA'
  };

  const raw = String(value || '').trim();
  return targetMap[raw.toLowerCase()] || raw;
}

function aaDetectSwitchTargetFast(transcript, detectedLanguage = '') {
  const t = aaNormalizeSpeechText(transcript);
  if (!t) return null;

  const containsAny = phrases => phrases.some(p => t.includes(aaNormalizeSpeechText(p)));

  const rules = {
    'fa-IR': [
      'فارسی', 'به فارسی', 'فارسی صحبت کن', 'فارسی حرف بزن',
      'میشه فارسی صحبت کنی', 'می شه فارسی صحبت کنی',
      'من انگلیسی بلد نیستم', 'انگلیسی بلد نیستم',
      'انگلیسی نمی فهمم', 'انگلیسی نمیفهمم', 'انگلیسی متوجه نمی شم',
      'انگلیسی متوجه نمیشم', 'من فارسی راحت ترم', 'فارسی راحت ترم',
      'میتونی فارسی', 'می تونی فارسی', 'میشه فارسی', 'فارسی بلدی', 'فارسی هم بلدی',
      'speak persian', 'speak farsi', 'in persian', 'in farsi', 'persian please', 'farsi please',
      'talk in persian', 'talk in farsi', 'switch to persian', 'switch to farsi'
    ],
    'fr-CA': [
      'français', 'francais', 'en français', 'en francais',
      'parlez français', 'parlez francais', 'je ne parle pas anglais',
      "je ne comprends pas l anglais", "je ne comprends pas anglais",
      'je préfère le français', 'je prefere le francais',
      'speak french', 'in french', 'french please', 'switch to french', 'talk in french'
    ],
    'en-US': [
      'english please', 'speak english', 'in english', 'back to english',
      'switch to english', 'continue in english', 'i do not speak farsi',
      "i don't speak farsi", 'i do not speak french', "i don't speak french"
    ]
  };

  for (const [lang, phrases] of Object.entries(rules)) {
    if (lang !== _aa.language && containsAny(phrases)) return lang;
  }

  // If a different language was reliably detected and the user explicitly says
  // they cannot understand/speak the current language, continue in the detected language.
  if (detectedLanguage && detectedLanguage !== _aa.language) {
    if (detectedLanguage === 'fa-IR' && containsAny([
      'نمی فهمم', 'نمیفهمم', 'متوجه نمی شم', 'متوجه نمیشم', 'بلد نیستم'
    ])) return 'fa-IR';

    if (detectedLanguage === 'fr-CA' && containsAny([
      'je ne comprends pas', 'je ne parle pas', 'je préfère', 'je prefere'
    ])) return 'fr-CA';

    if (detectedLanguage === 'en-US' && containsAny([
      "i don't understand", 'i do not understand', "i don't speak", 'i do not speak', 'english please'
    ])) return 'en-US';
  }

  return null;
}

const AA_SWITCH_INTENT_PROMPT = `You are a multilingual language-switch classifier for a client intake interview.
The MAIN speech recognizer is intentionally fixed to the current session language for accuracy.
A separate detector has recognized the user's utterance in another possible language.

Decide whether the user is asking, requesting, or clearly implying that the interview should continue in another language.
Treat these as language-switch requests:
- asking the assistant to speak another language;
- saying they do not speak or understand the current language;
- saying they are more comfortable in another language;
- asking to continue in another language.

Do NOT switch merely because the user answered the intake question in another language without expressing a language preference.

Supported targets:
- en-US English
- fa-IR Persian/Farsi
- fr-CA French

Return ONLY JSON:
{"changeLanguage":true,"targetLanguage":"fa-IR","confidence":0.95}`;

async function aaClassifySwitchCandidate(transcript, detectedLanguage) {
  const fast = aaDetectSwitchTargetFast(transcript, detectedLanguage);
  if (fast) return fast;

  try {
    const result = await callGPT(
      AA_SWITCH_INTENT_PROMPT,
      `Current session language: ${_aa.language}\nDetected speech language: ${detectedLanguage || 'unknown'}\nUser utterance: "${transcript}"`,
      true
    );

    if (result?.changeLanguage === true && Number(result?.confidence || 0) >= 0.65) {
      const normalized = aaNormalizeSwitchTarget(result.targetLanguage);
      if (AA_SWITCH_DETECT_LANGUAGES.includes(normalized)) return normalized;
    }
  } catch (error) {
    console.warn('[Language Switch Detector] LLM classification failed:', error);
  }

  return null;
}


function aaDiscardCurrentUtteranceAsAnswer(reason = 'language-control') {
  aaEnsurePersistentState();

  // A language-control utterance is control data, not form data.
  // Remove any fixed-language garbage transcript produced from the same audio.
  _aa.bargeTranscript = '';
  _aa.preListenFinal = [];
  _aa.preListenPartial = '';
  _aa.preListenLanguage = '';

  const cutoff = Date.now() - 4500;
  _aa.pendingClientAnswers = (_aa.pendingClientAnswers || []).filter(item =>
    item.queuedAt < cutoff ||
    (item.questionId && _aa.question?.id && item.questionId !== _aa.question.id)
  );

  console.log('[Client Intake] Discarded current utterance as intake answer:', reason);
}

function aaQueueLanguageSwitch(targetLanguage, transcript, detectedLanguage) {
  const target = aaNormalizeSwitchTarget(targetLanguage);
  if (!target || !AA_LANGUAGE_CONFIG[target] || target === _aa.language) return false;

  _aa.switchUtteranceAt = Date.now();
  _aa.pendingLanguageSwitch = {
    targetLanguage: target,
    transcript: transcript || '',
    detectedLanguage: detectedLanguage || target,
    queuedAt: _aa.switchUtteranceAt
  };

  aaDiscardCurrentUtteranceAsAnswer('language switch requested');
  return true;
}

async function aaConsumePendingLanguageSwitch() {
  const pending = _aa.pendingLanguageSwitch;
  if (!pending) return false;

  _aa.pendingLanguageSwitch = null;
  const targetLanguage = pending.targetLanguage;
  if (!targetLanguage || targetLanguage === _aa.language) return false;

  aaSetPhase(AA_PHASE.ANALYZING, 'Switching language…');

  _aa.language = targetLanguage;
  _aa.lastDetectedLanguage = targetLanguage;

  // Restart only the MAIN recognizer in the new fixed locale. The multilingual
  // switch detector stays alive for the whole client session.
  await aaRestartMainRecognizer(targetLanguage);

  const confirmation = aaLanguageConfig(targetLanguage).confirmation || '';
  if (confirmation) {
    await aaSpeakLocalized(confirmation, targetLanguage);
  }

  // Repeat the current workflow/follow-up prompt in the newly selected language.
  const promptEn = _aa.currentPromptEn || _aa.question?.question || '';
  if (promptEn) await aaSpeakEnglishPrompt(promptEn);
  return true;
}

async function aaWaitForSwitchDecision() {
  if (_aa.pendingLanguageSwitch) return true;

  // The shadow detector finalizes slightly faster than the main recognizer.
  // Add only a tiny delay for normal answers, but if an LLM switch-classification
  // is already running, wait for that decision before analyzing the answer.
  await new Promise(resolve => setTimeout(resolve, AA_SWITCH_DECISION_GRACE_MS));
  if (_aa.pendingLanguageSwitch) return true;

  // Foreign-language speech was just heard by the shadow detector but its final
  // result has not been classified yet: wait briefly for it.
  const started = Date.now();
  while (
    !_aa.pendingLanguageSwitch && !_aa.switchCheckBusy &&
    Date.now() - (_aa.shadowForeignPartialAt || 0) < 1500 &&
    Date.now() - started < 1800
  ) {
    await new Promise(resolve => setTimeout(resolve, 70));
  }

  // An LLM classification can take a few seconds; wait for its decision.
  if (_aa.switchCheckBusy) {
    const busyStart = Date.now();
    while (_aa.switchCheckBusy && Date.now() - busyStart < 4000) {
      await new Promise(resolve => setTimeout(resolve, 70));
    }
  }

  return !!_aa.pendingLanguageSwitch;
}

async function aaHandleLanguageSwitch(transcript) {
  // Fast path for commands already decoded correctly by the fixed main recognizer.
  let targetLanguage = aaDetectLanguageCommandLocally(transcript);

  if (!targetLanguage) {
    const fast = aaDetectSwitchTargetFast(transcript, _aa.language);
    targetLanguage = fast;
  }

  if (!targetLanguage) {
    const intent = await detectIntent(transcript, _aa.language);
    if (intent.intent === 'change_language' && intent.targetLanguage) {
      targetLanguage = aaNormalizeSwitchTarget(intent.targetLanguage);
    }
  }

  if (!targetLanguage || !AA_LANGUAGE_CONFIG[targetLanguage] || targetLanguage === _aa.language) {
    return false;
  }

  aaQueueLanguageSwitch(targetLanguage, transcript, targetLanguage);
  return aaConsumePendingLanguageSwitch();
}


// Azure recognizes one language at a time. In a Persian/French session every
// answer is re-transcribed by Gemini (English street names, numbers and postal
// codes inside Persian speech come out right). In an English session this only
// happens when the client seems to have spoken another language (shadow detector
// heard foreign speech, or Azure's confidence was low), so normal English answers
// get no extra delay.
async function aaImproveTranscript(azureText) {
  const startedAt = _aa.utteranceStartAt || 0;
  const minConfidence = _aa.utteranceMinConfidence;
  _aa.utteranceStartAt = 0;
  _aa.utteranceMinConfidence = undefined;
  if (typeof aaGeminiTranscribe !== 'function' || !startedAt) return azureText;

  const session = _aa.language || 'en-US';
  const foreignHeard = (_aa.shadowForeignPartialAt || 0) >= startedAt - 1000;
  const lowConfidence = typeof minConfidence === 'number' && minConfidence < 0.8;
  if (session === 'en-US' && !foreignHeard && !lowConfidence) return azureText;

  const wav = aaMicRingWav(startedAt - 600, Date.now());
  if (!wav) return azureText;

  aaSetPhase(AA_PHASE.ANALYZING, 'Transcribing mixed-language answer');
  const result = await aaGeminiTranscribe(wav);
  if (!result) return azureText;
  // In an English session an English result adds nothing: keep Azure's text.
  if (session === 'en-US' && result.language === 'en-US') return azureText;

  const finalEl = document.getElementById('aa-transcript-final');
  if (finalEl) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:14px;line-height:1.5;color:#1e293b;';
    row.innerHTML = `<div style="font-size:10px;color:#7c3aed;margin-bottom:3px">Gemini · mixed-language transcript</div><div dir="auto">${esc(result.transcript)}</div>`;
    finalEl.appendChild(row);
    finalEl.scrollTop = finalEl.scrollHeight;
  }
  console.log('[Mixed-language STT] Azure:', azureText, '→ Gemini:', result.transcript, `(${result.language})`);
  return result.transcript;
}

async function aaCaptureAndRouteClientTurn(token) {
  // 1) A switch request captured during Lisa's speech wins immediately.
  if (_aa.pendingLanguageSwitch) {
    await aaConsumePendingLanguageSwitch();
    return { kind: 'language_switch' };
  }

  // 2) Capture exactly one client utterance. A barge-in transcript is consumed
  // before opening another listening turn.
  let transcript = aaTakeQueuedClientAnswer();
  if (!transcript) transcript = await aaListen(_aa.language);

  if (!_aa.active || token !== _aa.loopToken) return { kind: 'stopped' };

  // 3) Let the multilingual shadow recognizer finish classifying THIS SAME
  // utterance before deciding whether it is form data.
  await aaWaitForSwitchDecision();

  if (_aa.pendingLanguageSwitch) {
    aaDiscardCurrentUtteranceAsAnswer('shadow detector classified language control');
    await aaConsumePendingLanguageSwitch();
    return { kind: 'language_switch' };
  }

  // 4) One silent handoff retry, without re-speaking the question.
  if (!transcript) {
    aaSetPhase(AA_PHASE.LISTENING, 'Waiting for client response');
    transcript = await aaListen(_aa.language);
    if (!_aa.active || token !== _aa.loopToken) return { kind: 'stopped' };
  }

  if (!transcript) return { kind: 'empty' };

  // 4b) Mixed-language turns: let Gemini re-transcribe the same audio.
  transcript = await aaImproveTranscript(transcript);
  if (!_aa.active || token !== _aa.loopToken) return { kind: 'stopped' };

  // 5) Commands correctly decoded by the main recognizer are also control data.
  if (await aaHandleLanguageSwitch(transcript)) {
    aaDiscardCurrentUtteranceAsAnswer('main recognizer classified language control');
    return { kind: 'language_switch' };
  }

  // 5b) Guardrail: out-of-scope utterances (PR chances, advice/suggestions,
  // off-topic) are never treated as intake answers. Fail-open on any error.
  if (typeof checkGuardrail === 'function') {
    const guardrail = await checkGuardrail(transcript, _aa.question?.question, _aa.language || 'en-US');
    if (!_aa.active || token !== _aa.loopToken) return { kind: 'stopped' };
    if (guardrail && guardrail.triggered) {
      aaDiscardCurrentUtteranceAsAnswer('guardrail out-of-scope');
      return { kind: 'out_of_scope', transcript, guardrail };
    }
  }

  // 6) Only here does speech become an intake answer.
  aaSetPhase(AA_PHASE.ANALYZING, 'Analyzing client answer');
  return {
    kind: 'answer',
    transcript,
    language: _aa.lastDetectedLanguage || _aa.language
  };
}

async function aaConversationLoop(token) {
  while (_aa.active && token === _aa.loopToken) {
    try {
      const step = await aaConversationStep(token);
      if (step === 'stop') return;
    } catch (error) {
      // One failed step (network, AI or a bug) must not end the whole interview.
      console.error('[Virtual Caseworker] Step failed; repeating the current prompt.', error);
      toast('Something went wrong; asking the question again.', 'warning');
      if (!_aa.active || token !== _aa.loopToken) return;
      const promptEn = _aa.currentPromptEn || _aa.question?.question || '';
      try {
        await aaSpeakEnglishPrompt(promptEn ? `Sorry, let me ask that again. ${promptEn}` : 'Sorry, could you please repeat that?');
      } catch (_) {}
    }
  }
}

// Read-back confirmation for general questions: the client answers yes / no to
// "I have ... Is that correct?". Returns 'done' (handled), 'stop', or
// 'reanalyze' (a rejection that already contains the correction).
async function aaHandleConfirmationReply(q, transcript, token) {
  const pc = _aa.pendingConfirm;
  let status = typeof detectLocalConfirmation === 'function' ? detectLocalConfirmation(transcript) : null;
  const plainReply = !!status;
  if (!status) {
    const cls = await analyzeConfirmationOnly(transcript, {
      fieldKey: q.fieldKey || null,
      structuredValue: { question: q.question, value: pc.value }
    });
    status = cls.confirmationStatus;
  }
  if (!_aa.active || token !== _aa.loopToken) return 'stop';

  if (status === 'confirmed') {
    _aa.pendingConfirm = null;
    aaSaveGenericResponse(q, { ...pc.analysis, isConfirmed: true }, _aa.genericTranscripts, false);
    return (await aaMoveToNextQuestion(token)) ? 'done' : 'stop';
  }

  if (status === 'rejected') {
    _aa.pendingConfirm = null;
    _aa.confirmRejections = (_aa.confirmRejections || 0) + 1;
    if (pc.value) _aa.rejectedReadbacks.push(pc.value);
    if (_aa.confirmRejections >= AA_MAX_FOLLOWUPS) {
      _aa.reviewReason = `The client rejected the read-back ${_aa.confirmRejections} times.`;
      aaSaveGenericResponse(q, pc.analysis, _aa.genericTranscripts, true);
      await aaSpeakEnglishPrompt('Thank you. I will flag this answer for the caseworker to review and continue to the next question.');
      return (await aaMoveToNextQuestion(token)) ? 'done' : 'stop';
    }
    if (!plainReply) return 'reanalyze';   // e.g. "No, it was 1984"
    _aa.currentPromptEn = `I'm sorry about that. Could you please give me the correct answer? ${q.question}`;
    await aaSpeakEnglishPrompt(_aa.currentPromptEn);
    return 'done';
  }

  // Unclear reply: ask for a clear yes or no (max 3 times, then review).
  pc.ambiguous = (pc.ambiguous || 0) + 1;
  if (pc.ambiguous >= AA_MAX_FOLLOWUPS) {
    _aa.pendingConfirm = null;
    _aa.reviewReason = 'The client did not clearly confirm the read-back answer.';
    aaSaveGenericResponse(q, pc.analysis, _aa.genericTranscripts, true);
    return (await aaMoveToNextQuestion(token)) ? 'done' : 'stop';
  }
  _aa.currentPromptEn = `Please answer yes or no. ${buildAnswerReadback(q, pc.analysis).prompt}`;
  await aaSpeakEnglishPrompt(_aa.currentPromptEn);
  return 'done';
}

// One client turn of the interview. Returns 'stop' to end the loop.
async function aaConversationStep(token) {
  {
    const turn = await aaCaptureAndRouteClientTurn(token);

    if (turn.kind === 'stopped') return 'stop';
    if (turn.kind === 'language_switch') return 'done';

    if (turn.kind === 'out_of_scope') {
      // Does not count as a follow-up and is not added to the answer history.
      aaRecordGuardrailEvent(turn.transcript, turn.guardrail);
      aaSetPhase(AA_PHASE.SPEAKING, 'Out of scope — redirecting to question');

      // Notice: use the ready-made localized text when available; otherwise
      // translate the English notice (same pattern as language switching).
      if (hasGuardrailMessages(_aa.language)) {
        await aaSpeakLocalized(getGuardrailMessage(_aa.language, turn.guardrail?.category), _aa.language);
      } else {
        await aaSpeakEnglishPrompt(turn.guardrail?.messageEn || getGuardrailMessage('en-US', turn.guardrail?.category));
      }
      if (!_aa.active || token !== _aa.loopToken) return 'stop';

      // Then repeat the current prompt (main question or current follow-up).
      const promptEn = _aa.currentPromptEn || _aa.question?.question || '';
      if (promptEn) await aaSpeakEnglishPrompt(promptEn);
      return 'done';
    }

    if (turn.kind === 'empty') {
      _aa.currentPromptEn =
        _aa.currentPromptEn ||
        _aa.question?.question ||
        'Could you please answer the question?';

      await aaSpeakEnglishPrompt('I did not catch that. Please answer once more.');
      return 'done';
    }

    const transcript = turn.transcript;

    const q = _aa.question;
    if (!q) return 'stop';

    // Structured fields use the state-machine workflow (name, country, address, etc.).
    if (conversationQuestionNeedsWorkflow(q)) {
      let nextPromptEn = '';

      const result = await runWorkflowStep(
        q,
        transcript,
        null,
        _aa.ctx,
        async message => { nextPromptEn = message; },
        null,
        { useLocalAnalysis: false }
      );

      if (!_aa.active || token !== _aa.loopToken) return 'stop';

      if (result.done) {
        aaSaveWorkflowResponse(q, _aa.ctx);
        const moved = await aaMoveToNextQuestion(token);
        return moved ? 'done' : 'stop';
      }

      _aa.currentPromptEn =
        nextPromptEn ||
        getWorkflowNextPromptPreview(_aa.ctx) ||
        _aa.ctx.lastAiResult?.suggestedFollowUp ||
        'Could you please clarify that information?';

      await aaSpeakEnglishPrompt(_aa.currentPromptEn);
      return 'done';
    }

    // A read-back ("I have ... Is that correct?") is waiting for the client's yes / no.
    if (_aa.pendingConfirm) {
      const reply = await aaHandleConfirmationReply(q, transcript, token);
      if (reply !== 'reanalyze') return reply;
      // The rejection carried a correction: analyze it as part of the answer.
    }

    // General questions: accumulate all follow-up answers and let the LLM decide
    // whether the answer is complete. This is the reasoning layer.
    _aa.genericTranscripts.push(transcript);
    const rejectedNotes = (_aa.rejectedReadbacks || []).map(v =>
      `(Note: the client said the read-back value "${v}" is NOT correct; use the client's later corrections.)`);
    const combinedAnswer = [..._aa.genericTranscripts, ...rejectedNotes].join(' ');

    const analysis = await analyzeAnswer(
      q.question,
      q.expectedAnswer || q.type || 'open text',
      combinedAnswer,
      null,
      _aa.lastDetectedLanguage || _aa.language,
      q.validation || {},
      q.type || 'open'
    );

    if (!_aa.active || token !== _aa.loopToken) return 'stop';

    // Impossible values the AI may still accept (future date of birth, 31 Feb...).
    if (analysis.isAnswerComplete !== false && typeof validateIntakeAnswerValue === 'function') {
      const check = validateIntakeAnswerValue(q, analysis);
      if (!check.ok) {
        analysis.isAnswerComplete = false;
        analysis.missingInformation = check.message;
        analysis.suggestedFollowUp = check.followUp;
      }
    }

    if (analysis.isAnswerComplete !== false) {
      // Read back what was understood; it is saved only after the client says yes.
      const readback = buildAnswerReadback(q, analysis);
      _aa.pendingConfirm = { analysis, value: readback.value, ambiguous: 0 };
      _aa.currentPromptEn = readback.prompt;
      await aaSpeakEnglishPrompt(readback.prompt);
      return 'done';
    }

    _aa.followupCount++;

    if (_aa.followupCount >= AA_MAX_FOLLOWUPS) {
      aaSaveGenericResponse(q, analysis, _aa.genericTranscripts, true);
      await aaSpeakEnglishPrompt(
        'Thank you. I still need some clarification, so I will flag this answer for the caseworker to review and continue to the next question.'
      );
      const moved = await aaMoveToNextQuestion(token);
      return moved ? 'done' : 'stop';
    }

    _aa.currentPromptEn =
      analysis.suggestedFollowUp ||
      'Could you please provide the missing information?';

    await aaSpeakEnglishPrompt(_aa.currentPromptEn);
  }
}

// Shows a small red card in the live transcript when a guardrail fires.
function aaRecordGuardrailEvent(transcript, guardrail) {
  try {
    const finalEl = document.getElementById('aa-transcript-final');
    const empty = document.getElementById('aa-transcript-empty');
    if (empty) empty.style.display = 'none';
    if (!finalEl) return;

    const card = document.createElement('div');
    card.style.cssText = 'padding:10px 12px;margin:8px 0;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;font-size:12px;line-height:1.5;color:#991b1b;';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;font-weight:700;margin-bottom:4px;color:#b91c1c;">
        <span>🛡️ Guardrail — Out of Scope (${esc(guardrail?.category || 'out_of_scope')})</span>
        <span style="margin-left:auto;font-size:10px;opacity:0.8">${new Date().toLocaleTimeString()}</span>
      </div>
      <div style="font-style:italic;color:#475569;margin-bottom:6px;padding:4px 6px;background:rgba(255,255,255,0.7);border-radius:4px;">"${esc(transcript)}"</div>
      <div style="font-weight:600;">${esc(guardrail?.message || getGuardrailMessage(_aa?.language || 'en-US', guardrail?.category))}</div>
    `;
    finalEl.appendChild(card);
    finalEl.scrollTop = finalEl.scrollHeight;
  } catch (e) {
    console.warn('[Guardrail] could not render event card:', e && e.message);
  }
}

// Override the listener so end-of-speech is detected automatically after a
// short silence. The client never needs to press Stop.
function aaSetTranscript(partial = '', finalText = '', detectedLanguage = '') {
  const live = document.getElementById('aa-transcript-live');
  const finalEl = document.getElementById('aa-transcript-final');
  const empty = document.getElementById('aa-transcript-empty');
  const langEl = document.getElementById('aa-detected-language');

  if (langEl && detectedLanguage) {
    const labels = {
      'en-US': 'English (en-US)',
      'fa-IR': 'Persian / Farsi (fa-IR)',
      'fr-CA': 'French (fr-CA)'
    };
    langEl.textContent = labels[detectedLanguage] || detectedLanguage;
    langEl.style.color = '#2563eb';
  }

  if (live) {
    live.textContent = partial || '';
    live.style.display = partial ? 'block' : 'none';
  }
  if (finalEl && finalText) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:14px;line-height:1.5;color:#1e293b;';
    const langPrefix = detectedLanguage ? `<div style="font-size:10px;color:#64748b;margin-bottom:3px">${esc(detectedLanguage)}</div>` : '';
    row.innerHTML = `${langPrefix}<div>${esc(finalText)}</div>`;
    finalEl.appendChild(row);
    finalEl.scrollTop = finalEl.scrollHeight;
  }
  if (empty) {
    const hasText = !!partial || !!(finalEl && finalEl.children.length);
    empty.style.display = hasText ? 'none' : 'block';
  }
}

// Azure's auto language ID often labels short Persian utterances as en-US.
// Persian/Arabic script in the transcript is a much stronger signal.
function aaDetectedLanguageFromText(text, detected) {
  if (/[؀-ۿ]/.test(String(text || ''))) return 'fa-IR';
  return detected;
}

function aaDetectedLanguageFromResult(result) {
  try {
    if (SpeechSDK.AutoDetectSourceLanguageResult?.fromResult) {
      const detected = SpeechSDK.AutoDetectSourceLanguageResult.fromResult(result);
      if (detected?.language) return detected.language;
    }
  } catch (_) {}

  try {
    const props = result?.properties;
    const key = SpeechSDK.PropertyId?.SpeechServiceConnection_AutoDetectSourceLanguageResult;
    const value = key ? props?.getProperty(key) : '';
    if (value) return value;
  } catch (_) {}

  return '';
}

function aaClearTranscript() {
  const live = document.getElementById('aa-transcript-live');
  const finalEl = document.getElementById('aa-transcript-final');
  const empty = document.getElementById('aa-transcript-empty');
  if (live) { live.textContent = ''; live.style.display = 'none'; }
  if (finalEl) finalEl.innerHTML = '';
  if (empty) empty.style.display = 'block';
  const langEl = document.getElementById('aa-detected-language');
  if (langEl) { langEl.textContent = 'Waiting for speech…'; langEl.style.color = 'var(--text-muted)'; }
}


function aaNormalizeSpeechText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aaLooksLikeAvatarEcho(candidate, spokenMessage) {
  const a = aaNormalizeSpeechText(candidate);
  const b = aaNormalizeSpeechText(spokenMessage);
  if (!a || !b) return false;

  const aWords = new Set(a.split(' ').filter(w => w.length > 1));
  const bWords = new Set(b.split(' ').filter(w => w.length > 1));
  if (!aWords.size || !bWords.size) return false;

  let overlap = 0;
  for (const word of aWords) if (bWords.has(word)) overlap++;
  const ratio = overlap / Math.max(1, aWords.size);

  // Speaker echo is usually a literal substring or has very high word overlap
  // with Lisa's current utterance. Filter it before starting the interruption
  // timer, including longer partials/finals produced by the persistent mic.
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;

  const jaccard = overlap / Math.max(1, new Set([...aWords, ...bWords]).size);
  return (
    ratio >= Math.max(AA_BARGE_IN_IGNORE_ECHO_RATIO, 0.62) ||
    jaccard >= 0.58
  );
}

function aaStopAvatarSpeech() {
  return new Promise(resolve => {
    if (!_aa.synth) { resolve(); return; }
    try {
      _aa.synth.stopSpeakingAsync(
        () => resolve(),
        () => resolve()
      );
    } catch (_) {
      resolve();
    }
  });
}

function aaCreateRecognizer(languageCode, settings) {
  // MAIN recognizer: fixed to the current session language for better short-answer accuracy.
  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
    settings.speechKey,
    settings.speechRegion
  );

  speechConfig.speechRecognitionLanguage =
    aaLanguageConfig(languageCode).recognitionLanguage || languageCode || 'en-US';

  try {
    speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;
    speechConfig.setProperty(
      'SpeechServiceConnection_InitialSilenceTimeoutMs',
      String(AA_INITIAL_SILENCE_MS)
    );
    speechConfig.setProperty(
      'Speech_SegmentationSilenceTimeoutMs',
      String(AA_END_SILENCE_MS)
    );
  } catch (_) {}

  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  return new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
}

function aaCreateLanguageSwitchRecognizer(settings) {
  // SHADOW recognizer: multilingual, but NEVER used as the normal answer transcript.
  // Its only job is to detect requests such as "فارسی صحبت کن" or
  // "من انگلیسی بلد نیستم" while the main recognizer remains fixed to English.
  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
    settings.speechKey,
    settings.speechRegion
  );

  try {
    speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;
    speechConfig.setProperty(
      'SpeechServiceConnection_InitialSilenceTimeoutMs',
      String(AA_INITIAL_SILENCE_MS)
    );
    speechConfig.setProperty(
      'Speech_SegmentationSilenceTimeoutMs',
      '1200'
    );
    speechConfig.setProperty(
      SpeechSDK.PropertyId?.SpeechServiceConnection_LanguageIdMode ||
        'SpeechServiceConnection_LanguageIdMode',
      'Continuous'
    );
  } catch (_) {}

  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();

  if (
    SpeechSDK.AutoDetectSourceLanguageConfig?.fromLanguages &&
    SpeechSDK.SpeechRecognizer?.FromConfig
  ) {
    const autoDetectConfig =
      SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(AA_SWITCH_DETECT_LANGUAGES);

    return SpeechSDK.SpeechRecognizer.FromConfig(
      speechConfig,
      autoDetectConfig,
      audioConfig
    );
  }

  throw new Error('Azure Speech auto language detection is unavailable in this browser SDK.');
}


// ─────────────────────────────────────────────────────────────────────────────
// Persistent microphone / barge-in runtime
// One Azure Speech recognizer stays open for the whole client session.
// This avoids recreating the recognizer for every Lisa utterance/question.
// ─────────────────────────────────────────────────────────────────────────────

function aaEnsurePersistentState() {
  if (_aa.persistentRecognizer === undefined) _aa.persistentRecognizer = null;
  if (_aa.persistentRecognizerStarted === undefined) _aa.persistentRecognizerStarted = false;
  if (_aa.avatarSpeaking === undefined) _aa.avatarSpeaking = false;
  if (_aa.currentAvatarText === undefined) _aa.currentAvatarText = '';
  if (_aa.listenWaiter === undefined) _aa.listenWaiter = null;
  if (_aa.bargeCapture === undefined) _aa.bargeCapture = null;
  if (_aa.preListenFinal === undefined) _aa.preListenFinal = [];
  if (_aa.preListenPartial === undefined) _aa.preListenPartial = '';
  if (_aa.preListenLanguage === undefined) _aa.preListenLanguage = '';
  if (_aa.mainRecognizerLanguage === undefined) _aa.mainRecognizerLanguage = '';
  if (_aa.switchRecognizer === undefined) _aa.switchRecognizer = null;
  if (_aa.switchRecognizerStarted === undefined) _aa.switchRecognizerStarted = false;
  if (_aa.switchCheckBusy === undefined) _aa.switchCheckBusy = false;
  if (_aa.switchSpeechStartedAt === undefined) _aa.switchSpeechStartedAt = 0;
  if (_aa.lastSwitchCandidateAt === undefined) _aa.lastSwitchCandidateAt = 0;
  if (_aa.lastSwitchCandidateKey === undefined) _aa.lastSwitchCandidateKey = '';
  if (_aa.pendingLanguageSwitch === undefined) _aa.pendingLanguageSwitch = null;
  if (!Array.isArray(_aa.pendingClientAnswers)) _aa.pendingClientAnswers = [];
  if (_aa.phase === undefined) _aa.phase = AA_PHASE.STOPPED;
  if (_aa.phaseDetail === undefined) _aa.phaseDetail = '';
  if (_aa.switchUtteranceAt === undefined) _aa.switchUtteranceAt = 0;
}

function aaClearCaptureTimers(capture) {
  if (!capture) return;
  clearTimeout(capture.endTimer);
  clearTimeout(capture.initialTimer);
  clearTimeout(capture.hardTimer);
  capture.endTimer = null;
  capture.initialTimer = null;
  capture.hardTimer = null;
}

function aaFinishListenWaiter() {
  const waiter = _aa.listenWaiter;
  if (!waiter || waiter.finished) return;

  waiter.finished = true;
  aaClearCaptureTimers(waiter);

  const transcript =
    waiter.finalParts.join(' ').trim() ||
    (waiter.latestPartial || '').trim();

  _aa.lastDetectedLanguage =
    waiter.detectedLanguage ||
    _aa.lastDetectedLanguage ||
    waiter.languageCode ||
    'en-US';

  if (transcript) {
    aaSetTranscript('', transcript, _aa.lastDetectedLanguage);
    aaSetPhase(AA_PHASE.ANALYZING, 'Routing response…');
  }

  _aa.listenWaiter = null;
  waiter.resolve(transcript);
}

function aaRestartListenEndTimer() {
  const waiter = _aa.listenWaiter;
  if (!waiter || waiter.finished) return;

  clearTimeout(waiter.endTimer);
  waiter.endTimer = setTimeout(
    aaFinishListenWaiter,
    AA_END_SILENCE_MS
  );
}


function aaQueueClientAnswer(text, languageCode = '') {
  aaEnsurePersistentState();

  const clean = String(text || '').trim();
  if (!clean) return false;

  // Once the parallel language detector has classified this utterance as a
  // switch request, it must never become an intake answer.
  if (_aa.pendingLanguageSwitch) return false;

  const last = _aa.pendingClientAnswers[_aa.pendingClientAnswers.length - 1];
  if (last && last.text === clean && Date.now() - last.queuedAt < 2500) {
    return false;
  }

  _aa.pendingClientAnswers.push({
    text: clean,
    languageCode: languageCode || _aa.language || 'en-US',
    questionId: _aa.question?.id || null,
    queuedAt: Date.now(),
    source: 'barge-in'
  });

  console.log('[Client Intake] Queued barge-in answer:', clean);
  return true;
}

function aaTakeQueuedClientAnswer() {
  aaEnsurePersistentState();

  while (_aa.pendingClientAnswers.length) {
    const item = _aa.pendingClientAnswers.shift();
    if (!item?.text) continue;

    if (
      item.questionId &&
      _aa.question?.id &&
      item.questionId !== _aa.question.id
    ) {
      console.warn(
        '[Client Intake] Dropping stale queued answer for previous question:',
        item.text
      );
      continue;
    }

    _aa.lastDetectedLanguage =
      item.languageCode ||
      _aa.lastDetectedLanguage ||
      _aa.language ||
      'en-US';

    console.log('[Client Intake] Using queued barge-in answer:', item.text);
    return item.text;
  }

  return '';
}

function aaFinishBargeCapture() {
  const capture = _aa.bargeCapture;
  if (!capture || capture.finished || !capture.interrupted) return;

  capture.finished = true;
  aaClearCaptureTimers(capture);

  const transcript =
    capture.finalParts.join(' ').trim() ||
    (capture.latestPartial || '').trim();

  if (transcript && !capture.switchInterruption) {
    _aa.bargeTranscript = transcript;
    _aa.lastDetectedLanguage =
      capture.detectedLanguage ||
      _aa.lastDetectedLanguage ||
      capture.languageCode ||
      'en-US';

    // The speech that interrupted Lisa is already the client's answer to the
    // prompt being spoken. Queue it so the interview loop consumes it before
    // opening another listening turn.
    if (aaQueueClientAnswer(transcript, _aa.lastDetectedLanguage)) {
      aaSetPhase(AA_PHASE.ANALYZING, 'Routing response…');
    }

    aaSetTranscript('', transcript, _aa.lastDetectedLanguage);
  }

  if (typeof capture.resolveDone === 'function') {
    capture.resolveDone(transcript);
  }
}

function aaRestartBargeEndTimer() {
  const capture = _aa.bargeCapture;
  if (!capture || capture.finished || !capture.interrupted) return;

  clearTimeout(capture.endTimer);
  capture.endTimer = setTimeout(
    aaFinishBargeCapture,
    AA_BARGE_IN_END_SILENCE_MS
  );
}

// Gemini avatar only: she cannot be interrupted mid-sentence, and her voice can
// reach the microphone. Speech heard while she talks, during a short tail after
// she stops, or that merely repeats her last sentence is ignored, so her own
// words are never taken as the client's answer. (Lisa keeps barge-in.)
const AA_GEMINI_MIC_TAIL_MS = 900;
const AA_GEMINI_ECHO_WINDOW_MS = 4000;

function aaGeminiMicGuard(text) {
  if (!_aa.synth || !_aa.synth.isGeminiAvatar) return false;
  if (_aa.avatarSpeaking) return true;
  const now = Date.now();
  if (now < (_aa.geminiMicQuietUntil || 0)) return true;
  if (now < (_aa.geminiEchoWindowUntil || 0) && aaGeminiIsEcho(text, _aa.geminiLastSpokenText)) return true;
  return false;
}

// Stricter than the barge-in echo check: a reply such as "Yes, that is correct"
// shares words with "... Is that correct?" but is a real answer. Echo must
// repeat the avatar's words in the same order, and yes / no is never echo.
function aaGeminiIsEcho(candidate, spoken) {
  if (typeof detectLocalConfirmation === 'function' && detectLocalConfirmation(candidate)) return false;
  const a = aaNormalizeSpeechText(candidate).split(' ').filter(Boolean);
  const b = aaNormalizeSpeechText(spoken).split(' ').filter(Boolean);
  if (!a.length || !b.length) return false;
  if (/^(yes|yeah|yep|no|nope|correct|right|بله|آره|نه|خیر|oui|non)\b/.test(a.join(' '))) return false;
  if (a.length >= 2 && (' ' + b.join(' ') + ' ').includes(' ' + a.join(' ') + ' ')) return true;
  // Longest run of consecutive words shared in the same order.
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best >= 3 && best / a.length >= 0.6;
}

async function aaHandlePersistentRecognizing(event) {
  aaEnsurePersistentState();

  const text = (event.result?.text || '').trim();
  if (!text) return;
  if (aaGeminiMicGuard(text)) return;
  if (!_aa.utteranceStartAt) _aa.utteranceStartAt = Date.now() - 700;   // partials lag the speech slightly

  const detected = _aa.language || 'en-US';

  // While Lisa is speaking OR after a barge-in has started, keep the whole
  // client utterance attached to the same capture.
  if (_aa.avatarSpeaking || _aa.bargeCapture?.interrupted) {
    const capture = _aa.bargeCapture;
    if (!capture) return;

    // Echo filtering is only needed before a real interruption is accepted.
    if (!capture.interrupted && aaLooksLikeAvatarEcho(text, _aa.currentAvatarText)) {
      return;
    }

    if (detected) capture.detectedLanguage = detected;

    if (!capture.speechStartedAt) {
      capture.speechStartedAt = Date.now();
    }

    capture.latestPartial = text;
    aaSetTranscript(text, '', capture.detectedLanguage);

    if (
      !capture.interrupted &&
      Date.now() - capture.speechStartedAt >= AA_BARGE_IN_MIN_MS
    ) {
      capture.interrupted = true;
      _aa.avatarSpeaking = false;


      // Stop Lisa immediately, but KEEP the same recognizer running.
      aaStopAvatarSpeech().catch(() => {});
    }

    if (capture.interrupted) {
      aaRestartBargeEndTimer();
    }

    return;
  }

  // Normal listening turn.
  if (_aa.listenWaiter && !_aa.listenWaiter.finished) {
    const waiter = _aa.listenWaiter;
    if (detected) waiter.detectedLanguage = detected;
    waiter.latestPartial = text;
    aaSetTranscript(text, '', waiter.detectedLanguage);
    aaRestartListenEndTimer();
    return;
  }

  // Small hand-off window: client may start speaking immediately after Lisa
  // finishes but before aaListen() installs its promise.
  _aa.preListenPartial = text;
  if (detected) _aa.preListenLanguage = detected;
  aaSetTranscript(text, '', _aa.preListenLanguage);
}

function aaHandlePersistentRecognized(event) {
  aaEnsurePersistentState();

  if (
    event.result?.reason !== SpeechSDK.ResultReason.RecognizedSpeech ||
    !event.result?.text
  ) {
    return;
  }

  const text = event.result.text.trim();
  if (!text) return;
  if (aaGeminiMicGuard(text)) return;
  if (!_aa.utteranceStartAt) _aa.utteranceStartAt = Date.now() - 1500;
  try {
    const conf = JSON.parse(event.result.json || '{}').NBest?.[0]?.Confidence;
    if (typeof conf === 'number') _aa.utteranceMinConfidence = Math.min(_aa.utteranceMinConfidence ?? 1, conf);
  } catch (_) {}

  const detected = _aa.language || 'en-US';

  if (_aa.avatarSpeaking || _aa.bargeCapture?.interrupted) {
    const capture = _aa.bargeCapture;
    if (!capture) return;

    if (!capture.interrupted && aaLooksLikeAvatarEcho(text, _aa.currentAvatarText)) {
      return;
    }

    if (detected) capture.detectedLanguage = detected;

    // A final recognized phrase is strong evidence of real user speech.
    if (!capture.interrupted) {
      if (!capture.speechStartedAt) capture.speechStartedAt = Date.now();
      capture.interrupted = true;
      _aa.avatarSpeaking = false;
      aaSetPhase(AA_PHASE.LISTENING, 'Client interrupted the avatar');
      aaStopAvatarSpeech().catch(() => {});
    }

    capture.finalParts.push(text);
    capture.latestPartial = '';
    aaSetTranscript('', text, capture.detectedLanguage);
    aaRestartBargeEndTimer();
    return;
  }

  if (_aa.listenWaiter && !_aa.listenWaiter.finished) {
    const waiter = _aa.listenWaiter;
    if (detected) waiter.detectedLanguage = detected;

    waiter.finalParts.push(text);
    waiter.latestPartial = '';
    aaSetTranscript('', text, waiter.detectedLanguage);
    aaRestartListenEndTimer();
    return;
  }

  // Preserve speech that lands in the tiny gap between speaking and aaListen().
  _aa.preListenFinal.push(text);
  _aa.preListenPartial = '';
  if (detected) _aa.preListenLanguage = detected;
  aaSetTranscript('', text, _aa.preListenLanguage);
}

async function aaStartPersistentRecognizer(languageCode = 'en-US') {
  aaEnsurePersistentState();

  if (_aa.persistentRecognizerStarted && _aa.persistentRecognizer) return;

  const settings = loadSettings();
  const recognizer = aaCreateRecognizer(languageCode, settings);

  _aa.persistentRecognizer = recognizer;
  _aa.mainRecognizerLanguage = languageCode || 'en-US';

  recognizer.recognizing = (_, event) => {
    aaHandlePersistentRecognizing(event).catch(error =>
      console.warn('[Client Intake STT] recognizing handler:', error)
    );
  };

  recognizer.recognized = (_, event) => {
    try {
      aaHandlePersistentRecognized(event);
    } catch (error) {
      console.warn('[Client Intake STT] recognized handler:', error);
    }
  };

  recognizer.canceled = (_, event) => {
    console.warn(
      '[Client Intake STT] Persistent recognizer canceled:',
      event?.errorDetails || event?.reason || ''
    );

    _aa.persistentRecognizerStarted = false;

    if (_aa.listenWaiter && !_aa.listenWaiter.finished) {
      aaFinishListenWaiter();
    }
  };

  recognizer.sessionStopped = () => {
    console.warn('[Client Intake STT] Persistent recognizer session stopped.');
    _aa.persistentRecognizerStarted = false;

    if (_aa.listenWaiter && !_aa.listenWaiter.finished) {
      aaFinishListenWaiter();
    }
  };

  await new Promise((resolve, reject) => {
    recognizer.startContinuousRecognitionAsync(
      () => {
        _aa.persistentRecognizerStarted = true;
        console.log(
          '[Client Intake STT] Main fixed-language recognizer started:',
          _aa.mainRecognizerLanguage
        );
        if (typeof aaMicRingStart === 'function') aaMicRingStart();
        resolve();
      },
      reject
    );
  });
}

async function aaStopPersistentRecognizer() {
  aaEnsurePersistentState();

  aaClearCaptureTimers(_aa.listenWaiter);
  aaClearCaptureTimers(_aa.bargeCapture);

  if (_aa.listenWaiter && !_aa.listenWaiter.finished) {
    _aa.listenWaiter.finished = true;
    try { _aa.listenWaiter.resolve(''); } catch (_) {}
  }

  if (_aa.bargeCapture && typeof _aa.bargeCapture.resolveDone === 'function') {
    try { _aa.bargeCapture.resolveDone(''); } catch (_) {}
  }

  _aa.listenWaiter = null;
  _aa.bargeCapture = null;
  _aa.avatarSpeaking = false;
  _aa.currentAvatarText = '';
  _aa.preListenFinal = [];
  _aa.preListenPartial = '';
  _aa.preListenLanguage = '';

  const recognizer = _aa.persistentRecognizer;
  _aa.persistentRecognizer = null;
  _aa.persistentRecognizerStarted = false;
  _aa.mainRecognizerLanguage = '';

  if (!recognizer) return;

  await new Promise(resolve => {
    try {
      recognizer.stopContinuousRecognitionAsync(
        () => {
          try { recognizer.close(); } catch (_) {}
          resolve();
        },
        () => {
          try { recognizer.close(); } catch (_) {}
          resolve();
        }
      );
    } catch (_) {
      try { recognizer.close(); } catch (_) {}
      resolve();
    }
  });
}


async function aaHandleSwitchRecognizerPartial(event) {
  aaEnsurePersistentState();

  const text = (event.result?.text || '').trim();
  if (!text) return;

  const detectedLanguage = aaDetectedLanguageFromText(text, aaDetectedLanguageFromResult(event.result));
  if (!detectedLanguage || detectedLanguage === _aa.language) {
    _aa.switchSpeechStartedAt = 0;
    return;
  }
  // Remember that foreign speech is in progress, so the main answer path waits
  // for this utterance's final classification (aaWaitForSwitchDecision).
  _aa.shadowForeignPartialAt = Date.now();

  if (_aa.avatarSpeaking && aaLooksLikeAvatarEcho(text, _aa.currentAvatarText)) {
    _aa.switchSpeechStartedAt = 0;
    return;
  }

  // Only interrupt Lisa early when the partial already contains a clear local
  // language-switch cue. This prevents a short English answer such as
  // "I'm married" from being interrupted merely because auto-LID briefly guessed fa-IR.
  const fastTarget = aaDetectSwitchTargetFast(text, detectedLanguage);
  if (_aa.avatarSpeaking && _aa.bargeCapture && fastTarget) {
    if (!_aa.switchSpeechStartedAt) _aa.switchSpeechStartedAt = Date.now();

    if (Date.now() - _aa.switchSpeechStartedAt >= AA_BARGE_IN_MIN_MS) {
      const capture = _aa.bargeCapture;
      capture.interrupted = true;
      capture.switchInterruption = true;
      capture.detectedLanguage = detectedLanguage;
      _aa.avatarSpeaking = false;
      aaSetPhase(AA_PHASE.LISTENING, 'Language request detected');
      aaStopAvatarSpeech().catch(() => {});
    }
  } else {
    _aa.switchSpeechStartedAt = 0;
  }
}

async function aaEvaluateSwitchRecognizerFinal(event) {
  aaEnsurePersistentState();

  if (
    event.result?.reason !== SpeechSDK.ResultReason.RecognizedSpeech ||
    !event.result?.text
  ) return;

  const text = event.result.text.trim();
  if (!text) return;

  const detectedLanguage = aaDetectedLanguageFromText(text, aaDetectedLanguageFromResult(event.result));
  if (!detectedLanguage) return;

  if (_aa.avatarSpeaking && aaLooksLikeAvatarEcho(text, _aa.currentAvatarText)) {
    return;
  }

  const key = `${detectedLanguage}:${aaNormalizeSpeechText(text)}`;
  const now = Date.now();
  if (
    key === _aa.lastSwitchCandidateKey &&
    now - _aa.lastSwitchCandidateAt < AA_SWITCH_DETECT_COOLDOWN_MS
  ) return;

  _aa.lastSwitchCandidateKey = key;
  _aa.lastSwitchCandidateAt = now;

  // If this shadow recognizer is hearing the same language as the session,
  // the fixed main recognizer is the authoritative transcript.
  if (detectedLanguage === _aa.language) return;

  if (_aa.switchCheckBusy) return;
  _aa.switchCheckBusy = true;

  try {
    const targetLanguage = await aaClassifySwitchCandidate(text, detectedLanguage);
    if (!targetLanguage || targetLanguage === _aa.language) return;

    aaQueueLanguageSwitch(targetLanguage, text, detectedLanguage);

    const capture = _aa.bargeCapture;
    if (_aa.avatarSpeaking && capture) {
      capture.interrupted = true;
      capture.switchInterruption = true;
      capture.detectedLanguage = detectedLanguage;
      _aa.avatarSpeaking = false;
      aaSetPhase(AA_PHASE.LISTENING, 'Language request detected');
      aaStopAvatarSpeech().catch(() => {});
    }

    if (capture?.switchInterruption) {
      capture.finished = true;
      aaClearCaptureTimers(capture);
      if (typeof capture.resolveDone === 'function') capture.resolveDone('');
    }

    const langEl = document.getElementById('aa-detected-language');
    if (langEl) {
      const label = aaLanguageConfig(targetLanguage)?.name || targetLanguage;
      langEl.textContent = `${label} — language switch requested`;
      langEl.style.color = '#7c3aed';
    }
  } finally {
    _aa.switchCheckBusy = false;
    _aa.switchSpeechStartedAt = 0;
  }
}

async function aaStartLanguageSwitchDetector() {
  aaEnsurePersistentState();
  if (_aa.switchRecognizerStarted && _aa.switchRecognizer) return;

  const settings = loadSettings();
  const recognizer = aaCreateLanguageSwitchRecognizer(settings);
  _aa.switchRecognizer = recognizer;

  recognizer.recognizing = (_, event) => {
    aaHandleSwitchRecognizerPartial(event).catch(error =>
      console.warn('[Language Switch Detector] partial handler:', error)
    );
  };

  recognizer.recognized = (_, event) => {
    aaEvaluateSwitchRecognizerFinal(event).catch(error =>
      console.warn('[Language Switch Detector] final handler:', error)
    );
  };

  recognizer.canceled = (_, event) => {
    console.warn(
      '[Language Switch Detector] canceled:',
      event?.errorDetails || event?.reason || ''
    );
    _aa.switchRecognizerStarted = false;
  };

  recognizer.sessionStopped = () => {
    console.warn('[Language Switch Detector] session stopped.');
    _aa.switchRecognizerStarted = false;
  };

  await new Promise((resolve, reject) => {
    recognizer.startContinuousRecognitionAsync(
      () => {
        _aa.switchRecognizerStarted = true;
        console.log(
          '[Language Switch Detector] started:',
          AA_SWITCH_DETECT_LANGUAGES.join(', ')
        );
        resolve();
      },
      reject
    );
  });
}

async function aaStopLanguageSwitchDetector() {
  aaEnsurePersistentState();

  const recognizer = _aa.switchRecognizer;
  _aa.switchRecognizer = null;
  _aa.switchRecognizerStarted = false;
  _aa.switchCheckBusy = false;
  _aa.switchSpeechStartedAt = 0;
  _aa.pendingLanguageSwitch = null;

  if (!recognizer) return;

  await new Promise(resolve => {
    try {
      recognizer.stopContinuousRecognitionAsync(
        () => {
          try { recognizer.close(); } catch (_) {}
          resolve();
        },
        () => {
          try { recognizer.close(); } catch (_) {}
          resolve();
        }
      );
    } catch (_) {
      try { recognizer.close(); } catch (_) {}
      resolve();
    }
  });
}

async function aaSpeakLocalizedPersistent(message, languageCode, options = {}) {
  if (!_aa.synth || !message) return;

  aaEnsurePersistentState();

  const lang = languageCode || 'en-US';

  // The recognizer is opened once and remains active across every question.
  if (!_aa.persistentRecognizerStarted) {
    await aaStartPersistentRecognizer(lang);
  }

  // Lisa's voice arrives on this element. It has no source with the Gemini
  // avatar (the voice is inside the video), and play() on an element without a
  // source never settles, which would block the interview.
  const audioEl = document.getElementById('aa-audio');
  if (audioEl && (audioEl.srcObject || audioEl.currentSrc)) {
    audioEl.muted = false;
    audioEl.volume = 1;
    try { await audioEl.play(); } catch (_) {}
  }

  const voice = aaVoiceForLanguage(lang);
  const safeMessage = esc(message);
  const leadingPauseMs = Math.max(0, Number(options.leadingPauseMs || 0));
  const leadingBreak = leadingPauseMs > 0
    ? `<break time="${leadingPauseMs}ms"/>`
    : '';

  const ssml = `<speak version="1.0"
    xmlns="http://www.w3.org/2001/10/synthesis"
    xml:lang="${lang}">
    <voice name="${voice}">${leadingBreak}${safeMessage}</voice>
  </speak>`;

  let resolveBargeDone;
  const bargeDone = new Promise(resolve => { resolveBargeDone = resolve; });

  _aa.bargeCapture = {
    languageCode: lang,
    interrupted: false,
    switchInterruption: false,
    finished: false,
    speechStartedAt: 0,
    latestPartial: '',
    finalParts: [],
    detectedLanguage: '',
    endTimer: null,
    resolveDone: resolveBargeDone
  };

  _aa.currentAvatarText = message;
  _aa.avatarSpeaking = true;
  _aa.utteranceStartAt = 0;
  _aa.utteranceMinConfidence = undefined;
  aaSetPhase(AA_PHASE.SPEAKING, message);

  try {
    if (_aa.synth.isGeminiAvatar) await _aa.synth.speak(message);
    else await _aa.synth.speakSsmlAsync(ssml);
  } catch (error) {
    // stopSpeakingAsync normally cancels/rejects the active synthesis when the
    // client barges in. Treat that as expected.
    if (!_aa.bargeCapture?.interrupted) throw error;
  }

  const capture = _aa.bargeCapture;

  if (_aa.synth && _aa.synth.isGeminiAvatar) {
    const now = Date.now();
    _aa.geminiMicQuietUntil = now + AA_GEMINI_MIC_TAIL_MS;
    _aa.geminiEchoWindowUntil = now + AA_GEMINI_ECHO_WINDOW_MS;
    _aa.geminiLastSpokenText = message;
    // Anything buffered while she was speaking is her own voice, not an answer.
    _aa.preListenFinal = [];
    _aa.preListenPartial = '';
  }

  if (!capture?.interrupted) {
    _aa.avatarSpeaking = false;
    _aa.currentAvatarText = '';
    aaClearCaptureTimers(capture);
    _aa.bargeCapture = null;
    return;
  }

  // Lisa has been interrupted. Keep the persistent recognizer alive and wait
  // only for this client utterance to finish.
  _aa.avatarSpeaking = false;

  await Promise.race([
    bargeDone,
    new Promise(resolve => setTimeout(resolve, 6000))
  ]);

  if (_aa.bargeCapture && !_aa.bargeCapture.finished) {
    if (_aa.bargeCapture.switchInterruption) {
      _aa.bargeCapture.finished = true;
      aaClearCaptureTimers(_aa.bargeCapture);
      if (typeof _aa.bargeCapture.resolveDone === 'function') {
        _aa.bargeCapture.resolveDone('');
      }
    } else {
      aaFinishBargeCapture();
    }
  }

  _aa.currentAvatarText = '';
  _aa.bargeCapture = null;
}

// Override the shared speaker for this page only. app.js remains unchanged.
aaSpeakLocalized = aaSpeakLocalizedPersistent;

async function aaListen(languageCode) {
  aaEnsurePersistentState();

  if (!_aa.persistentRecognizerStarted) {
    await aaStartPersistentRecognizer(languageCode || _aa.language || 'en-US');
  }

  const queuedAnswer = aaTakeQueuedClientAnswer();
  if (queuedAnswer) {
    _aa.bargeTranscript = '';
    aaSetPhase(AA_PHASE.ANALYZING, 'Routing response…');
    return queuedAnswer;
  }

  if (_aa.bargeTranscript) {
    const buffered = _aa.bargeTranscript;
    _aa.bargeTranscript = '';
    aaSetPhase(AA_PHASE.ANALYZING, 'Routing response…');
    return buffered;
  }

  return new Promise(resolve => {
    const waiter = {
      resolve,
      languageCode: languageCode || _aa.language || 'en-US',
      finished: false,
      finalParts: [],
      latestPartial: '',
      detectedLanguage: _aa.preListenLanguage || '',
      endTimer: null,
      initialTimer: null,
      hardTimer: null
    };

    // Consume anything captured during the tiny hand-off gap.
    if (_aa.preListenFinal.length) {
      waiter.finalParts.push(..._aa.preListenFinal);
      _aa.preListenFinal = [];
    }

    if (_aa.preListenPartial) {
      waiter.latestPartial = _aa.preListenPartial;
      _aa.preListenPartial = '';
    }

    _aa.preListenLanguage = '';
    _aa.listenWaiter = waiter;
    aaSetPhase(AA_PHASE.LISTENING, 'Waiting for client response');

    if (waiter.finalParts.length || waiter.latestPartial) {
      aaRestartListenEndTimer();
    } else {
      waiter.initialTimer = setTimeout(() => {
        if (
          _aa.listenWaiter === waiter &&
          !waiter.finalParts.length &&
          !waiter.latestPartial
        ) {
          aaFinishListenWaiter();
        }
      }, AA_INITIAL_SILENCE_MS);
    }

    waiter.hardTimer = setTimeout(() => {
      if (_aa.listenWaiter === waiter) aaFinishListenWaiter();
    }, 60000);
  });
}

async function aaAutoStart() {
  if (_aa.active || _aa.starting) return;

  const questions = loadQuestions();
  if (!questions.length) {
    aaShowError('No questions are available. Generate or load a Question Bank first.');
    return;
  }

  aaHideMessages();
  aaClearTranscript();
  _aa.starting = true;
  _aa.language = 'en-US';
  _aa.questions = questions;
  _aa.index = 0;
  _aa.followupCount = 0;
  _aa.genericTranscripts = [];
  _aa.lastDetectedLanguage = '';
  _aa.bargeTranscript = '';
  _aa.pendingClientAnswers = [];
  _aa.pendingLanguageSwitch = null;
  _aa.phase = AA_PHASE.STARTING;
  _aa.phaseDetail = '';
  _aa.lastSwitchCandidateKey = '';
  _aa.lastSwitchCandidateAt = 0;
  _aa.loopToken++;
  const token = _aa.loopToken;

  const settings = loadSettings();
  const gemini = typeof useGeminiAvatar === 'function' && useGeminiAvatar(settings);
  const avatarName = gemini ? (settings.geminiAvatarName || 'Kira') : 'Lisa';

  aaSetPhase(AA_PHASE.STARTING, `Connecting to ${avatarName}`);
  aaUpdateProgressUi();

  if (gemini) {
    // Gemini Live avatar: same interview loop, listening, guardrails and saving;
    // only the face and voice come from Gemini instead of Azure.
    try {
      aaSetPhase(AA_PHASE.STARTING, 'Waiting for a click to allow sound');
      await geminiAvatarEnsureSoundAllowed(document.getElementById('aa-remote-video'));
      if (token !== _aa.loopToken) return;
      _aa.synth = new GeminiLiveAvatar(document.getElementById('aa-remote-video'), settings);
      await _aa.synth.connect();
      if (token !== _aa.loopToken) return;
      const overlay = document.getElementById('aa-overlay');
      if (overlay) overlay.style.display = 'none';

      _aa.active = true;
      _aa.starting = false;
      aaResetQuestionRuntime(_aa.questions[0]);

      await aaStartPersistentRecognizer(_aa.language);
      try {
        await aaStartLanguageSwitchDetector();
      } catch (error) {
        console.warn('[Language Switch Detector] Could not start; main STT will continue.', error);
      }

      await aaSpeakLocalized(`Hello, and welcome. I'm ${avatarName}`, 'en-US');
      await aaSpeakEnglishPrompt(_aa.question.question);
      await aaConversationLoop(token);
    } catch (error) {
      console.error('[Gemini Avatar]', error);
      _aa.starting = false;
      _aa.active = false;
      aaShowError(error.message || 'Unable to start the Gemini avatar.');
    }
    return;
  }

  if (!settings.avatarKey || !settings.avatarRegion || !settings.avatarResourceName) {
    _aa.starting = false;
    aaShowError('Configure Azure Speech Resource Name, Region, and API Key first.');
    return;
  }

  try {
    const relayData = await fetchAvatarRelayToken(settings);
    const ice = normalizeAvatarIceInfo(relayData);

    _aa.peer = new RTCPeerConnection({
      iceServers: [{ urls: [ice.turnUrl], username: ice.username, credential: ice.credential }]
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
            'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;object-position:center center;background:#fff;';
          host.appendChild(video);
        }
        video.srcObject = event.streams[0];
        video.play().catch(error => console.warn('[AI Assistant Video]', error));
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
        const play = () => audioEl.play().catch(() => {});
        audioEl.onloadedmetadata = play;
        audioEl.oncanplay = play;
        setTimeout(play, 250);
      }
    };

    _aa.peer.addTransceiver('video', { direction: 'sendrecv' });
    _aa.peer.addTransceiver('audio', { direction: 'sendrecv' });

    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
      settings.avatarKey,
      settings.avatarRegion
    );
    speechConfig.speechSynthesisLanguage = 'en-US';
    speechConfig.speechSynthesisVoiceName = settings.avatarVoice || 'en-US-LunaNeural';

    const avatarConfig = new SpeechSDK.AvatarConfig(settings.avatarCharacter || 'lisa', settings.avatarStyle || 'casual-sitting');
    avatarConfig.backgroundColor = '#FFFFFFFF';

    _aa.synth = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);
    const startResult = await _aa.synth.startAvatarAsync(_aa.peer);

    if (startResult.reason !== SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
      const details = SpeechSDK.CancellationDetails.fromResult(startResult);
      throw new Error(details.errorDetails || 'Avatar connection failed.');
    }

    if (token !== _aa.loopToken) return;

    _aa.active = true;
    _aa.starting = false;
    aaResetQuestionRuntime(_aa.questions[0]);

    await aaWaitForAudioReady();

    // MAIN STT stays fixed to the session language for accurate short answers.
    await aaStartPersistentRecognizer(_aa.language);

    // SHADOW STT uses auto language detection only to catch language-switch requests.
    // It never supplies normal intake answers to the LLM.
    try {
      await aaStartLanguageSwitchDetector();
    } catch (error) {
      console.warn('[Language Switch Detector] Could not start; main STT will continue.', error);
    }

    await aaSpeakLocalized(
      "Hello, and welcome. I'm Lisa",
      'en-US',
      { leadingPauseMs: 350 }
    );

    await aaSpeakEnglishPrompt(_aa.question.question);
    await aaConversationLoop(token);
  } catch (error) {
    console.error('[AI Assistant V2]', error);
    _aa.starting = false;
    _aa.active = false;
    aaShowError(error.message || 'Unable to start the AI Assistant.');
  }
}

function aaStop() {
  _aa.loopToken++;
  _aa.active = false;
  _aa.starting = false;

  // Both recognizers are session-scoped and are stopped only when the client session ends.
  aaStopPersistentRecognizer().catch(() => {});
  aaStopLanguageSwitchDetector().catch(() => {});
  if (typeof aaMicRingStop === 'function') aaMicRingStop();

  if (_aa.recognizer) {
    try { _aa.recognizer.stopContinuousRecognitionAsync(); } catch (_) {}
    try { _aa.recognizer.close(); } catch (_) {}
  }
  if (_aa.synth) { try { _aa.synth.close(); } catch (_) {} }
  if (_aa.peer) { try { _aa.peer.close(); } catch (_) {} }

  _aa.peer = null;
  _aa.synth = null;
  _aa.recognizer = null;
  _aa.bargeTranscript = '';
  _aa.pendingClientAnswers = [];
  _aa.phase = AA_PHASE.STOPPED;
  _aa.phaseDetail = '';
  _aa.ctx = null;
  _aa.question = null;
  _aa.questions = [];
  _aa.index = 0;

  const video = document.getElementById('aa-video');
  if (video) {
    try { video.srcObject = null; } catch (_) {}
    video.remove();
  }

  const audio = document.getElementById('aa-audio');
  if (audio) {
    try { audio.pause(); } catch (_) {}
    try { audio.srcObject = null; } catch (_) {}
  }

  const overlay = document.getElementById('aa-overlay');
  if (overlay) overlay.style.display = 'flex';

  aaSetPhase(AA_PHASE.STOPPED, '');
  aaUpdateProgressUi();
}
