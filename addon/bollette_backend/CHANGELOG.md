# Changelog

## 1.0.2

- Aggiunto questo CHANGELOG (la finestra di aggiornamento di HA lo mostra).
- Nessuna modifica funzionale rispetto alla 1.0.1.

## 1.0.1

- `run.sh` auto-adattivo: cerca il codice dell'app sia in
  `/homeassistant/www/bollette` (mapping moderno) sia in `/config/www/bollette`
  (mapping storico).
- Se il codice non si trova, il log dell'add-on stampa la mappa reale dei mount
  (`ls` di `/`, `/homeassistant`, `/config` e relativi `www`) per la diagnosi.

## 1.0.0

- Prima versione: backend Starlette/uvicorn su porta 8000, codice da
  `/config/www/bollette` (pubblicato con "Pubblica su NAS"), chiave Gemini
  nelle options, boot automatico + watchdog, log sobri per la microSD.
