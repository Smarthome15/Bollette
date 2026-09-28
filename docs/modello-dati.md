# Modello dati

> Come sono organizzati e strutturati i dati. È la cosa più importante da capire prima di toccare il codice.

## Un file JSON per utente × utenza × tipo

I dati vivono in `database/` (non versionata). I nomi usano sempre il **`db_prefix` anonimo** (es. `Matteo → UserA`), mai lo username in chiaro:

```
{prefix}_{utenza}.json          → bollette         (es. UserA_gas.json)
{prefix}_man_{utenza}.json      → letture manuali  (es. UserA_man_gas.json)
```

Le utenze sono `luce`, `gas`, `acqua` e `rifiuti`. Per costruire i path si usano gli helper del backend (`get_filename_only()` / `get_json_filepath()`), **mai a mano**.

> **RIFIUTI (TARI)** è una **utenza solo-bollette**: esiste `UserA_rifiuti.json` ma **non** `UserA_man_rifiuti.json` (è una tassa, niente contatore/letture). Nel codice va incluso solo nei flussi-bollette ed escluso da letture/audit/prezzi/confronto-consumi — vedi [frontend](frontend.md).

Ogni file è un **array di record ordinato per `data`**. Non c'è un DB: `POST /api/save` riceve e riscrive l'array completo, non un delta. L'ordinamento cronologico crescente è un requisito (vedi sotto, calcolo dei consumi).

## Record bolletta

Campi comuni a tutte le utenze:

| Campo | Significato |
|---|---|
| `data` | Data della bolletta (YYYY-MM-DD). |
| `periodo_inizio` / `periodo_fine` | Periodo di fatturazione coperto dalla bolletta. |
| `consumo_fatturato` | Consumo **stampato in bolletta** (kWh/SMC/m³). Per l'acqua è **lordo**: le fatture di conguaglio rifatturano dall'ultima lettura reale e restituiscono a parte gli acconti — il netto si ricava dalle letture fatturate (vedi sotto). |
| `fattura` | Importo totale in € della bolletta. |
| `pdf_path` | Percorso relativo del PDF archiviato (se presente). Accanto, stesso nome `.json`, la **scheda bolletta** (vedi sotto). |
| `tipo_lettura` | Tipo della **lettura fatturata**: `rilevata` / `stimata` (`mista` nei record vecchi inseriti a mano). |
| `data_lettura` | (Dal 28/09/2026) data della **lettura fatturata**: l'ultima riga del quadro letture, reale o stimata. Con la lettura (`lettura`, o `lettura_totale` per la luce) dà il saldo in Verifica Anomalie. `null` se ignota. |
| `note` | Note libere. |
| `quota_fissa` | (Opzionale) quota fissa del periodo in €. |
| `quota_energia` | (Opzionale) spesa per la materia/energia consumata in €. |
| `prezzo_unitario_energia` | (Opzionale) prezzo unitario della quota variabile (€/unità): è un **composto** (energia + perdite di rete + dispacciamento), non il prezzo puro. |
| `prezzo_vendita_energia` | (Opzionale, dal 30/08/2026) prezzo della **sola componente energia/materia prima** (riga "Prezzo vendita energia" del quadro di dettaglio), 5 decimali, media pesata sulle quantità se la riga è mensile. Senza perdite, dispacciamento, trasporto, oneri, imposte. |
| `canone_rai` | (Opzionale, solo LUCE, dal 30/08/2026) rata del canone TV addebitata in questa bolletta (fuori campo IVA, di norma 9 €/mese gen–ott). `null` = non addebitata. È una tassa già compresa in `fattura`, non un costo dell'energia. |

Campi specifici:
- **LUCE**: `lettura_f1`, `lettura_f2`, `lettura_f3` (fasce) + `lettura_totale` = letture **fatturate** (ultima riga del quadro letture), come per gas/acqua qui sotto; recuperate dai PDF il 28/09/2026.
- **GAS / ACQUA**: `lettura` = posizione del contatore **fatturata** dalla bolletta (ultima riga del quadro letture, reale o stimata): la bolletta successiva riparte da lì, quindi `lettura − lettura della bolletta precedente` = **consumo netto fatturato** (`nettoFatturato` in `app.js`), e `lettura − tua autolettura alla data_lettura` = **saldo**. Recuperate dai PDF su tutto lo storico il 28/09/2026 (prima i record storici avevano le autoletture; backup `backup_nas/fix_letture_fatturate_*`).

### Scheda bolletta (JSON accanto al PDF, dal 28/09/2026)

