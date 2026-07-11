# Deploy, NAS e sincronizzazione

> Dove gira l'app nella realtà, come i dati e il codice arrivano sul NAS, e come tutto degrada con grazia quando qualcosa è offline.

## Infrastruttura reale (rete)

- **HA / NAS = `192.168.1.15`** — Home Assistant OS su Raspberry Pi (~4 GB RAM). Serve l'app come file **statici** da `/config/www/bollette` sulla porta **8123** e — dall'11/07/2026 — esegue il **backend come add-on locale** sulla porta **8000** (vedi sezione sotto). Con l'add-on attivo il PC non serve più.
- **Backend Python su PC** (modalità sviluppo/riserva): avviato a mano con `run.bat`/`.venv`, IP DHCP (es. `192.168.1.165:8000`). Resta la macchina da cui si **pubblica il codice** sul NAS; al login scarica dal NAS anche una copia dei dati (rete di riserva).
- **Accesso da HA**: con l'add-on attivo → tutto (incluso l'inserimento PDF via Gemini: il frontend punta da solo a `<host>:8000`); con add-on fermo e PC spento → login + **sola lettura** dei dati statici serviti da HA.

## Backend come add-on Home Assistant (dall'11/07/2026)

Il backend gira come **add-on locale HA OS** direttamente sul Raspberry. I file dell'add-on vivono nel repo in `addon/bollette_backend/` (`config.yaml`, `Dockerfile`, `run.sh`, `README.md`) e si consegnano sul Pi con `addon/deploy_addon.ps1` (share `\\192.168.1.15\addons`; lo script copia anche il `requirements.txt` del repo e forza i fine-riga LF di `run.sh`). Installazione dalla UI di HA: *Impostazioni → Componenti aggiuntivi → Store → ⋮ → Verifica aggiornamenti → Bollette Backend → Installa*, poi chiave Gemini nelle **options** e Avvia.

Principi di funzionamento:

