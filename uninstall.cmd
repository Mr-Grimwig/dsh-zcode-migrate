@echo off
chcp 65001 >nul
where node >nul 2>nul || (echo [x] Node.js 22.15+ required: https://nodejs.org & pause & exit /b 1)
set "OC=%TEMP%\dsh-zcode-migrate-boot.mjs"
curl -fsSL -o "%OC%" "https://raw.githubusercontent.com/Mr-Grimwig/dsh-zcode-migrate/main/scripts/one-click.mjs"
if errorlevel 1 (echo [x] download failed, check your network & pause & exit /b 1)
node "%OC%" --uninstall %*
pause
