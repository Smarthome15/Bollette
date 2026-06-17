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

# Doppio clic alternativo: run.bat (usa il .venv se presente, si posiziona nella
# cartella dello script e NON avvia una seconda istanza se la porta 8000 è già occupata)
run.bat

# (Re)installare le dipendenze
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Non esiste una suite di test né linter configurati. Per verificare una modifica: avviare il server e fare il round-trip via API (es. `POST /api/save` poi `GET /api/data`), oppure caricare un PDF dalla UI.

## Architettura

Due metà che comunicano solo via API REST JSON — **nessun framework frontend, nessun build step**: il frontend è HTML/CSS/JS statico servito da Starlette.

- **Backend** — `server.py`: app Starlette (ASGI) servita da uvicorn. Espone gli endpoint `/api/*`, monta i PDF archiviati su `/database/pdfs`, e monta `static/` come root del sito. CORS è aperto a `*` apposta per permettere a Home Assistant (porta 8123) di chiamare le API. `config.py` definisce utenti/ruoli, percorsi e i percorsi app locale/remota; **la chiave Gemini NON è in `config.py`** (vedi sotto "Chiave Gemini").
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

### Flusso di estrazione PDF (solo Gemini, nessun fallback)

`POST /api/parse-pdf` → `pdfplumber` estrae il testo → `parse_pdf_gemini` (Gemini `gemini-2.5-flash`, output JSON). **Non c'è alcun fallback euristico**: `parse_pdf_heuristics` è stata rimossa apposta (le sue regex davano dati sbagliati ma plausibili — testato sulle bollette Iren reali, ~14% di accuratezza vs ~100% di Gemini). Se Gemini non è disponibile (chiave assente o irraggiungibile) l'endpoint risponde **`503` con `error: "gemini_non_disponibile"`** e nessun dato; il frontend (`handlePdfSelected`) **blocca l'inserimento del PDF e avvisa**, invece di pre-compilare con valori inaffidabili. Scelta esplicita: meglio nessun dato che dati sbagliati. `parsed_via` vale sempre `"gemini"` quando va a buon fine. I dati estratti **pre-compilano** il form, non vengono salvati direttamente. **Se si aggiunge un campo estratto, va aggiornato in 3 punti coerenti**: il prompt in `parse_pdf_gemini` (`server.py`), `prefillBillForm()` e `saveNewBill()` in `app.js`, e (per visualizzarlo) `openPdfModal()`.

### Chiave Gemini (fuori dal codice versionato)

`config.py` legge `API_KEY_GEMINI` in ordine da: (1) variabile d'ambiente `GEMINI_API_KEY`; (2) file locale **`secrets_local.py`** (non versionato, vedi `.gitignore`) con `API_KEY_GEMINI = "..."`. Se nessuna è presente resta vuota → l'app blocca l'estrazione PDF. Sul NAS la chiave arriva perché `secrets_local.py` è incluso nella pubblicazione (vedi sotto).

### Login (senza password) e Storage mode

