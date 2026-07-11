# server.py
import os
import json
import uuid
import re
import socket
import shutil
import hashlib
import traceback
from datetime import datetime
import webbrowser
import uvicorn
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.requests import Request
from starlette.responses import JSONResponse, HTMLResponse, FileResponse
from starlette.staticfiles import StaticFiles
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import pdfplumber

from config import (
    UTENTI_CONFIG, API_KEY_GEMINI, DB_DIR_LOCALE, PDF_DIR, DB_DIR_REMOTA,
    APP_DIR_LOCALE, APP_DIR_REMOTA, APP_SYNC_ESCLUSI, APP_SYNC_EST_ESCLUSE,
    APP_BACKUP_DIR, MODALITA_ADDON
)

# --- UTILITIES DI SINCRONIZZAZIONE NAS ---
def connessione_nas_attiva():
    # In modalità add-on il backend GIRA sul NAS: non c'è nessun "remoto" da
    # specchiare, e i percorsi UNC di config.py su Linux sarebbero interpretati
    # come path relativi (cartelle spurie). Tutti i flussi di sync degradano
    # quindi al comportamento "NAS offline", che è già gestito ovunque.
    if MODALITA_ADDON:
        return False

    ip_nas = "192.168.1.15"
    porta_samba = 445  # Porta standard SMB
    timeout_secondi = 2.0  # Timeout rapido per non piantare il server
    try:
        with socket.create_connection((ip_nas, porta_samba), timeout=timeout_secondi):
            pass
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False

    if not os.path.exists(DB_DIR_REMOTA):
        try:
            os.makedirs(DB_DIR_REMOTA, exist_ok=True)
            return True
        except:
            return False
    return True

def get_filename_only(username: str, utility: str, is_manual: bool):
    if username not in UTENTI_CONFIG:
        return None
    prefix = UTENTI_CONFIG[username]["db_prefix"]
    suffix = "_man" if is_manual else ""
    return f"{prefix}{suffix}_{utility.lower()}.json"

def analizza_stato_sincronizzazione_utente(utente: str):
    if not connessione_nas_attiva():
        return False, {"stato": "offline", "dettagli": {}}

    richiede_risoluzione = False
    report = {"stato": "online", "dettagli": {}}

    for utenza in ["LUCE", "GAS", "ACQUA", "RIFIUTI"]:
        # RIFIUTI è una tassa: solo bollette, nessun file di letture manuali (_man).
        modalita = [False] if utenza == "RIFIUTI" else [False, True]
        for is_manual in modalita:
            nome_file = get_filename_only(utente, utenza, is_manual)
            path_locale = os.path.join(DB_DIR_LOCALE, nome_file)
            path_remoto = os.path.join(DB_DIR_REMOTA, nome_file)

            loc_exists = os.path.exists(path_locale)
            rem_exists = os.path.exists(path_remoto)

            key_name = f"{utenza}{'_MAN' if is_manual else ''}"
            info_utenza = {
                "locale_data": "Nessun dato",
                "remoto_data": "Nessun dato",
                "stato_confronto": "allineato",
                "filename": nome_file
            }

            if loc_exists:
                info_utenza["locale_data"] = datetime.fromtimestamp(os.path.getmtime(path_locale)).strftime('%d/%m/%Y %H:%M:%S')
            if rem_exists:
                info_utenza["remoto_data"] = datetime.fromtimestamp(os.path.getmtime(path_remoto)).strftime('%d/%m/%Y %H:%M:%S')

            if loc_exists and rem_exists:
                time_loc = int(os.path.getmtime(path_locale))
                time_rem = int(os.path.getmtime(path_remoto))
                
                # Tolleranza di 2 secondi per difetti di file system diversi
                if abs(time_loc - time_rem) > 2:
                    if time_loc > time_rem:
                        info_utenza["stato_confronto"] = "locale_piu_nuovo"
                        richiede_risoluzione = True
                    else:
                        info_utenza["stato_confronto"] = "remoto_piu_nuovo"
                        richiede_risoluzione = True
            elif loc_exists and not rem_exists:
                info_utenza["stato_confronto"] = "solo_locale"
                richiede_risoluzione = True
            elif not loc_exists and rem_exists:
                info_utenza["stato_confronto"] = "solo_remoto"
                richiede_risoluzione = True

            report["dettagli"][key_name] = info_utenza

    return richiede_risoluzione, report

