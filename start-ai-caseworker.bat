@echo off
cd /d "%~dp0"
echo Starting AI Caseworker portable demo on port 5512...
echo Settings saved from the Settings page will be written to config.js.
echo Checking Google sign-in library for Google Document AI...
python -m pip install --quiet --disable-pip-version-check google-auth requests
start "AI Caseworker Web Server" cmd /k "python server.py"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5512/question-engine.html"
