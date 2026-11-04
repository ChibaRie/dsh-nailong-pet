@echo off
rem ============================================================
rem  Nailong Desktop Pet  -  launcher
rem  Double-click this file to put the pet on your desktop.
rem  (This .bat is deliberately ASCII-only so cmd.exe never
rem   mangles it regardless of the console code page.)
rem ============================================================
setlocal
chcp 65001 >nul 2>&1
title Nailong Desktop Pet

rem --- DSH ships Electron with ELECTRON_RUN_AS_NODE=1 set in some shells.
rem     If that leaks in, electron.exe degrades into plain Node and the app
rem     dies with "Cannot find module 'electron'". Clear it.
set "ELECTRON_RUN_AS_NODE="

set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
set "APP=%APPDIR%\plugin\runtime\app"

set "ELECTRON="

rem 1) Electron bundled next to the local node_modules
if exist "%APPDIR%\node_modules\electron\dist\electron.exe" set "ELECTRON=%APPDIR%\node_modules\electron\dist\electron.exe"

rem 2) Electron shipped with DeepSeek Harness
if not defined ELECTRON if exist "%USERPROFILE%\.dsh\electron\electron.exe" set "ELECTRON=%USERPROFILE%\.dsh\electron\electron.exe"

rem 3) Whatever `electron` is on PATH
if not defined ELECTRON for %%I in (electron.exe) do if not "%%~$PATH:I"=="" set "ELECTRON=%%~$PATH:I"

if not defined ELECTRON (
  echo.
  echo   [X] Electron not found.
  echo       Put electron.exe at: "%APPDIR%\node_modules\electron\dist\electron.exe"
  echo       or install it globally:  npm i -g electron
  echo.
  pause
  exit /b 1
)

if not exist "%APP%\main.js" (
  echo.
  echo   [X] Missing app: "%APP%\main.js"
  echo.
  pause
  exit /b 1
)

echo   Starting Nailong Desktop Pet ...
echo   Electron : %ELECTRON%
echo   App      : %APP%
echo.
echo   Click the pet  -> side panel (pick any action)
echo   Drag the pet   -> move it around
echo   Right-click    -> menu (actions / size / exit)
echo.

start "" "%ELECTRON%" "%APP%"
endlocal
