@echo off
rem ============================================================
rem  Nailong Desktop Pet  -  force quit
rem  Only kills the Electron process whose command line points at
rem  this folder, so the DeepSeek Harness app itself is untouched.
rem  (Normally you should just right-click the pet -> Exit.)
rem ============================================================
setlocal
chcp 65001 >nul 2>&1
title Nailong Desktop Pet - quit

set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me = $env:APPDIR; $p = Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($me) };" ^
  "if (-not $p) { Write-Host '  Nailong Desktop Pet is not running.'; exit 0 }" ^
  "foreach ($x in $p) { Write-Host ('  stopping PID ' + $x.ProcessId); Stop-Process -Id $x.ProcessId -Force }" ^
  "Write-Host '  done.'"

echo.
pause
endlocal
