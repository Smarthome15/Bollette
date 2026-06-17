@echo off
title Gestione Bollette e Letture - Server Backend
echo ===================================================
echo   AVVIO DEL SERVER DI GESTIONE BOLLETTE E LETTURE
echo ===================================================
echo.

REM Ci posizioniamo nella cartella di questo script (cosi i percorsi relativi,
REM es. la cartella "database", funzionano anche se il .bat e' lanciato da altrove).
cd /d "%~dp0"

REM Verifica che il backend non sia gia' in esecuzione sulla porta 8000.
netstat -ano | findstr ":8000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Il backend risulta GIA' attivo sulla porta 8000.
    echo Non avvio una seconda istanza. Puoi chiudere questa finestra.
    echo.
    pause
    exit /b
)

REM Preferiamo il Python del virtual environment (con le dipendenze gia' installate).
if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
) else (
    echo [AVVISO] Virtual environment .venv non trovato: uso il Python globale.
    echo Se mancano le dipendenze esegui: python -m pip install -r requirements.txt
    echo.
    where python >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERRORE] Python non trovato! Installalo ed aggiungilo al PATH.
        pause
        exit /b
    )
    set "PY=python"
)

echo Avvio del backend sulla porta 8000...
echo Premi Ctrl+C per arrestare il server.
echo.
"%PY%" server.py
pause