def esegui_azione_sincronizzazione(utente: str, azione: str, chiave_specifica: str = None):
    if not connessione_nas_attiva():
        return False, "NAS non raggiungibile."
    
    if chiave_specifica:
        chiavi = [chiave_specifica]
    else:
        chiavi = ["LUCE", "LUCE_MAN", "GAS", "GAS_MAN", "ACQUA", "ACQUA_MAN", "RIFIUTI"]
        
    try:
        for chiave in chiavi:
            parts = chiave.split("_")
            utenza = parts[0]
            is_manual = len(parts) > 1 and parts[1] == "MAN"
            
            nome_file = get_filename_only(utente, utenza, is_manual)
            path_locale = os.path.join(DB_DIR_LOCALE, nome_file)
            path_remoto = os.path.join(DB_DIR_REMOTA, nome_file)

            if azione == 'upload':
                if os.path.exists(path_locale):
                    shutil.copy2(path_locale, path_remoto)
            elif azione == 'download':
                if os.path.exists(path_remoto):
                    shutil.copy2(path_remoto, path_locale)
        return True, "Sincronizzazione completata."
    except Exception as e:
        return False, f"Errore sync: {e}"

# --- CONFRONTO DEL CODICE DELL'APPLICAZIONE (locale vs NAS) ---
# Verifica se la copia "di produzione" dell'app sul NAS è allineata a quella
# locale. Sola lettura: non copia nulla. Pensato per girare anche su Raspberry,
# quindi confronta prima la DIMENSIONE (economico) e calcola l'hash del contenuto
# SOLO quando le dimensioni coincidono (evita I/O inutile su file già diversi).

def _path_escluso(rel_path: str):
    # Esclude se un qualsiasi segmento della path relativa è nella lista,
    # o se l'estensione del file è tra quelle ignorate.
    parti = rel_path.replace("\\", "/").split("/")
    for p in parti:
        if p in APP_SYNC_ESCLUSI:
            return True
    _, ext = os.path.splitext(rel_path)
    if ext.lower() in APP_SYNC_EST_ESCLUSE:
        return True
    return False

def _elenca_file_app(root: str):
    # Restituisce un dict { path_relativa(posix): (dimensione, mtime) } per tutti
    # i file sotto 'root', saltando le cartelle/estensioni escluse. Tollerante:
    # se 'root' non esiste o non è leggibile, ritorna un dict vuoto.
    risultato = {}
    if not root or not os.path.isdir(root):
        return risultato
    for dirpath, dirnames, filenames in os.walk(root):
        # Pota le cartelle escluse in-place così os.walk non vi scende dentro.
        dirnames[:] = [d for d in dirnames if d not in APP_SYNC_ESCLUSI]
        for nome in filenames:
            full = os.path.join(dirpath, nome)
            rel = os.path.relpath(full, root).replace("\\", "/")
            if _path_escluso(rel):
                continue
            try:
                st = os.stat(full)
                risultato[rel] = (st.st_size, st.st_mtime)
            except OSError:
                # File sparito o non accessibile durante la scansione: ignora.
                continue
    return risultato

def _hash_file(path: str, blocchi=65536):
    # MD5 a blocchi: sufficiente per il controllo di integrità (non crittografico)
    # e leggero in memoria. Ritorna None se il file non è leggibile.
    h = hashlib.md5()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(blocchi), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None