`database/pdfs/<nome>.json`, scritta da `_salva_scheda_bolletta` (`server.py`) a ogni `upload-pdf` e recuperata per tutto lo storico: `{versione, creata_il, pdf, utenza, scheda, testo}`. `testo` è il testo completo estratto dal PDF; `scheda` i dati strutturati letti in modo deterministico (`estrai_scheda_bolletta`): `letture` (ogni riga del quadro letture: data, lettura, consumo, tipo; per la luce anche `f1`/`f2`/`f3`, con `lettura` = totale), `periodo`, `consumo` (lordo `totale`, `dal`/`al`, `stimato`, `acconti_restituiti` per l'acqua), `tipo_fattura` e `ricalcoli_euro` (acqua). Rifiuti: solo testo. Serve a lavorare su dati già estratti invece di rileggere il PDF; il frontend la mostra nel dettaglio bolletta ("Dati estratti dalla bolletta"), mentre le analisi usano i campi del record.

**Tipi di fattura acqua (Iren)**: *Acconto* = solo consumi stimati; *Conguaglio e Acconto* = rifattura dall'ultima lettura reale, restituisce gli acconti precedenti in m³ ("Restituzione acconti mc N") e aggiunge una nuova stima fino a fine periodo; *Conguaglio/Rettifica* = come sopra ma le bollette precedenti vengono corrette in **euro** ("Ricalcoli per conguaglio", es. nuove tariffe annuali retroattive dal 1° gennaio: 2024 e 2026), e può chiudere su una lettura reale senza acconto — da cui un periodo come "GIUGNO - SETTEMBRE 2026" = 01/06 → 03/09.

I tre campi di **scomposizione costi** (`quota_fissa`, `quota_energia`, `prezzo_unitario_energia`) sono **opzionali** e valgono `null` quando non disponibili: lo storico importato ne è privo, vengono compilati da Gemini sulle bollette PDF future. Li usa la tab Andamento Prezzi ([frontend](frontend.md)).

## Record lettura manuale

Più semplice: `data`, `note`, e il valore del contatore (`lettura` per gas/acqua, oppure `lettura_f1/f2/f3` + `lettura_totale` per la luce). Per le letture il **periodo di riferimento è il mese di rilievo** (cioè il mese della `data`): una lettura del 31/03 si riferisce a marzo. Alcuni record di lettura che cadono sulla data di una bolletta hanno anche `periodo_inizio`/`periodo_fine` propagati: sono campi "passeggeri", ignorati dall'app (la UI mostra comunque il mese di rilievo, non questi campi).

## La distinzione cruciale: lettura vs consumo

- `lettura` / `lettura_totale` = **valore progressivo del contatore** (cresce nel tempo).
- `consumo_fatturato` = **consumo del periodo dichiarato in bolletta**.

Il consumo per-periodo mostrato nei grafici **non è memorizzato**: è calcolato a runtime per **differenza tra letture consecutive** (`.diff()` lato JS). Per questo le letture devono essere **cronologiche e crescenti** — su questo vegliano le guardie di inserimento ([frontend](frontend.md)).

## La distinzione altrettanto cruciale: periodo di competenza vs data

Ogni record ha una `data` (emissione bolletta / giorno della lettura), ma **non è quella a contare** nelle aggregazioni: vale il **periodo di competenza**. La `data` dice solo *quando* hai fatto l'operazione.

- **Bollette**: la competenza è il mese di `periodo_fine` (fallback alla `data` se il periodo manca). Una bolletta emessa a giugno ma che copre maggio pesa su **maggio**. Tutti i grafici/KPI sulle bollette usano gli helper `meseCompetenzaBolletta`/`annoCompetenzaBolletta` ([frontend](frontend.md)), mai `new Date(bill.data)`.
- **Letture**: la competenza è il mese di rilievo (la `data` della lettura), come detto sopra.

## Periodo sulle bollette storiche

Le bollette importate dal vecchio Excel non avevano `periodo_inizio`/`periodo_fine`/`consumo_fatturato`. Sono stati popolati a posteriori:
- **periodo**: fine = data bolletta; inizio = giorno dopo la fine della bolletta precedente (per la prima bolletta: dalla prima autolettura disponibile);
- **`consumo_fatturato`**: per il gas dal dato reale ("MtC fatturati" dell'Excel); per luce/acqua = consumo rilevato dalle letture del periodo.

Questo ha reso utilizzabile la pagina Verifica Anomalie sullo storico. Il 28/09/2026 gas, acqua e luce sono stati ripresi dai PDF (lettura fatturata, `data_lettura`, `tipo_lettura`, consumo stampato; periodo corretto solo su acqua 18/09/2025 e gas 31/12/2023). Luce: `periodo_*` e `prezzo_unitario_energia` NON toccati (li legge il ponte "conti del solare" di Jarvis).

## Vincoli pratici

- Aggiungere un utente = una voce in `UTENTI_CONFIG` (`config.py`, backend) **e** in `PROFILI_UTENTE` (`app.js`, login lato client), con lo **stesso** `db_prefix`.
- Non versionati (`.gitignore`): `database/` (dati + PDF), `secrets_local.py` (chiave Gemini), `backup_nas/` (backup pre-pubblicazione).
