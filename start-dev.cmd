@echo off
setlocal
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;C:\Windows\System32;C:\Windows"
start "leased-line-server" /min "C:\Program Files\nodejs\node.exe" server\index.js
start "leased-line-client" /min "C:\Program Files\nodejs\node.exe" node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5173
echo Server: http://127.0.0.1:3001
echo Client: http://127.0.0.1:5173