def analizza_stato_applicazione():
    # Confronta APP_DIR_LOCALE con APP_DIR_REMOTA file per file.
    # Ritorna (richiede_attenzione, report). Lo stato per ciascun file è uno di:
    #   identico / diverso / solo_locale / solo_remoto.

    # Modalità add-on: l'app in esecuzione È la copia "di produzione" sul NAS.
    # Equivale al caso stessa_radice: niente da confrontare, nessuna attenzione.
    if MODALITA_ADDON:
        return False, {
            "stato": "online",
            "stessa_radice": True,
            "remoto_presente": True,
            "dettagli": [],
            "riepilogo": {"identici": 0, "diversi": 0, "solo_locale": 0, "solo_remoto": 0}
        }

    if not connessione_nas_attiva():
        return False, {"stato": "offline", "dettagli": [], "riepilogo": {}}

    # Caso particolare: l'app gira già dal NAS (locale == remoto) -> tutto allineato.
    try:
        stessa_radice = os.path.normcase(os.path.abspath(APP_DIR_LOCALE)) == \
                        os.path.normcase(os.path.abspath(APP_DIR_REMOTA))
    except Exception:
        stessa_radice = False

    if stessa_radice or not os.path.isdir(APP_DIR_REMOTA):
        return False, {
            "stato": "online",
            "stessa_radice": stessa_radice,
            "remoto_presente": os.path.isdir(APP_DIR_REMOTA),
            "dettagli": [],
            "riepilogo": {"identici": 0, "diversi": 0, "solo_locale": 0, "solo_remoto": 0}
        }

    locali = _elenca_file_app(APP_DIR_LOCALE)
    remoti = _elenca_file_app(APP_DIR_REMOTA)

    tutte_le_path = sorted(set(locali.keys()) | set(remoti.keys()))
    dettagli = []
    conteggi = {"identici": 0, "diversi": 0, "solo_locale": 0, "solo_remoto": 0}
    richiede_attenzione = False

    for rel in tutte_le_path:
        in_loc = rel in locali
        in_rem = rel in remoti

        info = {"file": rel, "stato": "identico", "locale_data": "-", "remoto_data": "-"}
        if in_loc:
            info["locale_data"] = datetime.fromtimestamp(locali[rel][1]).strftime('%d/%m/%Y %H:%M:%S')
        if in_rem:
            info["remoto_data"] = datetime.fromtimestamp(remoti[rel][1]).strftime('%d/%m/%Y %H:%M:%S')

        if in_loc and not in_rem:
            info["stato"] = "solo_locale"
            conteggi["solo_locale"] += 1
            richiede_attenzione = True
        elif in_rem and not in_loc:
            info["stato"] = "solo_remoto"
            conteggi["solo_remoto"] += 1
            richiede_attenzione = True
        else:
            size_loc = locali[rel][0]
            size_rem = remoti[rel][0]
            if size_loc != size_rem:
                # Dimensioni diverse: sicuramente diverso, niente hash.
                info["stato"] = "diverso"
                conteggi["diversi"] += 1
                richiede_attenzione = True
            else:
                # Stessa dimensione: confronta l'hash del contenuto.
                h_loc = _hash_file(os.path.join(APP_DIR_LOCALE, rel))
                h_rem = _hash_file(os.path.join(APP_DIR_REMOTA, rel))
                if h_loc is not None and h_loc == h_rem:
                    info["stato"] = "identico"
                    conteggi["identici"] += 1
                else:
                    info["stato"] = "diverso"
                    conteggi["diversi"] += 1
                    richiede_attenzione = True

        dettagli.append(info)

    report = {
        "stato": "online",
        "stessa_radice": False,
        "remoto_presente": True,
        "app_dir_locale": APP_DIR_LOCALE,
        "app_dir_remota": APP_DIR_REMOTA,
        "dettagli": dettagli,
        "riepilogo": conteggi
    }
    return richiede_attenzione, report

