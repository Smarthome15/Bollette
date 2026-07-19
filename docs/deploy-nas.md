# Deploy, NAS e sincronizzazione

> Dove gira l'app nella realtà, come i dati e il codice arrivano sul NAS, e come tutto degrada con grazia quando qualcosa è offline.

## Infrastruttura reale (rete)

- **HA / NAS = `192.168.1.15`** — Home Assistant OS su Raspberry Pi (~4 GB RAM). Dalla **bonifica /local del 19/07/2026** (vedi sotto): sulla porta **8123** HA serve SOLO il frontend statico (`/config/www/Bollette/static` → `/local/Bollette/static/index.html`, **senza autenticazione**); **codice backend, dati e segreti** vivono nell'area privata `/config/bollette_app`, non servita da HA. L'add-on locale esegue il backend sulla porta **8000** (vedi sezione sotto). Con l'add-on attivo il PC non serve più.
- **Backend Python su PC** (modalità sviluppo/riserva): avviato a mano con `run.bat`/`.venv`, IP DHCP (es. `192.168.1.165:8000`). Resta la macchina da cui si **pubblica il codice** sul NAS; al login scarica dal NAS anche una copia dei dati (rete di riserva).
- **Accesso da HA**: con l'add-on attivo → tutto (incluso l'inserimento PDF via Gemini: il frontend punta da solo a `<host>:8000`); con add-on fermo → solo login + errore dati (il vecchio ripiego "sola lettura dai JSON statici in /local" non esiste più: era la falla di sicurezza).

## Bonifica /local (19/07/2026) — perché i dati NON stanno in `www/`

Verifica di sicurezza di Jarvis (bacheca 19/07/2026): HA serve tutta `www/` come `/local/` **senza autenticazione**, e tramite l'add-on NGINX SSL proxy (porta 48443, DuckDNS) `/local` era raggiungibile **da internet** — chiave Gemini, password, `.git/`, bollette PDF e dati erano scaricabili da chiunque. Bonifica eseguita: tutto spostato in `/config/bollette_app` (404 da fuori, come le stanze interne di HA), in `www/Bollette` è rimasto solo `static/`, chiave Gemini rigenerata, password e `/api/login` rimossi, residui (`.git`, `.venv`, `ConsumiCasaPython/`) eliminati. Backup pre-bonifica: `backup_nas/bonifica_20260719/` sul PC. **Regola permanente: in `www/` non va MAI nulla di sensibile.**

## Backend come add-on Home Assistant (dall'11/07/2026)

Il backend gira come **add-on locale HA OS** direttamente sul Raspberry. I file dell'add-on vivono nel repo in `addon/bollette_backend/` (`config.yaml`, `Dockerfile`, `run.sh`, `README.md`) e si consegnano sul Pi con `addon/deploy_addon.ps1` (share `\\192.168.1.15\addons`; lo script copia anche il `requirements.txt` del repo e forza i fine-riga LF di `run.sh`). Installazione dalla UI di HA: *Impostazioni → Componenti aggiuntivi → Store → ⋮ → Verifica aggiornamenti → Bollette Backend → Installa*, poi chiave Gemini nelle **options** e Avvia.

Principi di funzionamento:

- **L'add-on è solo il runtime** (immagine `python:3.12-slim-bookworm` + dipendenze del `requirements.txt`): dalla v1.0.4 il codice dell'app gira da `/homeassistant/bollette_app` (area privata, la STESSA cartella aggiornata da "Pubblica su NAS"; i vecchi percorsi `www/` restano in `run.sh` solo come fallback transitorio). **Deploy del codice = Pubblica + Riavvia l'add-on** (nessuna ricostruzione). Se cambiano dipendenze/Dockerfile/run.sh: rieseguire `deploy_addon.ps1` e alzare `version` in `config.yaml` (l'add-on proporrà l'aggiornamento, con rebuild).
- **`BOLLETTE_ADDON=1`** (esportata da `run.sh`) attiva `MODALITA_ADDON` in `config.py`: `connessione_nas_attiva()` risponde sempre False (spegne mirroring dati e overlay conflitti — non c'è più un "remoto": i dati locali SONO quelli sul NAS), il confronto codice dichiara `stessa_radice` e `POST /api/app/publish` rifiuta con un messaggio chiaro (si pubblica dal PC). Senza il flag, i path UNC `\\192.168.1.15\...` di `config.py` su Linux verrebbero interpretati come **cartelle relative** creando directory spurie.
- **Chiave Gemini nelle options** dell'add-on → env `GEMINI_API_KEY`, già primo nella catena di lettura di `config.py`: sul NAS `secrets_local.py` non serve più.
- **Vincoli concordati con Jarvis** (bacheca inter-progetto, voce archiviata dell'11/07/2026): `boot: auto` + `watchdog` TCP sulla 8000; access-log disattivato (`--no-access-log`, siamo su microSD; anche `PYTHONDONTWRITEBYTECODE=1` per non sporcare `www` di `__pycache__`); porta 8000 verificata libera sul Pi.
- **Dati**: unica fonte di verità in `/config/bollette_app/database`, inclusa nei backup nativi HA. ⚠️ La catena backup del Pi (Google Drive Backup settimanale, 2 copie, ~1,5 GB liberi su Drive) è il punto debole segnalato da Jarvis: il PC che scarica dal NAS al login fa da copia di riserva aggiuntiva.
- **Diagnostica**: `GET http://192.168.1.15:8000/api/health` → `{ok, addon, gemini}` (`gemini: false` = chiave mancante nelle options); log dell'add-on nella sua scheda UI.
- ⚠️ **Maiuscole/minuscole**: sul filesystem del Pi la cartella pubblica del frontend è `www/Bollette` (**B maiuscola**), mentre l'area privata è `bollette_app` (tutta minuscola). Da Windows/SMB la differenza non si vede, ma **Linux è case-sensitive**: se si creano riferimenti lato Pi (URL `/local/...`, script), rispettare la grafia esatta.

## Due sincronizzazioni distinte (da non confondere)

### 1. Sincronizzazione DATI (i JSON)

Il backend specchia **ogni salvataggio** sul NAS via SMB (`DB_DIR_REMOTA` in `config.py`, `\\192.168.1.15\...`).

- `connessione_nas_attiva()` fa un check TCP rapido (porta 445) per non bloccarsi se il NAS è offline.
- Al login, `analizza_stato_sincronizzazione_utente()` (`GET /api/sync/status`) confronta i timestamp `mtime` locale vs remoto (tolleranza 2s) per ogni utenza/tipo. Esiti possibili: allineato, `solo_locale`, `solo_remoto`, `locale_piu_nuovo`, `remoto_piu_nuovo`.
- Se divergono, il frontend mostra l'**overlay di risoluzione conflitti**: si sceglie download o upload, per-file o globale (`POST /api/sync/resolve`).

### 2. Controllo e pubblicazione del CODICE (l'app stessa)

Distinto dai dati. Dalla bonifica /local la pubblicazione ha **due target**: il codice completo va nell'area privata `APP_DIR_REMOTA` (`\\192.168.1.15\config\bollette_app`), il SOLO `static/` va anche in `FRONTEND_DIR_REMOTA` (`\\192.168.1.15\config\www\Bollette`, la cartella pubblica `/local`).

- `GET /api/app/status` (`analizza_stato_applicazione`): confronto file-per-file (prima dimensione, poi hash MD5), **sola lettura**; controlla anche il frontend pubblico (voci `www:`) e segnala come `solo_remoto` qualunque file estraneo in `www/Bollette`. Esclude `database`, `.venv`, `.git`, `__pycache__`, `.claude`, `backup_nas` (vedi `APP_SYNC_ESCLUSI`). UI: riquadro in Impostazioni + banner al login.
- `POST /api/app/publish` (`pubblica_app_su_nas`): **specchio esatto** locale→NAS su entrambi i target (copia i diversi/nuovi, cancella gli extra — mai i dati; in `www/Bollette` elimina tutto ciò che non è `static/`). **Prima** salva un backup del codice NAS in `backup_nas/nas_<timestamp>/` (`_backup_codice_nas`, sottocartelle `app/` e `www/`); se il backup fallisce, **non pubblica**. Include `secrets_local.py` (solo area privata, MAI in www). Per sicurezza, se locale e remoto coincidono (l'app gira già dal NAS) la pubblicazione si interrompe senza fare nulla. UI: pulsante "Pubblica su NAS" con conferma.

> **Importante**: modificare il codice in locale (o pushare su GitHub) **non** aggiorna ciò che HA serve. Per rendere live le modifiche su Home Assistant serve **Impostazioni → Pubblica su NAS**.

## Storage mode e `apiBaseUrl`

- **`state.storageMode`** (in `localStorage`): `server` usa le API; `local` usa solo `localStorage` del browser (parsing PDF disattivato, scritture accodate).
- **`apiBaseUrl`** (`initSettings`): un indirizzo salvato in Impostazioni ha sempre la **precedenza** (es. per puntare al backend sul PC di sviluppo); pagina su porta 8000 → percorso relativo; **altrimenti (es. servito da HA su 8123) prova `<host>:8000`** — con il backend come add-on, HA e backend vivono sullo stesso host, quindi da HA funziona tutto senza configurare nulla. Se su `<host>:8000` nessuno risponde, `loadData()` tenta ancora i JSON statici, ma dalla bonifica /local non esistono più in `www/` → resta l'errore con hint rosso (scelta voluta). Pagina aperta da `file://` → resta relativo (fallback `localStorage`).

## No-cache del frontend

Il frontend è servito sempre con header **`Cache-Control: no-cache`** (meta tag in `index.html` + `NoCacheStaticMiddleware` nel backend, esclusi API e PDF). Senza, il browser — soprattutto la scheda dentro HA — continuerebbe a mostrare una `app.js` vecchia dopo un aggiornamento, perché il nome file non cambia. Con il no-cache, dopo aver **pubblicato il codice sul NAS** le modifiche compaiono senza dover svuotare la cache a mano (al più un refresh la prima volta sull'istanza HA, per scavalcare l'eventuale cache pre-esistente).

## Degradazione con grazia

- NAS offline (dal PC) → il backend PC lavora in solo-locale; il mirror riprende quando il NAS torna.
- Add-on fermo e PC spento → da HA (8123) si carica solo la pagina di login: i dati non sono leggibili finché un backend non riparte (la "sola lettura dai JSON statici" è stata rimossa con la bonifica /local: era la falla).
- In modalità add-on, sync e mirroring sono spenti per definizione (`MODALITA_ADDON`): niente overlay conflitti sul Pi.

## Accesso da fuori casa via NGINX (preparato l'11/07/2026, in attesa di attivazione)

Da pagina **HTTPS** (DuckDNS) il browser blocca le chiamate a `http://…:8000` (mixed content): la soluzione è pubblicare l'API **same-origin** sotto il dominio del proxy. Tutto è pronto, manca solo l'attivazione (verifica di Jarvis + "vai" di Matteo):

- **Snippet NGINX** in `addon/nginx/nginx_proxy_default_bollette.conf`: `location /bollette-api/ { proxy_pass http://192.168.1.15:8000/; … }` con `client_max_body_size 64m` (upload PDF) e `proxy_read_timeout 180s` (Gemini). Va copiato in `/share` e serve l'add-on NGINX in modalità `customize` + riavvio dell'add-on NGINX.
- **Frontend già pronto** (`initSettings`): su pagina HTTPS l'`apiBaseUrl` default è `/bollette-api` (same-origin); un indirizzo `http://…` salvato a mano viene **ignorato su pagina HTTPS** (non potrebbe comunque funzionare). Se la rotta NGINX non esiste ancora, si degrada in sola lettura come sempre.
- **Sicurezza — deciso l'11/07/2026** (bacheca, proposta Jarvis + approvazione Matteo): **letture da ovunque, scritture solo dalla LAN** — `limit_except GET HEAD { allow 192.168.1.0/24; deny all; }` nello snippet. Motivo: il dominio DuckDNS non è segreto (Certificate Transparency) e l'app non ha auth propria; senza blocco chiunque potrebbe scrivere i JSON o consumare quota Gemini via `/api/parse-pdf`. Da fuori l'app risulta "online" ma i salvataggi ricevono 403 (sola consultazione); il caricamento bollette si fa da casa. Se un giorno servisse scrivere da fuori: basic auth sulle scritture al posto del `deny`. NB collaudo: dal telefono in casa via DuckDNS la scrittura deve passare (hairpin NAT: l'origine vista da NGINX deve restare nella `/24`).

## Piste aperte sul deploy

- **Rafforzare la catena di backup** ora che il Pi è l'unica fonte di verità dei dati (segnalazione di Jarvis, 11/07/2026: Google Drive Backup settimanale ×2 copie, ~1,5 GB liberi su Drive; il PC che scarica al login è la riserva attuale).
- **Scrittura atomica dei JSON** (tmp + rename in `api_save_data`) — concordata con Jarvis, da fare al prossimo giro su `server.py` (poi Pubblica + riavvio add-on).
