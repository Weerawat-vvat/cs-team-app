@echo off
rem ============================================================
rem  CS Team App - start the web server and keep it running
rem  Used by Task Scheduler "At startup" (see README in commit message)
rem  - runs from this folder so server.js finds .env
rem  - restarts node 10 seconds after it stops or crashes
rem  - output: server_out.log / errors: server_err.log
rem ============================================================
setlocal
cd /d "%~dp0"

rem Task Scheduler (SYSTEM) may not have node on PATH - use the full path when found
set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

:loop
echo [%date% %time%] starting server>> server_out.log
"%NODE_EXE%" server.js >> server_out.log 2>> server_err.log
echo [%date% %time%] server stopped (exit %errorlevel%) - restarting in 10s>> server_out.log
rem ping instead of timeout: timeout fails when there is no console (Task Scheduler)
ping -n 11 127.0.0.1 > nul
goto loop
