@echo off
title Test Push PRO300
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-pro300-push.ps1"
pause
