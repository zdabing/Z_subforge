@echo off
rem Start subforge web console (auto opens browser)
chcp 65001 >nul
cd /d "%~dp0"
start "" "http://localhost:8790"
node server.js
