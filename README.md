# CaseBridge AI

AI-assisted client intake for caseworkers. An intake form is turned into a question bank, the client is interviewed by voice (in their own language, by a caseworker or by a talking avatar), every answer is checked and confirmed with the client, and the approved data is mapped to CRM fields and sent to a Mock CRM.

Hackathon prototype: plain HTML/JavaScript pages plus a small Python server. **All AI runs on Google Cloud (Gemini on Vertex AI, Gemini Live, Gemini-TTS, Document AI). No Azure services are used.**

## Run

1. Put your Google service-account key in this folder as `google-service-account.json`.
2. Double-click `start-ai-caseworker.bat`. It installs `google-auth` and `requests`, starts `server.py` on port 5512 and opens `http://localhost:5512/index.html`.
3. Open **Settings**, check the values and click **Save Settings** (they are written to `config.js`).

Always use the app through `http://localhost:5512/`; opening the HTML files directly does not work. Allow microphone access when the browser asks. If the browser blocks sound, the Virtual Caseworker shows a **▶ Start the interview** button: one click enables sound and the microphone.

## Pages

| Page | File | What it does |
|---|---|---|
| Landing page | `index.html` | Product overview and entry point. |
| Question Engine | `question-engine.html` | Upload an intake form (PDF, Word, Excel, PowerPoint, HTML, images). Document AI extracts the text; Gemini extracts only the questions that are actually in the document. |
| Question Bank | `question-bank.html` | Review and edit the extracted questions. |
| Translation Engine | `translation.html` | Translate the questions into interview languages (Persian, French, Arabic, Spanish, …) and edit the translations. |
| ID Scan | `id-scan.html` | Upload the client's ID (passport, PR card, licence…). Gemini reads name, date of birth, document number, expiry, etc. The name and date of birth are used in Responses and sent to the CRM (`fullname`, `birthdate`). The ID image is never stored. |
| Client Intake | `interview.html` | Caseworker-led interview. **Play Question** reads the question (Gemini voice), **Speak / Stop** records the answer; analysis starts automatically after Stop. |
| Virtual Caseworker | `ai-assistant.html` | Fully automatic interview with **Lisa**, a Gemini Live video avatar: she asks each question, listens, asks follow-ups and confirms every answer. |
| Responses | `responses.html` | All saved answers with English translation and mapping, caseworker review, Dynamics field mapping, approval and sync to the Mock CRM. |
| Mock CRM | `crm.html` | Client records received from the app (`/api/clients`). |
| Settings | `settings.html` | Google project, Gemini model, voice and avatar settings. |

Sample files: `client_intake_questions_reordered.pdf` (intake form) and `Specimen_Passport.jpg` (official UK specimen passport, for testing ID Scan).

## How an interview works

