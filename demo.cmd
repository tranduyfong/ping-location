@echo off
cd /d "%~dp0demo"
echo Open http://127.0.0.1:8767 in Chrome. Keep this window open.
python -m http.server 8767 --bind 127.0.0.1
pause
