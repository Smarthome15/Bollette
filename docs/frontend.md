# Frontend (tab e funzioni)

> Come è organizzata l'interfaccia. Tutto in `static/app.js` (single-file) attorno a un oggetto globale `state`, con markup in `static/index.html` e stile in `static/app.css`. Niente framework, niente build.

## L'oggetto `state`

È la fonte di verità lato client. Campi principali:

- `user` — profilo attivo (`{ username, ruolo, prefix }`); determina il `db_prefix` dei file dati.
- `data.bills` / `data.readings` — i record per utenza: `{ LUCE: [], GAS: [], ACQUA: [] }`.
- `charts` — istanze Chart.js attive (`spese`, `consumi`, `consumiMensili`, `audit`, `prezzi`), distrutte e ricreate a ogni render.
- `activeTab` — la tab visibile; le funzioni `render*` escono subito se la loro tab non è attiva.
- `dashboardYear` — anno selezionato nella Dashboard (default = anno in corso).
- `billDateFrom`/`billDateTo`, `readingDateFrom`/`readingDateTo` — filtri intervallo date delle tabelle Bollette e Letture.
- `editingBill`/`editingReading` — `{utility, index}` del record in modifica (null = inserimento nuovo).
- `storageMode` — `server` (usa le API) o `local` (solo `localStorage`, parsing PDF disattivato).
- `apiBaseUrl` — base delle API; relativa di default, impostabile a mano per l'uso da Home Assistant.

## Login e caricamento dati

- **Login senza password**: `handleLogin` + `PROFILI_UTENTE`. È tutto lato client, quindi funziona anche col backend spento. Il profilo scelto fissa il `prefix`.
- **`loadData`** scarica i dati dell'utente (o li legge da `localStorage` / dai JSON statici serviti da HA se il backend è offline) e li mette in `state.data`.
- Al login, `checkSyncAndLoad` confronta locale e NAS e, se divergono, mostra l'overlay di risoluzione conflitti (vedi [deploy-nas](deploy-nas.md)).

## Principio fondamentale: periodo di competenza, NON data di emissione