1. The question is spoken in the interview language (Gemini-TTS, or Lisa's voice in the Virtual Caseworker).
2. The client answers by voice. **Gemini Live** transcribes speech and detects the end of each sentence (about 0.5 s).
3. Answers in Persian/French, or text that does not look like English, are re-transcribed from the recording by Gemini, so English names, numbers and postal codes are written correctly (e.g. `999 Marine Drive`, `X7A 1A1`).
4. **Guardrails** reject out-of-scope requests (chances of PR, advice, off-topic chat) without counting them as answers.
5. **Gemini analyzes** the answer against the question's validation rules (required date parts, numbers, choices, address components). Impossible values such as a future date of birth or 31 February are rejected. Missing information leads to a targeted follow-up (at most 3).
6. The understood answer is **read back** ("I have the date as 24 August 1983. Is that correct?"). It is saved only after the client says yes; "no" lets the client correct it. Names are spelled back letter by letter. Name, country of birth and address use a dedicated step-by-step workflow (`intake-rules.json`).
7. Saved answers keep the client's words, an English translation and the mapped value; unresolved answers are flagged for caseworker review.

Language: the client can ask to switch language at any time ("می‌تونی فارسی صحبت کنی؟", "speak French"). In Client Intake the language is chosen at the top of the page. Answers are always analyzed and saved in English.

## Architecture

```
Browser pages ── http://localhost:5512 ── server.py ── Google Cloud
                                            │            ├─ Document AI            (read uploaded documents)
                                            │            ├─ Vertex AI Gemini       (questions, analysis, translation, ID reading, transcription check)
                                            │            ├─ Cloud Text-to-Speech   (Gemini-TTS interview voice, streamed)
                                            │            └─ (sign-in token)
Browser ── WebSocket ── Vertex AI Gemini Live  (speech-to-text, and Lisa's video avatar)
```

`server.py` signs in with `google-service-account.json` and forwards requests, so no Google key is ever placed in the browser. For Gemini Live the browser receives a short-lived access token from the server and opens the WebSocket itself.

| Feature | Google service / model |
|---|---|
| Document text extraction | Document AI (Document OCR or Layout Parser processor) |
| Question extraction, answer analysis, follow-ups, guardrails, translation, ID reading | Gemini on Vertex AI, default `gemini-3.8-flash` (location `global`) |
| Interview voice | Gemini-TTS on Cloud Text-to-Speech, `gemini-2.5-flash-tts`, voice `Kore` (streamed, starts in ~1 s) |
| Speech-to-text | Gemini Live `gemini-live-2.5-flash-native-audio` (`us-central1`) with expected-language hints |
| Virtual Caseworker avatar | Gemini Live `gemini-3.8-live` with Live Avatar (`us-central1`), avatar face `Kira`, voice `zephyr`; introduces itself as Lisa |

### server.py endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/google-docai`, `/google-docai/status` | Document AI processing / sign-in test |
| POST | `/gemini` | Vertex AI `generateContent` proxy |
| POST | `/google-tts` | Gemini-TTS, whole clip (fallback) |
| POST | `/google-tts-stream` | Gemini-TTS streamed as raw PCM (24 kHz) |
| POST | `/google-live-token` | Short-lived token for the Gemini Live WebSocket |
| POST | `/save-config` | Writes the Settings to `config.js` |
| GET / POST / DELETE | `/api/clients`, `/api/clients/<id>` | Mock CRM (stored in `mock_crm_clients.json`) |

## Google Cloud setup (one time)

1. Create or pick a Google Cloud project.
2. Enable these APIs: **Document AI API**, **Vertex AI API**, **Cloud Text-to-Speech API**.
3. Document AI: create a processor (**Document OCR** for PDFs/images, or **Layout Parser** to also read DOCX/PPTX/XLSX/HTML) and note its **Processor ID** and region (`us` or `eu`).
4. Create a service account with the roles **Document AI API User** and **Vertex AI User**, create a JSON key and save it in this folder as `google-service-account.json`.
5. Gemini Live Avatar must be available to the project in `us-central1` (it is not offered in `global`).
6. In **Settings** enter the Project ID, Document AI location and processor, then use **Test Google Sign-in**, **Test Connection** and **Test Gemini Voice**, and **Save Settings**.

If no key file is found, the server falls back to `gcloud auth print-access-token`.

### Settings

| Section | Fields (defaults) |
|---|---|
| Google Document AI | Project ID, location (`us`), processor ID, key file (`google-service-account.json`) |
| Google Gemini (Vertex AI) | Model (`gemini-3.8-flash`), location (`global`) |
| Interview Voice | Gemini voice (`Kore`), voice model (`gemini-2.5-flash-tts`) |
| Gemini Live Avatar | Avatar face (`Kira`), avatar voice (`zephyr`), Live model (`gemini-3.8-live`), region (`us-central1`) |

## Main files

| File | Role |
|---|---|
| `js/app.js` | Shared code: settings, Gemini calls, Document AI pipeline, validation and read-back helpers, voice, Client Intake recording, Responses/CRM mapping |
| `js/client-intake.js` | Client Intake page: interview flow, follow-ups, confirmation, interview language |
| `js/virtual-caseworker.js` | Virtual Caseworker page: automatic interview, language switching, guardrails, confirmation |
| `js/gemini-live-stt.js` | Speech-to-text with Gemini Live (shared by both interview pages) |
| `js/gemini-transcribe.js` | Re-transcription of mixed-language answers with Gemini, English-likeness check |
| `js/gemini-avatar.js` | Lisa: Gemini Live Avatar player (MP4 stream via MediaSource, voice routed through WebRTC so echo cancellation keeps it out of the microphone) |
| `js/id-scan.js` | ID Scan page |
| `intake-rules.json` | Fields that use the step-by-step confirmation workflow (full name, country of birth, current address) |
| `CLIENT-INTAKE-ARCHITECTURE.md` | Notes on the interview turn routing |

## Troubleshooting

- **No sound / interview stays on "Starting…"**: click once on the page (or the ▶ Start button); browsers block audio and microphone processing until the user interacts.
- **Changes not visible**: press **Ctrl+F5**, and make sure the server was started from this folder.
- **Speech in the wrong language**: check the interview language (Client Intake) or ask Lisa to switch language; answers that do not look like the expected language are re-checked automatically.
- **Avatar does not appear**: check Settings > Gemini Live Avatar (model `gemini-3.8-live`, region `us-central1`) and that the service account has **Vertex AI User**.
