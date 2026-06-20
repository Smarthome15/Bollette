# Deploy, NAS e sincronizzazione

> Dove gira l'app nella realtà, come i dati e il codice arrivano sul NAS, e come tutto degrada con grazia quando qualcosa è offline.

## Infrastruttura reale (rete)

- **HA / NAS = `192.168.1.15`** — Home Assistant OS su Raspberry Pi. Serve l'app come file **statici** da `/config/www/bollette` sulla porta **8123**. **Non esegue Python.**
- **Backend Python = su un PC della LAN** (es. `192.168.1.11:8000`), avviato a mano con `run.bat`/`.venv`. Previsti ~3 PC, ognuno col **proprio profilo/dati** (file separati per `db_prefix`), quindi nessuna sovrascrittura tra loro. Il backend **non è un servizio**: vive finché la finestra di `run.bat` resta aperta.
- **Accesso da HA**: col PC acceso → tutto (incluso l'inserimento PDF via Gemini); col PC spento → login + **sola lettura** dei dati statici serviti da HA.

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
- **`apiBaseUrl`** (`initSettings`): se l'utente ha salvato un indirizzo in Impostazioni lo usa; se la pagina è su porta 8000 resta relativo; **altrimenti (es. servito da HA su 8123) resta relativo** e non assume più `<host>:8000`. Per inserire/salvare da HA va impostato a mano l'indirizzo del PC dove gira il backend (es. `http://192.168.1.11:8000`); se non impostato e il backend non risponde, `loadData()` legge i JSON statici serviti da HA (sola lettura).

## Degradazione con grazia

- NAS offline → il backend lavora in solo-locale; il mirror riprende quando il NAS torna.
- Backend (PC) spento → da HA si fa login e si leggono i dati statici; inserimento e PDF non disponibili finché il PC non è riacceso.

## Piste aperte sul deploy

- **Backend come add-on di Home Assistant** (HA OS è chiuso: niente systemd libero), per non dipendere da un PC acceso — passo "serio" verso un deploy stabile, soprattutto per l'accesso da fuori via **DuckDNS + NGINX** (in tal caso instradare `/api` same-origin per evitare mixed-content/CORS).
- **IP statico del PC** sul router, altrimenti l'indirizzo backend in Impostazioni va riaggiornato a ogni cambio.
