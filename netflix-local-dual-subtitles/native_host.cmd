@echo off
:: Chrome Native Messaging host launcher for Windows.
:: All diagnostics go to stderr or the local log; stdout is reserved for the
:: Native Messaging binary protocol emitted by native_host.py.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PYTHONDONTWRITEBYTECODE=1"
set "LOG_DIR=%LOCALAPPDATA%\NetflixLocalDualSubtitles"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

where py >nul 2>&1
if not errorlevel 1 goto run_py

where python3 >nul 2>&1
if not errorlevel 1 goto run_python3

where python >nul 2>&1
if not errorlevel 1 goto run_python

>&2 echo Python 3 was not found. Install Python and try again.
exit /b 1

:run_py
py -3 -u "%SCRIPT_DIR%native_host.py" %* 2>>"%LOG_DIR%\native-host.log"
exit /b %ERRORLEVEL%

:run_python3
python3 -u "%SCRIPT_DIR%native_host.py" %* 2>>"%LOG_DIR%\native-host.log"
exit /b %ERRORLEVEL%

:run_python
python -u "%SCRIPT_DIR%native_host.py" %* 2>>"%LOG_DIR%\native-host.log"
exit /b %ERRORLEVEL%
