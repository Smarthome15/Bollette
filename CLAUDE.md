# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Cos'è

App per tracciare i consumi domestici (luce / gas / acqua): caricamento bollette PDF con estrazione dati via IA, letture manuali mensili dei contatori, dashboard con grafici, e una scheda di audit che confronta i consumi **fatturati vs rilevati**. Pensata per essere servita anche da Home Assistant e usata da telefono/PC. Lingua del codice e dell'UI: italiano.

## Comandi

Ambiente: Windows, Python 3.12, virtual environment già presente in `.venv`.

```powershell
# Avvio (dev): apre il browser e serve su 0.0.0.0:8000
.\.venv\Scripts\python.exe server.py

# Avvio (senza auto-apertura browser, utile per debug)
.\.venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8000

# Doppio clic alternativo (usa il python globale, non il venv)
run.bat

# (Re)installare le dipendenze
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Non esiste una suite di test né linter configurati. Per verificare una modifica: avviare il server e fare il round-trip via API (es. `POST /api/save` poi `GET /api/data`), oppure caricare un PDF dalla UI.

## Architettura

Due metà che comunicano solo via API REST JSON — **nessun framework frontend, nessun build step**: il frontend è HTML/CSS/JS statico servito da Starlette.

- **Backend** — `server.py`: app Starlette (ASGI) servita da uvicorn. Espone gli endpoint `/api/*`, monta i PDF archiviati su `/database/pdfs`, e monta `static/` come root del sito. CORS è aperto a `*` apposta per permettere a Home Assistant (porta 8123) di chiamare le API. `config.py` definisce utenti/ruoli, percorsi e la chiave Gemini, e crea le cartelle `database/` e `database/pdfs/` all'import.
- **Frontend** — `static/index.html` (markup + tab), `static/app.js` (tutta la logica, single-file, basata su un oggetto globale `state`), `static/app.css`. Chart.js e Lucide arrivano da CDN.

### Modello dati (la cosa più importante da capire)

I dati vivono in file JSON in `database/`, **un file per ogni combinazione utente × utenza × tipo**. Il nome è anonimizzato tramite un prefisso (`db_prefix` in `UTENTI_CONFIG`, es. `Matteo → UserA`):

```
{prefix}_{utenza}.json          → bollette        (es. UserA_gas.json)
{prefix}_man_{utenza}.json      → letture manuali (es. UserA_man_gas.json)
```

- Ogni file è un **array di record ordinato per `data`**. Non c'è un DB: il backend riscrive l'intero array a ogni salvataggio (`POST /api/save` riceve l'array completo, non un delta).
- **Record bolletta**: `data`, `periodo_inizio`, `periodo_fine`, `consumo_fatturato`, `fattura`, `pdf_path`, `tipo_lettura` (`rilevata`/`stimata`/`mista`), `note`. LUCE ha anche `lettura_f1/f2/f3` + `lettura_totale`; GAS/ACQUA hanno `lettura` (valore progressivo del contatore).
- **Distinzione chiave**: `lettura` / `lettura_totale` sono il valore **progressivo del contatore**; `consumo_fatturato` è il **consumo del periodo dichiarato in bolletta**. Il consumo per-periodo nei grafici è invece calcolato a runtime per **differenza tra letture consecutive** (`.diff()` lato JS) — quindi le letture devono essere cronologiche e crescenti.

### Flusso di estrazione PDF

`POST /api/parse-pdf` → `pdfplumber` estrae il testo → `parse_pdf_gemini` (Gemini `gemini-2.5-flash`, output JSON) è il percorso primario; se la chiave manca o l'IA fallisce, fa fallback su `parse_pdf_heuristics` (regex). Il campo `parsed_via` nel risultato dice quale dei due ha risposto. I dati estratti **pre-compilano** il form, non vengono salvati direttamente: l'utente verifica e conferma. **Se si aggiunge un campo estratto, va aggiornato in 3 punti coerenti**: il prompt/euristica in `server.py`, `prefillBillForm()` e `saveNewBill()` in `app.js`, e (per visualizzarlo) `openPdfModal()`.

### Storage mode (server vs local)

`app.js` ha due modalità (`state.storageMode`, salvata in `localStorage`):
- `server`: usa le API. `apiBaseUrl` è derivato automaticamente — se la pagina è servita da una porta diversa da 8000 (es. 8123 di HA) punta a `http://<host>:8000`.
- `local`: nessun backend; i dati stanno in `localStorage` del browser, il parsing PDF IA è disattivato. Le scritture offline vengono accodate per la sincronizzazione successiva.

### Sincronizzazione NAS

Il backend specchia ogni salvataggio sul NAS Home Assistant via SMB (`DB_DIR_REMOTA` in `config.py`, `\\192.168.1.15\...`). `connessione_nas_attiva()` fa un check TCP rapido (porta 445) per non bloccarsi se offline. Al login, `analizza_stato_sincronizzazione_utente()` confronta i timestamp `mtime` locale vs remoto (tolleranza 2s) e, se divergono, il frontend mostra l'overlay di risoluzione conflitti (download/upload, per-file o globale). Tutto degrada con grazia se il NAS è offline (modalità solo-locale).

## Convenzioni e vincoli

- I nomi file/JSON usano sempre il `db_prefix` anonimo, **mai lo username in chiaro**. Per i path usare gli helper `get_filename_only()` / `get_json_filepath()`, non costruirli a mano.
- La cartella `database/` (dati, letture `_man_`, e `database/pdfs/`) **non è versionata** (vedi `.gitignore`) ed è ricreata dal codice all'avvio.
- Aggiungere un utente = aggiungere una voce in `UTENTI_CONFIG` con un `db_prefix` univoco.
