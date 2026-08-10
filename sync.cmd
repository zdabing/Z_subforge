@echo off
rem Sync subforge config + script version (run manually or via scheduled task)
chcp 65001 >nul
cd /d "%~dp0"
node sync.js
node scriptGenerator.js sync
node scriptGenerator.js generate
