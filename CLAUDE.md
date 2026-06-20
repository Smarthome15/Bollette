# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Cos'è

App per tracciare i consumi domestici (luce / gas / acqua): caricamento bollette PDF con estrazione dati via IA, letture manuali mensili dei contatori, dashboard con grafici (con **filtro per anno**), una scheda di audit che confronta i consumi **fatturati vs rilevati**, e una scheda **Andamento Prezzi** che confronta bollette consecutive per scovare rincari tariffari o variazioni di consumo. Pensata per essere servita anche da Home Assistant e usata da telefono/PC. Lingua del codice e dell'UI: italiano.

Le 5 tab del frontend: **Dashboard**, **Bollette PDF**, **Letture Manuali**, **Verifica Anomalie** (audit fatturato vs rilevato), **Andamento Prezzi** (variazioni prezzo/consumo tra bollette).

## Documentazione di dettaglio

Per capire la struttura del software in profondità, oltre a questo file consulta la cartella `docs/`:

- [Architettura](docs/architettura.md) — visione d'insieme: backend Starlette + frontend statico, endpoint `/api/*`, ruolo di `config.py`.
- [Modello dati](docs/modello-dati.md) — file JSON per utente×utenza×tipo, struttura dei record, lettura vs consumo, perché le letture devono essere crescenti.
- [Frontend](docs/frontend.md) — l'oggetto `state`, le 5 tab e le funzioni che le governano (filtro anno, audit, andamento prezzi, guardie, import).
- [Flusso estrazione PDF](docs/flusso-pdf.md) — da PDF a form via Gemini, niente fallback, chiave Gemini, e la regola dei punti coerenti per i campi estratti.
- [Deploy, NAS e sincronizzazione](docs/deploy-nas.md) — infrastruttura reale, sync dati vs pubblicazione codice, storage mode e degradazione offline.

> Le sezioni qui sotto restano la guida operativa rapida; i file `docs/` sono l'approfondimento per area.

## Comandi

Ambiente: Windows, Python 3.14 (il codice nasce per 3.12 ma gira bene su 3.14; le wheel `cp314` esistono). Il `.venv` **non è versionato**: se manca su una macchina nuova va ricreato (`py -m venv .venv` poi `pip install -r requirements.txt`). Per l'estrazione PDF serve anche `secrets_local.py` con la chiave Gemini (vedi sotto), altrimenti tutto funziona tranne il caricamento PDF.

