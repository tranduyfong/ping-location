@echo off
setlocal
cd /d "%~dp0.."
set "PING_LOCATION_PYTHON=python"
if exist ".venv\Scripts\python.exe" set "PING_LOCATION_PYTHON=.venv\Scripts\python.exe"
for %%F in (extension\*.js) do (
  node --check "%%F"
  if errorlevel 1 exit /b 1
)
node --test tests/core.test.cjs tests/background.test.cjs tests/content.test.cjs
if errorlevel 1 exit /b 1
"%PING_LOCATION_PYTHON%" -m unittest discover -s service/tests -v
if errorlevel 1 exit /b 1
