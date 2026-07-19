# Changelog

## 1.0.4

- **Bonifica /local (sicurezza)**: il codice dell'app ora vive nell'area
  PRIVATA `/homeassistant/bollette_app` (o `/config/bollette_app`), NON più
  sotto `www/` — tutto ciò che sta in `www/` è servito da HA come `/local/`
  senza autenticazione (e risultava raggiungibile anche da internet via proxy).
  In `www/Bollette` resta solo il frontend statico. I vecchi percorsi `www/`
  restano come fallback transitorio per il primo avvio.

## 1.0.3

- **Fix decisivo**: sul filesystem del Pi la cartella dell'app è
  `www/Bollette` (B maiuscola) — da Windows/SMB non si vede, ma Linux è
  case-sensitive. `run.sh` ora prova `Bollette` e `bollette` in
  `/homeassistant` e `/config` (diagnosi arrivata dal log della 1.0.1/1.0.2).

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
