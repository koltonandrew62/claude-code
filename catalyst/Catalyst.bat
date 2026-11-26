@echo off
setlocal
cd /d "%~dp0"
title Catalyst
rem Double-click to run Catalyst. Installs Node.js if it is missing, adds a desktop shortcut, opens the app in your browser.

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo Catalyst needs Node.js, which is free. Installing it now...
  echo If Windows asks for permission, choose Yes.
  echo.
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "NODE=%ProgramFiles%\nodejs\node.exe"
)

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js could not be installed automatically.
  echo Install it from https://nodejs.org and then double-click this file again.
  echo.
  pause
  exit /b 1
)

"%NODE%" shortcut.js >nul 2>nul
echo.
echo Catalyst is starting and will open in your browser.
echo Keep this window open while you use it. Close it to stop the app.
echo.
"%NODE%" server.js --open
pause