def _backup_codice_nas():
    # Salva in locale (APP_BACKUP_DIR/nas_<timestamp>/) una copia del codice app
    # attualmente presente sul NAS, PRIMA di sovrascriverlo. Rete di sicurezza.
    # Restituisce (ok, percorso_backup_o_messaggio_errore).
    remoti = _elenca_file_app(APP_DIR_REMOTA)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest_root = os.path.join(APP_BACKUP_DIR, f"nas_{timestamp}")
    try:
        os.makedirs(dest_root, exist_ok=True)
        for rel in remoti.keys():
            src = os.path.join(APP_DIR_REMOTA, rel)
            dst = os.path.join(dest_root, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
        return True, dest_root
    except Exception as e:
        return False, f"Errore durante il backup del NAS: {e}"

def pubblica_app_su_nas():
    # Pubblica (specchio esatto) il CODICE dell'app da locale verso il NAS:
    # copia i file nuovi/diversi e CANCELLA dal NAS quelli non più presenti in locale.
    # Rispetta le esclusioni (database/, .venv/, .git/, __pycache__/, ...): i DATI
    # non vengono mai toccati. Prima di scrivere salva un backup locale del NAS.
    # Restituisce (successo, report_azioni).

    # Modalità add-on: l'app gira già dalla cartella sul NAS. La pubblicazione
    # del codice si fa dal PC di sviluppo (che vede il NAS via SMB), non da qui.
    if MODALITA_ADDON:
        return False, {"errore": "L'app gira già sul NAS (add-on Home Assistant): la pubblicazione del codice si fa dal PC di sviluppo."}

    if not connessione_nas_attiva():
        return False, {"errore": "NAS non raggiungibile."}

    # Sicurezza: non pubblicare se l'app gira già dal NAS (locale == remoto).
    try:
        stessa_radice = os.path.normcase(os.path.abspath(APP_DIR_LOCALE)) == \
                        os.path.normcase(os.path.abspath(APP_DIR_REMOTA))
    except Exception:
        stessa_radice = False
    if stessa_radice:
        return False, {"errore": "L'app gira già dalla cartella sul NAS: nessuna pubblicazione necessaria."}

    if not os.path.isdir(APP_DIR_REMOTA):
        try:
            os.makedirs(APP_DIR_REMOTA, exist_ok=True)
        except Exception as e:
            return False, {"errore": f"Impossibile creare la cartella remota: {e}"}

    # 0) BACKUP del codice attualmente sul NAS, prima di toccare qualsiasi cosa.
    #    Se il backup fallisce, NON procediamo: meglio non aggiornare che farlo
    #    senza rete di sicurezza.
    backup_ok, backup_info = _backup_codice_nas()
    if not backup_ok:
        return False, {"errore": backup_info}

    locali = _elenca_file_app(APP_DIR_LOCALE)
    remoti = _elenca_file_app(APP_DIR_REMOTA)

    copiati = []
    cancellati = []
    errori = []

    # 1) Copia da locale -> NAS i file nuovi o diversi (per dimensione o hash).
    for rel in locali.keys():
        src = os.path.join(APP_DIR_LOCALE, rel)
        dst = os.path.join(APP_DIR_REMOTA, rel)
        try:
            serve_copia = True
            if rel in remoti and locali[rel][0] == remoti[rel][0]:
                # Stessa dimensione: copia solo se l'hash differisce.
                if _hash_file(src) == _hash_file(dst):
                    serve_copia = False
            if serve_copia:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                copiati.append(rel)
        except Exception as e:
            errori.append({"file": rel, "azione": "copia", "errore": str(e)})

    # 2) Specchio esatto: cancella dal NAS i file (di codice app) non più in locale.
    #    _elenca_file_app già esclude database/ e affini, quindi i DATI non compaiono qui.
    for rel in remoti.keys():
        if rel in locali:
            continue
        dst = os.path.join(APP_DIR_REMOTA, rel)
        try:
            os.remove(dst)
            cancellati.append(rel)
        except Exception as e:
            errori.append({"file": rel, "azione": "cancellazione", "errore": str(e)})

    report = {
        "backup_dir": backup_info,
        "copiati": copiati,
        "cancellati": cancellati,
        "errori": errori,
        "n_copiati": len(copiati),
        "n_cancellati": len(cancellati),
        "n_errori": len(errori)
    }
    return (len(errori) == 0), report

# Funzione per recuperare il nome del file JSON
def get_json_filepath(username: str, utility: str, is_manual: bool):
    if username not in UTENTI_CONFIG:
        return None
    prefix = UTENTI_CONFIG[username]["db_prefix"]
    suffix = "_man" if is_manual else ""
    filename = f"{prefix}{suffix}_{utility.lower()}.json"
    return os.path.join(DB_DIR_LOCALE, filename)

# Chiamata a Gemini per il parsing avanzato
def parse_pdf_gemini(text: str, utility_type: str):
    if not API_KEY_GEMINI:
        return None
    try:
        from google import genai
        from google.genai import types
        
        client = genai.Client(api_key=API_KEY_GEMINI)
        prompt = f"""
        Analizza il testo di questa bolletta italiana di {utility_type.upper()}. Estrai i seguenti dati in formato JSON puro.
        Se un dato non è presente, metti null.
        Campi richiesti:
        - data: la data di fine periodo o di emissione della bolletta (in formato YYYY-MM-DD).
        - periodo_inizio: la data di INIZIO del periodo di fatturazione/consumo indicato in bolletta (formato YYYY-MM-DD, null se assente). Usa il PERIODO DI RIFERIMENTO della fornitura (il periodo a cui si riferisce il consumo fatturato), NON la data di emissione, di scadenza o di sola lettura del contatore. Se in bolletta compaiono più periodi, scegli quello etichettato come "periodo di riferimento" / "periodo di fatturazione" / "consumi dal … al …".
        - periodo_fine: la data di FINE dello stesso periodo di riferimento (formato YYYY-MM-DD, null se assente).
        - consumo_fatturato: il consumo del periodo DICHIARATO nella bolletta (numero, nell'unità dell'utenza: kWh per la luce, Smc per il gas, m³ per l'acqua). È il consumo del periodo, NON la lettura del contatore. Metti null se non indicato.
        - fattura: l'importo totale da pagare in Euro (numero decimale). Se non c'è importo o è solo una comunicazione, metti null.
        - quota_fissa: la somma delle quote FISSE del periodo in Euro (numero decimale: es. quota fissa di vendita + trasporto/gestione contatore, indipendenti dal consumo). null se non scorporabile.
        - quota_energia: l'importo in Euro della parte VARIABILE legata al consumo (la riga complessiva tipo "Quota per consumi X unità × PREZZO = IMPORTO"), esclusa la quota fissa. NON usare le sotto-voci "di cui ..." (es. "di cui spesa per vendita"): serve l'importo complessivo della quota consumi. null se non indicata.
        - prezzo_unitario_energia: il prezzo unitario COMPLESSIVO della stessa riga "Quota per consumi" (EUR/kWh per LUCE, EUR/Smc per GAS, EUR/m³ per ACQUA), numero decimale con più cifre. VINCOLO DI COERENZA: deve valere quota_energia ≈ consumo_fatturato × prezzo_unitario_energia (stessa riga della bolletta, mai mescolare una sotto-voce col totale). null se non indicato.
        """
        if utility_type.upper() == "LUCE":
            prompt += """
            - lettura_f1: valore lettura contatore fascia F1 (intero, null se assente).
            - lettura_f2: valore lettura contatore fascia F2 (intero, null se assente).
            - lettura_f3: valore lettura contatore fascia F3 (intero, null se assente).
            - lettura_totale: valore lettura totale contatore (intero, null se assente).

            ATTENZIONE LETTURE (LUCE): se la bolletta riporta più letture nel tempo,
            usa per ogni fascia la lettura PIÙ RECENTE (quella di FINE periodo), non
            la lettura iniziale né quelle intermedie, e mai stime future.
            """
        elif utility_type.upper() == "RIFIUTI":
            prompt += """

            NOTA RIFIUTI (TARI): è una tassa fissa sui rifiuti, NON ha contatore né consumo.
            Estrai SOLO: data, periodo_inizio, periodo_fine e fattura (l'importo da pagare).
            Per periodo_inizio/periodo_fine usa la sezione "Periodo di riferimento"
            (es. "Periodo di riferimento GG/MM/AAAA - GG/MM/AAAA"). Metti null su
            consumo_fatturato, quota_fissa, quota_energia, prezzo_unitario_energia e non
            inventare alcuna lettura del contatore.
            """
        else:
            prompt += """
            - lettura: valore lettura contatore (intero, null se assente).

            ATTENZIONE LETTURA: la tabella "Letture e consumi" riporta spesso PIÙ
            letture (inizio periodo, intermedie, fine periodo). "lettura" è il valore
            del contatore PIÙ RECENTE, cioè quello con la DATA PIÙ AVANTI nel tempo
            (l'ultima riga della tabella, di norma la fine del periodo fatturato).
            NON usare la lettura iniziale, NON le intermedie, NON stime future.
            I punti nelle migliaia vanno rimossi (es. "1.377" → 1377).
            """
            if utility_type.upper() == "ACQUA":
                prompt += """

            ATTENZIONE PERIODO (ACQUA): la bolletta dell'acqua riporta spesso più date
            (data emissione, data scadenza, periodo di lettura del contatore, eventuali
            acconti/conguagli). Per periodo_inizio/periodo_fine usa ESCLUSIVAMENTE la
            sezione "Periodo di riferimento" (la dicitura può essere "Periodo di
            riferimento: dal GG/MM/AAAA al GG/MM/AAAA"). NON usare il periodo di lettura,
            la data di emissione né la scadenza. Se la sezione "Periodo di riferimento"
            non è presente, metti null su entrambi.
            """
        prompt += f"\n\nTesto della bolletta:\n{text}"
        
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            # temperature=0: estrazione DETERMINISTICA. Senza, il default alto del
            # modello faceva "ballare" i campi tra un caricamento e l'altro (lettura
            # sbagliata/vuota, quota_energia che alternava totale e sotto-voce).
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0
            )
        )
        return json.loads(response.text)
    except Exception as e:
        print(f"Errore durante l'estrazione con Gemini API: {e}")
        traceback.print_exc()
        return None

