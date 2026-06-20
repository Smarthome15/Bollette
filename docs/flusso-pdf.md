# Flusso estrazione PDF

> Come una bolletta PDF diventa dati nel form. Solo Gemini, nessun fallback.

## Il percorso, passo per passo

1. L'utente trascina/seleziona un PDF nella tab Bollette → `handlePdfSelected` (`app.js`).
2. Il frontend invia il PDF a **`POST /api/parse-pdf`** (`server.py`) con l'utenza.
3. Il backend estrae il **testo** del PDF con `pdfplumber` (concatena le pagine). Se il testo è vuoto (es. scansione immagine non-OCR) → errore.
4. Il testo va a **`parse_pdf_gemini`**: chiama Gemini `gemini-2.5-flash` con un prompt italiano che descrive i campi attesi e impone output **JSON puro**.
5. Il JSON estratto torna al frontend, che **pre-compila il form** con `prefillBillForm`. **Non salva nulla automaticamente**: l'utente controlla e conferma.
6. Al salvataggio, `saveNewBill` costruisce il record; se c'è un file, `POST /api/upload-pdf` archivia il PDF in `database/pdfs/` e restituisce il `pdf_path` da memorizzare.

## Niente fallback euristico — scelta esplicita

Non esiste un parser a regex di riserva: `parse_pdf_heuristics` è stata **rimossa apposta** (dava dati sbagliati ma plausibili — ~14% di accuratezza sulle bollette Iren reali, contro ~100% di Gemini).

Se Gemini non è disponibile (chiave assente o irraggiungibile), `/api/parse-pdf` risponde **`503` con `error: "gemini_non_disponibile"`** e nessun dato. Il frontend (`handlePdfSelected` → `blockPdfInsertion`) **blocca l'inserimento del PDF e avvisa**, invece di pre-compilare con valori inaffidabili. Principio: **meglio nessun dato che dati sbagliati**. Quando l'estrazione riesce, `parsed_via` vale `"gemini"`.

## Campi estratti dal prompt

Comuni a tutte le utenze: `data`, `periodo_inizio`, `periodo_fine`, `consumo_fatturato`, `fattura`, e la scomposizione costi `quota_fissa`, `quota_energia`, `prezzo_unitario_energia` (usata dalla tab Andamento Prezzi). Specifici: `lettura_f1/f2/f3` + `lettura_totale` per la LUCE; `lettura` per GAS/ACQUA. Un dato non trovato viene messo a `null`.

## Chiave Gemini (fuori dal codice versionato)

`config.py` legge `API_KEY_GEMINI` in ordine da:
1. variabile d'ambiente `GEMINI_API_KEY`;
2. file locale **`secrets_local.py`** (non versionato, `.gitignore`) con `API_KEY_GEMINI = "..."`.

Se nessuna è presente resta vuota → l'app blocca l'estrazione PDF (tutto il resto funziona). Sul NAS la chiave arriva perché `secrets_local.py` è incluso nella pubblicazione del codice. Su una macchina nuova si recupera dal NAS (`\\192.168.1.15\config\www\bollette\secrets_local.py`).

## La regola dei punti coerenti

Quando si **aggiunge un campo estratto**, va aggiornato in punti coordinati, altrimenti il dato si perde tra estrazione e salvataggio:

1. **Prompt Gemini** in `parse_pdf_gemini` (`server.py`) — elenca il campo da estrarre.
2. **Input HTML** nel form bolletta (`index.html`) — il campo deve esistere nel form.
3. **`prefillBillForm`** (`app.js`) — copia il valore estratto nell'input.
4. **`saveNewBill`** (`app.js`) — include il campo nel record salvato.
5. **`openPdfModal`** (`app.js`) — per visualizzarlo nel dettaglio bolletta.

**Naming**: usa la **stessa chiave** ovunque (es. `prezzo_unitario_energia` nel JSON Gemini, nel record e nell'attributo letto da `prefillBillForm`). Niente rimappature = niente bug silenziosi.
