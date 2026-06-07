@echo off
setlocal
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;C:\Windows\System32;C:\Windows"
if not exist certs\server.crt (
  powershell -ExecutionPolicy Bypass -File scripts\generate-self-signed-cert.ps1 -DnsName localhost
)
set "HOST=0.0.0.0"
set "PORT=3443"
set "HTTP_REDIRECT_PORT=3001"
set "HTTPS_PFX_FILE=certs\server.pfx"
set "HTTPS_PFX_PASSPHRASE=changeit"
set "AUTH_COOKIE_SECURE=true"
npm.cmd run build
node server\index.js