Ciò che conta in ogni grafico/KPI è il **periodo di fatturazione/rilevamento**, non la `data` di emissione o inserimento del record (quella serve solo a sapere *quando* è stata fatta l'operazione). Una bolletta emessa il 4 giugno ma che copre maggio deve pesare su **maggio**.

- **Bollette**: il mese/anno di competenza si ricava da `meseCompetenzaBolletta(bill)` / `annoCompetenzaBolletta(bill)` = mese di `periodo_fine`, con **fallback alla `data`** se il periodo manca (record storici). Usato da: grafico Spese Mensili, KPI spesa/trend, KPI per utenza, ordinamento della tab Andamento Prezzi, audit.
- **Letture manuali**: il periodo **è il mese di rilievo** (la data della lettura). La colonna "Periodo" nella tabella Letture mostra il mese di rilievo (`meseDiRilievo`, es. "Marzo 2026"); i consumi mensili/annuali si calcolano per differenza tra letture, quindi sono già ancorati al mese di rilievo.
- La `data` resta usata SOLO dove è corretto: ordinamento tabelle, deduplica per data, "Ultime operazioni", sincronizzazione.

> Quando aggiungi un nuovo grafico/aggregazione sulle bollette, usa SEMPRE `meseCompetenzaBolletta`/`annoCompetenzaBolletta`, mai `new Date(bill.data)`.

## Navigazione a tab

`switchTab(tabId)` cambia la sezione visibile e invoca la funzione di render giusta. Le 6 tab:

### 1. Dashboard — `renderDashboard`, `renderDashboardCharts`
Panoramica: promemoria dati mancanti, KPI di spesa, grafici, ultime operazioni.
- **Filtro Anno** (`popolaSelettoreAnni`, `getAnniConDati`, `state.dashboardYear`): selettore popolato **solo con gli anni che hanno dati**, default = anno in corso. Filtra KPI spesa, trend e i due grafici mensili (gen→dic dell'anno scelto).
- **Promemoria "dati da inserire"** (`renderDatiMancanti`, `bollettaMancante`, `mesiLettureMancanti`): riquadro in cima alla Dashboard, visibile solo se manca qualcosa. Avvisa quando l'ultima bolletta di un'utenza è più vecchia della soglia, e quando mancano letture mensili. Le **soglie sono configurabili per utenza** in Impostazioni (vedi sotto), default bollette 3 / letture 1 mese.
- **Trend a pari periodo**: per l'anno in corso confronta gen→mese corrente vs gli stessi mesi dell'anno prima; per un anno passato confronta l'anno intero vs quello precedente. Evita i crolli fittizi del confronto "anno parziale vs anno intero". Calcolato per **competenza** (vedi principio sopra).
- **Grafico "Andamento Spese Mensili"** — spesa per mese dell'anno selezionato, attribuita al mese di **competenza** della bolletta.
- **Grafico "Andamento Consumi Mensili"** (`state.charts.consumiMensili`) — consumo per mese dell'anno selezionato, dalle **autoletture** (differenza tra lettura del mese e mese-base precedente); 3 utenze a barre affiancate (unità diverse: kWh/SMC/m³).
- **Grafico "Consumo Storico Annuale"** — dalle autoletture, ripartizione **pro-rata sui giorni** a cavallo d'anno. Include anche **Rifiuti/TARI** come **spesa annua in €** (barra verde, anno di competenza via `annoCompetenzaBolletta`, stesso criterio del KPI): non avendo contatore non ha un consumo, ma così il rincaro della tassa resta confrontabile anno su anno.

### 2. Bollette PDF — `renderBillsTable`, `saveNewBill`, `prefillBillForm`, `openPdfModal`, `editBill`, `deleteBill`, `handlePdfSelected`
Storico bollette, inserimento (manuale o da PDF via Gemini), apertura del PDF e del dettaglio, **modifica** ed eliminazione. La tabella ha una colonna **Periodo** (inizio→fine, helper `formattaPeriodo`), un **filtro intervallo date** (dal/al + Azzera, helper `filtraPerIntervallo`) oltre al filtro per utenza, e una colonna **Azioni** con i pulsanti Modifica/Elimina.
- **Modifica** (`editBill`, `state.editingBill = {utility, index}`): riusa lo stesso pannello di inserimento, pre-compilato; titolo e pulsante diventano "Modifica…/Salva Modifiche". `saveNewBill` aggiorna il record esistente invece di crearne uno nuovo (e sposta tra utenze se l'utenza viene cambiata). In modifica **il PDF allegato resta quello esistente**, non si ricarica. `resetBillForm`/chiusura pannello azzerano `editingBill`.

Il flusso di estrazione PDF è descritto in [flusso-pdf](flusso-pdf.md).

### 3. Letture Manuali — `renderReadingsTable`, `saveNewReading`, `editReading`, `annullaModificaLettura`, `deleteReading`, `toggleUtilityFields`
Storico autoletture e inserimento (luce con F1/F2/F3, gas/acqua con valore unico). La tabella ha una colonna **Periodo = mese di rilievo** (`meseDiRilievo`, es. "Marzo 2026"), lo stesso **filtro intervallo date** delle bollette, e una colonna **Azioni** con Modifica/Elimina. `saveNewReading` ha **guardie**:
- avviso se il totale luce ≠ F1+F2+F3;
- data duplicata → propone la **sostituzione** invece di creare un doppione;
- lettura non crescente → avviso (il contatore di norma cresce).
- **Modifica** (`editReading`, `state.editingReading = {utility, index}`): pre-compila il form (sempre visibile), mostra "Annulla modifica" e cambia il pulsante in "Salva Modifiche"; al salvataggio aggiorna il record. Le guardie **escludono il record in modifica** (niente falso allarme "data duplicata" su sé stesso).

Inoltre, in modalità offline, accoda in "pending" la lettura realmente inserita (anche se arretrata).

### 4. Verifica Anomalie — `renderAuditTab`, `auditConsumoForBill`, helper di matching
Confronta, per ogni bolletta, il **consumo fatturato** col **consumo rilevato** dalle autoletture nello stesso periodo (matching per **mese**: differenza tra la lettura del mese di fine e quella del mese prima dell'inizio). Classifica ogni bolletta: Allineata / Sovrafatturata / Conguaglio atteso / Non verificabile. Mostra un avviso cliccabile che rimanda alla tab Andamento Prezzi quando ci sono variazioni di prezzo/consumo da controllare.

### 5. Andamento Prezzi — `renderPrezziTab`, `computePrezziVariazioni`, `renderPrezziChart`, `contaSegnalazioniPrezzi`, `getPrezziSoglia`
Confronta ogni bolletta con la **precedente della stessa utenza** su **prezzo unitario** (`prezzo_unitario_energia`) e **consumo**, evidenziando le variazioni oltre una **soglia regolabile** (default 15%). Considera **solo le bollette con prezzo unitario reale** (quelle estratte da PDF): niente stime sullo storico. Tabella delle variazioni + grafico dell'andamento del prezzo unitario nel tempo. `contaSegnalazioniPrezzi` alimenta il badge nella pagina Verifica Anomalie.

### 6. Confronto Periodi — `renderConfrontoTab`, `mesiDelPeriodo`, `consumoPeriodo`, `consumoPerMese`, `renderConfrontoChart`, `renderConfrontoMensileChart`
Confronta il **consumo** di due periodi della stessa durata. Selettori: **durata** (1/3/6/12 mesi), **Periodo A** e **Periodo B** (mese-anno d'inizio, `<input type="month">`), **soglia "simile"** regolabile (default 10%). Mostra **solo il consumo** dalle autoletture (la spesa dipende dalle bollette, non sempre presenti, quindi è stata esclusa): per ogni utenza consumo A vs B con variazione % ed esito (Simile/In aumento/In calo). Tre output: tabella, grafico totale per utenza (`state.charts.confronto`), e **3 grafici mese-per-mese** uno per utenza (`confrontoLuce/Gas/Acqua`) con asse X = posizione nel periodo (1° mese, 2° mese, …) così A e B sono allineabili anche se partono da mesi diversi.

## Impostazioni e backup

- `initSettings` / `saveSettings`: storage mode e `apiBaseUrl`.
- **Soglie promemoria dati** (`getSoglieDati`, `saveSoglieDati`): per ogni utenza, dopo quanti mesi senza bolletta o lettura la Dashboard segnala il dato mancante. Salvate in `localStorage` (`consumicasa_soglie_dati`), default da `SOGLIE_DATI_DEFAULT` (bollette 3 / letture 1). Valori mancanti/corrotti ricadono sul default.
- `exportBackup` / `importBackup` (+ `validaBundleBackup`): l'import **sostituisce** (non unisce) i dati; per questo chiede conferma esplicita e **valida** il bundle e i record **prima** di toccare `state.data`, così un file corrotto non lascia lo stato a metà.
- **Avviso indirizzo backend mancante** (`updateBackendStatusBadge`): quando l'app è in sola lettura HA (`ha-static`) e il campo indirizzo backend è vuoto, compaiono (a) un avviso arancione sotto il campo in Impostazioni (`api-url-mancante-alert`) e (b) un hint rosso sotto lo status in basso a sinistra (`status-readonly-hint`). Spiegano perché si è in sola lettura e cosa fare.
- Controllo e pubblicazione del **codice** sul NAS: vedi [deploy-nas](deploy-nas.md).

## Colori delle utenze

I colori "ufficiali" delle utenze sono variabili CSS in `app.css` (`--color-luce/gas/acqua` + `-glow`): **Luce gialla, Gas arancione (`#f97316`), Acqua blu (`#3b82f6`)**. Sono usati da: KPI Dashboard (via classi `.kpi-card.gas/.acqua`), i tre grafici (colori passati a Chart.js in `app.js`), e i **badge utenza** nelle tabelle (classi `.badge-luce/gas/acqua`, assegnate dalla helper `badgeUtenzaClass(utility)`). Per cambiare un colore di utenza, modifica la variabile CSS e i colori corrispondenti nei dataset Chart.js.

## Icone di aiuto nelle tabelle

Ogni intestazione di colonna (`<th>`) ha un'icona **ⓘ** (`span.th-help`) con un tooltip nativo (`title`) che spiega cosa contiene la colonna. Tecnica volutamente leggera: nessun JS, funziona ovunque (anche dentro HA). Le descrizioni riflettono il comportamento reale del software (es. su "Data Bolletta" ricorda che per i grafici conta il Periodo, non la data).

## Layout su schermi stretti (app companion / telefono) — anti-overflow

Su un telefono (es. app companion di Home Assistant) un contenuto largo — una tabella, un canvas, una "parola" senza spazi come un percorso NAS o un nome file PDF — propaga la sua **larghezza minima** su per la catena flex/grid e allarga card e pagina oltre lo schermo: il layout si dimensiona sulle scritte. Le regole (blocco "ANTI-OVERFLOW" in `app.css`, stessa tecnica dell'app F.A.M.ilia):

- **Ogni anello della catena deve poter restringersi**: `min-width: 0` su `.content-area` (figlio flex), sui figli diretti delle grid (`.charts-grid > *`, `.split-view > *`, `.grid-2-1 > *`, `.kpi-grid > *` — i track `1fr` non scendono sotto il contenuto senza questo) e su `.form-group`.
- **Le tabelle scorrono nel proprio contenitore**: ogni `<table class="data-table">` va avvolta in un `<div class="table-responsive">` (`overflow-x: auto`); è la tabella a scorrere, mai la pagina ad allargarsi.
- **Testi senza spazi si spezzano**: `overflow-wrap: anywhere` su `code`, `.help-text` e `.details-val` (nel modal dettaglio i valori lunghi tipo nomi file vanno a capo invece di allargare il modal).
- **Media dentro i limiti**: `iframe, canvas, img { max-width: 100% }`.
- **A ≤768px le righe di form si impilano**: `.form-row` diventa colonna (i `.col-3/4/6` passano a `width: 100%`), perché più input date/number affiancati non ci stanno. Eccezione: le righe con classe **`form-row-compact`** (la griglia soglie in Impostazioni) restano affiancate perché formano una tabellina con riga di intestazione.
- Sempre a ≤768px: nav a **barra orizzontale scorrevole** (`white-space: nowrap` sui bottoni), padding ridotti (card, celle tabella, `.modal`), titoli più piccoli. `.filter-group` e `.audit-summary-badges` hanno `flex-wrap: wrap` a ogni larghezza.
- Gli overlay a schermo intero (`.login-panel`, usato anche dal conflitto sync) hanno `overflow-y: auto` + `margin: auto` sulla card: se il contenuto è più alto dello schermo si scorre, non si taglia.

> Quando aggiungi una sezione nuova: se introduce una grid con track `1fr`, dai `min-width: 0` ai figli; se mostra testo "macchina" (path, URL, nomi file), dagli `overflow-wrap: anywhere`; se è una tabella, avvolgila in `.table-responsive`. Verifica a ~360px di larghezza.

## No-cache (niente versioni vecchie nel browser)

Per evitare che il browser (anche servito da HA) mostri una `app.js`/`app.css` vecchia dopo un aggiornamento: meta `Cache-Control: no-cache` nell'`<head>` di `index.html` **e** middleware `NoCacheStaticMiddleware` nel backend che aggiunge gli header no-cache a HTML/JS/CSS (esclusi API e PDF). Vedi [deploy-nas](deploy-nas.md).

## Regola sui campi estratti dal PDF

Aggiungere un campo estratto da Gemini significa toccare **4 punti coerenti** (prompt backend, input HTML, prefill, save) + la visualizzazione nel modal. Dettagli in [flusso-pdf](flusso-pdf.md).
