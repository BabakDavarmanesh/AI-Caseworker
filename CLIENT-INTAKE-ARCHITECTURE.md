# Client Intake Architecture — Version 7

## Core rule
Each client utterance is routed exactly once as either:

1. `language_switch` — control speech only; never saved or analyzed as an intake answer.
2. `answer` — intake data; sent to the question/workflow analyzer.
3. `empty` — no usable speech; one silent listening retry before any spoken retry prompt.

## Turn flow

`SPEAKING -> LISTENING -> ANALYZING -> SPEAKING/LISTENING`

The UI phase is controlled by `aaSetPhase()` so Speech SDK callbacks cannot independently bounce the header between states.

## Barge-in
The microphone recognizers remain active while Lisa is speaking. When real client speech is detected:

- Lisa is stopped.
- The entire utterance remains attached to the current question.
- The same utterance is routed before a second listening turn can start.

## Language switching
Two recognizers have separate responsibilities:

- Main recognizer: fixed to the current session language and authoritative for intake answers.
- Shadow multilingual recognizer: only detects language-switch intent.

A language-control utterance is discarded from all answer buffers before the language is switched and the current prompt is repeated in the new language.

## Question reasoning
After routing an utterance as `answer`:

- Structured questions use the existing workflow state machine.
- General questions use the LLM completeness analysis.
- The system either saves and advances, or asks only the required follow-up.

Language-switch speech never enters either analysis path.


## Guardrails (Scope Enforcement) — Version 21
Before an utterance becomes an intake answer it is checked by `checkGuardrail()` (js/app.js):
1. Fast regex (en / fa / fr) for PR-chances, advice/suggestion, and obvious off-topic requests.
2. LLM classifier, only for utterances that look like a question (supports `?` and `؟`). Clarification questions about the current question are NOT violations. Errors/timeouts fail open.

Virtual Caseworker (Lisa): an `out_of_scope` turn is discarded from all answer buffers, Lisa speaks the notice in the session language and repeats the current prompt. No follow-up is consumed.
Client Intake: the response is not analyzed or saved; the notice is shown and Play Question reads it together with the same prompt.
Switch off with `GUARDRAILS_ENABLED = false` in js/app.js.
