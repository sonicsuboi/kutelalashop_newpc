@echo off
rem Bam dup vao file nay TRONG FILE EXPLORER de chay trang web.
rem Giu cua so nay mo trong luc dung, dong cua so la tat server.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay Node.js. Hay cai Node.js tai https://nodejs.org roi chay lai.
  pause
  exit /b 1
)

if not exist node_modules call npm install

rem Doi 3 giay cho server san sang roi moi mo trinh duyet
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

echo Dang chay trang web tai http://localhost:3000
echo Dong cua so nay de tat.
node server.js

echo.
echo Server da dung. Neu co dong bao loi o tren, hay gui cho nguoi ho tro.
pause
