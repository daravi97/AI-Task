@echo off
REM Double-click this file to start the Merch Store on Windows.
REM It uses npm.cmd, which works even when PowerShell blocks npm.ps1.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org ^(version 22.13 or newer^) & pause & exit /b 1)
echo Installing / updating packages...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (echo npm install failed - see the messages above. & pause & exit /b 1)
call npm.cmd start
pause
