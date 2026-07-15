@echo off
REM Recipe Book launcher - double-click to start
cd /d "%~dp0"
echo ============================================
echo   Recipe Book - starting local server...
echo ============================================
echo.
REM Build the GitHub Pages site (docs/) from public/ so Pages stays in sync
node build.js
echo.
start "RecipeBookServer" cmd /k node server.js
ping -n 3 127.0.0.1 >nul
start "" http://localhost:3517
echo Browser opened. The server runs in the other window.
echo Close that window to stop the server.
