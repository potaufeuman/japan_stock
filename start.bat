@echo off
chcp 65001 > nul
echo ========================================
echo  日本株式市場アナライザー
echo ========================================

:: ポート8000を使っているプロセスを強制終了
echo ポート8000をクリア中...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8000 " ^| findstr LISTEN') do (
    powershell -Command "Stop-Process -Id %%a -Force -ErrorAction SilentlyContinue" 2>nul
)
timeout /t 2 /nobreak > nul

echo サーバーを起動します...
cd /d %~dp0
start "" http://localhost:8000
python -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
