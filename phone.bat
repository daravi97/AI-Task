@echo off
REM Double-click to open the Merch Store on your phone (via a free Cloudflare tunnel).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org ^(version 22.13 or newer^) & pause & exit /b 1)
where cloudflared >nul 2>nul || (echo. & echo cloudflared is not installed - the store will only work on the same Wi-Fi. & echo To use it from anywhere, run once:  winget install --id Cloudflare.cloudflared & echo.)
echo Installing / updating packages...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (echo npm install failed - see the messages above. & pause & exit /b 1)
call npm.cmd run phone
pause