# --- API ENDPOINTS ---

async def api_login(request: Request):
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
        
        if username in UTENTI_CONFIG and UTENTI_CONFIG[username]["password"] == password:
            return JSONResponse({
                "success": True,
                "username": username,
                "ruolo": UTENTI_CONFIG[username]["ruolo"],
                "prefix": UTENTI_CONFIG[username]["db_prefix"]
            })
        return JSONResponse({"success": False, "message": "Credenziali non valide."}, status_code=401)
    except Exception as e:
        return JSONResponse({"success": False, "message": str(e)}, status_code=400)

async def api_get_data(request: Request):
    params = request.query_params
    user = params.get("user")
    utility = params.get("utility")
    data_type = params.get("type") # 'bill' o 'manual'
    
    if not user or not utility or not data_type:
        return JSONResponse({"error": "Parametri user, utility e type sono obbligatori."}, status_code=400)
        
    is_manual = (data_type == "manual")
    filepath = get_json_filepath(user, utility, is_manual)
    
    if not filepath:
        return JSONResponse({"error": "Utente non configurato."}, status_code=400)
        
    if not os.path.exists(filepath):
        return JSONResponse([])
        
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": f"Errore nel caricamento dei dati: {str(e)}"}, status_code=500)

async def api_save_data(request: Request):
    try:
        body = await request.json()
        user = body.get("user")
        utility = body.get("utility")
        data_type = body.get("type")
        records = body.get("records") # L'intero array aggiornato
        
        if not user or not utility or not data_type or records is None:
            return JSONResponse({"error": "Parametri user, utility, type e records sono obbligatori."}, status_code=400)
            
        is_manual = (data_type == "manual")
        filepath = get_json_filepath(user, utility, is_manual)
        
        if not filepath:
            return JSONResponse({"error": "Utente non configurato."}, status_code=400)
            
        # Ordiniamo i record per data (YYYY-MM-DD) per garantire consistenza cronologica
        try:
            records.sort(key=lambda x: x.get("data", ""))
        except Exception as e:
            print(f"Errore ordinamento record: {e}")
            
        # 1. Salva localmente sul PC
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(records, f, indent=4, ensure_ascii=False)
            
        # 2. Specchia immediatamente sul NAS (se online)
        mirror_msg = ""
        if connessione_nas_attiva():
            try:
                filename = os.path.basename(filepath)
                path_remoto = os.path.join(DB_DIR_REMOTA, filename)
                shutil.copy2(filepath, path_remoto)
                mirror_msg = " e sincronizzati istantaneamente sul NAS!"
            except Exception as e:
                mirror_msg = f" (ma errore di sincronizzazione immediata sul NAS: {e})"
                print(f"Errore mirroring immediato sul NAS: {e}")
            
        return JSONResponse({"success": True, "message": f"Dati salvati in locale{mirror_msg}"})
    except Exception as e:
        return JSONResponse({"error": f"Errore nel salvataggio dei dati: {str(e)}"}, status_code=500)

