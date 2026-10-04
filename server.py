from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import os
import datetime
import urllib.request
import urllib.error
import re
import time
import shutil
import subprocess
import threading
import base64

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.js"
CLIENTS_PATH = ROOT / "mock_crm_clients.json"
HOST = "127.0.0.1"
PORT = 5512

ALLOWED_KEYS = {
    "gcpProjectId", "gcpLocation", "gcpProcessorId", "gcpCredentialsFile",
    "geminiModel", "geminiLocation",
    "voiceProvider", "googleTtsModel", "googleTtsVoice",
    "speechRegion", "speechKey", "speechVoice",
    "avatarResourceName", "avatarEndpoint", "avatarRegion", "avatarKey", "avatarCharacter", "avatarStyle", "avatarVoice",
    "avatarProvider", "geminiAvatarName", "geminiAvatarVoice", "geminiLiveModel", "geminiLiveLocation"
}

def _load_clients():
    if not CLIENTS_PATH.exists():
        return []
    try:
        data = json.loads(CLIENTS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []

def _save_clients(clients):
    tmp = CLIENTS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(clients, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, CLIENTS_PATH)

def _next_client_id(clients):
    max_id = 1000
    for c in clients:
        cid = str(c.get("clientId", "")).strip().upper()
        if cid.startswith("CRM-"):
            try:
                num = int(cid[4:])
                if num > max_id:
                    max_id = num
            except ValueError:
                pass
    return f"CRM-{max_id + 1}"

# ─── Google Document AI ─────────────────────────────────────
# Google Document AI does not accept API keys; it needs an OAuth access token.
# The token is obtained here (server side) so the service-account key never
# goes to the browser. Order tried:
#   1. Service-account JSON key file in this folder (needs: pip install google-auth requests)
#   2. GOOGLE_APPLICATION_CREDENTIALS environment variable (same library)
#   3. gcloud CLI: "gcloud auth print-access-token" (if you ran "gcloud auth login")
GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
MAX_DOCAI_BODY = 45 * 1024 * 1024  # base64 of a ~30 MB file
_token_lock = threading.Lock()
_token_cache = {"key": None, "token": None, "expires": 0.0, "method": ""}


def _resolve_credentials_file(name):
    name = (name or "").strip()
    candidates = []
    if name:
        p = Path(name)
        candidates.append(p if p.is_absolute() else ROOT / p)
    env = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if env:
        candidates.append(Path(env))
    for c in candidates:
        if c.is_file():
            return c
    return None


def _get_google_token(credentials_file):
    with _token_lock:
        cred_path = _resolve_credentials_file(credentials_file)
        cache_key = str(cred_path) if cred_path else "gcloud"
        if (_token_cache["key"] == cache_key and _token_cache["token"]
                and _token_cache["expires"] - time.time() > 120):
            return _token_cache["token"], _token_cache["method"]

        errors = []
        if cred_path:
            try:
                from google.oauth2 import service_account
                import google.auth.transport.requests
                creds = service_account.Credentials.from_service_account_file(
                    str(cred_path), scopes=[GCP_SCOPE])
                creds.refresh(google.auth.transport.requests.Request())
                expires = creds.expiry.replace(tzinfo=datetime.timezone.utc).timestamp() if creds.expiry else time.time() + 3000
                _token_cache.update(key=cache_key, token=creds.token, expires=expires,
                                    method=f"service account {cred_path.name}")
                return creds.token, _token_cache["method"]
            except ImportError:
                errors.append("Python package missing: run  pip install google-auth requests")
            except Exception as exc:
                errors.append(f"Service account key {cred_path.name}: {exc}")
        else:
            errors.append(f"Key file '{credentials_file or 'google-service-account.json'}' not found in {ROOT}")

        gcloud = shutil.which("gcloud") or shutil.which("gcloud.cmd")
        if gcloud:
            try:
                out = subprocess.run([gcloud, "auth", "print-access-token"],
                                     capture_output=True, text=True, timeout=30)
                token = out.stdout.strip()
                if out.returncode == 0 and token:
                    _token_cache.update(key=cache_key, token=token,
                                        expires=time.time() + 3000, method="gcloud CLI")
                    return token, "gcloud CLI"
                errors.append("gcloud: " + (out.stderr.strip()[:200] or "no token"))
            except Exception as exc:
                errors.append(f"gcloud: {exc}")

        raise RuntimeError(" | ".join(errors))


def _layout_blocks_to_text(blocks, out):
    for b in blocks or []:
        tb = b.get("textBlock") or {}
        if tb.get("text"):
            prefix = "#" * 2 + " " if str(tb.get("type", "")).startswith("heading") else ""
            out.append(prefix + tb["text"])
        _layout_blocks_to_text(tb.get("blocks"), out)
        tbl = b.get("tableBlock")
        if tbl:
            for section in ("headerRows", "bodyRows"):
                for row in tbl.get(section) or []:
                    cells = []
                    for cell in row.get("cells") or []:
                        parts = []
                        _layout_blocks_to_text(cell.get("blocks"), parts)
                        cells.append(" ".join(parts).replace("\n", " "))
                    out.append("| " + " | ".join(cells) + " |")
        lb = b.get("listBlock")
        if lb:
            for entry in lb.get("listEntries") or []:
                parts = []
                _layout_blocks_to_text(entry.get("blocks"), parts)
                out.append("- " + " ".join(parts))


def _google_docai_process(data):
    project = str(data.get("projectId", "")).strip()
    location = str(data.get("location", "us")).strip() or "us"
    processor = str(data.get("processorId", "")).strip()
    if not re.fullmatch(r"[a-z0-9-]{4,63}", project or ""):
        raise ValueError("Invalid Google Project ID")
    if location not in ("us", "eu"):
        raise ValueError("Location must be 'us' or 'eu'")
    if not re.fullmatch(r"[A-Za-z0-9]{6,64}", processor or ""):
        raise ValueError("Invalid Processor ID")

    body = data.get("request") or {}
    raw = body.get("rawDocument") or {}
    if not raw.get("content") or not raw.get("mimeType"):
        raise ValueError("rawDocument.content and rawDocument.mimeType are required")
    payload = {
        "skipHumanReview": bool(body.get("skipHumanReview", True)),
        "rawDocument": {"mimeType": raw["mimeType"], "content": raw["content"]},
    }

    token, _ = _get_google_token(data.get("credentialsFile", ""))
    url = (f"https://{location}-documentai.googleapis.com/v1/projects/{project}"
           f"/locations/{location}/processors/{processor}:process")
    req = urllib.request.Request(
        url, method="POST", data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8",
                 "x-goog-user-project": project})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("error", {}).get("message", detail)
        except Exception:
            pass
        raise RuntimeError(f"Google HTTP {exc.code}: {detail[:400]}")

    doc = result.get("document") or {}
    text = doc.get("text") or ""
    if not text and doc.get("documentLayout"):
        parts = []
        _layout_blocks_to_text(doc["documentLayout"].get("blocks"), parts)
        text = "\n\n".join(parts)
    pages = len(doc.get("pages") or []) or None
    return {"ok": True, "text": text, "pages": pages}


