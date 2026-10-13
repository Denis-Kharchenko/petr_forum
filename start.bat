@echo off
rem Kiosk launcher: local server + Chrome in kiosk mode (camera allowed without prompt)
cd /d "%~dp0"
start "kiosk-server" /min node server.js
timeout /t 2 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --user-data-dir="%TEMP%\petr-kiosk" --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-first-run http://localhost:8080/
