# Architettura

> Visione d'insieme di come è fatta l'app. Per i dettagli: [modello-dati](modello-dati.md), [frontend](frontend.md), [flusso-pdf](flusso-pdf.md), [deploy-nas](deploy-nas.md).

## Due metà, una sola via di comunicazione

L'app è divisa in due parti che dialogano **solo via API REST JSON**. Non c'è framework frontend e non c'è build step.

- **Backend** — `server.py`: app [Starlette](https://www.starlette.io/) (ASGI) servita da `uvicorn`. Espone gli endpoint `/api/*`, monta i PDF archiviati su `/database/pdfs` e monta `static/` come root del sito. Il CORS è aperto a `*` di proposito, così Home Assistant (porta 8123) può chiamare le API del backend.
- **Frontend** — `static/`: `index.html` (markup e tab), `app.js` (tutta la logica, single-file, attorno a un oggetto globale `state`), `app.css`. Chart.js e Lucide arrivano da CDN.

Il backend **non genera HTML**: serve file statici e risponde JSON. Per aggiornare l'interfaccia basta modificare i file in `static/`.

## Il backend in breve

All'avvio `server.py`:
1. legge la configurazione da `config.py` (utenti, percorsi, esclusioni, chiave Gemini);
2. crea le cartelle `database/` e `database/pdfs/` se mancano;
3. apre il browser sulla home;
4. avvia uvicorn su `0.0.0.0:8000`.

### Endpoint `/api/*`

| Endpoint | Metodo | Cosa fa |
|---|---|---|
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
