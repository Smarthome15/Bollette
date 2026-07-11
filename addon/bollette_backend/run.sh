#!/usr/bin/env bash
set -e

# Chiave Gemini dalle options dell'add-on (il Supervisor le scrive in
# /data/options.json). Se assente, il backend parte lo stesso: tutto funziona
# tranne l'estrazione PDF (che risponde 503, come da progetto).
GEMINI_API_KEY="$(python3 -c "import json; print(json.load(open('/data/options.json')).get('gemini_api_key') or '')" 2>/dev/null || true)"
export GEMINI_API_KEY

# Modalità add-on: niente sync/mirroring NAS (i dati locali SONO quelli sul NAS).
export BOLLETTE_ADDON=1

# MicroSD: niente bytecode dentro www, log non bufferizzati nell'add-on log.
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1

# Il codice dell'app vive nella config HA (montata in /homeassistant), NON
# dentro l'add-on: è la stessa cartella aggiornata con "Pubblica su NAS".
APP_DIR=/homeassistant/www/bollette

if [ ! -f "$APP_DIR/server.py" ]; then
    echo "[bollette] ERRORE: $APP_DIR/server.py non trovato."
    echo "[bollette] Pubblica prima il codice dell'app dal PC (Impostazioni -> Pubblica su NAS)."
    sleep 60   # niente crash-loop stretto del watchdog mentre si sistema
    exit 1
fi

cd "$APP_DIR"
echo "[bollette] Avvio backend da $APP_DIR sulla porta 8000 (access log disattivato)."
# --no-access-log: siamo su microSD, niente una riga di log per ogni richiesta.
exec python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --no-access-log