- **L'add-on è solo il runtime** (immagine `python:3.12-slim-bookworm` + dipendenze del `requirements.txt`): il codice dell'app gira da `/homeassistant/www/bollette`, cioè la STESSA cartella aggiornata da "Pubblica su NAS". **Deploy del codice = Pubblica + Riavvia l'add-on** (nessuna ricostruzione). Se cambiano dipendenze/Dockerfile/run.sh: rieseguire `deploy_addon.ps1` e alzare `version` in `config.yaml` (l'add-on proporrà l'aggiornamento, con rebuild).
- **`BOLLETTE_ADDON=1`** (esportata da `run.sh`) attiva `MODALITA_ADDON` in `config.py`: `connessione_nas_attiva()` risponde sempre False (spegne mirroring dati e overlay conflitti — non c'è più un "remoto": i dati locali SONO quelli sul NAS), il confronto codice dichiara `stessa_radice` e `POST /api/app/publish` rifiuta con un messaggio chiaro (si pubblica dal PC). Senza il flag, i path UNC `\\192.168.1.15\...` di `config.py` su Linux verrebbero interpretati come **cartelle relative** creando directory spurie.
- **Chiave Gemini nelle options** dell'add-on → env `GEMINI_API_KEY`, già primo nella catena di lettura di `config.py`: sul NAS `secrets_local.py` non serve più.
- **Vincoli concordati con Jarvis** (bacheca inter-progetto, voce archiviata dell'11/07/2026): `boot: auto` + `watchdog` TCP sulla 8000; access-log disattivato (`--no-access-log`, siamo su microSD; anche `PYTHONDONTWRITEBYTECODE=1` per non sporcare `www` di `__pycache__`); porta 8000 verificata libera sul Pi.
- **Dati**: unica fonte di verità in `/config/www/bollette/database`, inclusa nei backup nativi HA. ⚠️ La catena backup del Pi (Google Drive Backup settimanale, 2 copie, ~1,5 GB liberi su Drive) è il punto debole segnalato da Jarvis: il PC che scarica dal NAS al login fa da copia di riserva aggiuntiva.
- **Diagnostica**: `GET http://192.168.1.15:8000/api/health` → `{ok, addon, gemini}` (`gemini: false` = chiave mancante nelle options); log dell'add-on nella sua scheda UI.
- ⚠️ **Maiuscole/minuscole**: sul filesystem del Pi la cartella reale è `www/Bollette` (**B maiuscola**). Da Windows/SMB la differenza non si vede (per questo `\\192.168.1.15\config\www\bollette` funziona), ma **Linux è case-sensitive**: dentro il container il percorso giusto è `/homeassistant/www/Bollette`. Il `run.sh` dell'add-on prova entrambe le grafie; se si creano riferimenti nuovi lato Pi (URL `/local/...`, script), usare la B maiuscola.

## Due sincronizzazioni distinte (da non confondere)

### 1. Sincronizzazione DATI (i JSON)

Il backend specchia **ogni salvataggio** sul NAS via SMB (`DB_DIR_REMOTA` in `config.py`, `\\192.168.1.15\...`).

- `connessione_nas_attiva()` fa un check TCP rapido (porta 445) per non bloccarsi se il NAS è offline.
- Al login, `analizza_stato_sincronizzazione_utente()` (`GET /api/sync/status`) confronta i timestamp `mtime` locale vs remoto (tolleranza 2s) per ogni utenza/tipo. Esiti possibili: allineato, `solo_locale`, `solo_remoto`, `locale_piu_nuovo`, `remoto_piu_nuovo`.
- Se divergono, il frontend mostra l'**overlay di risoluzione conflitti**: si sceglie download o upload, per-file o globale (`POST /api/sync/resolve`).

### 2. Controllo e pubblicazione del CODICE (l'app stessa)

Distinto dai dati: confronta/pubblica i **file dell'app** (locale `APP_DIR_LOCALE` vs NAS `APP_DIR_REMOTA`, cioè `\\192.168.1.15\config\www\bollette`).

- `GET /api/app/status` (`analizza_stato_applicazione`): confronto file-per-file (prima dimensione, poi hash MD5), **sola lettura**. Esclude `database`, `.venv`, `.git`, `__pycache__`, `.claude`, `backup_nas` (vedi `APP_SYNC_ESCLUSI`). UI: riquadro in Impostazioni + banner al login.
- `POST /api/app/publish` (`pubblica_app_su_nas`): **specchio esatto** locale→NAS (copia i diversi/nuovi, cancella dal NAS gli extra — mai i dati). **Prima** salva un backup del codice NAS in `backup_nas/nas_<timestamp>/` (`_backup_codice_nas`); se il backup fallisce, **non pubblica**. Include `secrets_local.py`. Per sicurezza, se locale e remoto coincidono (l'app gira già dal NAS) la pubblicazione si interrompe senza fare nulla. UI: pulsante "Pubblica su NAS" con conferma.

> **Importante**: modificare il codice in locale (o pushare su GitHub) **non** aggiorna ciò che HA serve. Per rendere live le modifiche su Home Assistant serve **Impostazioni → Pubblica su NAS**.

## Storage mode e `apiBaseUrl`

- **`state.storageMode`** (in `localStorage`): `server` usa le API; `local` usa solo `localStorage` del browser (parsing PDF disattivato, scritture accodate).
- **`apiBaseUrl`** (`initSettings`): un indirizzo salvato in Impostazioni ha sempre la **precedenza** (es. per puntare al backend sul PC di sviluppo); pagina su porta 8000 → percorso relativo; **altrimenti (es. servito da HA su 8123) prova `<host>:8000`** — con il backend come add-on, HA e backend vivono sullo stesso host, quindi da HA funziona tutto senza configurare nulla. Se su `<host>:8000` nessuno risponde, `loadData()` degrada come sempre ai JSON statici serviti da HA (sola lettura, hint rosso sotto lo status). Pagina aperta da `file://` → resta relativo (fallback `localStorage`).

## No-cache del frontend

Il frontend è servito sempre con header **`Cache-Control: no-cache`** (meta tag in `index.html` + `NoCacheStaticMiddleware` nel backend, esclusi API e PDF). Senza, il browser — soprattutto la scheda dentro HA — continuerebbe a mostrare una `app.js` vecchia dopo un aggiornamento, perché il nome file non cambia. Con il no-cache, dopo aver **pubblicato il codice sul NAS** le modifiche compaiono senza dover svuotare la cache a mano (al più un refresh la prima volta sull'istanza HA, per scavalcare l'eventuale cache pre-esistente).

## Degradazione con grazia

- NAS offline (dal PC) → il backend PC lavora in solo-locale; il mirror riprende quando il NAS torna.
- Add-on fermo e PC spento → da HA (8123) si fa login e si leggono i dati statici; inserimento e PDF non disponibili finché uno dei due backend non riparte. L'app segnala lo stato "sola lettura".
- In modalità add-on, sync e mirroring sono spenti per definizione (`MODALITA_ADDON`): niente overlay conflitti sul Pi.

## Accesso da fuori casa via NGINX (preparato l'11/07/2026, in attesa di attivazione)

Da pagina **HTTPS** (DuckDNS) il browser blocca le chiamate a `http://…:8000` (mixed content): la soluzione è pubblicare l'API **same-origin** sotto il dominio del proxy. Tutto è pronto, manca solo l'attivazione (verifica di Jarvis + "vai" di Matteo):

- **Snippet NGINX** in `addon/nginx/nginx_proxy_default_bollette.conf`: `location /bollette-api/ { proxy_pass http://192.168.1.15:8000/; … }` con `client_max_body_size 64m` (upload PDF) e `proxy_read_timeout 180s` (Gemini). Va copiato in `/share` e serve l'add-on NGINX in modalità `customize` + riavvio dell'add-on NGINX.
- **Frontend già pronto** (`initSettings`): su pagina HTTPS l'`apiBaseUrl` default è `/bollette-api` (same-origin); un indirizzo `http://…` salvato a mano viene **ignorato su pagina HTTPS** (non potrebbe comunque funzionare). Se la rotta NGINX non esiste ancora, si degrada in sola lettura come sempre.
- ⚠️ **Sicurezza da decidere PRIMA di attivare**: l'app non ha autenticazione propria; con la rotta attiva le **scritture** diventano raggiungibili da chiunque conosca il dominio (oggi da fuori è esposta solo la lettura via `/local/`). Opzioni nello snippet: allowlist IP, basic auth, o accettare il rischio (dominio non pubblicizzato). Discussione in bacheca.

## Piste aperte sul deploy

- **Rafforzare la catena di backup** ora che il Pi è l'unica fonte di verità dei dati (segnalazione di Jarvis, 11/07/2026: Google Drive Backup settimanale ×2 copie, ~1,5 GB liberi su Drive; il PC che scarica al login è la riserva attuale).
- **Scrittura atomica dei JSON** (tmp + rename in `api_save_data`) — concordata con Jarvis, da fare al prossimo giro su `server.py` (poi Pubblica + riavvio add-on).
