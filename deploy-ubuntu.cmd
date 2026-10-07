@echo off
rem Double-click to deploy the hub to the Ubuntu server: assembles this
rem checkout's committed HEAD into ..\token-monitor-release and deploys it with
rem deploy\3.deploy-ubuntu.ps1, which asks only for the SSH account and
rem password. Run from a terminal, extra arguments go to that script, for
rem example: deploy-ubuntu.cmd -SkipBackup. See docs/hub.zh-TW.md, deploy section.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\3.deploy-ubuntu.ps1" %*
set code=%errorlevel%
echo.
pause
exit /b %code%
