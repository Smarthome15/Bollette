# config.py
import os

# Percorso locale del database contenente i file JSON
DB_DIR_LOCALE = "database"

# Il percorso di rete SMB verso l'area PRIVATA dell'app su Home Assistant (NAS).
# Dal 2026-07-19 i dati NON stanno più sotto www/: tutto ciò che è in www/ viene
# servito da HA come /local/ SENZA autenticazione (verificato esposto anche da
# internet via proxy NGINX porta 48443). In /config/bollette_app HA non serve
# nulla: i file sono raggiungibili solo via API del backend (porta 8000).
DB_DIR_REMOTA = r"\\192.168.1.15\config\bollette_app\database"

# La cartella PUBBLICA servita da HA come /local/Bollette: contiene SOLO il
# frontend statico (static/), nessun dato e nessun segreto.
FRONTEND_DIR_REMOTA = r"\\192.168.1.15\config\www\Bollette"

# --- Modalità ADD-ON (backend dentro Home Assistant OS sul Raspberry) ---
# Quando il backend gira come add-on HA (il run.sh dell'add-on esporta
# BOLLETTE_ADDON=1) NON esiste un "NAS remoto" da specchiare: la cartella dati
# locale È quella che dal PC chiamiamo remota. Il flag spegne sync/mirroring e
# neutralizza i percorsi UNC Windows qui sopra (che su Linux verrebbero
# interpretati come path RELATIVI, creando cartelle spurie "\\192.168.1.15\...").
MODALITA_ADDON = os.environ.get("BOLLETTE_ADDON", "") == "1"

# --- Percorsi per il confronto del CODICE dell'applicazione (locale vs NAS) ---
# Radice locale dell'app: la cartella che contiene questo config.py (robusto
# indipendentemente dalla cartella di lavoro da cui viene avviato il server).
APP_DIR_LOCALE = os.path.dirname(os.path.abspath(__file__))

# Radice dell'app "di produzione" sul NAS: è la cartella che contiene il
# database remoto, cioè \\192.168.1.15\config\www\bollette.
APP_DIR_REMOTA = os.path.dirname(DB_DIR_REMOTA)

# Cartelle/elementi da ESCLUDERE dal confronto del codice: dati, ambiente
# virtuale, metadati di versionamento, cache, configurazioni dell'assistente e
# i backup del NAS (non devono finire né nel confronto né nella copia).
# I nomi sono confrontati a livello di singolo segmento di path.
# 'install' e 'prepara_install.bat' servono a portare il backend su un altro PC:
# NON fanno parte dell'app servita da Home Assistant, quindi restano fuori dal NAS.
# 'addon' contiene i file dell'add-on HA: si consegna in \\NAS\addons (vedi
# addon/deploy_addon.ps1), non nella cartella www dell'app.
APP_SYNC_ESCLUSI = {"database", ".venv", ".git", "__pycache__", ".claude", ".idea", ".vscode", "backup_nas", "install", "prepara_install.bat", "addon"}

# Estensioni di file da ignorare sempre (rumore: bytecode, file temporanei).
APP_SYNC_EST_ESCLUSE = {".pyc", ".pyo", ".log", ".tmp"}

# Cartella locale dove salvare un backup del codice app presente sul NAS PRIMA
# di ogni pubblicazione (rete di sicurezza in caso di errore o ripensamento).
APP_BACKUP_DIR = os.path.join(APP_DIR_LOCALE, "backup_nas")

# Chiave API per l'integrazione con Gemini 2.5 Flash.
# NON va scritta qui (questo file è versionato). Viene letta, in ordine:
#   1) dalla variabile d'ambiente GEMINI_API_KEY;
#   2) dal file locale non versionato secrets_local.py (variabile API_KEY_GEMINI).
# Se non è disponibile resta vuota: l'app blocca l'estrazione PDF e avvisa,
# senza mai inventare dati.
API_KEY_GEMINI = os.environ.get("GEMINI_API_KEY", "")
if not API_KEY_GEMINI:
    try:
        from secrets_local import API_KEY_GEMINI as _SECRET_KEY  # type: ignore
        API_KEY_GEMINI = _SECRET_KEY or ""
    except ImportError:
        API_KEY_GEMINI = ""

# Configurazione utenti e profili database associati.
# NIENTE password: il login è la sola scelta del profilo, lato client
# (PROFILI_UTENTE in app.js). Le vecchie password in chiaro sono state rimosse
# il 2026-07-19 (bonifica /local): erano esposte e comunque non più usate.
UTENTI_CONFIG = {
    "Matteo": {"ruolo": "admin", "db_prefix": "UserA"},
    "Dario":  {"ruolo": "user",  "db_prefix": "UserB"},
    "Test":   {"ruolo": "user",  "db_prefix": "UserC"},
    "Test_2": {"ruolo": "user",  "db_prefix": "UserD"}
}

# Assicuriamoci che la cartella locale esista
if not os.path.exists(DB_DIR_LOCALE):
    os.makedirs(DB_DIR_LOCALE, exist_ok=True)

# Assicuriamoci che la cartella per i PDF salvati esista
PDF_DIR = os.path.join(DB_DIR_LOCALE, "pdfs")
if not os.path.exists(PDF_DIR):
    os.makedirs(PDF_DIR, exist_ok=True)