# ─── Gemini on Vertex AI ───────────────────────────────────
MAX_GEMINI_BODY = 8 * 1024 * 1024


def _gemini_vertex(data):
    """Returns (http_status, json_payload) from Vertex AI generateContent."""
    project = str(data.get("projectId", "")).strip()
    location = str(data.get("location", "global")).strip() or "global"
    model = str(data.get("model", "gemini-3.8-flash")).strip() or "gemini-3.8-flash"
    if not re.fullmatch(r"[a-z0-9-]{4,63}", project or ""):
        raise ValueError("Invalid Google Project ID")
    if not re.fullmatch(r"[a-z0-9-]{2,40}", location):
        raise ValueError("Invalid Vertex AI location")
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,80}", model):
        raise ValueError("Invalid Gemini model name")
    body = data.get("request")
    if not isinstance(body, dict) or not body.get("contents"):
        raise ValueError("request.contents is required")

    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    url = (f"https://{host}/v1/projects/{project}/locations/{location}"
           f"/publishers/google/models/{model}:generateContent")

    token, _ = _get_google_token(data.get("credentialsFile", ""))
    req = urllib.request.Request(
        url, method="POST", data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8",
                 "x-goog-user-project": project})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return 200, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(detail)
            if isinstance(payload, list) and payload:
                payload = payload[0]
            if not isinstance(payload, dict):
                raise ValueError
        except Exception:
            payload = {"error": {"message": detail[:400]}}
        return exc.code, payload