- **Login**: si sceglie solo il profilo, **senza password** (`handleLogin` + `PROFILI_UTENTE` in `app.js`). È tutto lato client, quindi funziona anche col backend spento. Il profilo determina il `prefix` dei file dati. (L'endpoint `/api/login` esiste ancora ma non è più usato dal frontend.)
- **`state.storageMode`** (salvato in `localStorage`): `server` usa le API; `local` usa solo `localStorage` del browser (parsing PDF disattivato, scritture accodate).
- **`apiBaseUrl`** (`initSettings`): se l'utente ha salvato un indirizzo in Impostazioni lo usa; se la pagina è su porta 8000 resta relativo; **altrimenti (es. servito da HA su 8123) resta relativo** e NON assume più `<host>:8000` (che puntava erroneamente al NAS). Per inserire/salvare da HA va impostato a mano l'indirizzo del PC dove gira il backend (es. `http://192.168.1.11:8000`); se non impostato e il backend non risponde, `loadData()` legge i JSON statici serviti da HA (sola lettura).

### Controllo codice app e pubblicazione sul NAS

Distinto dalla sincronizzazione DATI: confronta/pubblica il **codice** dell'app (locale `APP_DIR_LOCALE` vs NAS `APP_DIR_REMOTA = genitore di DB_DIR_REMOTA`, cioè `\\192.168.1.15\config\www\bollette`).
- `GET /api/app/status` (`analizza_stato_applicazione`): confronto file-per-file, dimensione poi hash MD5, sola lettura. Esclude `database`, `.venv`, `.git`, `__pycache__`, `.claude`, `backup_nas` (vedi `APP_SYNC_ESCLUSI`). UI: riquadro in Impostazioni + banner al login.
- `POST /api/app/publish` (`pubblica_app_su_nas`): **specchio esatto** locale→NAS (copia diversi/nuovi, cancella dal NAS gli extra — mai i dati). **Prima** salva un backup del codice NAS in `backup_nas/nas_<timestamp>/` (`_backup_codice_nas`); se il backup fallisce, non pubblica. Include `secrets_local.py`. UI: pulsante "Pubblica su NAS" con conferma.

### Sincronizzazione NAS

Il backend specchia ogni salvataggio sul NAS Home Assistant via SMB (`DB_DIR_REMOTA` in `config.py`, `\\192.168.1.15\...`). `connessione_nas_attiva()` fa un check TCP rapido (porta 445) per non bloccarsi se offline. Al login, `analizza_stato_sincronizzazione_utente()` confronta i timestamp `mtime` locale vs remoto (tolleranza 2s) e, se divergono, il frontend mostra l'overlay di risoluzione conflitti (download/upload, per-file o globale). Tutto degrada con grazia se il NAS è offline (modalità solo-locale).

## Convenzioni e vincoli

- I nomi file/JSON usano sempre il `db_prefix` anonimo, **mai lo username in chiaro**. Per i path usare gli helper `get_filename_only()` / `get_json_filepath()`, non costruirli a mano.
- **Non versionati** (vedi `.gitignore`): `database/` (dati + `database/pdfs/`, ricreata all'avvio), `secrets_local.py` (chiave Gemini), `backup_nas/` (backup del NAS pre-pubblicazione).
- Aggiungere un utente = voce in `UTENTI_CONFIG` (`config.py`, backend) **e** in `PROFILI_UTENTE` (`app.js`, login lato client), con lo stesso `db_prefix`.

## Infrastruttura reale (rete)

- **HA / NAS = `192.168.1.15`** (Home Assistant OS su Raspberry Pi). Serve l'app come file **statici** da `/config/www/bollette` sulla porta **8123**; **NON esegue Python**.
- **Backend Python = su un PC della LAN** (es. `192.168.1.11:8000`), avviato a mano con `run.bat`/`.venv`. Previsti ~3 PC, ognuno col **proprio profilo/dati** (file separati per `db_prefix`), quindi nessuna sovrascrittura tra loro. Il backend **non è un servizio**: vive finché la finestra di `run.bat` resta aperta.
- Accesso da HA: col PC acceso → tutto (incl. inserimento PDF via Gemini); col PC spento → login + **sola lettura** dei dati statici serviti da HA.

## Stato attuale e prossimi passi (giugno 2026)

Fatto e in produzione (committato su `main`, pubblicato sul NAS): scheda Audit fatturato vs rilevato (matching mensile); controllo/pubblicazione codice app; estrazione PDF solo-Gemini con blocco offline; chiave fuori dal codice; login senza password; `apiBaseUrl` corretto per HA; `run.bat` migliorato.

Piste aperte (non ancora fatte), per quando si riprende:
- **Backend come add-on di Home Assistant** (HA OS è un sistema chiuso: niente systemd libero) per non dipendere da un PC acceso. È il passo "serio" verso il deploy stabile, soprattutto se si vuole l'accesso da fuori via **DuckDNS + NGINX** (in tal caso instradare `/api` same-origin per evitare mixed-content/CORS).
- **IP statico del PC** sul router, altrimenti l'indirizzo backend nelle Impostazioni va riaggiornato se cambia.
- **Chiave Gemini**: gestita dall'utente su Google AI Studio; la vecchia chiave (non valida) resta nella storia git ma è inattiva.
