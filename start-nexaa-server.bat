@echo off
setlocal
cd /d "%~dp0"

echo Starting Nexaa local servers...
echo.
echo App:      http://localhost:5177/
echo API:      http://localhost:5177/api/health
if not defined NEXA_API_TARGET set "NEXA_API_TARGET=http://127.0.0.1:4000"
echo Backend:  %NEXA_API_TARGET% ^(proxied through 5177^)
echo.

set "NODE_EXE=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
  if exist "%LOCALAPPDATA%\OpenAI\Codex\bin\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\OpenAI\Codex\bin\node.exe"
  ) else (
    echo Node.js was not found on your PATH.
    echo Install Node.js or run this project from an environment where node is available.
    echo.
    pause
    exit /b 1
  )
)

echo Starting Nexaa in this terminal...
echo Press Ctrl+C in this window to stop the visible local server session.
echo.
"%NODE_EXE%" scripts\dev-all.js
echo.
echo Nexaa local server session stopped.
pause
