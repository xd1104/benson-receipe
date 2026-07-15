@echo off
REM Recipe Book launcher - double-click to start
cd /d "%~dp0"
echo ============================================
echo   Recipe Book - starting local server...
echo ============================================
echo.
start "RecipeBookServer" cmd /k node server.js
ping -n 3 127.0.0.1 >nul
start "" http://localhost:3517
echo Browser opened. The server runs in the other window.
echo Close that window to stop the server.
