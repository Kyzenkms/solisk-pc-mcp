@echo off
title PC Control MCP — Installer
color 0A
cls

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║       PC Control MCP — Easy Installer        ║
echo  ║   Give AI full control of your Windows PC    ║
echo  ╚══════════════════════════════════════════════╝
echo.
echo  This installer will set everything up for you.
echo  It takes about 1-2 minutes.
echo.
pause

:: ── Check Node.js ────────────────────────────────────────────────────────────
echo.
echo  [1/3] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  Node.js not found. Installing automatically...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    if %errorlevel% neq 0 (
        echo.
        echo  Could not auto-install Node.js.
        echo  Please download it from: https://nodejs.org
        echo  Then run this installer again.
        pause
        exit /b 1
    )
    echo  Node.js installed!
    :: Refresh PATH
    set "PATH=%PATH%;C:\Program Files\nodejs"
) else (
    echo  Node.js found!
)

:: ── Install dependencies ──────────────────────────────────────────────────────
echo.
echo  [2/3] Installing MCP server dependencies...
cd /d "%~dp0"
call npm install --silent
if %errorlevel% neq 0 (
    echo  ERROR: npm install failed.
    pause
    exit /b 1
)
echo  Dependencies installed!

:: ── Create desktop shortcut ───────────────────────────────────────────────────
echo.
echo  [3/3] Creating desktop shortcuts...

:: Start shortcut
set "SHORTCUT=%USERPROFILE%\Desktop\PC Control MCP.bat"
echo @echo off > "%SHORTCUT%"
echo title PC Control MCP >> "%SHORTCUT%"
echo cd /d "%~dp0" >> "%SHORTCUT%"
echo node app.js >> "%SHORTCUT%"

:: ── Done ──────────────────────────────────────────────────────────────────────
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║              Setup Complete! ✓               ║
echo  ╠══════════════════════════════════════════════╣
echo  ║                                              ║
echo  ║  A shortcut was added to your Desktop:       ║
echo  ║  "PC Control MCP"                            ║
echo  ║                                              ║
echo  ║  HOW TO USE:                                 ║
echo  ║  1. Double-click "PC Control MCP" on Desktop ║
echo  ║  2. Type a name (e.g. "john-pc")             ║
echo  ║  3. Copy your permanent URL                  ║
echo  ║  4. Paste it into Claude.ai or ChatGPT       ║
echo  ║                                              ║
echo  ║  That's it! Same URL every time. ✅          ║
echo  ╚══════════════════════════════════════════════╝
echo.
echo  Starting the app now...
echo.
timeout /t 2 /nobreak >nul
node app.js
