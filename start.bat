@echo off
title Peregrine
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto end
)
echo.
echo Python 3 isn't installed yet. Get it free from https://www.python.org/downloads/
echo During install, tick "Add python.exe to PATH". Then double-click start.bat again.
:end
echo.
pause
