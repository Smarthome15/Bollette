# server.py
import os
import json
import uuid
import re
import socket
import shutil
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
import pdfplumber

from config import UTENTI_CONFIG, API_KEY_GEMINI, DB_DIR_LOCALE, PDF_DIR, DB_DIR_REMOTA

# --- UTILITIES DI SINCRONIZZAZIONE NAS ---
def connessione_nas_attiva():
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

    for utenza in ["LUCE", "GAS", "ACQUA"]:
        for is_manual in [False, True]:
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
        chiavi = ["LUCE", "LUCE_MAN", "GAS", "GAS_MAN", "ACQUA", "ACQUA_MAN"]
        
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

# Funzione per recuperare il nome del file JSON
def get_json_filepath(username: str, utility: str, is_manual: bool):
    if username not in UTENTI_CONFIG:
        return None
    prefix = UTENTI_CONFIG[username]["db_prefix"]
    suffix = "_man" if is_manual else ""
    filename = f"{prefix}{suffix}_{utility.lower()}.json"
    return os.path.join(DB_DIR_LOCALE, filename)

# Estrattore euristico di fallback tramite Regex
def parse_pdf_heuristics(text: str, utility_type: str):
    result = {
        "data": None,
        "periodo_inizio": None,
        "periodo_fine": None,
        "consumo_fatturato": None,
        "fattura": None,
        "lettura_totale": None,
        "lettura": None,
        "lettura_f1": 0,
        "lettura_f2": 0,
        "lettura_f3": 0
    }

    # 1. Ricerca date (DD/MM/YYYY o DD-MM-YYYY)
    date_matches = re.findall(r'\b(\d{2})[/-](\d{2})[/-](\d{4})\b', text)
    dates = []
    for m in date_matches:
        try:
            d_str = f"{m[2]}-{m[1]}-{m[0]}"
            datetime.strptime(d_str, "%Y-%m-%d")
            dates.append(d_str)
        except ValueError:
            pass
    if dates:
        dates.sort()
        # Spesso l'ultima data nel testo corrisponde alla fine periodo o scadenza bolletta
        result["data"] = dates[-1]
        # Euristica grezza del periodo di fatturazione: prima e ultima data trovate.
        # Indicativa, va sempre verificata a mano (la stima affidabile la fa Gemini).
        if len(dates) >= 2:
            result["periodo_inizio"] = dates[0]
            result["periodo_fine"] = dates[-1]
        
    # 2. Ricerca Importo (es: 120,40 € o € 120,40 o Totale 120,40)
    clean_text = re.sub(r'\s+', ' ', text)
    money_patterns = [
        r'(?:totale da pagare|totale bolletta|totale fattura|importo da pagare|totale a pagare|totale)\s*(?:di)?\s*€?\s*(\d+[\.,]\d{2})\b',
        r'€\s*(\d+[\.,]\d{2})\b',
        r'\b(\d+[\.,]\d{2})\s*€'
    ]
    found_amounts = []
    for pat in money_patterns:
        matches = re.findall(pat, clean_text, re.IGNORECASE)
        for m in matches:
            try:
                val = float(m.replace('.', '').replace(',', '.'))
                if 2.0 < val < 5000.0: # Esclude valori irrisori o spropositati
                    found_amounts.append(val)
            except ValueError:
                pass
    if found_amounts:
        result["fattura"] = found_amounts[0]
        
    # 3. Ricerca Letture
    reading_matches = re.findall(r'\b(\d+)\s*(?:kwh|smc|mc|m³|m3)\b', clean_text, re.IGNORECASE)
    if reading_matches:
        vals = [int(x) for x in reading_matches if len(x) < 7] # evita codici POD/PDR
        if vals:
            if utility_type.upper() == "LUCE":
                result["lettura_totale"] = max(vals)
            else:
                result["lettura"] = max(vals)
                
    return result

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
        - periodo_inizio: la data di INIZIO del periodo di fatturazione/consumo indicato in bolletta (formato YYYY-MM-DD, null se assente).
        - periodo_fine: la data di FINE del periodo di fatturazione/consumo indicato in bolletta (formato YYYY-MM-DD, null se assente).
        - consumo_fatturato: il consumo del periodo DICHIARATO nella bolletta (numero, nell'unità dell'utenza: kWh per la luce, Smc per il gas, m³ per l'acqua). È il consumo del periodo, NON la lettura del contatore. Metti null se non indicato.
        - fattura: l'importo totale da pagare in Euro (numero decimale). Se non c'è importo o è solo una comunicazione, metti null.
        """
        if utility_type.upper() == "LUCE":
            prompt += """
            - lettura_f1: valore lettura contatore fascia F1 (intero, null se assente).
            - lettura_f2: valore lettura contatore fascia F2 (intero, null se assente).
            - lettura_f3: valore lettura contatore fascia F3 (intero, null se assente).
            - lettura_totale: valore lettura totale contatore (intero, null se assente).
            """
        else:
            prompt += """
            - lettura: valore lettura contatore (intero, null se assente).
            """
        prompt += f"\n\nTesto della bolletta:\n{text}"
        
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json")
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
                
            # Tentiamo il parsing con Gemini AI
            parsed_data = None
            if API_KEY_GEMINI:
                parsed_data = parse_pdf_gemini(text_full, utility)
                
            # Se Gemini non è disponibile o fallisce, usiamo l'euristica Regex locale
            if not parsed_data:
                print("Esecuzione parser euristico di fallback...")
                parsed_data = parse_pdf_heuristics(text_full, utility)
                parsed_data["parsed_via"] = "heuristics"
            else:
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

# Rotte API dell'applicazione
routes = [
    Route("/api/login", api_login, methods=["POST"]),
    Route("/api/data", api_get_data, methods=["GET"]),
    Route("/api/save", api_save_data, methods=["POST"]),
    Route("/api/upload-pdf", api_upload_pdf, methods=["POST"]),
    Route("/api/parse-pdf", api_parse_pdf, methods=["POST"]),
    Route("/api/sync/status", api_sync_status, methods=["GET"]),
    Route("/api/sync/resolve", api_sync_resolve, methods=["POST"]),
    # Serviamo i file PDF archiviati
    Mount("/database/pdfs", StaticFiles(directory=PDF_DIR), name="pdfs"),
    # Serviamo il frontend statico
    Mount("/", StaticFiles(directory="static", html=True), name="static"),
]

# Configurazione CORS per permettere a Home Assistant (porta 8123) di fare chiamate API
middleware = [
    Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
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
