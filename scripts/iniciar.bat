@echo off
cd /d "%~dp0.."
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --no-audit --no-fund
)
start "" http://127.0.0.1:3847
node server.js
pause