async def api_upload_pdf(request: Request):
    try:
        form = await request.form()
        pdf_file = form.get("pdf")
        user = form.get("user", "User")
        utility = form.get("utility", "utility")
        
        if not pdf_file:
            return JSONResponse({"error": "Nessun file caricato."}, status_code=400)
            
        # Creiamo un nome file unico e pulito
        safe_user = re.sub(r'[^a-zA-Z0-9]', '_', user)
        safe_utility = re.sub(r'[^a-zA-Z0-9]', '_', utility).lower()
        unique_id = uuid.uuid4().hex[:8]
        filename = f"{safe_user}_{safe_utility}_{unique_id}.pdf"
        filepath = os.path.join(PDF_DIR, filename)
        
        # Salviamo il file PDF su disco
        contents = await pdf_file.read()
        with open(filepath, "wb") as f:
            f.write(contents)
            
        # Restituiamo il percorso relativo da salvare nel record JSON
        relative_path = f"database/pdfs/{filename}"
        return JSONResponse({"success": True, "pdf_path": relative_path})
    except Exception as e:
        return JSONResponse({"error": f"Errore caricamento PDF: {str(e)}"}, status_code=500)

async def api_parse_pdf(request: Request):
    try:
        form = await request.form()
        pdf_file = form.get("pdf")
        utility = form.get("utility", "luce")
        
        if not pdf_file:
            return JSONResponse({"error": "Nessun file PDF fornito."}, status_code=400)
            
        # Salviamo temporaneamente il PDF per leggerlo con pdfplumber
        temp_filename = f"temp_{uuid.uuid4().hex}.pdf"
        temp_filepath = os.path.join(DB_DIR_LOCALE, temp_filename)
        
        try:
            contents = await pdf_file.read()
            with open(temp_filepath, "wb") as f:
                f.write(contents)
                
            # Estraiamo il testo dal PDF
            text_pages = []
            with pdfplumber.open(temp_filepath) as pdf:
                for page in pdf.pages:
                    text_pages.append(page.extract_text() or "")
            text_full = "\n".join(text_pages)
            
            if not text_full.strip():
                return JSONResponse({"error": "Impossibile estrarre testo dal PDF. Il file potrebbe essere una scansione immagine non leggibile."}, status_code=400)

            # L'estrazione dati avviene SOLO tramite Gemini. Se non è disponibile
            # (chiave assente o nessuna connessione a Gemini) non usiamo alcun
            # fallback: meglio nessun dato che dati estratti in modo inaffidabile.
            if not API_KEY_GEMINI:
                return JSONResponse({
                    "error": "gemini_non_disponibile",
                    "message": "Estrazione automatica non disponibile: chiave Gemini non configurata."
                }, status_code=503)

            parsed_data = parse_pdf_gemini(text_full, utility)
            if not parsed_data:
                return JSONResponse({
                    "error": "gemini_non_disponibile",
                    "message": "Impossibile raggiungere Gemini per leggere la bolletta. Verifica la connessione a internet e riprova."
                }, status_code=503)

            parsed_data["parsed_via"] = "gemini"
            return JSONResponse(parsed_data)
            
        finally:
            # Rimuoviamo sempre il file temporaneo
            if os.path.exists(temp_filepath):
                os.remove(temp_filepath)
                
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": f"Errore durante l'elaborazione del PDF: {str(e)}"}, status_code=500)

