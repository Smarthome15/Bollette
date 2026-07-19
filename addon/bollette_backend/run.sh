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

# Il codice dell'app vive nella config di HA, NON dentro l'add-on: è la stessa
# cartella aggiornata con "Pubblica su NAS". A seconda della versione del
# Supervisor la config è montata in /homeassistant (mapping moderno
# homeassistant_config) oppure in /config (mapping storico).
# Dal 2026-07-19 (bonifica /local) l'app vive nell'area PRIVATA bollette_app,
# NON più in www/: tutto ciò che sta in www/ è servito da HA senza login.
# Le varianti www/ restano come fallback SOLO transitorio per il primo avvio.
APP_DIR=""
for cand in /homeassistant/bollette_app /config/bollette_app /homeassistant/www/Bollette /homeassistant/www/bollette /config/www/Bollette /config/www/bollette; do
    if [ -f "$cand/server.py" ]; then
        APP_DIR="$cand"
        break
    fi
done

if [ -z "$APP_DIR" ]; then
    echo "[bollette] ERRORE: server.py non trovato in /homeassistant|/config + bollette_app (ne' nei vecchi percorsi www)."
    echo "[bollette] Se il codice non e' mai stato pubblicato: dal PC, Impostazioni -> Pubblica su NAS."
    echo "[bollette] Diagnostica mount (da incollare in caso di problemi):"
    echo "[bollette] --- ls / ---";                  ls -la / 2>/dev/null || true
    echo "[bollette] --- ls /homeassistant ---";     ls -la /homeassistant 2>/dev/null || echo "  (non esiste)"
    echo "[bollette] --- ls /homeassistant/www ---"; ls -la /homeassistant/www 2>/dev/null || echo "  (non esiste)"
    echo "[bollette] --- ls /config ---";            ls -la /config 2>/dev/null || echo "  (non esiste)"
    echo "[bollette] --- ls /config/www ---";        ls -la /config/www 2>/dev/null || echo "  (non esiste)"
    sleep 60   # niente crash-loop stretto del watchdog mentre si sistema
    exit 1
fi

cd "$APP_DIR"
echo "[bollette] Avvio backend da $APP_DIR sulla porta 8000 (access log disattivato)."
# --no-access-log: siamo su microSD, niente una riga di log per ogni richiesta.
exec python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --no-access-log
