# Modello dati

> Come sono organizzati e strutturati i dati. È la cosa più importante da capire prima di toccare il codice.

## Un file JSON per utente × utenza × tipo

I dati vivono in `database/` (non versionata). I nomi usano sempre il **`db_prefix` anonimo** (es. `Matteo → UserA`), mai lo username in chiaro:

```
{prefix}_{utenza}.json          → bollette         (es. UserA_gas.json)
{prefix}_man_{utenza}.json      → letture manuali  (es. UserA_man_gas.json)
```

Le utenze sono `luce`, `gas`, `acqua`. Per costruire i path si usano gli helper del backend (`get_filename_only()` / `get_json_filepath()`), **mai a mano**.

Ogni file è un **array di record ordinato per `data`**. Non c'è un DB: `POST /api/save` riceve e riscrive l'array completo, non un delta. L'ordinamento cronologico crescente è un requisito (vedi sotto, calcolo dei consumi).

## Record bolletta

Campi comuni a tutte le utenze:

| Campo | Significato |
|---|---|
| `data` | Data della bolletta (YYYY-MM-DD). |
| `periodo_inizio` / `periodo_fine` | Periodo di fatturazione coperto dalla bolletta. |
| `consumo_fatturato` | Consumo del **periodo dichiarato in bolletta** (kWh/SMC/m³). |
| `fattura` | Importo totale in € della bolletta. |
| `pdf_path` | Percorso relativo del PDF archiviato (se presente). |
| `tipo_lettura` | `rilevata` / `stimata` / `mista`. |
| `note` | Note libere. |
| `quota_fissa` | (Opzionale) quota fissa del periodo in €. |
| `quota_energia` | (Opzionale) spesa per la materia/energia consumata in €. |
| `prezzo_unitario_energia` | (Opzionale) prezzo unitario della quota variabile (€/unità). |

Campi specifici:
- **LUCE**: `lettura_f1`, `lettura_f2`, `lettura_f3` (fasce) + `lettura_totale`.
- **GAS / ACQUA**: `lettura` (valore progressivo unico del contatore).

I tre campi di **scomposizione costi** (`quota_fissa`, `quota_energia`, `prezzo_unitario_energia`) sono **opzionali** e valgono `null` quando non disponibili: lo storico importato ne è privo, vengono compilati da Gemini sulle bollette PDF future. Li usa la tab Andamento Prezzi ([frontend](frontend.md)).

## Record lettura manuale

Più semplice: `data`, `note`, e il valore del contatore (`lettura` per gas/acqua, oppure `lettura_f1/f2/f3` + `lettura_totale` per la luce). Alcuni record di lettura che cadono sulla data di una bolletta hanno anche `periodo_inizio`/`periodo_fine` propagati: sono campi "passeggeri", ignorati dal resto dell'app.

## La distinzione cruciale: lettura vs consumo

- `lettura` / `lettura_totale` = **valore progressivo del contatore** (cresce nel tempo).
- `consumo_fatturato` = **consumo del periodo dichiarato in bolletta**.

Il consumo per-periodo mostrato nei grafici **non è memorizzato**: è calcolato a runtime per **differenza tra letture consecutive** (`.diff()` lato JS). Per questo le letture devono essere **cronologiche e crescenti** — su questo vegliano le guardie di inserimento ([frontend](frontend.md)).

## Periodo sulle bollette storiche

Le bollette importate dal vecchio Excel non avevano `periodo_inizio`/`periodo_fine`/`consumo_fatturato`. Sono stati popolati a posteriori:
- **periodo**: fine = data bolletta; inizio = giorno dopo la fine della bolletta precedente (per la prima bolletta: dalla prima autolettura disponibile);
- **`consumo_fatturato`**: per il gas dal dato reale ("MtC fatturati" dell'Excel); per luce/acqua = consumo rilevato dalle letture del periodo.

Questo ha reso utilizzabile la pagina Verifica Anomalie sullo storico.

## Vincoli pratici

- Aggiungere un utente = una voce in `UTENTI_CONFIG` (`config.py`, backend) **e** in `PROFILI_UTENTE` (`app.js`, login lato client), con lo **stesso** `db_prefix`.
- Non versionati (`.gitignore`): `database/` (dati + PDF), `secrets_local.py` (chiave Gemini), `backup_nas/` (backup pre-pubblicazione).
