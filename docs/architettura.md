# Architettura

> Visione d'insieme di come è fatta l'app. Per i dettagli: [modello-dati](modello-dati.md), [frontend](frontend.md), [flusso-pdf](flusso-pdf.md), [deploy-nas](deploy-nas.md).

## Due metà, una sola via di comunicazione

L'app è divisa in due parti che dialogano **solo via API REST JSON**. Non c'è framework frontend e non c'è build step.

- **Backend** — `server.py`: app [Starlette](https://www.starlette.io/) (ASGI) servita da `uvicorn`. Espone gli endpoint `/api/*`, monta i PDF archiviati su `/database/pdfs` e monta `static/` come root del sito. Il CORS è aperto a `*` di proposito, così Home Assistant (porta 8123) può chiamare le API del backend. Dalla **bonifica accessi (26/07/2026)** tutte le rotte API e i PDF esigono l'header **`X-Bollette-Key`** (middleware `ChiaveAccessoMiddleware`; eccezioni: `/api/health`, muto, e il frontend statico) — dettagli in [deploy-nas](deploy-nas.md).
- **Frontend** — `static/`: `index.html` (markup e tab), `app.js` (tutta la logica, single-file, attorno a un oggetto globale `state`), `app.css`. Librerie e caratteri sono file locali in `static/vendor/` (vedi sotto): la pagina non carica nulla da internet.

Il backend **non genera HTML**: serve file statici e risponde JSON. Per aggiornare l'interfaccia basta modificare i file in `static/`.

## Librerie di terzi: `static/vendor/`

Dal 02/10/2026 la pagina **non carica nulla da internet** (prima: Chart.js e Lucide da CDN senza versione, PDF.js da CDN, caratteri da Google Fonts). Due motivi: il codice di terzi che gira nella pagina con la chiave K dev'essere un file fermo, e in casa la pagina deve funzionare con internet giù.

`static/vendor/` è una copia del `vendor/` del **kit grafico di Jarvis v1.1.0** (`C:\Dev\Jarvis\collab\kit-grafico\`, regole nel suo README). I file non si modificano; per aggiornarli si chiede in bacheca una versione nuova del kit e si ricopia la cartella.

| File | Pacchetto e versione | Licenza | SHA-256 |
|---|---|---|---|
| `chart.umd.min.js` | `chart.js` 4.5.1 | MIT | `48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a` |
| `lucide.min.js` | `lucide` 1.50.0 | ISC | `46fb2edd30cbe171a17d01279cb794183fbe76cd823ae891fc9d912fd838d38b` |
| `pdf.min.js` | `pdfjs-dist` 3.11.174 | Apache 2.0 | `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946` |
| `pdf.worker.min.js` | `pdfjs-dist` 3.11.174 | Apache 2.0 | `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b` |
| `caratteri/inter-latin-wght-normal.woff2` | `@fontsource-variable/inter` 5.3.0 | OFL 1.1 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `caratteri/outfit-latin-wght-normal.woff2` | `@fontsource-variable/outfit` 5.3.0 | OFL 1.1 | `6c18d579fd87c3776be068b762cbc83fde3acb543d49eabd3ade842eb987e887` |

- **Dove sono usati**: i due `<script>` in `index.html`; i due `@font-face` in testa ad `app.css`; `caricaPdfJs` in `app.js` (PDF.js si carica solo alla prima apertura di un PDF).
- **Percorsi relativi** (`vendor/…`, mai `/vendor/…`): la stessa pagina vive su `:8000` e sotto `/local/Bollette/static/`.
- **Fine riga**: `.gitattributes` (`static/vendor/** -text`) tiene i file byte per byte; con `autocrlf` git li cambierebbe e gli SHA non tornerebbero. Dopo una copia, ricontrollarli con `sha256sum`.
- **Pubblicazione**: la cartella sta in `static/`, quindi finisce anche in `www/Bollette/static/` (pubblica). Sono librerie pubbliche: nessun dato, nessun segreto.

## Il backend in breve

All'avvio `server.py`:
1. legge la configurazione da `config.py` (utenti, percorsi, esclusioni, chiave Gemini);
2. crea le cartelle `database/` e `database/pdfs/` se mancano;
3. apre il browser sulla home;
4. avvia uvicorn su `0.0.0.0:8000`.

### Endpoint `/api/*`

Tutti (tranne `/api/health`) richiedono l'header `X-Bollette-Key`: senza → 401; server senza chiave configurata → 503 su tutto (fail-closed).

| Endpoint | Metodo | Cosa fa |
|---|---|---|
| `/api/health` | GET | Vivo/morto per il watchdog dell'add-on: `{"ok": true}` e nient'altro. Unica rotta **senza chiave**, per questo muta. |
| `/api/data` | GET | Legge i record di un'utenza. Parametri: `user`, `utility` (LUCE/GAS/ACQUA), `type` (`bollette`/`manual`). |
| `/api/save` | POST | Sovrascrive l'**intero array** di record di un'utenza (non un delta) e lo specchia sul NAS. |
| `/api/upload-pdf` | POST | Archivia un PDF in `database/pdfs/` e restituisce il `pdf_path` da salvare nel record. |
| `/api/parse-pdf` | POST | Estrae il testo del PDF e lo passa a Gemini per ricavare i dati della bolletta. Vedi [flusso-pdf](flusso-pdf.md). |
| `/api/sync/status` | GET | Confronta i dati locali col NAS (per utente) e segnala conflitti. |
| `/api/sync/resolve` | POST | Risolve un conflitto (download/upload, per-file o globale). |
| `/api/app/status` | GET | Confronta il **codice** dell'app locale vs NAS (sola lettura). |
| `/api/app/publish` | POST | Pubblica il codice locale sul NAS (specchio esatto, con backup preventivo). |

I dettagli di sincronizzazione dati e pubblicazione codice sono in [deploy-nas](deploy-nas.md).

## Il ruolo di `config.py`

Centralizza la configurazione, **senza la chiave Gemini** (che vive fuori dal codice versionato — vedi [flusso-pdf](flusso-pdf.md)):

- **`UTENTI_CONFIG`** — per ogni utente: ruolo e `db_prefix` (es. `Matteo → UserA`), usato per anonimizzare i nomi dei file dati.
- **Percorsi** — `DB_DIR_LOCALE`, `DB_DIR_REMOTA` (NAS via SMB), `PDF_DIR`, `APP_DIR_LOCALE`/`APP_DIR_REMOTA` (radici del codice per il confronto locale↔NAS).
- **Esclusioni** — `APP_SYNC_ESCLUSI` (cartelle come `.git`, `database`, `.venv`, `backup_nas`) e `APP_SYNC_EST_ESCLUSE` (estensioni come `.pyc`, `.tmp`): proteggono dati e artefatti durante la pubblicazione del codice.

## Persistenza: file JSON, niente database

Non c'è un DBMS. I dati sono file JSON in `database/`, uno per ogni combinazione utente × utenza × tipo. Ogni salvataggio riscrive l'intero array. Dettagli in [modello-dati](modello-dati.md).