# ─── Google Gemini-TTS (Cloud Text-to-Speech) ──────────────
def _google_tts(data):
    """Returns (http_status, json_payload). Success payload: {"audioContent": "<base64 mp3>"}."""
    project = str(data.get("projectId", "")).strip()
    model = str(data.get("model", "gemini-2.5-flash-tts")).strip() or "gemini-2.5-flash-tts"
    voice = str(data.get("voiceName", "Kore")).strip() or "Kore"
    lang = str(data.get("languageCode", "en-US")).strip() or "en-US"
    text = str(data.get("text", "")).strip()
    prompt = str(data.get("prompt", "")).strip()
    if not re.fullmatch(r"[a-z0-9-]{4,63}", project or ""):
        raise ValueError("Invalid Google Project ID")
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,80}", model):
        raise ValueError("Invalid voice model")
    if not re.fullmatch(r"[A-Za-z0-9-]{2,40}", voice):
        raise ValueError("Invalid voice name")
    if not re.fullmatch(r"[A-Za-z0-9-]{2,12}", lang):
        raise ValueError("Invalid language code")
    if not text:
        raise ValueError("text is required")
    if len(text.encode("utf-8")) > 4000:
        text = text.encode("utf-8")[:4000].decode("utf-8", errors="ignore")

    body = {
        "input": {"text": text},
        "voice": {"languageCode": lang, "name": voice, "model_name": model},
        "audioConfig": {"audioEncoding": "MP3"},
    }
    if prompt:
        body["input"]["prompt"] = prompt[:1000]

    token, _ = _get_google_token(data.get("credentialsFile", ""))
    req = urllib.request.Request(
        "https://texttospeech.googleapis.com/v1/text:synthesize",
        method="POST", data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8",
                 "x-goog-user-project": project})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = json.loads(resp.read().decode("utf-8"))
            return 200, {"audioContent": out.get("audioContent", "")}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(detail)
            if isinstance(payload, list) and payload:
                payload = payload[0]
            if not isinstance(payload, dict):
                raise ValueError
        except Exception:
            payload = {"error": {"message": detail[:400]}}
        return exc.code, payload


# ─── Streaming Gemini-TTS (Vertex AI streamGenerateContent) ─
# The Cloud TTS endpoint above returns audio only after the whole clip is made
# (3–17 s). Streaming yields the first audio after ~0.7 s; the handler forwards
# it to the browser as raw 16-bit PCM, 24 kHz mono, chunk by chunk.
TTS_STREAM_RATE = 24000


def _google_tts_stream_request(data):
    """Validates input and opens the Vertex AI SSE stream. Returns the response."""
    project = str(data.get("projectId", "")).strip()
    model = str(data.get("model", "gemini-2.5-flash-tts")).strip() or "gemini-2.5-flash-tts"
    voice = str(data.get("voiceName", "Kore")).strip() or "Kore"
    lang = str(data.get("languageCode", "en-US")).strip() or "en-US"
    text = str(data.get("text", "")).strip()
    style = str(data.get("prompt", "")).strip()
    if not re.fullmatch(r"[a-z0-9-]{4,63}", project or ""):
        raise ValueError("Invalid Google Project ID")
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,80}", model):
        raise ValueError("Invalid voice model")
    if not re.fullmatch(r"[A-Za-z0-9-]{2,40}", voice):
        raise ValueError("Invalid voice name")
    if not re.fullmatch(r"[A-Za-z0-9-]{2,12}", lang):
        raise ValueError("Invalid language code")
    if not text:
        raise ValueError("text is required")
    text = text[:4000]
    # Gemini-TTS takes the speaking style as a short lead-in ("Say warmly: ...");
    # it shapes the delivery and is not read aloud.
    spoken = f"{style[:300].rstrip(' .:')}: {text}" if style else text

    body = {
        "contents": [{"role": "user", "parts": [{"text": spoken}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "languageCode": lang,
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}},
            },
        },
    }
    url = ("https://aiplatform.googleapis.com/v1/projects/"
           f"{project}/locations/global/publishers/google/models/{model}:streamGenerateContent?alt=sse")
    token, _ = _get_google_token(data.get("credentialsFile", ""))
    req = urllib.request.Request(
        url, method="POST", data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8",
                 "x-goog-user-project": project})
    return urllib.request.urlopen(req, timeout=60)


