# config.py
import os

# Percorso locale del database contenente i file JSON
DB_DIR_LOCALE = "database"

# Il percorso di rete SMB verso la cartella www di Home Assistant (NAS)
DB_DIR_REMOTA = r"\\192.168.1.15\config\www\bollette\database"

# Chiave API per l'integrazione con Gemini 2.5 Flash
API_KEY_GEMINI = "Ab8RN6ICTawIjNXzbtGxIj1gLUaBapxgl3leOFpCh0UJfgxLqw"

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