async def api_sync_status(request: Request):
    try:
        user = request.query_params.get("user")
        if not user:
            return JSONResponse({"error": "Parametro user obbligatorio."}, status_code=400)
        
        has_conflict, report = analizza_stato_sincronizzazione_utente(user)
        return JSONResponse({
            "success": True,
            "has_conflict": has_conflict,
            "report": report
        })
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_sync_resolve(request: Request):
    try:
        body = await request.json()
        user = body.get("user")
        action = body.get("action") # 'upload' o 'download'
        key = body.get("key") # Chiave specifica o null per all
        
        if not user or not action:
            return JSONResponse({"error": "Parametri user e action obbligatori."}, status_code=400)
            
        success, message = esegui_azione_sincronizzazione(user, action, key)
        return JSONResponse({
            "success": success,
            "message": message
        })
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_health(request: Request):
    # Endpoint minimo per il watchdog dell'add-on e per la diagnostica: 200 se il
    # processo è vivo. 'gemini' dice se la chiave è configurata (utile per capire
    # al volo perché l'estrazione PDF risulta bloccata).
    return JSONResponse({
        "ok": True,
        "addon": MODALITA_ADDON,
        "gemini": bool(API_KEY_GEMINI)
    })

async def api_app_status(request: Request):
    # Confronto del CODICE dell'applicazione locale vs NAS (sola lettura).
    try:
        richiede_attenzione, report = analizza_stato_applicazione()
        return JSONResponse({
            "success": True,
            "richiede_attenzione": richiede_attenzione,
            "report": report
        })
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_app_publish(request: Request):
    # Pubblica il codice dell'app sul NAS (specchio esatto da locale -> NAS).
    # Operazione che SCRIVE/CANCELLA sul NAS: i dati (database/) non vengono toccati.
    try:
        success, report = pubblica_app_su_nas()
        return JSONResponse({
            "success": success,
            "report": report
        }, status_code=(200 if success else 409))
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)

