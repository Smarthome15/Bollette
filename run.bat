@echo off
title Gestione Bollette e Letture - Server Backend
echo ===================================================
echo   AVVIO DEL SERVER DI GESTIONE BOLLETTE E LETTURE
echo ===================================================
echo.
echo Controllo installazione Python...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRORE] Python non trovato! Installalo ed aggiungilo al PATH.
    pause
    exit /b
)

echo.
echo Avvio del backend sulla porta 8000...
echo Premi Ctrl+C per arrestare il server.
echo.
python server.py
pause
