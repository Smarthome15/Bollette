# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Cos'è

App per tracciare i consumi domestici (luce / gas / acqua / rifiuti): caricamento bollette PDF con estrazione dati via IA, letture manuali mensili dei contatori, dashboard con grafici (con **filtro per anno**, spese mensili, consumi mensili e confronto annuale) e **promemoria dei dati mancanti**, una scheda di audit che confronta i consumi **fatturati vs rilevati**, e una scheda **Andamento Prezzi** che confronta bollette consecutive per scovare rincari tariffari o variazioni di consumo. Le utenze sono **4**: luce, gas, acqua (con contatore/consumo) e **rifiuti/TARI** (una tassa: solo bollette periodo+importo, niente contatore). Pensata per essere servita anche da Home Assistant e usata da telefono/PC. Lingua del codice e dell'UI: italiano.

Le 6 tab del frontend: **Dashboard**, **Bollette PDF**, **Letture Manuali**, **Verifica Anomalie** (audit fatturato vs rilevato), **Andamento Prezzi** (variazioni prezzo/consumo tra bollette), **Confronto Periodi** (consumo di due periodi a confronto, mese per mese).

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
- **RIFIUTI (TARI) — 4ª utenza solo-bollette**: è una tassa, quindi ha solo `data`, `periodo_inizio`, `periodo_fine`, `fattura`, `note` (gli altri campi restano `null`). **Niente contatore, consumo, letture manuali**: NON esiste `UserA_man_rifiuti.json`, e `state.data.readings` resta a 3 utenze. RIFIUTI è incluso in: tab Bollette, Dashboard (KPI verde "Rifiuti/TARI", spesa nel grafico spese mensili, **spesa annua € nel grafico Consumo Storico Annuale**, ultime operazioni), promemoria bollette (soglia default 12 mesi). È **escluso** da: Letture, Verifica Anomalie, Andamento Prezzi, Confronto consumi e grafico Consumi Mensili (nel Consumo Storico Annuale compare, ma come **spesa €**, non consumo). Colore **verde `#22c55e`** (`--color-rifiuti`, `badge-rifiuti`).
- **Periodo sulle bollette storiche**: le bollette importate dall'Excel non avevano `periodo_inizio`/`periodo_fine`/`consumo_fatturato`; sono stati popolati a posteriori (periodo dedotto dalla bolletta precedente; `consumo_fatturato` = "MtC fatturati" Excel per il gas, = consumo rilevato dalle letture per luce/acqua). Anche i record di **lettura** che cadono sulla data di una bolletta hanno ora `periodo_inizio`/`periodo_fine` (campi "passeggeri" ignorati dal resto dell'app).
- **Distinzione chiave**: `lettura` / `lettura_totale` sono il valore **progressivo del contatore**; `consumo_fatturato` è il **consumo del periodo dichiarato in bolletta**. Il consumo per-periodo nei grafici è invece calcolato a runtime per **differenza tra letture consecutive** (`.diff()` lato JS) — quindi le letture devono essere cronologiche e crescenti.
- **Periodo di competenza, NON data (principio fondamentale)**: nelle aggregazioni (grafici/KPI) ciò che conta è il **periodo di fatturazione/rilevamento**, non la `data` di emissione/inserimento (che dice solo *quando* è avvenuta l'operazione). Per le **bollette** la competenza = mese di `periodo_fine` (fallback `data` se manca): usare sempre gli helper `meseCompetenzaBolletta`/`annoCompetenzaBolletta` in `app.js`, mai `new Date(bill.data)`. Per le **letture** la competenza = mese di rilievo (la `data` della lettura). La `data` resta usata solo per ordinamento, deduplica, "ultime operazioni" e sync.

### Flusso di estrazione PDF (solo Gemini, nessun fallback)

`POST /api/parse-pdf` → `pdfplumber` estrae il testo → `parse_pdf_gemini` (Gemini `gemini-2.5-flash`, output JSON). **Non c'è alcun fallback euristico**: `parse_pdf_heuristics` è stata rimossa apposta (le sue regex davano dati sbagliati ma plausibili — testato sulle bollette Iren reali, ~14% di accuratezza vs ~100% di Gemini). Se Gemini non è disponibile (chiave assente o irraggiungibile) l'endpoint risponde **`503` con `error: "gemini_non_disponibile"`** e nessun dato; il frontend (`handlePdfSelected`) **blocca l'inserimento del PDF e avvisa**, invece di pre-compilare con valori inaffidabili. Scelta esplicita: meglio nessun dato che dati sbagliati. `parsed_via` vale sempre `"gemini"` quando va a buon fine. Oltre ai campi base, il prompt estrae anche `quota_fissa`, `quota_energia`, `prezzo_unitario_energia` (scomposizione costi, usata dalla tab Andamento Prezzi). I dati estratti **pre-compilano** il form, non vengono salvati direttamente. **Se si aggiunge un campo estratto, va aggiornato in 4 punti coerenti**: il prompt in `parse_pdf_gemini` (`server.py`), l'`<input>` nel form bolletta (`index.html`), `prefillBillForm()` e `saveNewBill()` in `app.js`, e (per visualizzarlo nel modal) `openPdfModal()`. **Naming**: la chiave del JSON Gemini deve essere identica alla chiave del record e all'attributo letto in `prefillBillForm` (es. `prezzo_unitario_energia` ovunque) per evitare rimappature e bug silenziosi.

### Dashboard, Andamento Prezzi e guardie (frontend)

- **Dashboard — filtro Anno** (`renderDashboard`, `popolaSelettoreAnni`, `getAnniConDati`, `state.dashboardYear`): selettore in alto a destra popolato **solo con gli anni che hanno dati**, default = anno in corso. Filtra KPI spesa, trend e i grafici mensili (gen→dic dell'anno scelto). Il trend confronta a **pari periodo** (year-to-date per l'anno in corso, anno intero per gli anni passati). Spese e KPI sono attribuiti al **periodo di competenza** della bolletta (vedi principio sopra), non alla data.
- **Dashboard — grafici** : "Andamento Spese Mensili" (per competenza), "Andamento Consumi Mensili" (`state.charts.consumiMensili`, dalle autoletture, 3 utenze a barre affiancate) e "Consumo Storico Annuale" (autoletture, ripartizione pro-rata sui giorni a cavallo d'anno; **+ barra verde Rifiuti/TARI = spesa annua €** per anno di competenza, unica serie possibile per una tassa senza contatore).
- **Dashboard — promemoria dati mancanti** (`renderDatiMancanti`, `bollettaMancante`, `mesiLettureMancanti`; box `dati-mancanti-box`): riquadro in cima, visibile solo se manca qualcosa. Avvisa quando l'ultima bolletta supera la soglia o quando mancano letture mensili. **Soglie configurabili per utenza** in Impostazioni (`getSoglieDati`/`saveSoglieDati`, localStorage `consumicasa_soglie_dati`, default bollette 3 / letture 1).
- **Tabelle Bollette e Letture** (`renderBillsTable`, `renderReadingsTable`): colonna **Periodo** (bollette: inizio→fine via `formattaPeriodo`; letture: mese di rilievo via `meseDiRilievo`) + **filtro intervallo date** dal/al (`filtraPerIntervallo`, stato `billDateFrom/To`, `readingDateFrom/To`) oltre al filtro per utenza. Colonna **Azioni** con Modifica/Elimina: **modifica** (`editBill`/`editReading`, stato `editingBill`/`editingReading`) riusa il form di inserimento pre-compilato e aggiorna il record invece di crearne uno nuovo; in modifica bolletta il PDF allegato resta quello esistente; le guardie letture escludono il record in modifica.
- **Colori utenze e badge** (`app.css` variabili `--color-luce/gas/acqua/rifiuti`, helper `badgeUtenzaClass`): Luce gialla, **Gas arancione `#f97316`**, **Acqua blu `#3b82f6`**, **Rifiuti verde `#22c55e`**. Usati da KPI, grafici (colori in `app.js`) e badge utenza colorati nelle tabelle (`.badge-luce/gas/acqua/rifiuti`).
- **No-cache** (meta in `index.html` + `NoCacheStaticMiddleware` in `server.py`): il frontend è servito con `Cache-Control: no-cache` (escl. API e PDF) per non mostrare versioni vecchie di app.js/app.css dopo un aggiornamento.
- **Tab Confronto Periodi** (`renderConfrontoTab`, `consumoPeriodo`, `consumoPerMese`; `state.charts.confronto/confrontoLuce/Gas/Acqua`): confronta il **consumo** (dalle autoletture) di due periodi della stessa durata (1/3/6/12 mesi), con soglia "simile" regolabile (default 10%). Tabella per utenza + grafico totale + 3 grafici mese-per-mese (asse X = posizione nel periodo). Solo consumo: la spesa è esclusa perché dipende dalle bollette non sempre presenti.
- **Icone di aiuto colonne** (`span.th-help` + `title`, stile in `app.css`): ogni `<th>` ha una ⓘ con tooltip che spiega la colonna; tecnica nativa, nessun JS.
- **Anti-overflow mobile (app companion)**: blocco "ANTI-OVERFLOW" in `app.css` — `min-width: 0` su tutta la catena flex/grid (`.content-area`, figli di `charts-grid`/`split-view`/`grid-2-1`/`kpi-grid`, `.form-group`), `overflow-wrap: anywhere` su `code`/`.help-text`/`.details-val`, `max-width: 100%` su iframe/canvas/img, `flex-wrap` su `.filter-group` e badge; a ≤768px le `.form-row` si impilano (eccetto `.form-row-compact`, es. griglia soglie) e la nav diventa barra orizzontale scorrevole. Senza queste regole una "parola" larga (percorso NAS, nome PDF, tabella) allarga la pagina oltre lo schermo del telefono. Dettagli in `docs/frontend.md`.
- **Tab Andamento Prezzi** (`renderPrezziTab`, `computePrezziVariazioni`, `renderPrezziChart`, `contaSegnalazioniPrezzi`, `getPrezziSoglia`; `state.charts.prezzi`): confronta ogni bolletta con la precedente della stessa utenza (ordinate per **competenza**) su **prezzo unitario** (`prezzo_unitario_energia`) e **consumo**, segnalando le variazioni oltre una **soglia regolabile** (input `prezzi-soglia`, default 15%). Considera **solo le bollette con `prezzo_unitario_energia` reale** (quindi quelle future via PDF): niente stime sullo storico. Il prezzo unitario è gestito a **3 decimali** ovunque (prefill arrotonda, input `step=0.001`, modal e tabella `.toFixed(3)`). La pagina **Verifica Anomalie** mostra un avviso cliccabile (`audit-prezzi-alert`) "N variazioni da controllare" che rimanda qui.
- **Guardie pagina Letture** (`saveNewReading`): avviso se il totale luce ≠ F1+F2+F3, se la data è duplicata (propone sostituzione), o se la lettura non è crescente. Fix accodamento pending offline per letture arretrate (parametro `recordModificato` di `saveUtilityData`).
- **Import backup sicuro** (`importBackup`, `validaBundleBackup`): conferma esplicita (sostituisce, non unisce), validazione del bundle e dei record **prima** di toccare lo stato.

### Chiave Gemini (fuori dal codice versionato)

`config.py` legge `API_KEY_GEMINI` in ordine da: (1) variabile d'ambiente `GEMINI_API_KEY`; (2) file locale **`secrets_local.py`** (non versionato, vedi `.gitignore`) con `API_KEY_GEMINI = "..."`. Se nessuna è presente resta vuota → l'app blocca l'estrazione PDF. Sul NAS la chiave arriva perché `secrets_local.py` è incluso nella pubblicazione (vedi sotto).

### Login (senza password) e Storage mode

- **Login**: si sceglie solo il profilo, **senza password** (`handleLogin` + `PROFILI_UTENTE` in `app.js`). È tutto lato client, quindi funziona anche col backend spento. Il profilo determina il `prefix` dei file dati. (L'endpoint `/api/login` esiste ancora ma non è più usato dal frontend.)
- **`state.storageMode`** (salvato in `localStorage`): `server` usa le API; `local` usa solo `localStorage` del browser (parsing PDF disattivato, scritture accodate).
- **`apiBaseUrl`** (`initSettings`): se l'utente ha salvato un indirizzo in Impostazioni lo usa; se la pagina è su porta 8000 resta relativo; **altrimenti (es. servito da HA su 8123) resta relativo** e NON assume più `<host>:8000` (che puntava erroneamente al NAS). Per inserire/salvare da HA va impostato a mano l'indirizzo del PC dove gira il backend (es. `http://192.168.1.165:8000`, IP reale attuale — DHCP, può cambiare); se non impostato e il backend non risponde, `loadData()` legge i JSON statici serviti da HA (sola lettura) e l'app mostra un **avviso** (in Impostazioni + hint rosso sotto lo status) che spiega come configurare l'indirizzo.

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
- **Bacheca inter-progetto** (`C:\Dev\Jarvis\collab\bacheca.md`, regole ed elenco partecipanti in testa al file — oggi: Jarvis, Bollette, F.A.M.ilia): quando una decisione o un piano di questo progetto tocca il Raspberry/Home Assistant o interessa gli altri progetti (es. il backend come add-on HA), va scritta una voce lì; a inizio lavoro controllare se ci sono risposte (`STATO: RISPOSTA`) alle voci di Bollette. Comando rapido: `/bacheca`. Mai committare nel repo Jarvis (lì lavora un'altra sessione).

## Infrastruttura reale (rete)

- **HA / NAS = `192.168.1.15`** (Home Assistant OS su Raspberry Pi). Serve l'app come file **statici** da `/config/www/bollette` sulla porta **8123**; **NON esegue Python**.
- **Backend Python = su un PC della LAN** (IP reale attuale `192.168.1.165:8000`, via DHCP → può cambiare al riavvio), avviato a mano con `run.bat`/`.venv`. Previsti ~3 PC, ognuno col **proprio profilo/dati** (file separati per `db_prefix`), quindi nessuna sovrascrittura tra loro. Il backend **non è un servizio**: vive finché la finestra di `run.bat` resta aperta.
- Accesso da HA: col PC acceso → tutto (incl. inserimento PDF via Gemini); col PC spento → login + **sola lettura** dei dati statici serviti da HA.

## Stato attuale e prossimi passi (giugno 2026)

Fatto e in produzione (committato su `main`, pubblicato sul NAS): scheda Audit fatturato vs rilevato (matching mensile); controllo/pubblicazione codice app; estrazione PDF solo-Gemini con blocco offline; chiave fuori dal codice; login senza password; `apiBaseUrl` corretto per HA; `run.bat` migliorato.

### Già su GitHub `main` (pushato)

Dashboard filtro Anno + fix trend/consumi; import backup sicuro; guardie Letture (commit `5b6f1d1`). Nuova tab **Andamento Prezzi** + estrazione `quota_fissa`/`quota_energia`/`prezzo_unitario_energia` da Gemini, e documentazione `docs/` (commit `f301de2`). **Dati UserA sul NAS** già aggiornati: correzione luce F1 31/12/2024 (333→339, tot 1086); periodi/`consumo_fatturato` popolati su tutte le bollette storiche. Backup in `backup_nas/` (`fix_luce_F1_…`, `fix_audit_periodi_…`).

### Lavori del 21/06/2026 — IN LOCALE, da testare e poi committare/pubblicare

Non ancora committati (`static/app.js`, `static/index.html`, `static/app.css`, `server.py`, doc): 
- **Dashboard**: grafico **Consumi Mensili**; riquadro **promemoria dati mancanti** con **soglie configurabili per utenza** (Impostazioni).
- **Tabelle Bollette/Letture**: colonna **Periodo** + **filtro intervallo date** + **pulsante Modifica** (oltre a Elimina) che riusa il form di inserimento.
- **Fix concettuale importante**: grafici e KPI ora usano il **periodo di competenza** (non la `data` di emissione) — vedi principio nel modello dati. 
- **Prezzo unitario** uniformato a **3 decimali** (era 4: l'input lo rifiutava).
- **Colori utenze**: Gas → arancione `#f97316`, Acqua → blu `#3b82f6`; badge utenza colorati nelle tabelle.
- **No-cache** del frontend (meta + middleware `server.py`) per non vedere versioni vecchie dopo gli aggiornamenti.
- **Avviso "indirizzo backend mancante"** quando si è in sola lettura HA (Impostazioni + hint rosso sotto lo status); IP reale del PC = `192.168.1.165`.
→ Da committare e poi **pubblicare su NAS** (Impostazioni → Pubblica): codice locale e quello servito da HA divergono. NB: questa tornata tocca anche `server.py` (no-cache), quindi va riavviato il backend.

### Checklist di test

1. **Avvio**: `run.bat` o `server.py`; verificare che il `.venv` esista e che `secrets_local.py` sia presente (estrazione PDF attiva).
2. **Login + sync**: login come Matteo → scaricare dal NAS → i dati compaiono.
3. **Verifica Anomalie**: in maggioranza "Allineate" (gas 1 "Sovrafatturata" a giugno 2025); non più tutte "Non verificabili".
4. **Dashboard**: selettore Anno 2023–2026 (default 2026); cambiando anno cambiano KPI e i due grafici mensili (spese + consumi); riquadro promemoria mostra gas/acqua bolletta mancante e letture apr/mag 2026 mancanti; cambiare le soglie in Impostazioni e verificare che il promemoria si aggiorni.
5. **Andamento Prezzi** (test principale): caricare **bollette PDF reali** → Gemini estrae quota fissa/energia/prezzo unitario (form + modal); la tab elenca le bollette con prezzo unitario e le variazioni %; cambiare la **soglia**; avviso in Verifica Anomalie cliccabile.
6. **Periodo di competenza**: una bolletta emessa in un mese ma che copre il mese precedente deve pesare sul mese del **periodo** nel grafico spese, non sul mese di emissione.
7. **Tabelle**: colonna Periodo (bollette inizio→fine; letture "mese di rilievo") e filtro date dal/al + Azzera.
8. **Guardie Letture**: lettura più bassa della precedente o data duplicata → confirm.
9. **Modifica record**: pulsante Modifica su una bolletta → il form si pre-compila, salvando aggiorna (non duplica); idem su una lettura (con "Annulla modifica").
10. **Colori**: gas arancione, acqua blu, luce gialla — coerenti in KPI, grafici e badge utenza nelle tabelle.

Piste aperte (non ancora fatte), per quando si riprende:
- **Backend come add-on di Home Assistant** (HA OS è un sistema chiuso: niente systemd libero) per non dipendere da un PC acceso. È il passo "serio" verso il deploy stabile, soprattutto se si vuole l'accesso da fuori via **DuckDNS + NGINX** (in tal caso instradare `/api` same-origin per evitare mixed-content/CORS).
- **IP statico del PC** sul router, altrimenti l'indirizzo backend nelle Impostazioni va riaggiornato se cambia.
- **Chiave Gemini**: gestita dall'utente su Google AI Studio; la vecchia chiave (non valida) resta nella storia git ma è inattiva. La chiave attiva vive in `secrets_local.py` (non versionato); su una macchina nuova si recupera dal NAS (`\\192.168.1.15\config\www\bollette\secrets_local.py`).