# Rotte API dell'applicazione
routes = [
    Route("/api/login", api_login, methods=["POST"]),
    Route("/api/data", api_get_data, methods=["GET"]),
    Route("/api/save", api_save_data, methods=["POST"]),
    Route("/api/upload-pdf", api_upload_pdf, methods=["POST"]),
    Route("/api/parse-pdf", api_parse_pdf, methods=["POST"]),
    Route("/api/sync/status", api_sync_status, methods=["GET"]),
    Route("/api/sync/resolve", api_sync_resolve, methods=["POST"]),
    Route("/api/health", api_health, methods=["GET"]),
    Route("/api/app/status", api_app_status, methods=["GET"]),
    Route("/api/app/publish", api_app_publish, methods=["POST"]),
    # Serviamo i file PDF archiviati
    Mount("/database/pdfs", StaticFiles(directory=PDF_DIR), name="pdfs"),
]

# Serviamo il frontend statico SOLO se la cartella static/ è presente. Così lo stesso
# server.py può girare anche come "solo servizio di salvataggio" (es. su un PC dove
# l'interfaccia è servita da Home Assistant), senza la cartella static/ e senza crashare.
if os.path.isdir("static"):
    routes.append(Mount("/", StaticFiles(directory="static", html=True), name="static"))
else:
    print("NOTA: cartella 'static/' assente → il server espone solo le API (frontend servito altrove, es. Home Assistant).")

# Middleware no-cache: impedisce al browser di servire una versione vecchia del
# frontend (index.html, app.js, app.css) dopo un aggiornamento del codice. Si applica
# al sito statico e all'HTML, NON ai PDF archiviati (che possono restare in cache).
class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        path = request.url.path
        is_api = path.startswith("/api/")
        is_pdf = path.startswith("/database/pdfs")
        if not is_api and not is_pdf:
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

# Configurazione CORS per permettere a Home Assistant (porta 8123) di fare chiamate API
middleware = [
    Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]),
    Middleware(NoCacheStaticMiddleware)
]

app = Starlette(debug=True, routes=routes, middleware=middleware)

if __name__ == "__main__":
    port = 8000
    print(f"Avvio del server di Gestione Bollette sulla porta {port}...")
    
    # Auto-apertura del browser (funziona solo in ambiente desktop locale)
    try:
        webbrowser.open(f"http://localhost:{port}/index.html")
    except Exception as e:
        print(f"Impossibile aprire il browser automaticamente: {e}")
        
    uvicorn.run("server:app", host="0.0.0.0", port=port, log_level="info")
