# Frontend (tab e funzioni)

> Come è organizzata l'interfaccia. Tutto in `static/app.js` (single-file) attorno a un oggetto globale `state`, con markup in `static/index.html` e stile in `static/app.css`. Niente framework, niente build.

## L'oggetto `state`

È la fonte di verità lato client. Campi principali:

- `user` — profilo attivo (`{ username, ruolo, prefix }`); determina il `db_prefix` dei file dati.
- `data.bills` / `data.readings` — i record per utenza: `{ LUCE: [], GAS: [], ACQUA: [] }`.
- `charts` — istanze Chart.js attive (`spese`, `consumi`, `audit`, `prezzi`), distrutte e ricreate a ogni render.
- `activeTab` — la tab visibile; le funzioni `render*` escono subito se la loro tab non è attiva.
- `dashboardYear` — anno selezionato nella Dashboard (default = anno in corso).
- `storageMode` — `server` (usa le API) o `local` (solo `localStorage`, parsing PDF disattivato).
- `apiBaseUrl` — base delle API; relativa di default, impostabile a mano per l'uso da Home Assistant.

## Login e caricamento dati

- **Login senza password**: `handleLogin` + `PROFILI_UTENTE`. È tutto lato client, quindi funziona anche col backend spento. Il profilo scelto fissa il `prefix`.
- **`loadData`** scarica i dati dell'utente (o li legge da `localStorage` / dai JSON statici serviti da HA se il backend è offline) e li mette in `state.data`.
- Al login, `checkSyncAndLoad` confronta locale e NAS e, se divergono, mostra l'overlay di risoluzione conflitti (vedi [deploy-nas](deploy-nas.md)).

## Navigazione a tab

`switchTab(tabId)` cambia la sezione visibile e invoca la funzione di render giusta. Le 5 tab:

### 1. Dashboard — `renderDashboard`, `renderDashboardCharts`
Panoramica: KPI di spesa, grafici, ultime operazioni.
- **Filtro Anno** (`popolaSelettoreAnni`, `getAnniConDati`, `state.dashboardYear`): selettore popolato **solo con gli anni che hanno dati**, default = anno in corso. Filtra KPI spesa, trend e grafico "Andamento Spese Mensili" (gen→dic dell'anno scelto).
- **Trend a pari periodo**: per l'anno in corso confronta gen→mese corrente vs gli stessi mesi dell'anno prima; per un anno passato confronta l'anno intero vs quello precedente. Evita i crolli fittizi del confronto "anno parziale vs anno intero".
- **Consumo annuale "rilevato"**: calcolato dalle **autoletture** (non dalle bollette sparse), con ripartizione **pro-rata sui giorni** quando un intervallo è a cavallo d'anno.

### 2. Bollette PDF — `renderBillsTable`, `saveNewBill`, `prefillBillForm`, `openPdfModal`, `deleteBill`, `handlePdfSelected`
Storico bollette, inserimento (manuale o da PDF via Gemini), apertura del PDF e del dettaglio, eliminazione. Il flusso di estrazione PDF è descritto in [flusso-pdf](flusso-pdf.md).

### 3. Letture Manuali — `renderReadingsTable`, `saveNewReading`, `deleteReading`, `toggleUtilityFields`
Storico autoletture e inserimento (luce con F1/F2/F3, gas/acqua con valore unico). `saveNewReading` ha **guardie**:
- avviso se il totale luce ≠ F1+F2+F3;
- data duplicata → propone la **sostituzione** invece di creare un doppione;
- lettura non crescente → avviso (il contatore di norma cresce).
Inoltre, in modalità offline, accoda in "pending" la lettura realmente inserita (anche se arretrata).

### 4. Verifica Anomalie — `renderAuditTab`, `auditConsumoForBill`, helper di matching
Confronta, per ogni bolletta, il **consumo fatturato** col **consumo rilevato** dalle autoletture nello stesso periodo (matching per **mese**: differenza tra la lettura del mese di fine e quella del mese prima dell'inizio). Classifica ogni bolletta: Allineata / Sovrafatturata / Conguaglio atteso / Non verificabile. Mostra un avviso cliccabile che rimanda alla tab Andamento Prezzi quando ci sono variazioni di prezzo/consumo da controllare.

### 5. Andamento Prezzi — `renderPrezziTab`, `computePrezziVariazioni`, `renderPrezziChart`, `contaSegnalazioniPrezzi`, `getPrezziSoglia`
Confronta ogni bolletta con la **precedente della stessa utenza** su **prezzo unitario** (`prezzo_unitario_energia`) e **consumo**, evidenziando le variazioni oltre una **soglia regolabile** (default 15%). Considera **solo le bollette con prezzo unitario reale** (quelle estratte da PDF): niente stime sullo storico. Tabella delle variazioni + grafico dell'andamento del prezzo unitario nel tempo. `contaSegnalazioniPrezzi` alimenta il badge nella pagina Verifica Anomalie.

## Impostazioni e backup

- `initSettings` / `saveSettings`: storage mode e `apiBaseUrl`.
- `exportBackup` / `importBackup` (+ `validaBundleBackup`): l'import **sostituisce** (non unisce) i dati; per questo chiede conferma esplicita e **valida** il bundle e i record **prima** di toccare `state.data`, così un file corrotto non lascia lo stato a metà.
- Controllo e pubblicazione del **codice** sul NAS: vedi [deploy-nas](deploy-nas.md).

## Regola sui campi estratti dal PDF

Aggiungere un campo estratto da Gemini significa toccare **4 punti coerenti** (prompt backend, input HTML, prefill, save) + la visualizzazione nel modal. Dettagli in [flusso-pdf](flusso-pdf.md).
