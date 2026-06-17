# config.py
import os

# Percorso locale del database contenente i file JSON
DB_DIR_LOCALE = "database"

# Il percorso di rete SMB verso la cartella www di Home Assistant (NAS)
DB_DIR_REMOTA = r"\\192.168.1.15\config\www\bollette\database"

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
APP_SYNC_ESCLUSI = {"database", ".venv", ".git", "__pycache__", ".claude", ".idea", ".vscode", "backup_nas"}

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

# Configurazione utenti e profili database associati
UTENTI_CONFIG = {
    "Matteo": {"password": "passwordmatteo", "ruolo": "admin", "db_prefix": "UserA"},
    "Dario":  {"password": "passworddario",  "ruolo": "user",  "db_prefix": "UserB"},
    "Test":   {"password": "passwordtest",   "ruolo": "user",  "db_prefix": "UserC"},
    "Test_2": {"password": "passwordtest2",  "ruolo": "user",  "db_prefix": "UserD"}
}

# Assicuriamoci che la cartella locale esista
if not os.path.exists(DB_DIR_LOCALE):
    os.makedirs(DB_DIR_LOCALE, exist_ok=True)

# Assicuriamoci che la cartella per i PDF salvati esista
PDF_DIR = os.path.join(DB_DIR_LOCALE, "pdfs")
if not os.path.exists(PDF_DIR):
    os.makedirs(PDF_DIR, exist_ok=True)
