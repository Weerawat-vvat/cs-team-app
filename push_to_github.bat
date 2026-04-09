@echo off
echo === CS Team App - Push to GitHub ===
echo.

REM ลบ .git เดิมที่เสีย
echo [1/6] ลบ .git เดิม...
rmdir /s /q .git

REM Init ใหม่
echo [2/6] git init...
git init -b main
git config user.email "nart@infogrammer.com"
git config user.name "Weerawat"

REM เพิ่มไฟล์
echo [3/6] git add...
git add .

REM Commit
echo [4/6] git commit...
git commit -m "Add AI features: chatbot, dashboard insights, shift scheduling, KPI forecast"

REM Remote
echo [5/6] เพิ่ม remote...
git remote add origin https://github.com/Weerawat-vvat/cs-team-app.git

REM Push
echo [6/6] git push... (GitHub จะถาม username และ Personal Access Token)
git push -u origin main

echo.
echo === เสร็จแล้ว! ===
pause
