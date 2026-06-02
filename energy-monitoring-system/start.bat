@echo off
title EnergyAI - Smart Energy Monitoring System
color 0A

echo.
echo  =============================================
echo   ⚡ EnergyAI - Starting All Services
echo  =============================================
echo.

:: Start ML Service (Python Flask on port 5000)
echo  [1/2] Starting ML Service (port 5000)...
cd /d "%~dp0ml_service"
start "EnergyAI - ML Service" cmd /k "title EnergyAI ML Service (Port 5000) && venv\Scripts\python.exe app.py"

:: Wait a moment for ML service to initialize
timeout /t 3 /nobreak >nul

:: Start Backend Server (Node.js on port 3000)
echo  [2/2] Starting Backend Server (port 3000)...
cd /d "%~dp0backend"
start "EnergyAI - Backend" cmd /k "title EnergyAI Backend (Port 3000) && node server.js"

:: Wait for server to start
timeout /t 2 /nobreak >nul

echo.
echo  =============================================
echo   ✅ All services started!
echo.
echo   Dashboard:    http://localhost:3000
echo   ML Service:   http://localhost:5000
echo.
echo   Close this window - services keep running.
echo   To stop, close the two service windows.
echo  =============================================
echo.

:: Open browser
start http://localhost:3000

pause
