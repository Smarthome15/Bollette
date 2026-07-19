# Bollette Backend (ConsumiCasa)

Backend Python dell'app **Bollette/ConsumiCasa** come add-on locale di Home
Assistant OS: API REST, salvataggio dei JSON in `/config/bollette_app/database`,
archiviazione e **estrazione dati dalle bollette PDF via Gemini**. Con questo
add-on il PC non serve più: l'app completa risponde su `http://<ip-ha>:8000`.

## Come funziona

- Il **codice dell'app non è dentro l'add-on**: gira da
  `/homeassistant/bollette_app` (cioè `/config/bollette_app`, area PRIVATA
  fuori da `www/` — bonifica /local del 19/07/2026), la stessa cartella che il
  PC di sviluppo aggiorna con *Impostazioni → Pubblica su NAS*.
  **Deploy = pubblica + riavvia l'add-on.**
- I **dati** restano in `/config/bollette_app/database`: unica fonte di verità,
  inclusa nei backup di Home Assistant. In `www/Bollette` c'è SOLO il frontend
  statico (`/local` è servito da HA senza autenticazione: mai metterci segreti).
- In modalità add-on il backend disattiva da solo la sincronizzazione NAS
  (non serve più: è già "sul NAS") — flag `BOLLETTE_ADDON=1` in `run.sh`.

## Configurazione

| Opzione | Descrizione |
|---|---|
| `gemini_api_key` | Chiave API di Google AI Studio per l'estrazione PDF. Se vuota il backend parte comunque, ma il caricamento PDF risponde 503 (per scelta: meglio nessun dato che dati inventati). |

Watchdog e avvio automatico sono attivi (`boot: auto`, `watchdog` TCP su 8000).

## Aggiornamenti

- **Codice app** (server.py, static/…): *Pubblica su NAS* dal PC → **Riavvia**
  l'add-on. Non serve ricostruire.
- **Dipendenze Python o run.sh/Dockerfile**: aggiorna i file in
  `/addons/bollette_backend` (script `addon/deploy_addon.ps1` dal repo) e alza
  `version` in `config.yaml` → l'add-on propone l'aggiornamento (ricostruzione).

## Diagnostica

`GET http://<ip-ha>:8000/api/health` → `{"ok": true, "addon": true, "gemini": true|false}`
(`gemini: false` = chiave mancante nelle options).
