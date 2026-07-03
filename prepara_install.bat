@echo off
REM ============================================================================
REM  prepara_install.bat
REM  Genera la cartella "install\" con TUTTO il necessario per far girare su un
REM  altro PC solo il SERVIZIO DI SALVATAGGIO (il backend Python), senza frontend.
REM  Il frontend (l'app) e' servito da Home Assistant, quindi qui NON serve.
REM
REM  Rilancia questo script ogni volta che vuoi un pacchetto aggiornato:
REM  copia sempre le versioni piu' recenti dei file dalla root del progetto.
REM ============================================================================

setlocal
cd /d "%~dp0"

set DEST=install

echo.
echo === Preparazione pacchetto backend in "%DEST%\" ===
echo.

if not exist "%DEST%" mkdir "%DEST%"

REM --- File necessari al servizio (backend) ---
copy /Y "server.py"         "%DEST%\server.py"         >nul && echo   [OK] server.py
copy /Y "config.py"         "%DEST%\config.py"         >nul && echo   [OK] config.py
copy /Y "requirements.txt"  "%DEST%\requirements.txt"  >nul && echo   [OK] requirements.txt
copy /Y "run.bat"           "%DEST%\run.bat"           >nul && echo   [OK] run.bat

REM --- Chiave Gemini (necessaria per l'estrazione PDF) ---
if exist "secrets_local.py" (
    copy /Y "secrets_local.py" "%DEST%\secrets_local.py" >nul && echo   [OK] secrets_local.py (chiave Gemini)
) else (
    echo   [!!] secrets_local.py NON trovato: sul nuovo PC l'estrazione PDF sara' disattivata.
    echo        Recuperalo dal NAS: \\192.168.1.15\config\www\bollette\secrets_local.py
)

REM --- Genera il LEGGIMI con le istruzioni ---
(
echo SERVIZIO DI SALVATAGGIO (backend Python) - Gestione Bollette
echo ============================================================
echo.
echo A COSA SERVE
echo   Questo pacchetto fa girare SOLO il backend che salva i dati, carica i PDF
echo   (via Gemini^) e sincronizza col NAS. L'interfaccia (l'app^) NON e' qui: si usa
echo   quella servita da Home Assistant nel browser.
echo.
echo INSTALLAZIONE (una volta sola^)
echo   1^) Installa Python 3.12+ (con "py launcher"^).
echo   2^) Apri un terminale in questa cartella ed esegui:
echo        py -m venv .venv
echo        .\.venv\Scripts\python.exe -m pip install -r requirements.txt
echo   3^) Verifica che ci sia secrets_local.py (chiave Gemini^). Se manca, copialo da:
echo        \\192.168.1.15\config\www\bollette\secrets_local.py
echo.
echo AVVIO
echo   Doppio clic su run.bat. Il servizio ascolta su http://0.0.0.0:8000
echo   Tienilo aperto: il servizio vive finche' la finestra resta aperta.
echo.
echo COLLEGARE L'APP (in Home Assistant^)
echo   Apri l'app da HA, vai in Impostazioni ^> Indirizzo Server Backend e metti:
echo        http://IP-DI-QUESTO-PC:8000
echo   (trovi l'IP con "ipconfig"; se l'IP e' DHCP puo' cambiare al riavvio -
echo    conviene una reservation sul router^).
echo.
echo NOTE
echo   - static/ NON e' incluso apposta: il frontend lo serve HA. Il server parte
echo     lo stesso servendo solo le API.
echo   - I dati NON stanno qui: vivono sul NAS e si scaricano al login dall'app.
echo   - Ogni PC/persona usa il proprio profilo al login (dati separati per profilo^).
) > "%DEST%\LEGGIMI.txt"
echo   [OK] LEGGIMI.txt

echo.
echo === Fatto. La cartella "%DEST%\" e' pronta da copiare sull'altro PC. ===
echo.
echo Sul nuovo PC, dentro la cartella copiata:
echo   1) py -m venv .venv
echo   2) .\.venv\Scripts\python.exe -m pip install -r requirements.txt
echo   3) doppio clic su run.bat  (avvia il servizio su :8000)
echo   4) In Home Assistant, Impostazioni ^> Indirizzo Server Backend:
echo      metti  http://IP-DI-QUESTO-PC:8000
echo.
echo Vedi install\LEGGIMI.txt per i dettagli.
echo.
pause
endlocal
