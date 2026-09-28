# Flusso estrazione PDF

> Come una bolletta PDF diventa dati nel form. Solo Gemini, nessun fallback.

## Il percorso, passo per passo

1. L'utente trascina/seleziona un PDF nella tab Bollette → `handlePdfSelected` (`app.js`), che lo legge SUBITO per intero e ne tiene una **copia in memoria**: è quella che viaggia verso `parse-pdf` e poi `upload-pdf`. Un PDF scelto dal telefono da un provider cloud (es. Google Drive) altrimenti viene riletto dal provider al momento dell'invio e la richiesta muore prima di partire ("Impossibile raggiungere il server", 28/09/2026). Da fuori casa il proxy blocca le scritture (403) e il frontend lo dice esplicitamente.
2. Il frontend invia il PDF a **`POST /api/parse-pdf`** (`server.py`) con l'utenza.
3. Il backend estrae il **testo** del PDF con `pdfplumber` (concatena le pagine). Se il testo è vuoto (es. scansione immagine non-OCR) → errore.
4. Il testo va a **`parse_pdf_gemini`**: chiama Gemini `gemini-2.5-flash` con un prompt italiano che descrive i campi attesi e impone output **JSON puro**.
5. Il JSON estratto torna al frontend, che **pre-compila il form** con `prefillBillForm`. **Non salva nulla automaticamente**: l'utente controlla e conferma.
6. Al salvataggio, `saveNewBill` costruisce il record; se c'è un file, `POST /api/upload-pdf` archivia il PDF in `database/pdfs/` e restituisce il `pdf_path` da memorizzare. Accanto al PDF scrive la sua **scheda** (`<nome>.json`: testo estratto + dati strutturati, `_salva_scheda_bolletta`; vedi [modello-dati](modello-dati.md)), così le analisi future non devono rileggere il PDF. Un errore nella scheda non blocca l'archiviazione.

## Niente fallback euristico — scelta esplicita

Non esiste un parser a regex di riserva: `parse_pdf_heuristics` è stata **rimossa apposta** (dava dati sbagliati ma plausibili — ~14% di accuratezza sulle bollette Iren reali, contro ~100% di Gemini).

Se Gemini non è disponibile (chiave assente o irraggiungibile), `/api/parse-pdf` risponde **`503` con `error: "gemini_non_disponibile"`** e nessun dato. Il frontend (`handlePdfSelected` → `blockPdfInsertion`) **blocca l'inserimento del PDF e avvisa**, invece di pre-compilare con valori inaffidabili. Principio: **meglio nessun dato che dati sbagliati**. Quando l'estrazione riesce, `parsed_via` vale `"gemini"`.

## Campi estratti dal prompt

Comuni a tutte le utenze: `data`, `periodo_inizio`, `periodo_fine`, `consumo_fatturato`, `fattura`, la scomposizione costi `quota_fissa`, `quota_energia`, `prezzo_unitario_energia` (usata dalla tab Andamento Prezzi) e `prezzo_vendita_energia` (prezzo della sola componente energia). Specifici: `lettura_f1/f2/f3` + `lettura_totale` + `canone_rai` per la LUCE; `lettura` per GAS/ACQUA. Un dato non trovato viene messo a `null`.

## Rilettura regex (LUCE/GAS: canone RAI e prezzo puro; GAS/ACQUA: lettura fatturata; ACQUA: periodo)

Unica eccezione alla regola "solo Gemini": `estrai_campi_regex(text, utility)` in `server.py` rilegge `canone_rai` (solo LUCE) e `prezzo_vendita_energia` (LUCE e GAS) direttamente dal testo, perché nelle bollette Iren hanno un'etichetta stabile — LUCE: "Canone di abbonamento alla televisione … 9,00", "Prezzo (di) vendita (di) energia … Euro/kWh PREZZO QUANTITÀ TOTALE"; GAS: "Materia prima gas" (fino al 2025) o "Prezzo di vendita di gas naturale" (dal 2026) "… Euro/smc PREZZO QUANTITÀ TOTALE" (le righe a quantità 0 / IVA 22% pesano zero). Media pesata sulle quantità se la riga è mensile. Testata il 30/08/2026 su 28/28 bollette luce e 18/18 gas reali.

