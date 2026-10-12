@echo off
rem ============================================================
rem  CS Team App - pull the latest code and restart the web
rem  Double-click (run as Administrator). Steps:
rem   1. git pull
rem   2. stop node.exe  -> start-server.bat (Task "CS Team App") starts it again
rem   3. if nothing started, run the task "CS Team App"
rem   4. show the last lines of server_out.log
rem ============================================================
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo [!] Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

echo.
echo === 1/3 git pull ===
git pull
if errorlevel 1 (
  echo.
  echo [!] git pull failed - the web was NOT restarted. Check the message above.
  pause
  exit /b 1
)

echo.
echo === 2/3 restart web ===
taskkill /F /IM node.exe >nul 2>&1
if errorlevel 1 (echo node.exe was not running) else (echo stopped node.exe - waiting for it to start again...)
ping -n 16 127.0.0.1 >nul

tasklist /FI "IMAGENAME eq node.exe" | find /I "node.exe" >nul
if errorlevel 1 (
  echo node.exe did not come back - starting task "CS Team App"
  schtasks /run /tn "CS Team App"
  ping -n 16 127.0.0.1 >nul
)

echo.
echo === 3/3 last lines of server_out.log (look for "CS Team App running") ===
powershell -NoProfile -Command "Get-Content -Path 'server_out.log' -Tail 15"
echo.
echo Errors (if any) are in server_err.log
pause
