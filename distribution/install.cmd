@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "WEBCODEX_INSTALL_EXIT=%ERRORLEVEL%"
if not "%WEBCODEX_INSTALL_NO_PAUSE%"=="1" pause
exit /b %WEBCODEX_INSTALL_EXIT%