def _iter_tts_stream_pcm(resp):
    """Yields raw PCM byte chunks from a Vertex AI SSE response."""
    for raw in resp:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line.startswith("data:"):
            continue
        try:
            event = json.loads(line[5:])
        except ValueError:
            continue
        for cand in event.get("candidates", []):
            for part in cand.get("content", {}).get("parts", []):
                inline = part.get("inlineData")
                if inline and inline.get("data"):
                    yield base64.b64decode(inline["data"])


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _read_json_body(self, max_size=1024 * 1024):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > max_size:
            raise ValueError("Invalid request size")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Request body must be a JSON object")
        return data

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, status, text):
        body = str(text).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url_path = self.path.split("?")[0].rstrip("/")
        if url_path == "/api/clients":
            clients = _load_clients()
            self._send_json(200, {
                "success": True,
                "count": len(clients),
                "clients": clients
            })
            return
        elif url_path.startswith("/api/clients/"):
            client_id = url_path[len("/api/clients/"):].strip()
            clients = _load_clients()
            client = next((c for c in clients if str(c.get("clientId", "")).lower() == client_id.lower()), None)
            if client:
                self._send_json(200, {
                    "success": True,
                    "client": client
                })
            else:
                self._send_json(404, {
                    "success": False,
                    "error": f"Client '{client_id}' not found"
                })
            return

        super().do_GET()

    def do_POST(self):
        url_path = self.path.split("?")[0].rstrip("/")

        # Mock CRM Client creation endpoint
        if url_path == "/api/clients":
            try:
                data = self._read_json_body()
                clients = _load_clients()
                client_id = _next_client_id(clients)

                new_client = dict(data)
                new_client["clientId"] = client_id
                if "createdAt" not in new_client:
                    new_client["createdAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

                clients.append(new_client)
                _save_clients(clients)

                self._send_json(201, {
                    "success": True,
                    "clientId": client_id,
                    "message": f"Client {client_id} created successfully in Mock CRM",
                    "client": new_client
                })
            except Exception as exc:
                self._send_json(400, {
                    "success": False,
                    "error": str(exc)
                })
            return

        if url_path == "/google-tts":
            try:
                data = self._read_json_body()
                status, payload = _google_tts(data)
                self._send_json(status, payload)
            except ValueError as exc:
                self._send_json(400, {"error": {"message": str(exc)}})
            except Exception as exc:
                self._send_json(502, {"error": {"message": str(exc)}})
            return

        if url_path == "/google-live-token":
            # Short-lived OAuth token for the browser's Gemini Live (avatar)
            # WebSocket. The server only listens on 127.0.0.1.
            try:
                data = self._read_json_body()
                token, _ = _get_google_token(data.get("credentialsFile", ""))
                expires_in = max(0, int(_token_cache.get("expires", 0) - time.time()))
                self._send_json(200, {"accessToken": token, "expiresIn": expires_in})
            except Exception as exc:
                self._send_json(502, {"error": {"message": str(exc)}})
            return

        if url_path == "/google-tts-stream":
            try:
                data = self._read_json_body()
                resp = _google_tts_stream_request(data)
            except ValueError as exc:
                self._send_json(400, {"error": {"message": str(exc)}})
                return
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                self._send_json(exc.code, {"error": {"message": detail[:400]}})
                return
            except Exception as exc:
                self._send_json(502, {"error": {"message": str(exc)}})
                return

            # No Content-Length: the body is streamed and the connection closed
            # at the end (HTTP/1.0 handler).
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("X-Audio-Format", f"pcm_s16le;rate={TTS_STREAM_RATE};channels=1")
            self.end_headers()
            try:
                with resp:
                    for chunk in _iter_tts_stream_pcm(resp):
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass   # browser stopped playback (Stop / new question)
            except Exception as exc:
                print("[google-tts-stream] stream error:", exc)
            self.close_connection = True
            return

        if url_path == "/gemini":
            try:
                data = self._read_json_body(MAX_GEMINI_BODY)
                status, payload = _gemini_vertex(data)
                self._send_json(status, payload)
            except ValueError as exc:
                self._send_json(400, {"error": {"message": str(exc)}})
            except Exception as exc:
                self._send_json(502, {"error": {"message": str(exc)}})
            return

        if url_path == "/google-docai/status":
            try:
                data = self._read_json_body()
                _, method = _get_google_token(data.get("credentialsFile", ""))
                self._send_json(200, {"ok": True, "method": method})
            except Exception as exc:
                self._send_json(502, {"ok": False, "error": str(exc)})
            return

        if url_path == "/google-docai":
            try:
                data = self._read_json_body(MAX_DOCAI_BODY)
                self._send_json(200, _google_docai_process(data))
            except ValueError as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._send_json(502, {"ok": False, "error": str(exc)})
            return

        if self.path == "/avatar-relay-token":
            try:
                data = self._read_json_body()
                resource_name = str(data.get("resourceName", "")).strip()
                region = str(data.get("region", "")).strip()
                key = str(data.get("key", "")).strip()

                if not resource_name or not region or not key:
                    raise ValueError("Avatar resource name, region, and key are required")

                candidates = [
                    f"https://{resource_name}.cognitiveservices.azure.com/tts/cognitiveservices/avatar/relay/token/v1",
                    f"https://{region}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1",
                ]

                errors = []
                for url in candidates:
                    req = urllib.request.Request(
                        url,
                        method="GET",
                        headers={"Ocp-Apim-Subscription-Key": key},
                    )
                    try:
                        with urllib.request.urlopen(req, timeout=20) as resp:
                            raw = resp.read().decode("utf-8")
                            payload = json.loads(raw)
                            self._send_json(200, payload)
                            return
                    except urllib.error.HTTPError as exc:
                        detail = exc.read().decode("utf-8", errors="replace")[:300]
                        errors.append(f"{url} -> HTTP {exc.code}: {detail}")
                    except Exception as exc:
                        errors.append(f"{url} -> {exc}")

                raise RuntimeError(" | ".join(errors))
            except Exception as exc:
                self._send_text(502, exc)
            return

        if self.path != "/save-config":
            self.send_error(404)
            return

        try:
            data = self._read_json_body()

            clean = {key: str(data.get(key, "")) for key in ALLOWED_KEYS}
            # Preserve stable field order for readability.
            ordered_keys = [
                "gcpProjectId", "gcpLocation", "gcpProcessorId", "gcpCredentialsFile",
                "geminiModel", "geminiLocation",
                "voiceProvider", "googleTtsModel", "googleTtsVoice",
                "speechRegion", "speechKey", "speechVoice",
                "avatarResourceName", "avatarEndpoint", "avatarRegion", "avatarKey",
                "avatarCharacter", "avatarStyle", "avatarVoice"
            ]
            ordered = {k: clean[k] for k in ordered_keys}
            payload = (
                "// AI Caseworker portable configuration.\n"
                "// Updated automatically by Save Settings.\n"
                "// Do not publish this file to a public repository because it can contain API keys.\n"
                "window.AIC_CONFIG = " + json.dumps(ordered, indent=2, ensure_ascii=False) + ";\n"
            )

            tmp = CONFIG_PATH.with_suffix(".js.tmp")
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, CONFIG_PATH)

            self._send_json(200, {"ok": True})
        except Exception as exc:
            self._send_text(400, exc)

    def do_DELETE(self):
        url_path = self.path.split("?")[0].rstrip("/")
        if url_path == "/api/clients":
            _save_clients([])
            self._send_json(200, {
                "success": True,
                "message": "All mock CRM client records cleared"
            })
            return
        elif url_path.startswith("/api/clients/"):
            client_id = url_path[len("/api/clients/"):].strip()
            clients = _load_clients()
            filtered = [c for c in clients if str(c.get("clientId", "")).lower() != client_id.lower()]
            if len(filtered) < len(clients):
                _save_clients(filtered)
                self._send_json(200, {
                    "success": True,
                    "message": f"Client '{client_id}' deleted"
                })
            else:
                self._send_json(404, {
                    "success": False,
                    "error": f"Client '{client_id}' not found"
                })
            return
        self.send_error(404)

if __name__ == "__main__":
    print(f"AI Caseworker running at http://localhost:{PORT}/question-engine.html")
    print(f"Mock CRM API running at http://localhost:{PORT}/api/clients")
    print("Save Settings will update config.js in this folder.")
    print("Google Document AI proxy at http://localhost:%d/google-docai" % PORT)
    print("Gemini (Vertex AI) proxy at http://localhost:%d/gemini" % PORT)
    print("Gemini voice (Text-to-Speech) proxy at http://localhost:%d/google-tts" % PORT)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
