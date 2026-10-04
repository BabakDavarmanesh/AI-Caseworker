# CaseBridge AI

This version intentionally uses the simple browser-based architecture for the hackathon prototype.

## Run
Double-click `start-ai-caseworker.bat`.

Then open **Settings** and enter:
- Google Document AI: Project ID, Location, Processor ID, and a service-account key file
- Google Gemini on Vertex AI: model (default `gemini-3.8-flash`) and location (`global`)
- Azure Speech resource/region/key if using voice/avatar

When you click **Save Settings**, the values are written to `config.js` in this folder.
The browser also keeps a local copy for the current session.

If you ZIP and share the whole folder, `config.js` goes with it, so the recipient does not need to re-enter the settings.

The included lightweight `server.py` is only used to serve the existing pages and let the Settings page update `config.js`. No Node backend or Azure Functions are required.

## Architecture
Browser -> Azure services directly.

## Security note
This is a demo-only setup. Keys saved in `config.js` are plain text and are accessible to anyone who receives the folder. Do not publish `config.js` to a public repository or use this architecture for production.


## Portable settings
Run `start-ai-caseworker.bat` and open the app only through `http://localhost:5512/`. The Settings page writes Azure settings to `config.js` when Save Settings is clicked. Do not open the HTML files directly.


## Neural voice
Set Speech Region, Speech API Key, and Speech Voice (for example `en-US-LunaNeural`) in Settings. The Conversation Engine `Play Question` button now prefers Azure Speech Neural TTS and only falls back to the browser voice if Azure Speech is unavailable.

## AI Caseworker Avatar flow (v2 update)

The AI Caseworker page (`ai-assistant.html`) is now the primary client-session flow.
It loads the current Question Bank and runs the interview automatically:

1. Avatar asks the current question.
2. Azure Speech continuously listens.
3. About 1.8 seconds of silence ends the client's turn automatically.
4. The answer is analyzed by the caseworker reasoning logic.
5. If information is missing, the avatar asks a targeted follow-up.
6. After at most 3 follow-ups, unresolved answers are flagged for caseworker review.
7. Complete answers are saved to Responses and the avatar moves to the next question.
8. Language-switch commands continue to work during the session.

For real-time Avatar, configure an Azure Speech resource that supports Talking Avatar (Standard S0, supported region), and enter Resource Name, Region, API Key, and voice in Settings.


## Separate Speech and Avatar resources

This version intentionally keeps the normal Speech resource and real-time Avatar resource separate.

- Azure Speech (STT + Neural TTS): use your normal Speech resource, e.g. `westus`, F0.
- Azure Talking Avatar: use the separate S0 resource, e.g. resource name `ai-caseworker-avatar`, region `francecentral`.
- Avatar defaults: character `lisa`, style `casual-sitting`, voice `en-US-LunaNeural`.

The AI Assistant/Avatar pages use the Avatar resource for WebRTC video/TTS and the normal Speech resource for microphone speech recognition.


## Avatar settings

The real-time Avatar uses a separate S0 Speech resource. In Settings enter:

- Avatar Resource Name (for example `ai-caseworker-avatar`)
- Avatar Endpoint copied from Azure Portal (for example `https://francecentral.api.cognitive.microsoft.com/`)
- Avatar Region (for example `francecentral`)
- Avatar API Key
- Avatar Character (default `lisa`)
- Avatar Style (default `casual-sitting`)
- Avatar Voice (default `en-US-LunaNeural`)

The app stores the portal endpoint for configuration clarity. The WebRTC relay token uses the resource-specific Avatar relay endpoint required by Azure.

## Avatar connection note
The bundled `server.py` now proxies the Azure Talking Avatar relay-token request through `/avatar-relay-token`. This avoids browser CORS failures that can appear as `Failed to fetch`. Avatar settings remain separate from the regular Speech STT/TTS resource and use `avatarResourceName`, `avatarEndpoint`, `avatarRegion`, `avatarKey`, `avatarCharacter`, `avatarStyle`, and `avatarVoice`.


## Google Document AI (version 34)

Uploaded documents are read with Google Document AI. Azure Document Intelligence has
been removed completely (code, settings and keys).

Setup:
1. In Google Cloud Console, enable the **Document AI API** and create a processor
   (**Document OCR** for PDFs/images, or **Layout Parser** to also read DOCX/PPTX/XLSX/HTML).
   Copy its **Processor ID** and note the region (`us` or `eu`).
2. Create a service account with the role **Document AI API User**, create a JSON key,
   and save it in this folder as `google-service-account.json`.
3. In Settings, fill in Project ID, Location, Processor ID, then click
   **Test Google Sign-in** and **Save Settings**.

Google does not accept an API key for Document AI, so the browser sends the file to
`server.py` (`POST /google-docai`), which signs in with the key file and forwards this
request to Google:

```json
{
  "skipHumanReview": true,
  "rawDocument": { "mimeType": "application/pdf", "content": "<base64>" }
}
```

`start-ai-caseworker.bat` installs the needed library (`pip install google-auth requests`).
If no key file is found, the server falls back to `gcloud auth print-access-token`.

Do not share the zip publicly while `google-service-account.json` is inside it.


## Google Gemini (version 35)

Azure OpenAI (GPT) has been replaced by Google Gemini for every AI step: question
extraction, answer analysis, intent detection, follow-ups and translation.
Azure OpenAI TTS was removed too; voice still uses Azure Speech / the avatar.

Setup: create an API key at https://aistudio.google.com/apikey (pick the
AI-Caseworker project), paste it in Settings > Google Gemini, keep the model
`gemini-3.8-flash`, click Test Connection, then Save Settings.

Model choices: `gemini-3.8-flash` (recommended), `gemini-3.5-flash-lite`
(fastest, cheapest), `gemini-3.1-pro-preview` (most capable, slower).
The browser calls `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
directly with the key; JSON answers use `responseMimeType: application/json`.


## Gemini on Vertex AI (version 36)

Gemini now runs on Google Cloud **Vertex AI** instead of an AI Studio API key, so it is
paid from the Google Cloud free-trial credit (AI Studio keys cannot use that credit).
It uses the same Project ID and `google-service-account.json` as Document AI.

One-time setup in Google Cloud (project AI-Caseworker):
1. Enable the **Vertex AI API** (APIs & Services > Library > "Vertex AI API" > Enable).
2. IAM: give `docai-caseworker@...` the role **Vertex AI User** (keep Document AI API User).
3. Settings > Google Gemini (Vertex AI): model `gemini-3.8-flash`, location `global`,
   then Test Connection and Save Settings.

The browser posts to `server.py` (`POST /gemini`), which calls
`https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google/models/<model>:generateContent`.
If a model is not available in `global`, try location `us-central1`.


## Interview voice: Google Gemini-TTS (version 37)

The interview (Client Intake, and Play Question) now speaks with a Google Gemini voice
(Gemini-TTS on Cloud Text-to-Speech) in every interview language, including Persian,
French and Arabic. It uses the same Project ID and `google-service-account.json`.

One-time setup:
1. Google Cloud > APIs & Services > Library > **Cloud Text-to-Speech API** > Enable.
2. The service account already has **Agent Platform User** (needed by Gemini-TTS).
3. Settings > Interview Voice: Voice service = Google, voice `Kore`, model
   `gemini-2.5-flash-tts`, then **Test Gemini Voice** and **Save Settings**.

If Google fails, the app falls back to the Azure Speech voice, then the browser voice.
Listening to the client (speech-to-text) still uses Azure Speech, and the Lisa avatar
keeps its own Azure voice.