```powershell
# Ricreare il virtual environment (se .venv manca) e installare le dipendenze
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

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
- **Record bolletta**: `data`, `periodo_inizio`, `periodo_fine`, `consumo_fatturato`, `fattura`, `pdf_path`, `tipo_lettura` (`rilevata`/`stimata`/`mista`), `note`, e (per l'analisi prezzi) `quota_fissa`, `quota_energia`, `prezzo_unitario_energia` — tutti opzionali (`null` se non disponibili: lo storico ne è privo). LUCE ha anche `lettura_f1/f2/f3` + `lettura_totale`; GAS/ACQUA hanno `lettura` (valore progressivo del contatore).
- **Periodo sulle bollette storiche**: le bollette importate dall'Excel non avevano `periodo_inizio`/`periodo_fine`/`consumo_fatturato`; sono stati popolati a posteriori (periodo dedotto dalla bolletta precedente; `consumo_fatturato` = "MtC fatturati" Excel per il gas, = consumo rilevato dalle letture per luce/acqua). Anche i record di **lettura** che cadono sulla data di una bolletta hanno ora `periodo_inizio`/`periodo_fine` (campi "passeggeri" ignorati dal resto dell'app).
- **Distinzione chiave**: `lettura` / `lettura_totale` sono il valore **progressivo del contatore**; `consumo_fatturato` è il **consumo del periodo dichiarato in bolletta**. Il consumo per-periodo nei grafici è invece calcolato a runtime per **differenza tra letture consecutive** (`.diff()` lato JS) — quindi le letture devono essere cronologiche e crescenti.

### Flusso di estrazione PDF (solo Gemini, nessun fallback)

`POST /api/parse-pdf` → `pdfplumber` estrae il testo → `parse_pdf_gemini` (Gemini `gemini-2.5-flash`, output JSON). **Non c'è alcun fallback euristico**: `parse_pdf_heuristics` è stata rimossa apposta (le sue regex davano dati sbagliati ma plausibili — testato sulle bollette Iren reali, ~14% di accuratezza vs ~100% di Gemini). Se Gemini non è disponibile (chiave assente o irraggiungibile) l'endpoint risponde **`503` con `error: "gemini_non_disponibile"`** e nessun dato; il frontend (`handlePdfSelected`) **blocca l'inserimento del PDF e avvisa**, invece di pre-compilare con valori inaffidabili. Scelta esplicita: meglio nessun dato che dati sbagliati. `parsed_via` vale sempre `"gemini"` quando va a buon fine. Oltre ai campi base, il prompt estrae anche `quota_fissa`, `quota_energia`, `prezzo_unitario_energia` (scomposizione costi, usata dalla tab Andamento Prezzi). I dati estratti **pre-compilano** il form, non vengono salvati direttamente. **Se si aggiunge un campo estratto, va aggiornato in 4 punti coerenti**: il prompt in `parse_pdf_gemini` (`server.py`), l'`<input>` nel form bolletta (`index.html`), `prefillBillForm()` e `saveNewBill()` in `app.js`, e (per visualizzarlo nel modal) `openPdfModal()`. **Naming**: la chiave del JSON Gemini deve essere identica alla chiave del record e all'attributo letto in `prefillBillForm` (es. `prezzo_unitario_energia` ovunque) per evitare rimappature e bug silenziosi.

### Dashboard, Andamento Prezzi e guardie (frontend)

- **Dashboard — filtro Anno** (`renderDashboard`, `popolaSelettoreAnni`, `getAnniConDati`, `state.dashboardYear`): selettore in alto a destra popolato **solo con gli anni che hanno dati**, default = anno in corso. Filtra KPI spesa, trend e grafico "Andamento Spese Mensili" (gen→dic dell'anno scelto). Il trend confronta a **pari periodo** (year-to-date per l'anno in corso, anno intero per gli anni passati). Il grafico "Consumo Storico Annuale" usa le **autoletture** (non le bollette) con ripartizione pro-rata sui giorni a cavallo d'anno.
- **Tab Andamento Prezzi** (`renderPrezziTab`, `computePrezziVariazioni`, `renderPrezziChart`, `contaSegnalazioniPrezzi`, `getPrezziSoglia`; `state.charts.prezzi`): confronta ogni bolletta con la precedente della stessa utenza su **prezzo unitario** (`prezzo_unitario_energia`) e **consumo**, segnalando le variazioni oltre una **soglia regolabile** (input `prezzi-soglia`, default 15%). Considera **solo le bollette con `prezzo_unitario_energia` reale** (quindi quelle future via PDF): niente stime sullo storico. La pagina **Verifica Anomalie** mostra un avviso cliccabile (`audit-prezzi-alert`) "N variazioni da controllare" che rimanda qui.
- **Guardie pagina Letture** (`saveNewReading`): avviso se il totale luce ≠ F1+F2+F3, se la data è duplicata (propone sostituzione), o se la lettura non è crescente. Fix accodamento pending offline per letture arretrate (parametro `recordModificato` di `saveUtilityData`).
- **Import backup sicuro** (`importBackup`, `validaBundleBackup`): conferma esplicita (sostituisce, non unisce), validazione del bundle e dei record **prima** di toccare lo stato.

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

### Lavori del 20/06/2026 (da testare il giorno dopo)

**Su GitHub `main`** (commit `5b6f1d1`, già pushato): Dashboard filtro Anno + fix trend/consumi; import backup sicuro; guardie Letture.
**NON ancora committato** al momento della scrittura: nuova tab **Andamento Prezzi** + estrazione `quota_fissa`/`quota_energia`/`prezzo_unitario_energia` da Gemini (backend `server.py` + frontend). → da committare e poi **pubblicare su NAS** (Impostazioni → Pubblica) perché il codice locale e quello servito da HA divergono.
**Dati UserA sul NAS** già aggiornati: correzione lettura luce F1 31/12/2024 (333→339, totale 1086); periodi/`consumo_fatturato` popolati su tutte le bollette storiche. Backup pre-modifica in `backup_nas/` (`fix_luce_F1_…`, `fix_audit_periodi_…`).

### Checklist di test (domani)

1. **Avvio**: `run.bat` o `server.py`; verificare che il `.venv` esista e che `secrets_local.py` sia presente (estrazione PDF attiva).
2. **Login + sync**: login come Matteo → scaricare dal NAS nell'overlay di sincronizzazione → i dati compaiono.
3. **Verifica Anomalie**: cambiando utenza, le bollette devono risultare in maggioranza "Allineate" (gas ha 1 "Sovrafatturata" a giugno 2025); non più tutte "Non verificabili".
4. **Dashboard**: il selettore Anno mostra 2023–2026 (default 2026); cambiando anno cambiano KPI e grafico spese; i consumi annui non sono più 0 per gas/acqua 2026.
5. **Andamento Prezzi** (il test principale): caricare **una o più bollette PDF reali** → controllare che Gemini estragga quota fissa/energia/prezzo unitario (visibili nel form pre-compilato e nel modal dettaglio) → la tab deve elencare le bollette con prezzo unitario e, dalla 2ª in poi, le variazioni %; provare a cambiare la **soglia**; verificare che l'avviso compaia in Verifica Anomalie e che cliccandolo si arrivi alla tab.
6. **Guardie Letture**: provare a inserire una lettura più bassa della precedente, o una data già esistente → devono comparire i confirm.

Piste aperte (non ancora fatte), per quando si riprende:
- **Backend come add-on di Home Assistant** (HA OS è un sistema chiuso: niente systemd libero) per non dipendere da un PC acceso. È il passo "serio" verso il deploy stabile, soprattutto se si vuole l'accesso da fuori via **DuckDNS + NGINX** (in tal caso instradare `/api` same-origin per evitare mixed-content/CORS).
- **IP statico del PC** sul router, altrimenti l'indirizzo backend nelle Impostazioni va riaggiornato se cambia.
- **Chiave Gemini**: gestita dall'utente su Google AI Studio; la vecchia chiave (non valida) resta nella storia git ma è inattiva. La chiave attiva vive in `secrets_local.py` (non versionato); su una macchina nuova si recupera dal NAS (`\\192.168.1.15\config\www\bollette\secrets_local.py`).
