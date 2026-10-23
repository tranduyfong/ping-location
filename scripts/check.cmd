@echo off
setlocal
cd /d "%~dp0.."
set "PING_LOCATION_PYTHON=python"
if exist ".venv\Scripts\python.exe" set "PING_LOCATION_PYTHON=.venv\Scripts\python.exe"
set "PING_LOCATION_NODE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "tmp\runtime\node.exe" (
    set "PING_LOCATION_NODE=tmp\runtime\node.exe"
  ) else (
    echo Node.js is required. Install Node.js or place node.exe in tmp\runtime.
    exit /b 1
  )
)
for %%F in (extension\*.js) do (
  "%PING_LOCATION_NODE%" --check "%%F"
  if errorlevel 1 exit /b 1
)
"%PING_LOCATION_NODE%" --test tests/core.test.cjs tests/background.test.cjs tests/content.test.cjs
if errorlevel 1 exit /b 1
"%PING_LOCATION_PYTHON%" -m unittest discover -s service/tests -v
if errorlevel 1 exit /b 1