ACQUA (dal 28/09/2026, `_periodo_riferimento_acqua`): `periodo_inizio`/`periodo_fine` = intervallo delle **quote fisse** del dettaglio (righe "Quota Fissa GG/MM/AAAA - GG/MM/AAAA €/unità/anno"; le righe di ricalcolo di periodi passati non hanno "€/unità/anno"), preciso al giorno: 17/11/2023 a inizio contratto, 03/09/2026 quando la bolletta chiude su una lettura reale senza acconto. Ripiego: il "periodo di riferimento" dell'intestazione, stampato in **mesi** ("NOVEMBRE 2023", "MARZO - MAGGIO 2026", "GIUGNO - SETTEMBRE 2026") e che pdfplumber, per l'impaginazione a due colonne, mette un paio di righe **sotto** l'etichetta (primo giorno del primo mese → ultimo dell'ultimo). Il vecchio prompt descriveva un formato "dal GG/MM/AAAA al GG/MM/AAAA" che queste bollette non hanno, e sulla bolletta del 17/09/2026 Gemini restituiva `null`: prompt corretto con la definizione delle quote fisse, regex come rete di sicurezza. Testata su 12/12 bollette acqua reali (coincide col periodo salvato su 10, le altre 2 erano errori di estrazione o scelte a mano). NB: NON è la finestra del "Consumo totale fatturato (dal … al …)", che nelle fatture di conguaglio parte dall'ultima lettura reale (anche mesi prima).

GAS e ACQUA (dal 28/09/2026, `_letture_bolletta` / `_lettura_fatturata`): `lettura`, `data_lettura`, `tipo_lettura` dall'**ultima riga del quadro letture** = posizione del contatore fatturata, reale o stimata (formati: acqua "03/09/2026 174 8 Rilevata"; gas dal 2025 "31/08/2026 stimata 1.401 18 …"; gas fino al 2024 blocchi "Consumi rilevati nel periodo … / rilevata rilevata / 141 254 113,000000 …"). È la base del saldo in Verifica Anomalie ([frontend](frontend.md)). Testata su 12/12 acqua e 17/17 gas reali: Gemini estrae la stessa `lettura` (nessuna divergenza); `data_lettura` e `tipo_lettura` vengono solo dalla regex.

In `api_parse_pdf`, dopo Gemini: i `null` vengono completati dalla regex; se i due valori divergono vince la regex (è la riga letterale) e la divergenza va in `verifiche_regex`, che il frontend appende al banner "Analisi Gemini AI completata". Non è un fallback dell'estrazione intera: senza Gemini l'endpoint resta 503. Lo storico luce è stato popolato con la stessa funzione (script una tantum via `/api/save`, backup in `backup_nas/fix_canone_rai_20260830_*`).

## Chiave Gemini (fuori dal codice versionato)

`config.py` legge `API_KEY_GEMINI` in ordine da:
1. variabile d'ambiente `GEMINI_API_KEY`;
2. file locale **`secrets_local.py`** (non versionato, `.gitignore`) con `API_KEY_GEMINI = "..."`.

Se nessuna è presente resta vuota → l'app blocca l'estrazione PDF (tutto il resto funziona). Sul NAS la chiave arriva perché `secrets_local.py` è incluso nella pubblicazione del codice verso l'area PRIVATA (`bollette_app`, mai in `www/` — bonifica /local 19/07/2026); sul Pi vale comunque prima la chiave nelle options dell'add-on. Su una macchina nuova si recupera dal NAS (`\\192.168.1.15\config\bollette_app\secrets_local.py`).

## La regola dei punti coerenti

Quando si **aggiunge un campo estratto**, va aggiornato in punti coordinati, altrimenti il dato si perde tra estrazione e salvataggio:

1. **Prompt Gemini** in `parse_pdf_gemini` (`server.py`) — elenca il campo da estrarre.
2. **Input HTML** nel form bolletta (`index.html`) — il campo deve esistere nel form.
3. **`prefillBillForm`** (`app.js`) — copia il valore estratto nell'input.
4. **`saveNewBill`** (`app.js`) — include il campo nel record salvato.
5. **`openPdfModal`** (`app.js`) — per visualizzarlo nel dettaglio bolletta.

**Naming**: usa la **stessa chiave** ovunque (es. `prezzo_unitario_energia` nel JSON Gemini, nel record e nell'attributo letto da `prefillBillForm`). Niente rimappature = niente bug silenziosi.
