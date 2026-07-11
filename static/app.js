// app.js

// --- STATO DELL'APPLICAZIONE ---
const state = {
    user: null, // conterrà { username, ruolo, prefix }
    apiBaseUrl: "",
    storageMode: "server", // 'server' o 'local'
    data: {
        // RIFIUTI (TARI) è solo-bollette: niente letture (readings resta a 3 utenze).
        bills: { LUCE: [], GAS: [], ACQUA: [], RIFIUTI: [] },
        readings: { LUCE: [], GAS: [], ACQUA: [] }
    },
    charts: {
        spese: null,
        consumi: null,
        consumiMensili: null,
        audit: null,
        prezzi: null,
        confronto: null,
        confrontoLuce: null,
        confrontoGas: null,
        confrontoAcqua: null
    },
    activeTab: "tab-dashboard",
    dashboardYear: null, // anno selezionato nella dashboard (null = anno corrente)
    currentBillFilter: "all",
    currentReadingFilter: "all",
    billDateFrom: "", billDateTo: "",       // filtro intervallo date tabella bollette
    readingDateFrom: "", readingDateTo: "", // filtro intervallo date tabella letture
    editingBill: null,    // { utility, index } se si sta MODIFICANDO una bolletta (null = nuova)
    editingReading: null, // { utility, index } se si sta MODIFICANDO una lettura (null = nuova)
    tempPdfFile: null // File temporaneo caricato durante l'inserimento bolletta
};

// Mappa traduzione mesi
const MESI_IT_BREVE = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];
const MESI_IT = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];

// Mese di rilievo di una lettura, come "Marzo 2026", dalla sua data. "—" se data assente.
function meseDiRilievo(dateStr) {
    const ym = monthKey(dateStr);
    if (!ym) return "—";
    const [y, m] = ym.split("-");
    return `${MESI_IT[parseInt(m, 10) - 1]} ${y}`;
}

// Soglie (in mesi) per il promemoria "dati mancanti", configurabili per utenza in
// Impostazioni e salvate in localStorage. Default: bolletta dopo 3 mesi, lettura dopo 1.
const SOGLIE_DATI_DEFAULT = {
    LUCE:  { bollette: 3, letture: 1 },
    GAS:   { bollette: 3, letture: 1 },
    ACQUA: { bollette: 3, letture: 1 },
    // RIFIUTI: tassa annuale, soglia bolletta 12 mesi; nessuna lettura (letture: 0).
    RIFIUTI: { bollette: 12, letture: 0 }
};

// Legge le soglie salvate (merge col default, così campi mancanti/corrotti non rompono).
function getSoglieDati() {
    let salvate = {};
    try {
        salvate = JSON.parse(localStorage.getItem("consumicasa_soglie_dati")) || {};
    } catch (e) {
        salvate = {};
    }
    const out = {};
    ["LUCE", "GAS", "ACQUA", "RIFIUTI"].forEach(ut => {
        const d = SOGLIE_DATI_DEFAULT[ut];
        const s = salvate[ut] || {};
        const bol = parseInt(s.bollette, 10);
        const let_ = parseInt(s.letture, 10);
        out[ut] = {
            bollette: (isFinite(bol) && bol > 0) ? bol : d.bollette,
            // letture può essere 0 (es. RIFIUTI = nessuna soglia letture): 0 valido.
            letture: (isFinite(let_) && let_ >= 0) ? let_ : d.letture
        };
    });
    return out;
}

// Profili utente (senza password): determinano il prefisso usato per i file dati.
// Il login avviene interamente lato client, così funziona anche col backend spento
// (sola lettura tramite i JSON statici serviti da Home Assistant).
const PROFILI_UTENTE = {
    Matteo: { ruolo: "admin", prefix: "UserA" },
    Dario:  { ruolo: "user",  prefix: "UserB" },
    Test:   { ruolo: "user",  prefix: "UserC" },
    Test_2: { ruolo: "user",  prefix: "UserD" }
};

// --- INIZIALIZZAZIONE ---
document.addEventListener("DOMContentLoaded", () => {
    initSettings();
    initEventListeners();
    checkLogin();
    
    // Inizializza le icone Lucide
    lucide.createIcons();
});

// Configura l'indirizzo delle API in base all'ambiente
function initSettings() {
    const savedApiUrl = localStorage.getItem("consumicasa_api_url");
    const savedStorageMode = localStorage.getItem("consumicasa_storage_mode");
    
    if (savedStorageMode) {
        state.storageMode = savedStorageMode;
    }
    
    if (savedApiUrl) {
        // L'utente ha configurato esplicitamente l'indirizzo del backend (es. il PC).
        state.apiBaseUrl = savedApiUrl;
    } else if (window.location.port === "8000") {
        // L'app è servita dallo stesso backend Python: usa percorso relativo.
        state.apiBaseUrl = "";
    } else {
        // App servita altrove (es. Home Assistant su :8123) e nessun indirizzo backend
        // configurato. NON indoviniamo l'host (il backend è su un'altra macchina, es. il
        // PC): restiamo relativi così, se il backend non risponde, scatta il fallback di
        // lettura dei JSON statici serviti da HA. Per inserire/salvare imposta l'indirizzo
        // del PC (es. http://192.168.1.11:8000) in Impostazioni.
        state.apiBaseUrl = "";
    }

    // Compila i campi form impostazioni
    document.getElementById("settings-storage-mode").value = state.storageMode;
    document.getElementById("settings-api-url").value = state.apiBaseUrl;

    // Compila i campi delle soglie promemoria dati (per utenza).
    const soglie = getSoglieDati();
    ["luce", "gas", "acqua", "rifiuti"].forEach(u => {
        const ut = u.toUpperCase();
        const elB = document.getElementById(`soglia-${u}-bollette`);
        const elL = document.getElementById(`soglia-${u}-letture`); // assente per rifiuti
        if (elB) elB.value = soglie[ut].bollette;
        if (elL) elL.value = soglie[ut].letture;
    });

    if (state.storageMode === "local") {
        document.getElementById("settings-api-url-group").classList.add("hidden");
    }
}

// Salva le soglie promemoria dati (per utenza) in localStorage e aggiorna la Dashboard.
function saveSoglieDati() {
    const leggi = (id, def) => {
        const v = parseInt(document.getElementById(id).value, 10);
        return (isFinite(v) && v > 0) ? v : def;
    };
    const soglie = {
        LUCE:  { bollette: leggi("soglia-luce-bollette", 3),  letture: leggi("soglia-luce-letture", 1) },
        GAS:   { bollette: leggi("soglia-gas-bollette", 3),   letture: leggi("soglia-gas-letture", 1) },
        ACQUA: { bollette: leggi("soglia-acqua-bollette", 3), letture: leggi("soglia-acqua-letture", 1) },
        RIFIUTI: { bollette: leggi("soglia-rifiuti-bollette", 12), letture: 0 }
    };
    localStorage.setItem("consumicasa_soglie_dati", JSON.stringify(soglie));
    alert("Soglie salvate. Il promemoria nella Dashboard è aggiornato.");
    if (state.activeTab === "tab-dashboard") renderDatiMancanti();
}

// Verifica se l'utente è loggato
function checkLogin() {
    const sessionUser = sessionStorage.getItem("consumicasa_user") || localStorage.getItem("consumicasa_user");
    if (sessionUser) {
        state.user = JSON.parse(sessionUser);
        document.getElementById("login-overlay").classList.add("hidden");
        document.getElementById("current-user-display").textContent = state.user.username;
        checkSyncAndLoad();
    } else {
        document.getElementById("login-overlay").classList.remove("hidden");
        document.getElementById("current-user-display").textContent = "Non connesso";
    }
}

// --- GESTIONE DEGLI EVENTI ---
function initEventListeners() {
    // Navigazione Tab
    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const btnTarget = e.currentTarget;
            const targetTab = btnTarget.getAttribute("data-tab");
            switchTab(targetTab);
        });
    });

    // Login Form
    document.getElementById("login-form").addEventListener("submit", handleLogin);
    
    // Logout
    document.getElementById("btn-logout").addEventListener("click", handleLogout);

    // Salvataggio Impostazioni
    document.getElementById("btn-save-settings").addEventListener("click", saveSettings);

    // Salvataggio soglie promemoria dati
    document.getElementById("btn-save-soglie").addEventListener("click", saveSoglieDati);

    // Controllo stato codice applicazione (locale vs NAS)
    document.getElementById("btn-check-app-status").addEventListener("click", () => checkAppCodeStatus(true));

    // Pubblicazione del codice app sul NAS (con backup preventivo)
    document.getElementById("btn-publish-app").addEventListener("click", publishAppToNas);

    // Banner di avviso codice app: vai alle impostazioni / chiudi
    document.getElementById("app-code-warning-go").addEventListener("click", () => {
        switchTab("tab-settings");
        document.getElementById("app-code-warning").classList.add("hidden");
        checkAppCodeStatus(true);
    });
    document.getElementById("app-code-warning-close").addEventListener("click", () => {
        document.getElementById("app-code-warning").classList.add("hidden");
    });
    
    // Selezione Modalità Storage in Impostazioni
    document.getElementById("settings-storage-mode").addEventListener("change", (e) => {
        const mode = e.target.value;
        const apiGroup = document.getElementById("settings-api-url-group");
        if (mode === "local") {
            apiGroup.classList.add("hidden");
        } else {
            apiGroup.classList.remove("hidden");
        }
    });

    // Filtri tabelle Bollette
    document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            state.currentBillFilter = e.target.getAttribute("data-utility");
            renderBillsTable();
        });
    });

    // Filtro intervallo date tabella Bollette
    document.getElementById("bill-filter-from").addEventListener("change", (e) => {
        state.billDateFrom = e.target.value;
        renderBillsTable();
    });
    document.getElementById("bill-filter-to").addEventListener("change", (e) => {
        state.billDateTo = e.target.value;
        renderBillsTable();
    });
    document.getElementById("bill-filter-reset").addEventListener("click", () => {
        state.billDateFrom = ""; state.billDateTo = "";
        document.getElementById("bill-filter-from").value = "";
        document.getElementById("bill-filter-to").value = "";
        renderBillsTable();
    });

    // Filtri tabelle Letture
    document.querySelectorAll(".filter-btn-reading").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".filter-btn-reading").forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            state.currentReadingFilter = e.target.getAttribute("data-utility");
            renderReadingsTable();
        });
    });

    // Filtro intervallo date tabella Letture
    document.getElementById("reading-filter-from").addEventListener("change", (e) => {
        state.readingDateFrom = e.target.value;
        renderReadingsTable();
    });
    document.getElementById("reading-filter-to").addEventListener("change", (e) => {
        state.readingDateTo = e.target.value;
        renderReadingsTable();
    });
    document.getElementById("reading-filter-reset").addEventListener("click", () => {
        state.readingDateFrom = ""; state.readingDateTo = "";
        document.getElementById("reading-filter-from").value = "";
        document.getElementById("reading-filter-to").value = "";
        renderReadingsTable();
    });

    // Panel Inserimento Bolletta (Apri/Chiudi)
    document.getElementById("btn-nuova-bolletta").addEventListener("click", () => {
        document.getElementById("panel-inserimento-bolletta").classList.remove("hidden");
        resetBillForm();
    });
    
    document.getElementById("btn-chiudi-inserimento").addEventListener("click", () => {
        document.getElementById("panel-inserimento-bolletta").classList.add("hidden");
        resetBillForm(); // esce dall'eventuale modalità modifica
    });

    // Utenza Form Bolletta change (LUCE vs GAS/ACQUA)
    document.getElementById("bill-utility").addEventListener("change", (e) => {
        toggleUtilityFields(e.target.value, "bill");
    });
    
    // Utenza Form Lettura change
    document.getElementById("read-utility").addEventListener("change", (e) => {
        toggleUtilityFields(e.target.value, "read");
    });

    // Calcolo automatico Lettura Totale Luce nel Form Bolletta
    const calcLuceTotale = () => {
        const f1 = parseInt(document.getElementById("bill-f1").value) || 0;
        const f2 = parseInt(document.getElementById("bill-f2").value) || 0;
        const f3 = parseInt(document.getElementById("bill-f3").value) || 0;
        document.getElementById("bill-luce-totale").value = f1 + f2 + f3;
    };
    document.getElementById("bill-f1").addEventListener("input", calcLuceTotale);
    document.getElementById("bill-f2").addEventListener("input", calcLuceTotale);
    document.getElementById("bill-f3").addEventListener("input", calcLuceTotale);

    // Calcolo automatico Lettura Totale Luce nel Form Letture Manuali
    const calcLuceTotaleRead = () => {
        const f1 = parseInt(document.getElementById("read-f1").value) || 0;
        const f2 = parseInt(document.getElementById("read-f2").value) || 0;
        const f3 = parseInt(document.getElementById("read-f3").value) || 0;
        document.getElementById("read-value").value = f1 + f2 + f3;
    };
    document.getElementById("read-f1").addEventListener("input", calcLuceTotaleRead);
    document.getElementById("read-f2").addEventListener("input", calcLuceTotaleRead);
    document.getElementById("read-f3").addEventListener("input", calcLuceTotaleRead);

    // Drag and Drop PDF
    const dropArea = document.getElementById("pdf-drag-drop");
    const fileInput = document.getElementById("pdf-file-input");

    dropArea.addEventListener("click", () => fileInput.click());
    
    dropArea.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropArea.style.borderColor = "var(--color-accent)";
        dropArea.style.backgroundColor = "rgba(99, 102, 241, 0.05)";
    });

    dropArea.addEventListener("dragleave", () => {
        dropArea.style.borderColor = "var(--border-glass)";
        dropArea.style.backgroundColor = "transparent";
    });

    dropArea.addEventListener("drop", (e) => {
        e.preventDefault();
        dropArea.style.borderColor = "var(--border-glass)";
        dropArea.style.backgroundColor = "transparent";
        
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type === "application/pdf") {
            handlePdfSelected(files[0]);
        }
    });

    fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) {
            handlePdfSelected(e.target.files[0]);
        }
    });

    document.getElementById("btn-rimuovi-pdf").addEventListener("click", removePdfFile);

    // Form Submit Bolletta
    document.getElementById("form-bolletta").addEventListener("submit", saveNewBill);
    
    // Form Submit Lettura Manuale
    document.getElementById("form-lettura").addEventListener("submit", saveNewReading);

    // Annulla modifica lettura
    document.getElementById("btn-annulla-modifica-lettura").addEventListener("click", annullaModificaLettura);

    // Modal close
    document.getElementById("btn-close-modal").addEventListener("click", () => {
        document.getElementById("modal-dettaglio-bolletta").classList.add("hidden");
        document.getElementById("modal-pdf-frame").src = "";
    });

    // Utenza select in Verifica
    document.getElementById("audit-utility-select").addEventListener("change", () => {
        renderAuditTab();
    });

    // Selettore anno nella Dashboard
    document.getElementById("dashboard-year-select").addEventListener("change", (e) => {
        state.dashboardYear = parseInt(e.target.value, 10);
        renderDashboard();
    });

    // Tab Andamento Prezzi: selettore utenza e soglia di segnalazione
    document.getElementById("prezzi-utility-select").addEventListener("change", renderPrezziTab);
    document.getElementById("prezzi-soglia").addEventListener("input", renderPrezziTab);

    // Tab Confronto Periodi: durata, periodi A/B, soglia
    ["confronto-durata", "confronto-a-mese", "confronto-b-mese", "confronto-soglia"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", renderConfrontoTab);
    });

    // Avviso nella pagina Anomalie → porta alla tab Andamento Prezzi
    document.getElementById("audit-prezzi-alert").addEventListener("click", () => {
        switchTab("tab-prezzi");
    });

    // Backup & Restore
    document.getElementById("btn-export-backup").addEventListener("click", exportBackup);
    document.getElementById("btn-trigger-import").addEventListener("click", () => {
        document.getElementById("import-backup-file").click();
    });
    document.getElementById("import-backup-file").addEventListener("change", importBackup);

    // Allineamento Sync NAS
    document.getElementById("btn-sync-download-all").addEventListener("click", async () => {
        const success = await resolveSyncConflict("download", null);
        if (success) {
            alert("Allineamento completato: tutti i file sul PC sono stati aggiornati con quelli del NAS.");
            checkSyncAndLoad();
        }
    });
    
    document.getElementById("btn-sync-upload-all").addEventListener("click", async () => {
        const success = await resolveSyncConflict("upload", null);
        if (success) {
            alert("Allineamento completato: tutti i file del NAS sono stati aggiornati con quelli del PC.");
            checkSyncAndLoad();
        }
    });
    
    document.getElementById("btn-sync-skip").addEventListener("click", () => {
        document.getElementById("sync-overlay").classList.add("hidden");
        loadData();
    });
}

// --- LOGICA DI NAVIGAZIONE E LOGIN ---
function switchTab(tabId) {
    state.activeTab = tabId;
    
    // Cambia pulsante attivo
    document.querySelectorAll(".nav-btn").forEach(btn => {
        if (btn.getAttribute("data-tab") === tabId) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    // Cambia vista attiva
    document.querySelectorAll(".tab-content").forEach(tab => {
        if (tab.id === tabId) {
            tab.classList.add("active");
        } else {
            tab.classList.remove("active");
        }
    });

    // Trigger aggiornamento dati o grafici specifici
    if (tabId === "tab-dashboard") {
        renderDashboard();
    } else if (tabId === "tab-bollette") {
        renderBillsTable();
    } else if (tabId === "tab-letture") {
        renderReadingsTable();
    } else if (tabId === "tab-verifica") {
        renderAuditTab();
    } else if (tabId === "tab-prezzi") {
        renderPrezziTab();
    } else if (tabId === "tab-confronto") {
        renderConfrontoTab();
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById("login-username").value;
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";

    // Login senza password e senza backend: il profilo scelto determina il prefisso
    // dei file dati. Funziona identico col server acceso o spento (in quest'ultimo
    // caso i dati vengono letti dai JSON statici serviti da Home Assistant).
    const profilo = PROFILI_UTENTE[username];
    if (!profilo) {
        errorEl.textContent = "Profilo utente non valido.";
        return;
    }

    state.user = { username, ruolo: profilo.ruolo, prefix: profilo.prefix };
    sessionStorage.setItem("consumicasa_user", JSON.stringify(state.user));
    checkLogin();
}

function handleLogout() {
    sessionStorage.removeItem("consumicasa_user");
    localStorage.removeItem("consumicasa_user");
    state.user = null;
    checkLogin();
}

function saveSettings() {
    const mode = document.getElementById("settings-storage-mode").value;
    const apiUrl = document.getElementById("settings-api-url").value.trim();
    
    localStorage.setItem("consumicasa_storage_mode", mode);
    localStorage.setItem("consumicasa_api_url", apiUrl);
    
    state.storageMode = mode;
    state.apiBaseUrl = apiUrl;
    
    alert("Impostazioni salvate con successo! L'applicazione verrà ricaricata.");
    window.location.reload();
}

// Visualizza/Nasconde campi specifici in base all'utenza selezionata
function toggleUtilityFields(utility, formPrefix) {
    if (formPrefix === "bill") {
        const fieldsLuce = document.getElementById("fields-luce");
        const fieldsGasAcqua = document.getElementById("fields-gas-acqua");
        const labelGasAcqua = document.getElementById("label-lettura-gas-acqua");
        
        if (utility === "LUCE") {
            fieldsLuce.classList.remove("hidden");
            fieldsGasAcqua.classList.add("hidden");
            document.getElementById("bill-luce-totale").required = true;
            document.getElementById("bill-reading").required = false;
        } else if (utility === "RIFIUTI") {
            // RIFIUTI (TARI): nessun contatore → nascondi tutti i campi lettura.
            fieldsLuce.classList.add("hidden");
            fieldsGasAcqua.classList.add("hidden");
            document.getElementById("bill-luce-totale").required = false;
            document.getElementById("bill-reading").required = false;
        } else {
            fieldsLuce.classList.add("hidden");
            fieldsGasAcqua.classList.remove("hidden");
            labelGasAcqua.innerHTML = utility === "GAS" ? "Lettura Contatore Gas (SMC)" : "Lettura Contatore Acqua (m³)";
            document.getElementById("bill-luce-totale").required = false;
            document.getElementById("bill-reading").required = true;
        }
    } else if (formPrefix === "read") {
        const readFieldsLuce = document.getElementById("read-fields-luce");
        const labelValue = document.getElementById("label-lettura-valore");
        
        if (utility === "LUCE") {
            readFieldsLuce.classList.remove("hidden");
            labelValue.innerHTML = "Lettura Totale Contatore (kWh)";
        } else {
            readFieldsLuce.classList.add("hidden");
            labelValue.innerHTML = utility === "GAS" ? "Lettura Contatore (SMC)" : "Lettura Contatore (m³)";
        }
    }
}

// --- CARICAMENTO E SALVATAGGIO DEI DATI ---
async function loadData() {
    if (!state.user) return;
    
    // RIFIUTI ha solo bollette (niente letture). Lista completa per le bollette,
    // e una lista "con letture" separata per non creare readings.RIFIUTI.
    const utilities = ["LUCE", "GAS", "ACQUA", "RIFIUTI"];
    const utilitiesConLetture = ["LUCE", "GAS", "ACQUA"];

    if (state.storageMode === "local") {
        // Carica da LocalStorage
        utilities.forEach(ut => {
            const bKey = `local_${state.user.prefix}_${ut.toLowerCase()}`;
            state.data.bills[ut] = JSON.parse(localStorage.getItem(bKey)) || [];
        });
        utilitiesConLetture.forEach(ut => {
            const rKey = `local_${state.user.prefix}_man_${ut.toLowerCase()}`;
            state.data.readings[ut] = JSON.parse(localStorage.getItem(rKey)) || [];
        });
        updateBackendStatusBadge("local");
        renderDashboard();
        return;
    }

    // Modalità server (Python backend)
    try {
        let online = false;
        
        // Prima verifichiamo la raggiungibilità del server sulla porta 8000
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500);
            const check = await fetch(`${state.apiBaseUrl}/api/data?user=${state.user.username}&utility=LUCE&type=bill`, { signal: controller.signal });
            if (check.ok) online = true;
            clearTimeout(timeoutId);
        } catch(e) {
            online = false;
        }
        
        if (online) {
            // Sincronizza eventuali letture manuali salvate offline (se presenti)
            await syncPendingReadingsToServer();
            
            for (const ut of utilities) {
                // Carica bollette (tutte le utenze, RIFIUTI incluso)
                const bRes = await fetch(`${state.apiBaseUrl}/api/data?user=${state.user.username}&utility=${ut}&type=bill`);
                if (bRes.ok) state.data.bills[ut] = await bRes.json();

                // Carica letture solo per le utenze con contatore (no RIFIUTI)
                if (ut !== "RIFIUTI") {
                    const rRes = await fetch(`${state.apiBaseUrl}/api/data?user=${state.user.username}&utility=${ut}&type=manual`);
                    if (rRes.ok) state.data.readings[ut] = await rRes.json();
                }
            }
            updateBackendStatusBadge("online");
        } else {
            // Se il server Python porta 8000 è spento, proviamo a caricare i JSON statici direttamente da Home Assistant (porta 8123)
            let loadedFromHAStatic = false;
            try {
                for (const ut of utilities) {
                    const prefix = state.user.prefix;
                    const controllerB = new AbortController();
                    const timeoutB = setTimeout(() => controllerB.abort(), 1500);
                    const bRes = await fetch(`../database/${prefix}_${ut.toLowerCase()}.json`, { signal: controllerB.signal });
                    if (bRes.ok) {
                        state.data.bills[ut] = await bRes.json();
                        loadedFromHAStatic = true;
                    }
                    clearTimeout(timeoutB);

                    // Letture solo per le utenze con contatore (no RIFIUTI)
                    if (ut !== "RIFIUTI") {
                        const controllerR = new AbortController();
                        const timeoutR = setTimeout(() => controllerR.abort(), 1500);
                        const rRes = await fetch(`../database/${prefix}_man_${ut.toLowerCase()}.json`, { signal: controllerR.signal });
                        if (rRes.ok) {
                            state.data.readings[ut] = await rRes.json();
                            loadedFromHAStatic = true;
                        }
                        clearTimeout(timeoutR);
                    }
                }
            } catch(staticErr) {
                console.error("Impossibile caricare JSON statici da HA:", staticErr);
                loadedFromHAStatic = false;
            }
            
            if (loadedFromHAStatic) {
                updateBackendStatusBadge("ha-static");
                // Applica le letture salvate offline a livello di interfaccia temporanea
                applyLocalPendingReadings();
            } else {
                // Fallback totale LocalStorage
                utilities.forEach(ut => {
                    const bKey = `local_${state.user.prefix}_${ut.toLowerCase()}`;
                    const rKey = `local_${state.user.prefix}_man_${ut.toLowerCase()}`;
                    state.data.bills[ut] = JSON.parse(localStorage.getItem(bKey)) || [];
                    state.data.readings[ut] = JSON.parse(localStorage.getItem(rKey)) || [];
                });
                updateBackendStatusBadge("offline");
            }
        }
    } catch (err) {
        console.error("Errore nel caricamento dati:", err);
        updateBackendStatusBadge("offline");
    }
    
    renderDashboard();
}

// recordModificato (opzionale): il record appena inserito/modificato. Serve al ramo
// offline per accodare in "pending" la lettura GIUSTA anche quando è arretrata (dopo il
// sort non sarebbe l'ultimo dell'array). Se omesso, si ricade sull'ultimo per data.
async function saveUtilityData(utility, dataType, recordModificato) {
    if (!state.user) return;
    const isManual = (dataType === "manual");
    const records = isManual ? state.data.readings[utility] : state.data.bills[utility];
    
    // Ordiniamo sempre prima di salvare
    records.sort((a, b) => a.data.localeCompare(b.data));

    if (state.storageMode === "local") {
        const key = `local_${state.user.prefix}_${isManual ? 'man_' : ''}${utility.toLowerCase()}`;
        localStorage.setItem(key, JSON.stringify(records));
        loadData();
        return;
    }

    try {
        const response = await fetch(`${state.apiBaseUrl}/api/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user: state.user.username,
                utility: utility,
                type: dataType,
                records: records
            })
        });
        if (!response.ok) {
            throw new Error("Errore salvataggio server.");
        }
        loadData();
    } catch (err) {
        console.error("Errore nel salvataggio dei dati remoti:", err);
        if (isManual) {
            // Se stiamo salvando un'autolettura e il server è offline, la salviamo localmente come "pending".
            // Usa il record appena inserito se fornito (corretto anche per letture arretrate),
            // altrimenti ricade sull'ultimo per data.
            savePendingReadingOffline(utility, recordModificato || records[records.length - 1]);
            alert("Il server backend Python è offline. La lettura è stata salvata localmente nel browser del telefono e verrà caricata sul NAS automaticamente non appena riavvierai il server Python sul tuo PC!");
            loadData();
        } else {
            alert("Impossibile salvare la bolletta: il server Python (porta 8000) sul PC deve essere attivo per caricare i file PDF e salvare i dati sul NAS.");
        }
    }
}

// Salva un'autolettura offline in LocalStorage
function savePendingReadingOffline(utility, readingRecord) {
    const key = `pending_readings_${state.user.prefix}`;
    const pending = JSON.parse(localStorage.getItem(key)) || [];
    pending.push({ utility, record: readingRecord });
    localStorage.setItem(key, JSON.stringify(pending));
}

// Applica le letture salvate offline allo stato corrente (in memoria temporanea per la UI)
function applyLocalPendingReadings() {
    const key = `pending_readings_${state.user.prefix}`;
    const pending = JSON.parse(localStorage.getItem(key)) || [];
    pending.forEach(item => {
        // Verifica se è già presente per evitare duplicati
        const exists = state.data.readings[item.utility].some(x => x.data === item.record.data);
        if (!exists) {
            state.data.readings[item.utility].push(item.record);
            state.data.readings[item.utility].sort((a, b) => a.data.localeCompare(b.data));
        }
    });
}

// Invia le letture manuali accumulate offline al server Python
async function syncPendingReadingsToServer() {
    const key = `pending_readings_${state.user.prefix}`;
    const pending = JSON.parse(localStorage.getItem(key)) || [];
    if (pending.length === 0) return;
    
    console.log(`Rilevate ${pending.length} letture offline da sincronizzare...`);
    
    try {
        // Raggruppa per utenza per fare salvataggi cumulativi
        const grouped = {};
        pending.forEach(item => {
            if (!grouped[item.utility]) grouped[item.utility] = [];
            grouped[item.utility].push(item.record);
        });
        
        for (const ut of Object.keys(grouped)) {
            // Carica le letture correnti dal server
            const res = await fetch(`${state.apiBaseUrl}/api/data?user=${state.user.username}&utility=${ut}&type=manual`);
            if (res.ok) {
                const serverReadings = await res.json();
                
                // Unisci le letture offline evitando duplicati
                grouped[ut].forEach(offlineRec => {
                    const exists = serverReadings.some(x => x.data === offlineRec.data);
                    if (!exists) {
                        serverReadings.push(offlineRec);
                    }
                });
                
                // Salva l'array combinato sul server
                serverReadings.sort((a, b) => a.data.localeCompare(b.data));
                await fetch(`${state.apiBaseUrl}/api/save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        user: state.user.username,
                        utility: ut,
                        type: "manual",
                        records: serverReadings
                    })
                });
            }
        }
        
        // Pulisci lo storage offline dopo il successo
        localStorage.removeItem(key);
        alert(`Sincronizzazione completata: ${pending.length} autoletture inserite dal telefono sono state caricate sul database del NAS!`);
    } catch(err) {
        console.error("Errore durante la sincronizzazione delle letture offline:", err);
    }
}

function updateBackendStatusBadge(status) {
    const statusDot = document.querySelector(".status-dot");
    const statusText = document.querySelector(".status-text");

    if (status === "local") {
        statusDot.className = "status-dot offline";
        statusText.textContent = "Memoria Locale (No Server)";
        statusText.style.color = "var(--text-secondary)";
        statusDot.style.backgroundColor = "";
        statusDot.style.boxShadow = "";
    } else if (status === "online") {
        statusDot.className = "status-dot online";
        statusText.textContent = "Connesso ad HA (Backend)";
        statusText.style.color = "var(--color-success)";
        statusDot.style.backgroundColor = "";
        statusDot.style.boxShadow = "";
    } else if (status === "ha-static") {
        statusDot.className = "status-dot";
        statusText.style.color = "#fb923c"; // Arancione
        statusText.textContent = "NAS Statico (Senza Python)";
        statusDot.style.backgroundColor = "#fb923c";
        statusDot.style.boxShadow = "0 0 8px #fb923c";
    } else {
        statusDot.className = "status-dot offline";
        statusText.textContent = "Backend Disconnesso";
        statusText.style.color = "var(--text-muted)";
        statusDot.style.backgroundColor = "";
        statusDot.style.boxShadow = "";
    }

    // Avviso in Impostazioni: mostra "manca l'indirizzo del backend" solo quando si è
    // in sola lettura HA (ha-static) E il campo indirizzo è vuoto (quindi configurabile).
    const alertEl = document.getElementById("api-url-mancante-alert");
    if (alertEl) {
        const indirizzoVuoto = !state.apiBaseUrl || state.apiBaseUrl.trim() === "";
        alertEl.classList.toggle("hidden", !(status === "ha-static" && indirizzoVuoto));
    }

    // Suggerimento rosso sotto lo status (in basso a sinistra): solo in sola lettura HA.
    const hintEl = document.getElementById("status-readonly-hint");
    if (hintEl) {
        hintEl.classList.toggle("hidden", status !== "ha-static");
    }
}

// --- RICEZIONE E CARICAMENTO PDF ---
// L'inserimento di una bolletta PDF richiede SEMPRE l'estrazione dati via Gemini.
// Se Gemini non è raggiungibile (offline, modalità locale, errore API), il PDF
// NON viene accettato: meglio bloccare l'inserimento che pre-compilare con dati
// inaffidabili. L'utente viene avvisato e può inserire la bolletta a mano (senza PDF).
async function handlePdfSelected(file) {
    const uploadingBadge = document.getElementById("uploading-badge");
    const previewBox = document.getElementById("pdf-preview-box");
    const previewFrame = document.getElementById("pdf-preview-frame");

    // In modalità locale non c'è backend: l'estrazione automatica è impossibile.
    if (state.storageMode === "local") {
        blockPdfInsertion("Senza connessione al server/Gemini non è possibile leggere la bolletta PDF. Inserisci i dati a mano.");
        return;
    }

    // Mostra lo stato di elaborazione, ma NON agganciare ancora il PDF né l'anteprima:
    // lo facciamo solo se Gemini risponde con successo.
    state.tempPdfFile = file;
    document.getElementById("pdf-drag-drop").classList.add("hidden");
    uploadingBadge.classList.remove("hidden");

    try {
        const formData = new FormData();
        formData.append("pdf", file);
        formData.append("utility", document.getElementById("bill-utility").value);

        const response = await fetch(`${state.apiBaseUrl}/api/parse-pdf`, {
            method: "POST",
            body: formData
        });

        if (response.ok) {
            const parsed = await response.json();
            // Successo: ora mostriamo l'anteprima e pre-compiliamo il form.
            previewFrame.src = URL.createObjectURL(file);
            previewBox.classList.remove("hidden");
            prefillBillForm(parsed);

            const aiBanner = document.getElementById("ai-status-banner");
            const aiText = document.getElementById("ai-status-text");
            aiBanner.classList.remove("hidden");
            aiText.textContent = "Analisi Gemini AI completata con successo!";
        } else {
            // Il backend c'è ma Gemini non è disponibile (503) o altro errore: blocca.
            let msg = "Estrazione automatica non riuscita: impossibile leggere la bolletta.";
            try {
                const errData = await response.json();
                if (errData && errData.message) msg = errData.message;
            } catch (e) { /* risposta non JSON: usa il messaggio di default */ }
            blockPdfInsertion(msg);
        }
    } catch (err) {
        // Errore di rete: il server Python sulla porta 8000 non è raggiungibile.
        console.error("Errore parsing PDF:", err);
        blockPdfInsertion("Impossibile raggiungere il server per leggere la bolletta. Verifica la connessione e riprova, oppure inserisci i dati a mano.");
    } finally {
        uploadingBadge.classList.add("hidden");
    }
}

// Blocca l'inserimento del PDF: rimuove il file agganciato, ripristina la drag-drop
// area e mostra un avviso. Nessun dato viene pre-compilato.
function blockPdfInsertion(message) {
    removePdfFile();
    document.getElementById("uploading-badge").classList.add("hidden");
    const aiBanner = document.getElementById("ai-status-banner");
    const aiText = document.getElementById("ai-status-text");
    aiBanner.classList.remove("hidden");
    aiBanner.classList.add("ai-banner-warning");
    aiText.textContent = message;
}

function prefillBillForm(data) {
    if (data.data) document.getElementById("bill-date").value = data.data;
    if (data.periodo_inizio) document.getElementById("bill-periodo-inizio").value = data.periodo_inizio;
    if (data.periodo_fine) document.getElementById("bill-periodo-fine").value = data.periodo_fine;
    if (data.consumo_fatturato != null) document.getElementById("bill-consumo-fatturato").value = data.consumo_fatturato;
    if (data.fattura) document.getElementById("bill-amount").value = data.fattura;
    // Scomposizione costi (per Andamento Prezzi): guard != null così uno 0 valido passa.
    if (data.quota_fissa != null) document.getElementById("bill-quota-fissa").value = data.quota_fissa;
    if (data.quota_energia != null) document.getElementById("bill-quota-energia").value = data.quota_energia;
    // Prezzo unitario: troncato a 3 decimali (più cifre non servono e l'input number
    // con step=0.001 rifiuterebbe valori con più decimali estratti da Gemini).
    if (data.prezzo_unitario_energia != null) {
        const pu = Math.round(parseFloat(data.prezzo_unitario_energia) * 1000) / 1000;
        document.getElementById("bill-prezzo-unitario-energia").value = isFinite(pu) ? pu : "";
    }

    const utility = document.getElementById("bill-utility").value;
    if (utility === "LUCE") {
        document.getElementById("bill-f1").value = data.lettura_f1 || 0;
        document.getElementById("bill-f2").value = data.lettura_f2 || 0;
        document.getElementById("bill-f3").value = data.lettura_f3 || 0;
        document.getElementById("bill-luce-totale").value = data.lettura_totale || (data.lettura_f1 + data.lettura_f2 + data.lettura_f3) || 0;
    } else if (utility === "RIFIUTI") {
        // nessun campo lettura da pre-compilare per i rifiuti
    } else {
        document.getElementById("bill-reading").value = data.lettura || 0;
    }
}

function removePdfFile() {
    state.tempPdfFile = null;
    document.getElementById("form-bill-pdf-path").value = "";
    document.getElementById("pdf-preview-box").classList.add("hidden");
    document.getElementById("pdf-preview-frame").src = "";
    document.getElementById("pdf-drag-drop").classList.remove("hidden");
    const aiBanner = document.getElementById("ai-status-banner");
    aiBanner.classList.add("hidden");
    aiBanner.classList.remove("ai-banner-warning");
}

function resetBillForm() {
    document.getElementById("form-bolletta").reset();
    removePdfFile();
    toggleUtilityFields("LUCE", "bill");
    // Esci dalla modalità modifica e ripristina titolo/pulsante.
    state.editingBill = null;
    const t = document.getElementById("panel-bolletta-title");
    if (t) t.textContent = "Registrazione Nuova Bolletta";
    const b = document.getElementById("btn-salva-bolletta-text");
    if (b) b.textContent = "Salva Bolletta";
}

// --- FUNZIONI DI SALVATAGGIO DEI MODULI ---
async function saveNewBill(e) {
    e.preventDefault();
    const utility = document.getElementById("bill-utility").value;
    const date = document.getElementById("bill-date").value;
    const amount = parseFloat(document.getElementById("bill-amount").value) || null;
    const billType = document.getElementById("bill-type").value;
    const notes = document.getElementById("bill-notes").value.trim();
    
    // In modifica si parte dal PDF già allegato (non si ricarica il PDF in modifica).
    const inModifica = state.editingBill && state.data.bills[state.editingBill.utility]
        && state.data.bills[state.editingBill.utility][state.editingBill.index];
    let pdfPath = inModifica ? (inModifica.pdf_path || null) : null;

    // 1. Carica il PDF sul server se presente (solo per nuove bollette con PDF)
    if (state.tempPdfFile && state.storageMode !== "local") {
        try {
            const formData = new FormData();
            formData.append("pdf", state.tempPdfFile);
            formData.append("user", state.user.username);
            formData.append("utility", utility);
            
            const uploadRes = await fetch(`${state.apiBaseUrl}/api/upload-pdf`, {
                method: "POST",
                body: formData
            });
            if (uploadRes.ok) {
                const uploadData = await uploadRes.json();
                pdfPath = uploadData.pdf_path;
            }
        } catch (err) {
            console.error("Errore caricamento definitivo PDF:", err);
        }
    }

    const periodoInizio = document.getElementById("bill-periodo-inizio").value || null;
    const periodoFine = document.getElementById("bill-periodo-fine").value || null;
    const consumoFatturatoRaw = document.getElementById("bill-consumo-fatturato").value;
    const consumoFatturato = consumoFatturatoRaw !== "" ? parseFloat(consumoFatturatoRaw) : null;

    // Scomposizione costi (opzionale, usata dall'analisi Andamento Prezzi).
    // Campo vuoto → null (= dato non disponibile, lo storico ne è privo).
    const quotaFissaRaw = document.getElementById("bill-quota-fissa").value;
    const quotaEnergiaRaw = document.getElementById("bill-quota-energia").value;
    const prezzoUnitarioRaw = document.getElementById("bill-prezzo-unitario-energia").value;

    // Costruisci record
    const record = {
        data: date,
        periodo_inizio: periodoInizio,
        periodo_fine: periodoFine,
        consumo_fatturato: consumoFatturato,
        fattura: amount,
        pdf_path: pdfPath,
        tipo_lettura: billType, // Stimata, Rilevata, Mista
        note: notes,
        quota_fissa: quotaFissaRaw !== "" ? parseFloat(quotaFissaRaw) : null,
        quota_energia: quotaEnergiaRaw !== "" ? parseFloat(quotaEnergiaRaw) : null,
        prezzo_unitario_energia: prezzoUnitarioRaw !== "" ? parseFloat(prezzoUnitarioRaw) : null
    };

    if (utility === "LUCE") {
        const f1 = parseInt(document.getElementById("bill-f1").value) || 0;
        const f2 = parseInt(document.getElementById("bill-f2").value) || 0;
        const f3 = parseInt(document.getElementById("bill-f3").value) || 0;
        record.lettura_f1 = f1;
        record.lettura_f2 = f2;
        record.lettura_f3 = f3;
        record.lettura_totale = parseInt(document.getElementById("bill-luce-totale").value) || (f1 + f2 + f3);
    } else if (utility === "RIFIUTI") {
        // RIFIUTI (TARI): nessuna lettura né consumo/quote. Solo periodo + importo.
        record.consumo_fatturato = null;
        record.quota_fissa = null;
        record.quota_energia = null;
        record.prezzo_unitario_energia = null;
    } else {
        record.lettura = parseInt(document.getElementById("bill-reading").value) || 0;
    }

    // 2. Aggiorna il record esistente (modifica) oppure aggiungilo (nuovo).
    if (state.editingBill && state.editingBill.utility === utility &&
        state.data.bills[utility][state.editingBill.index]) {
        state.data.bills[utility][state.editingBill.index] = record;
    } else if (state.editingBill && state.editingBill.utility !== utility) {
        // L'utenza è stata cambiata in modifica: rimuovi dal vecchio array e aggiungi al nuovo.
        state.data.bills[state.editingBill.utility].splice(state.editingBill.index, 1);
        state.data.bills[utility].push(record);
    } else {
        state.data.bills[utility].push(record);
    }

    // 3. Salva (se l'utenza è cambiata, salva entrambi gli array)
    await saveUtilityData(utility, "bill");
    if (state.editingBill && state.editingBill.utility !== utility) {
        await saveUtilityData(state.editingBill.utility, "bill");
    }

    // Pulisci e chiudi form
    state.editingBill = null;
    document.getElementById("panel-inserimento-bolletta").classList.add("hidden");
    resetBillForm();
}

async function saveNewReading(e) {
    e.preventDefault();
    const utility = document.getElementById("read-utility").value;
    const date = document.getElementById("read-date").value;
    const notes = document.getElementById("read-notes").value.trim();
    
    const record = {
        data: date,
        note: notes || "Lettura rilevata"
    };

    if (utility === "LUCE") {
        const f1 = parseInt(document.getElementById("read-f1").value) || 0;
        const f2 = parseInt(document.getElementById("read-f2").value) || 0;
        const f3 = parseInt(document.getElementById("read-f3").value) || 0;
        record.lettura_f1 = f1;
        record.lettura_f2 = f2;
        record.lettura_f3 = f3;
        record.lettura_totale = parseInt(document.getElementById("read-value").value) || (f1 + f2 + f3);

        // GUARDIA 1: il totale digitato a mano diverge dalla somma delle fasce.
        if (record.lettura_totale !== f1 + f2 + f3) {
            if (!confirm(`Il Totale inserito (${record.lettura_totale}) non corrisponde alla somma delle fasce F1+F2+F3 (${f1 + f2 + f3}).\n\nVuoi salvare comunque con questo totale?`)) {
                return;
            }
        }
    } else {
        record.lettura = parseInt(document.getElementById("read-value").value) || 0;
    }

    const nuovoValore = readingValue(record);

    // Se stiamo MODIFICANDO una lettura, ricaviamo l'indice del record originale (per
    // la stessa utenza) così da escluderlo dai controlli e aggiornarlo invece di duplicare.
    const inModifica = state.editingReading && state.editingReading.utility === utility;
    const idxModifica = inModifica ? state.editingReading.index : -1;

    // GUARDIA 2: esiste già un'ALTRA lettura per questa stessa data → propongo la sostituzione
    // (escludo il record che sto modificando, altrimenti darebbe un falso allarme).
    const idxStessaData = state.data.readings[utility].findIndex((x, i) => x.data === date && i !== idxModifica);
    if (idxStessaData !== -1) {
        if (!confirm(`Esiste già un'autolettura per il ${formatDate(date)}.\n\nVuoi SOSTITUIRLA con questo nuovo valore?`)) {
            return;
        }
    }

    // GUARDIA 3: lettura non crescente rispetto all'ultima precedente a questa data.
    // Il contatore è progressivo: un valore più basso è quasi sempre un errore di battitura.
    const precedenti = state.data.readings[utility]
        .filter((x, i) => x.data < date && i !== idxModifica)
        .sort((a, b) => a.data.localeCompare(b.data));
    const ultimaPrec = precedenti.length ? precedenti[precedenti.length - 1] : null;
    if (ultimaPrec && nuovoValore < readingValue(ultimaPrec)) {
        if (!confirm(`Attenzione: il valore inserito (${nuovoValore}) è MINORE dell'ultima lettura del ${formatDate(ultimaPrec.data)} (${readingValue(ultimaPrec)}).\n\nIl contatore di norma cresce sempre. Salvare comunque?`)) {
            return;
        }
    }

    // Applica. Casi:
    //  - modifica con stessa utenza → aggiorna il record all'indice originale;
    //  - modifica con utenza cambiata → rimuovi dal vecchio array, aggiungi al nuovo;
    //  - altrimenti: sostituisci se c'è una lettura della stessa data, altrimenti aggiungi.
    if (inModifica) {
        state.data.readings[utility][idxModifica] = record;
    } else if (state.editingReading && state.editingReading.utility !== utility) {
        state.data.readings[state.editingReading.utility].splice(state.editingReading.index, 1);
        if (idxStessaData !== -1) state.data.readings[utility][idxStessaData] = record;
        else state.data.readings[utility].push(record);
    } else if (idxStessaData !== -1) {
        state.data.readings[utility][idxStessaData] = record;
    } else {
        state.data.readings[utility].push(record);
    }
    await saveUtilityData(utility, "manual", record);
    if (state.editingReading && state.editingReading.utility !== utility) {
        await saveUtilityData(state.editingReading.utility, "manual");
    }

    // Esci dall'eventuale modalità modifica e ripristina il form.
    state.editingReading = null;
    document.getElementById("form-lettura").reset();
    toggleUtilityFields("LUCE", "read");
    const rt = document.getElementById("form-lettura-title");
    if (rt) rt.textContent = "Registra Nuova Rilevazione";
    const rb = document.getElementById("btn-salva-lettura-text");
    if (rb) rb.textContent = "Salva Lettura";
    const ra = document.getElementById("btn-annulla-modifica-lettura");
    if (ra) ra.classList.add("hidden");
}

async function deleteBill(utility, index) {
    if (!confirm("Sei sicuro di voler eliminare questa bolletta dallo storico?")) return;
    state.data.bills[utility].splice(index, 1);
    await saveUtilityData(utility, "bill");
}

// Apre il form di inserimento in modalità MODIFICA, pre-compilato col record scelto.
function editBill(utility, index) {
    const bill = state.data.bills[utility] && state.data.bills[utility][index];
    if (!bill) return;
    state.editingBill = { utility, index };

    // Apri il pannello e adatta titolo/pulsante.
    document.getElementById("panel-inserimento-bolletta").classList.remove("hidden");
    document.getElementById("panel-bolletta-title").textContent = "Modifica Bolletta";
    document.getElementById("btn-salva-bolletta-text").textContent = "Salva Modifiche";

    // Imposta l'utenza e mostra i campi giusti, poi compila tutto.
    document.getElementById("bill-utility").value = utility;
    toggleUtilityFields(utility, "bill");

    document.getElementById("bill-date").value = bill.data || "";
    document.getElementById("bill-periodo-inizio").value = bill.periodo_inizio || "";
    document.getElementById("bill-periodo-fine").value = bill.periodo_fine || "";
    document.getElementById("bill-consumo-fatturato").value = bill.consumo_fatturato != null ? bill.consumo_fatturato : "";
    document.getElementById("bill-amount").value = bill.fattura != null ? bill.fattura : "";
    document.getElementById("bill-type").value = bill.tipo_lettura || "rilevata";
    document.getElementById("bill-notes").value = bill.note || "";
    document.getElementById("bill-quota-fissa").value = bill.quota_fissa != null ? bill.quota_fissa : "";
    document.getElementById("bill-quota-energia").value = bill.quota_energia != null ? bill.quota_energia : "";
    document.getElementById("bill-prezzo-unitario-energia").value = bill.prezzo_unitario_energia != null ? bill.prezzo_unitario_energia : "";

    if (utility === "LUCE") {
        document.getElementById("bill-f1").value = bill.lettura_f1 || 0;
        document.getElementById("bill-f2").value = bill.lettura_f2 || 0;
        document.getElementById("bill-f3").value = bill.lettura_f3 || 0;
        document.getElementById("bill-luce-totale").value = bill.lettura_totale != null ? bill.lettura_totale : 0;
    } else if (utility === "RIFIUTI") {
        // nessun campo lettura per i rifiuti
    } else {
        document.getElementById("bill-reading").value = bill.lettura != null ? bill.lettura : 0;
    }

    // In modifica non si ricarica il PDF: nascondi il drag&drop e mostra che resta l'allegato.
    document.getElementById("panel-inserimento-bolletta").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteReading(utility, index) {
    if (!confirm("Sei sicuro di voler eliminare questa autolettura?")) return;
    state.data.readings[utility].splice(index, 1);
    await saveUtilityData(utility, "manual");
}

// Pre-compila il form letture in modalità MODIFICA col record scelto.
function editReading(utility, index) {
    const read = state.data.readings[utility] && state.data.readings[utility][index];
    if (!read) return;
    state.editingReading = { utility, index };

    document.getElementById("read-utility").value = utility;
    toggleUtilityFields(utility, "read");
    document.getElementById("read-date").value = read.data || "";
    document.getElementById("read-notes").value = (read.note && read.note !== "Lettura rilevata") ? read.note : "";

    if (utility === "LUCE") {
        document.getElementById("read-f1").value = read.lettura_f1 || 0;
        document.getElementById("read-f2").value = read.lettura_f2 || 0;
        document.getElementById("read-f3").value = read.lettura_f3 || 0;
        document.getElementById("read-value").value = read.lettura_totale != null ? read.lettura_totale : 0;
    } else {
        document.getElementById("read-value").value = read.lettura != null ? read.lettura : 0;
    }

    // Adatta titolo/pulsante e mostra "Annulla".
    const t = document.getElementById("form-lettura-title");
    if (t) t.textContent = "Modifica Rilevazione";
    const b = document.getElementById("btn-salva-lettura-text");
    if (b) b.textContent = "Salva Modifiche";
    const a = document.getElementById("btn-annulla-modifica-lettura");
    if (a) a.classList.remove("hidden");

    document.getElementById("form-lettura").scrollIntoView({ behavior: "smooth", block: "center" });
    lucide.createIcons();
}

// Annulla la modifica di una lettura: ripristina il form a "nuova rilevazione".
function annullaModificaLettura() {
    state.editingReading = null;
    document.getElementById("form-lettura").reset();
    toggleUtilityFields("LUCE", "read");
    const t = document.getElementById("form-lettura-title");
    if (t) t.textContent = "Registra Nuova Rilevazione";
    const b = document.getElementById("btn-salva-lettura-text");
    if (b) b.textContent = "Salva Lettura";
    const a = document.getElementById("btn-annulla-modifica-lettura");
    if (a) a.classList.add("hidden");
}

// --- CODICE RENDERIZZAZIONE INTERFACCIA (TAB) ---

// Restituisce, in ordine decrescente, gli anni per cui esistono bollette o letture.
function getAnniConDati() {
    const anni = new Set();
    ["bills", "readings"].forEach(tipo => {
        Object.keys(state.data[tipo]).forEach(ut => {
            state.data[tipo][ut].forEach(r => {
                const y = monthKey(r.data);
                if (y) anni.add(parseInt(y.slice(0, 4), 10));
            });
        });
    });
    return Array.from(anni).sort((a, b) => b - a);
}

// Popola il <select> dell'anno con gli anni che hanno dati e imposta state.dashboardYear.
// Default: anno in corso se presente tra i dati, altrimenti il più recente con dati.
function popolaSelettoreAnni() {
    const sel = document.getElementById("dashboard-year-select");
    if (!sel) return;
    const anni = getAnniConDati();
    const annoCorrente = new Date().getFullYear();

    // Determina l'anno attivo, mantenendo la scelta dell'utente se ancora valida.
    let attivo = state.dashboardYear;
    if (anni.length === 0) {
        attivo = annoCorrente;
    } else if (attivo == null || !anni.includes(attivo)) {
        attivo = anni.includes(annoCorrente) ? annoCorrente : anni[0];
    }
    state.dashboardYear = attivo;

    const opzioni = anni.length ? anni : [annoCorrente];
    sel.innerHTML = opzioni.map(y =>
        `<option value="${y}" ${y === attivo ? "selected" : ""}>${y}${y === annoCorrente ? " (in corso)" : ""}</option>`
    ).join("");
}

// --- PROMEMORIA DATI MANCANTI ---

// Numero di mesi (interi, arrotondati) tra due date 'YYYY-MM-DD'.
function mesiTraDate(d1, d2) {
    const a = new Date(d1), b = new Date(d2);
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

// Bolletta probabilmente mancante: se l'ultima è più vecchia della soglia (in mesi)
// configurata per l'utenza. Restituisce { ultima, mesiFa, soglia } se manca, altrimenti null.
function bollettaMancante(utility, oggi, soglia) {
    const date = (state.data.bills[utility] || [])
        .map(b => b.data)
        .filter(d => typeof d === "string")
        .sort((a, b) => a.localeCompare(b));
    if (date.length === 0) return null;
    const ultima = date[date.length - 1];
    const mesiFa = mesiTraDate(ultima, oggi);
    return mesiFa >= soglia ? { ultima, mesiFa, soglia } : null;
}

// Mesi (conclusi) senza lettura manuale, dal mese dopo l'ultima lettura fino al mese
// limite. Il limite è il mese corrente arretrato di 'soglia' mesi: con soglia=1 si
// avvisa per i mesi fino al mese scorso (il corrente non è ancora dovuto); con soglia
// maggiore si concede più tolleranza prima di segnalare. Restituisce array di 'YYYY-MM'.
function mesiLettureMancanti(utility, oggi, soglia) {
    const date = (state.data.readings[utility] || [])
        .map(r => r.data)
        .filter(d => typeof d === "string")
        .sort((a, b) => a.localeCompare(b));
    if (date.length === 0) return [];
    const ultimoMese = monthKey(date[date.length - 1]);
    if (!ultimoMese) return [];
    // Mese limite = mese corrente arretrato di 'soglia' mesi.
    let limite = `${oggi.getFullYear()}-${String(oggi.getMonth() + 1).padStart(2, "0")}`;
    for (let k = 0; k < soglia; k++) limite = prevMonthKey(limite);
    if (!limite || ultimoMese >= limite) return [];
    const mancanti = [];
    let cur = nextMonthKey(ultimoMese);
    let guard = 0;
    while (cur && cur <= limite && guard < 240) {
        mancanti.push(cur);
        cur = nextMonthKey(cur);
        guard++;
    }
    return mancanti;
}

// Mese di COMPETENZA di una bolletta come 'YYYY-MM': è il mese di periodo_fine (il
// periodo di fatturazione è ciò che conta, non la data di emissione/inserimento).
// Fallback alla data della bolletta se il periodo non è indicato (record storici).
function meseCompetenzaBolletta(bill) {
    return monthKey(bill.periodo_fine) || monthKey(bill.data);
}

// Anno di competenza di una bolletta (dal mese di competenza). null se indeterminabile.
function annoCompetenzaBolletta(bill) {
    const mk = meseCompetenzaBolletta(bill);
    return mk ? parseInt(mk.slice(0, 4), 10) : null;
}

// Mese successivo a 'YYYY-MM' (gestisce il confine d'anno).
function nextMonthKey(ym) {
    if (typeof ym !== "string" || !/^\d{4}-\d{2}$/.test(ym)) return null;
    let anno = parseInt(ym.slice(0, 4), 10);
    let mese = parseInt(ym.slice(5, 7), 10) + 1;
    if (mese > 12) { mese = 1; anno += 1; }
    return anno + "-" + (mese < 10 ? "0" : "") + mese;
}

// Formatta 'YYYY-MM' come "mag 2026".
function formattaMeseAnno(ym) {
    const [y, m] = ym.split("-");
    return `${MESI_IT_BREVE[parseInt(m, 10) - 1].toLowerCase()} ${y}`;
}

// Popola il riquadro "Dati da inserire" in cima alla Dashboard. Lo mostra solo se
// c'è davvero qualcosa che manca (bollette in ritardo o letture mensili mancanti).
function renderDatiMancanti() {
    const box = document.getElementById("dati-mancanti-box");
    const list = document.getElementById("dati-mancanti-list");
    if (!box || !list) return;

    const oggi = new Date();
    const soglie = getSoglieDati();
    // Bollette: tutte le utenze (RIFIUTI incluso). Letture: solo quelle col contatore.
    const utenze = [
        { key: "LUCE", nome: "Energia Elettrica" },
        { key: "GAS", nome: "Gas Naturale" },
        { key: "ACQUA", nome: "Servizio Idrico" },
        { key: "RIFIUTI", nome: "Rifiuti (TARI)" }
    ];
    const utenzeConLetture = utenze.filter(u => u.key !== "RIFIUTI");

    const righe = [];

    // Bollette in ritardo rispetto alla soglia configurata per l'utenza.
    utenze.forEach(u => {
        const m = bollettaMancante(u.key, oggi, soglie[u.key].bollette);
        if (m) {
            righe.push(`<div style="padding:6px 0;">📄 <strong>${u.nome}</strong>: ultima bolletta ${formatDate(m.ultima)} (${m.mesiFa} mesi fa, soglia ${m.soglia}): potrebbe mancarne una.</div>`);
        }
    });

    // Letture mensili mancanti (solo utenze col contatore; i rifiuti non hanno letture).
    utenzeConLetture.forEach(u => {
        const mesi = mesiLettureMancanti(u.key, oggi, soglie[u.key].letture);
        if (mesi.length > 0) {
            const elenco = mesi.map(formattaMeseAnno).join(", ");
            righe.push(`<div style="padding:6px 0;">📊 <strong>${u.nome}</strong>: manca${mesi.length === 1 ? "" : "no"} la lettura di ${elenco}.</div>`);
        }
    });

    if (righe.length === 0) {
        box.classList.add("hidden");
        list.innerHTML = "";
        return;
    }
    list.innerHTML = righe.join("");
    box.classList.remove("hidden");
    lucide.createIcons();
}

// DASHBOARD RENDER
function renderDashboard() {
    if (state.activeTab !== "tab-dashboard") return;

    const bills = state.data.bills;
    const readings = state.data.readings;

    // Selettore anno: popola le opzioni e fissa l'anno attivo (default = anno in corso).
    popolaSelettoreAnni();

    // Promemoria dei dati mancanti (bollette in ritardo, letture mensili mancanti).
    renderDatiMancanti();

    const selectedYear = state.dashboardYear;
    const annoCorrente = new Date().getFullYear();
    const isAnnoInCorso = (selectedYear === annoCorrente);

    // 1. Spesa Totale dell'ANNO SELEZIONATO (valore KPI = intero anno selezionato).
    // TREND a confronto con l'anno precedente:
    //  - anno in corso → confronto a PARI PERIODO (gen→mese corrente vs stessi mesi anno prima);
    //  - anno passato (completo) → confronto sull'intero anno vs intero anno precedente.
    const currentMonth = new Date().getMonth() + 1; // 1..12
    const meseLimite = isAnnoInCorso ? currentMonth : 12;
    let totalSpentSelected = 0;     // intero anno selezionato (per il valore KPI)
    let cmpSelected = 0;            // anno selezionato, fino a meseLimite
    let cmpPrev = 0;               // anno precedente, fino a meseLimite

    Object.keys(bills).forEach(ut => {
        bills[ut].forEach(b => {
            if (!b.fattura) return;
            // Anno/mese di COMPETENZA (periodo_fine), non la data di emissione.
            const mk = meseCompetenzaBolletta(b);
            if (!mk) return;
            const bYear = parseInt(mk.slice(0, 4), 10);
            const bMonth = parseInt(mk.slice(5, 7), 10);
            if (bYear === selectedYear) {
                totalSpentSelected += b.fattura;
                if (bMonth <= meseLimite) cmpSelected += b.fattura;
            } else if (bYear === selectedYear - 1) {
                if (bMonth <= meseLimite) cmpPrev += b.fattura;
            }
        });
    });

    document.getElementById("kpi-spesa-totale-title").textContent = `Spesa Totale ${selectedYear}`;
    document.getElementById("kpi-spesa-totale").textContent = `€ ${totalSpentSelected.toFixed(2)}`;

    const trendEl = document.getElementById("kpi-spesa-trend");
    if (cmpPrev > 0) {
        const pctDiff = ((cmpSelected - cmpPrev) / cmpPrev) * 100;
        const segno = pctDiff > 0 ? "+" : "";
        const icona = pctDiff > 0 ? "trending-up" : "trending-down";
        const testoPeriodo = isAnnoInCorso ? "vs stesso periodo anno scorso" : `vs ${selectedYear - 1}`;
        trendEl.className = pctDiff > 0 ? "kpi-trend up" : "kpi-trend down";
        trendEl.innerHTML = `<i data-lucide="${icona}" style="display:inline-block; width:12px; height:12px;"></i> ${segno}${pctDiff.toFixed(1)}% ${testoPeriodo}`;
    } else {
        trendEl.className = "kpi-trend";
        trendEl.textContent = "Nessun dato storico precedente";
    }

    // 2. Compila KPI specifici per Luce, Gas, Acqua — riferiti all'ANNO SELEZIONATO:
    //    mostra l'ULTIMA bolletta di quell'anno (e il relativo consumo).
    const updateKpi = (utility, kpiId, subId, unit) => {
        const tutte = bills[utility].filter(x => x.fattura > 0);
        // Filtra per ANNO DI COMPETENZA (periodo_fine), non per data di emissione.
        const list = tutte.filter(x => annoCompetenzaBolletta(x) === selectedYear);

        // RIFIUTI (tassa): mostra il TOTALE speso nell'anno; nessun consumo.
        if (utility === "RIFIUTI") {
            const totRifiuti = list.reduce((s, x) => s + (x.fattura || 0), 0);
            document.getElementById(kpiId).textContent = `€ ${totRifiuti.toFixed(2)}`;
            document.getElementById(subId).textContent = list.length
                ? `${list.length} bollett${list.length === 1 ? "a" : "e"} (TARI)`
                : "Nessuna bolletta";
            return;
        }

        if (list.length > 0) {
            const last = list[list.length - 1];
            document.getElementById(kpiId).textContent = `€ ${last.fattura.toFixed(2)}`;
            const cons = last.lettura_totale !== undefined ? last.lettura_totale : (last.lettura || 0);

            // Sotto-etichetta del consumo dell'ultima bolletta. Priorità:
            //  1) consumo_fatturato dichiarato in bolletta → etichetta "(Fatturato)" (è davvero il fatturato);
            //  2) altrimenti differenza tra letture progressive → etichetta "(stima da letture)";
            //  3) altrimenti il valore progressivo del contatore → "(Totale contatore)".
            if (typeof last.consumo_fatturato === "number" && isFinite(last.consumo_fatturato)) {
                document.getElementById(subId).textContent = `${last.consumo_fatturato} ${unit} (Fatturato)`;
            } else {
                let consumed = 0;
                const idx = bills[utility].indexOf(last);
                if (idx > 0) {
                    const prev = bills[utility][idx - 1];
                    const prevVal = prev.lettura_totale !== undefined ? prev.lettura_totale : (prev.lettura || 0);
                    consumed = cons - prevVal;
                }
                document.getElementById(subId).textContent = consumed > 0
                    ? `${consumed} ${unit} (stima da letture)`
                    : `${cons} ${unit} (Totale contatore)`;
            }
        } else {
            document.getElementById(kpiId).textContent = "€ 0.00";
            document.getElementById(subId).textContent = `0 ${unit}`;
        }
    };
    
    updateKpi("LUCE", "kpi-spesa-luce", "kpi-consumo-luce", "kWh");
    updateKpi("GAS", "kpi-spesa-gas", "kpi-consumo-gas", "SMC");
    updateKpi("ACQUA", "kpi-spesa-acqua", "kpi-consumo-acqua", "m³");
    updateKpi("RIFIUTI", "kpi-spesa-rifiuti", "kpi-consumo-rifiuti", "");

    // 3. Tabella Ultime Rilevazioni
    const activities = [];
    Object.keys(bills).forEach(ut => {
        const isRifiuti = (ut === "RIFIUTI");
        bills[ut].forEach((b, idx) => {
            const readingVal = b.lettura_totale !== undefined ? b.lettura_totale : (b.lettura || 0);
            let partial = 0;
            if (idx > 0 && !isRifiuti) {
                const prevReading = bills[ut][idx - 1].lettura_totale !== undefined ? bills[ut][idx - 1].lettura_totale : (bills[ut][idx - 1].lettura || 0);
                partial = readingVal - prevReading;
            }

            activities.push({
                data: b.data,
                utenza: ut,
                tipo: isRifiuti ? "Bolletta TARI" : "Bolletta PDF",
                valore: b.fattura ? `€ ${b.fattura.toFixed(2)}` : "Lettura stimata",
                consumo: (!isRifiuti && partial > 0) ? `${partial} ${unitForUtility(ut)}` : "-",
                lettura: isRifiuti ? "—" : readingVal
            });
        });
    });

    Object.keys(readings).forEach(ut => {
        readings[ut].forEach(r => {
            activities.push({
                data: r.data,
                utenza: ut,
                tipo: "Lettura Manuale",
                valore: "-",
                consumo: "-",
                lettura: r.lettura_totale !== undefined ? r.lettura_totale : (r.lettura || 0)
            });
        });
    });

    // Ordina per data decrescente e prendi le ultime 5 attività
    activities.sort((a, b) => b.data.localeCompare(a.data));
    const recent5 = activities.slice(0, 5);
    
    const tbody = document.getElementById("recent-activities-table");
    tbody.innerHTML = "";
    
    if (recent5.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-secondary);">Nessun dato registrato.</td></tr>`;
    } else {
        recent5.forEach(act => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${formatDate(act.data)}</td>
                <td><span class="badge ${badgeUtenzaClass(act.utenza)}">${act.utenza}</span></td>
                <td>${act.tipo}</td>
                <td class="font-medium">${act.valore}</td>
                <td>${act.consumo}</td>
                <td>${act.lettura}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    // 4. Disegna i grafici
    renderDashboardCharts();
    
    // Aggiorna icone caricate dinamicamente
    lucide.createIcons();
}

// RENDER GRAFICI DASHBOARD
function renderDashboardCharts() {
    const bills = state.data.bills;
    const readings = state.data.readings;
    
    // Aggrega spese per mese/anno
    const speseMensili = {};
    const consumiLuce = {};
    const consumiGas = {};
    const consumiAcqua = {};
    
    // Inizializza i 12 mesi (gen→dic) dell'ANNO SELEZIONATO nella dashboard.
    const annoGrafico = state.dashboardYear || new Date().getFullYear();
    const labels = [];
    for (let m = 1; m <= 12; m++) {
        const key = `${annoGrafico}-${String(m).padStart(2, '0')}`;
        speseMensili[key] = { LUCE: 0, GAS: 0, ACQUA: 0, RIFIUTI: 0 };
        labels.push(key);
    }

    Object.keys(bills).forEach(ut => {
        bills[ut].forEach(b => {
            if (!b.fattura) return;
            // La spesa è attribuita al mese di COMPETENZA (periodo_fine), non alla
            // data di emissione/inserimento. Fallback alla data se manca il periodo.
            const meseComp = meseCompetenzaBolletta(b);
            if (meseComp && speseMensili[meseComp]) {
                speseMensili[meseComp][ut] += b.fattura;
            }
        });
    });

    // Label formattate (es: Gen, Feb, ...) — tutte dello stesso anno selezionato.
    const formattedLabels = labels.map(lbl => {
        const month = lbl.split("-")[1];
        return MESI_IT_BREVE[parseInt(month) - 1];
    });

    // Titolo dinamico del grafico spese con l'anno selezionato.
    const titoloSpese = document.getElementById("chart-spese-title");
    if (titoloSpese) titoloSpese.textContent = `Andamento delle Spese Mensili ${annoGrafico} (€)`;

    const datasetLuce = labels.map(lbl => speseMensili[lbl].LUCE);
    const datasetGas = labels.map(lbl => speseMensili[lbl].GAS);
    const datasetAcqua = labels.map(lbl => speseMensili[lbl].ACQUA);
    const datasetRifiuti = labels.map(lbl => speseMensili[lbl].RIFIUTI);

    // --- GRAFICO SPESE ---
    const ctxSpese = document.getElementById("chart-spese").getContext("2d");
    if (state.charts.spese) state.charts.spese.destroy();

    state.charts.spese = new Chart(ctxSpese, {
        type: "bar",
        data: {
            labels: formattedLabels,
            datasets: [
                { label: "Luce", data: datasetLuce, backgroundColor: "#eab308", borderRadius: 4 },
                { label: "Gas", data: datasetGas, backgroundColor: "#f97316", borderRadius: 4 },
                { label: "Acqua", data: datasetAcqua, backgroundColor: "#3b82f6", borderRadius: 4 },
                { label: "Rifiuti", data: datasetRifiuti, backgroundColor: "#22c55e", borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { stacked: true, grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } },
                y: { stacked: true, grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: {
                legend: { labels: { color: "#f8fafc" } }
            }
        }
    });

    // --- GRAFICO CONSUMI MENSILI (anno selezionato) ---
    // Consumo di ogni mese (gen→dic dell'anno selezionato) per utenza, calcolato dalle
    // AUTOLETTURE: consumo del mese = (ultima lettura del mese) − (ultima lettura del mese
    // precedente con dati). Se un mese non ha letture resta a 0. Stesse label dei grafici
    // spese (gen…dic), così i due grafici sono allineati.
    const consumoMensilePerUtenza = (utility) => {
        const list = (readings[utility] || [])
            .slice()
            .filter(r => typeof r.data === "string")
            .sort((a, b) => a.data.localeCompare(b.data));
        // Ultima lettura per ogni mese 'YYYY-MM' (l'ultima del mese vince).
        const ultimaDelMese = {};
        list.forEach(r => {
            const ym = monthKey(r.data);
            if (ym) ultimaDelMese[ym] = readingValue(r);
        });
        // Per ogni mese del grafico: consumo = valore mese − valore del mese-base
        // precedente (il più recente <= mese precedente). Null-safe sui buchi.
        return labels.map(ym => {
            if (!(ym in ultimaDelMese)) return 0;
            const valFine = ultimaDelMese[ym];
            // Trova il valore di riferimento: l'ultima lettura nei mesi precedenti.
            let base = null;
            let cur = prevMonthKey(ym);
            let guard = 0;
            while (cur && guard < 240) {
                if (cur in ultimaDelMese) { base = ultimaDelMese[cur]; break; }
                cur = prevMonthKey(cur);
                guard++;
            }
            if (base == null) return 0; // nessuna lettura precedente: niente da differenziare
            const diff = valFine - base;
            return diff > 0 ? diff : 0;
        });
    };

    const consMensLuce = consumoMensilePerUtenza("LUCE");
    const consMensGas = consumoMensilePerUtenza("GAS");
    const consMensAcqua = consumoMensilePerUtenza("ACQUA");

    const titoloConsMens = document.getElementById("chart-consumi-mensili-title");
    if (titoloConsMens) titoloConsMens.textContent = `Andamento dei Consumi Mensili ${annoGrafico}`;

    const ctxConsMens = document.getElementById("chart-consumi-mensili").getContext("2d");
    if (state.charts.consumiMensili) state.charts.consumiMensili.destroy();

    state.charts.consumiMensili = new Chart(ctxConsMens, {
        type: "bar",
        data: {
            labels: formattedLabels,
            datasets: [
                { label: "Luce (kWh)", data: consMensLuce, backgroundColor: "#eab308", borderRadius: 4 },
                { label: "Gas (SMC)", data: consMensGas, backgroundColor: "#f97316", borderRadius: 4 },
                { label: "Acqua (m³)", data: consMensAcqua, backgroundColor: "#3b82f6", borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } },
                y: { beginAtZero: true, grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: {
                legend: { labels: { color: "#f8fafc" } }
            }
        }
    });

    // --- GRAFICO CONSUMI (ANNUALE) ---
    // Consumo "rilevato" per anno solare: si calcola dalle AUTOLETTURE mensili
    // (state.data.readings), non dalle bollette sparse, coerentemente col titolo
    // "Rilevato" e col principio del progetto (consumo = differenza tra letture).
    // Ogni intervallo tra due letture consecutive viene ripartito PRO-RATA sui
    // giorni effettivi, così un intervallo a cavallo d'anno (o con buchi) finisce
    // negli anni giusti invece di essere attribuito tutto all'anno della lettura finale.
    const years = [currentYear() - 2, currentYear() - 1, currentYear()];
    const consLuceAnnuo = [0, 0, 0];
    const consGasAnnuo = [0, 0, 0];
    const consAcquaAnnuo = [0, 0, 0];

    const MS_GIORNO = 24 * 60 * 60 * 1000;

    const calcolaConsumoAnnuo = (utility, arrayDest) => {
        const list = (readings[utility] || [])
            .slice()
            .sort((a, b) => a.data.localeCompare(b.data));
        for (let idx = 1; idx < list.length; idx++) {
            const recPrev = list[idx - 1];
            const recCur = list[idx];
            const val = recCur.lettura_totale !== undefined ? recCur.lettura_totale : (recCur.lettura || 0);
            const prev = recPrev.lettura_totale !== undefined ? recPrev.lettura_totale : (recPrev.lettura || 0);
            const diff = val - prev;
            if (diff <= 0) continue; // azzeramenti/incoerenze: ignorati

            const dStart = new Date(recPrev.data);
            const dEnd = new Date(recCur.data);
            const giorniTot = Math.round((dEnd - dStart) / MS_GIORNO);
            if (giorniTot <= 0) continue;

            // Ripartisci il diff sui giorni di ciascun anno coperto dall'intervallo.
            years.forEach((anno, yearIdx) => {
                const inizioAnno = new Date(anno, 0, 1);
                const fineAnno = new Date(anno + 1, 0, 1);
                const overlapStart = dStart > inizioAnno ? dStart : inizioAnno;
                const overlapEnd = dEnd < fineAnno ? dEnd : fineAnno;
                const giorniNelAnno = Math.round((overlapEnd - overlapStart) / MS_GIORNO);
                if (giorniNelAnno > 0) {
                    arrayDest[yearIdx] += diff * (giorniNelAnno / giorniTot);
                }
            });
        }
        // Arrotonda a interi per leggibilità (i consumi sono kWh/SMC/m³).
        for (let i = 0; i < arrayDest.length; i++) {
            arrayDest[i] = Math.round(arrayDest[i]);
        }
    };

    calcolaConsumoAnnuo("LUCE", consLuceAnnuo);
    calcolaConsumoAnnuo("GAS", consGasAnnuo);
    calcolaConsumoAnnuo("ACQUA", consAcquaAnnuo);

    // RIFIUTI (TARI) non ha contatore né consumo: nel grafico annuale entra come
    // SPESA annua in €, attribuita all'anno di COMPETENZA della bolletta
    // (periodo_fine, fallback data) — stesso criterio del KPI Rifiuti.
    const spesaRifiutiAnnua = [0, 0, 0];
    (bills.RIFIUTI || []).forEach(b => {
        if (!b.fattura) return;
        const yearIdx = years.indexOf(annoCompetenzaBolletta(b));
        if (yearIdx !== -1) spesaRifiutiAnnua[yearIdx] += b.fattura;
    });
    for (let i = 0; i < spesaRifiutiAnnua.length; i++) {
        spesaRifiutiAnnua[i] = Math.round(spesaRifiutiAnnua[i]);
    }

    const ctxConsumi = document.getElementById("chart-consumi").getContext("2d");
    if (state.charts.consumi) state.charts.consumi.destroy();

    state.charts.consumi = new Chart(ctxConsumi, {
        type: "bar",
        data: {
            labels: years.map(String),
            datasets: [
                { label: "Luce (kWh)", data: consLuceAnnuo, backgroundColor: "rgba(234, 179, 8, 0.7)", borderColor: "#eab308", borderWidth: 1 },
                { label: "Gas (SMC)", data: consGasAnnuo, backgroundColor: "rgba(249, 115, 22, 0.7)", borderColor: "#f97316", borderWidth: 1 },
                { label: "Acqua (m³)", data: consAcquaAnnuo, backgroundColor: "rgba(59, 130, 246, 0.7)", borderColor: "#3b82f6", borderWidth: 1 },
                { label: "Rifiuti/TARI (€)", data: spesaRifiutiAnnua, backgroundColor: "rgba(34, 197, 94, 0.7)", borderColor: "#22c55e", borderWidth: 1 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } },
                y: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: {
                legend: { labels: { color: "#f8fafc" } }
            }
        }
    });
}

// RENDER TABELLA BOLLETTE
function renderBillsTable() {
    if (state.activeTab !== "tab-bollette") return;
    
    const tbody = document.getElementById("table-bollette-body");
    tbody.innerHTML = "";

    const filter = state.currentBillFilter;
    let listToShow = [];

    // Aggrega
    if (filter === "all") {
        Object.keys(state.data.bills).forEach(ut => {
            state.data.bills[ut].forEach((b, idx) => {
                listToShow.push({ ...b, utility: ut, originalIndex: idx });
            });
        });
    } else {
        state.data.bills[filter].forEach((b, idx) => {
            listToShow.push({ ...b, utility: filter, originalIndex: idx });
        });
    }

    // Filtro per intervallo date (dal/al), sulla data della bolletta.
    listToShow = filtraPerIntervallo(listToShow, state.billDateFrom, state.billDateTo);

    // Ordina per data decrescente
    listToShow.sort((a, b) => b.data.localeCompare(a.data));

    if (listToShow.length === 0) {
        const vuotoMsg = (state.billDateFrom || state.billDateTo)
            ? "Nessuna bolletta nell'intervallo selezionato."
            : "Nessuna bolletta salvata.";
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:var(--text-secondary); padding:20px;">${vuotoMsg}</td></tr>`;
        return;
    }

    listToShow.forEach(bill => {
        const tr = document.createElement("tr");
        const amountDisplay = bill.fattura ? `€ ${bill.fattura.toFixed(2)}` : "-";
        
        // Calcola il consumo periodo da bolletta. RIFIUTI non ha contatore → "—".
        let consPeriodo = "-";
        if (bill.utility !== "RIFIUTI") {
            const utilityBills = state.data.bills[bill.utility];
            const currentVal = bill.lettura_totale !== undefined ? bill.lettura_totale : (bill.lettura || 0);
            // Trova l'indice nel database originale ordinato
            const origList = [...utilityBills].sort((a,b) => a.data.localeCompare(b.data));
            const matchingRecord = origList.find(x => x.data === bill.data);
            const oIndex = origList.indexOf(matchingRecord);
            if (oIndex > 0) {
                const prev = origList[oIndex - 1];
                const prevVal = prev.lettura_totale !== undefined ? prev.lettura_totale : (prev.lettura || 0);
                const diff = currentVal - prevVal;
                if (diff >= 0) {
                    consPeriodo = `${diff} ${unitForUtility(bill.utility)}`;
                }
            }
        }

        // Badge Tipo Lettura
        let badgeClass = "badge-secondary";
        if (bill.tipo_lettura === "rilevata") badgeClass = "badge-success";
        else if (bill.tipo_lettura === "stimata") badgeClass = "badge-warning";
        const tipoDisplay = bill.tipo_lettura ? `<span class="badge ${badgeClass}">${bill.tipo_lettura}</span>` : "-";

        // Collegamento PDF
        let pdfDisplay = "-";
        if (bill.pdf_path) {
            const fileUrl = `${state.apiBaseUrl}/${bill.pdf_path}`;
            pdfDisplay = `<a href="#" class="pdf-link" data-url="${fileUrl}" data-title="Bolletta ${bill.utility} - ${formatDate(bill.data)}"><i data-lucide="file-text"></i> PDF</a>`;
        }

        const periodoDisplay = formattaPeriodo(bill);
        // Lettura contatore mostrata: vuota per RIFIUTI (tassa, niente contatore).
        const letturaDisplay = (bill.utility === "RIFIUTI")
            ? "—"
            : (bill.lettura_totale !== undefined ? bill.lettura_totale : (bill.lettura || 0));

        tr.innerHTML = `
            <td>${formatDate(bill.data)}</td>
            <td style="font-size:0.85rem;">${periodoDisplay}</td>
            <td><span class="badge ${badgeUtenzaClass(bill.utility)}">${bill.utility}</span></td>
            <td class="font-medium">${amountDisplay}</td>
            <td>${letturaDisplay}</td>
            <td>${consPeriodo}</td>
            <td>${tipoDisplay}</td>
            <td>${pdfDisplay}</td>
            <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${bill.note || ''}">${bill.note || "-"}</td>
            <td>
                <button class="btn-secondary-sm btn-edit-bill" data-utility="${bill.utility}" data-index="${bill.originalIndex}">Modifica</button>
                <button class="btn-danger-sm btn-delete-bill" data-utility="${bill.utility}" data-index="${bill.originalIndex}">Elimina</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // Collega i gestori di visualizzazione PDF ai link PDF in tabella
    tbody.querySelectorAll(".pdf-link").forEach(link => {
        link.addEventListener("click", (e) => {
            e.preventDefault();
            const url = e.currentTarget.getAttribute("data-url");
            const title = e.currentTarget.getAttribute("data-title");
            openPdfModal(url, title, listToShow.find(x => `${state.apiBaseUrl}/${x.pdf_path}` === url));
        });
    });

    // Collega il tasto elimina
    tbody.querySelectorAll(".btn-delete-bill").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const ut = e.target.getAttribute("data-utility");
            const idx = parseInt(e.target.getAttribute("data-index"));
            await deleteBill(ut, idx);
        });
    });

    // Collega il tasto modifica
    tbody.querySelectorAll(".btn-edit-bill").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const ut = e.target.getAttribute("data-utility");
            const idx = parseInt(e.target.getAttribute("data-index"));
            editBill(ut, idx);
        });
    });

    lucide.createIcons();
}

function openPdfModal(url, title, bill) {
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-pdf-frame").src = url;
    
    // Popola i dati dettaglio sulla destra
    const detailsBox = document.getElementById("modal-details-content");
    const reading = bill.lettura_totale !== undefined ? bill.lettura_totale : (bill.lettura || 0);
    
    let specificContent = "";
    if (bill.utility === "LUCE") {
        specificContent = `
            <div class="details-row"><span class="details-label">Fascia F1</span><span class="details-val">${bill.lettura_f1 || 0} kWh</span></div>
            <div class="details-row"><span class="details-label">Fascia F2</span><span class="details-val">${bill.lettura_f2 || 0} kWh</span></div>
            <div class="details-row"><span class="details-label">Fascia F3</span><span class="details-val">${bill.lettura_f3 || 0} kWh</span></div>
        `;
    }

    const periodoText = (bill.periodo_inizio || bill.periodo_fine)
        ? `${bill.periodo_inizio ? formatDate(bill.periodo_inizio) : "?"} → ${bill.periodo_fine ? formatDate(bill.periodo_fine) : "?"}`
        : "Non indicato";
    const consumoFattText = (bill.consumo_fatturato != null)
        ? `${bill.consumo_fatturato} ${unitForUtility(bill.utility)}`
        : "Non indicato";

    detailsBox.innerHTML = `
        <div class="details-row"><span class="details-label">Utenza</span><span class="details-val badge ${badgeUtenzaClass(bill.utility)}">${bill.utility}</span></div>
        <div class="details-row"><span class="details-label">Data Bolletta</span><span class="details-val">${formatDate(bill.data)}</span></div>
        <div class="details-row"><span class="details-label">Periodo Fatturazione</span><span class="details-val">${periodoText}</span></div>
        <div class="details-row"><span class="details-label">Consumo Fatturato</span><span class="details-val">${consumoFattText}</span></div>
        <div class="details-row"><span class="details-label">Importo Fatturato</span><span class="details-val text-primary" style="font-size:1.15rem; font-weight:700;">€ ${(bill.fattura || 0).toFixed(2)}</span></div>
        <div class="details-row"><span class="details-label">Lettura Totale</span><span class="details-val">${reading}</span></div>
        ${specificContent}
        <div class="details-row"><span class="details-label">Tipo Rilevazione</span><span class="details-val text-capitalize">${bill.tipo_lettura || 'Non specificata'}</span></div>
        <div class="details-row"><span class="details-label">Quota Fissa</span><span class="details-val">${bill.quota_fissa != null ? "€ " + bill.quota_fissa.toFixed(2) : "n/d"}</span></div>
        <div class="details-row"><span class="details-label">Quota Energia</span><span class="details-val">${bill.quota_energia != null ? "€ " + bill.quota_energia.toFixed(2) : "n/d"}</span></div>
        <div class="details-row"><span class="details-label">Prezzo Unitario</span><span class="details-val">${bill.prezzo_unitario_energia != null ? "€ " + bill.prezzo_unitario_energia.toFixed(3) + "/" + unitForUtility(bill.utility) : "n/d"}</span></div>
        <div class="details-row" style="flex-direction:column; border:none; gap:6px;">
            <span class="details-label">Note bolletta:</span>
            <p style="background:rgba(255,255,255,0.03); padding:10px; border-radius:var(--radius-sm); font-size:0.85rem; border:1px solid var(--border-glass);">${bill.note || "Nessuna nota aggiuntiva."}</p>
        </div>
    `;
    
    document.getElementById("modal-dettaglio-bolletta").classList.remove("hidden");
}

// RENDER TABELLA LETTURE MANUALI
function renderReadingsTable() {
    if (state.activeTab !== "tab-letture") return;
    
    const tbody = document.getElementById("table-letture-body");
    tbody.innerHTML = "";

    const filter = state.currentReadingFilter;
    let listToShow = [];

    // Aggrega
    if (filter === "all") {
        Object.keys(state.data.readings).forEach(ut => {
            state.data.readings[ut].forEach((r, idx) => {
                listToShow.push({ ...r, utility: ut, originalIndex: idx });
            });
        });
    } else {
        state.data.readings[filter].forEach((r, idx) => {
            listToShow.push({ ...r, utility: filter, originalIndex: idx });
        });
    }

    // Filtro per intervallo date (dal/al), sulla data della lettura.
    listToShow = filtraPerIntervallo(listToShow, state.readingDateFrom, state.readingDateTo);

    // Ordina per data decrescente
    listToShow.sort((a, b) => b.data.localeCompare(a.data));

    if (listToShow.length === 0) {
        const vuotoMsg = (state.readingDateFrom || state.readingDateTo)
            ? "Nessuna lettura nell'intervallo selezionato."
            : "Nessuna lettura contatore registrata.";
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-secondary); padding:20px;">${vuotoMsg}</td></tr>`;
        return;
    }

    listToShow.forEach(read => {
        const tr = document.createElement("tr");
        const val = read.lettura_totale !== undefined ? read.lettura_totale : (read.lettura || 0);

        let details = "-";
        if (read.utility === "LUCE") {
            details = `<span class="help-text">F1: ${read.lettura_f1 || 0} | F2: ${read.lettura_f2 || 0} | F3: ${read.lettura_f3 || 0}</span>`;
        }
        if (read.note) {
            details = details !== "-" ? `${details} <br> <span style="font-style:italic;">${read.note}</span>` : read.note;
        }

        tr.innerHTML = `
            <td>${formatDate(read.data)}</td>
            <td style="font-size:0.85rem;">${meseDiRilievo(read.data)}</td>
            <td><span class="badge ${badgeUtenzaClass(read.utility)}">${read.utility}</span></td>
            <td class="font-medium">${val} ${read.utility === 'LUCE' ? 'kWh' : read.utility === 'GAS' ? 'SMC' : 'm³'}</td>
            <td>${details}</td>
            <td>
                <button class="btn-secondary-sm btn-edit-reading" data-utility="${read.utility}" data-index="${read.originalIndex}">Modifica</button>
                <button class="btn-danger-sm btn-delete-reading" data-utility="${read.utility}" data-index="${read.originalIndex}">Elimina</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-delete-reading").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const ut = e.target.getAttribute("data-utility");
            const idx = parseInt(e.target.getAttribute("data-index"));
            await deleteReading(ut, idx);
        });
    });

    tbody.querySelectorAll(".btn-edit-reading").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const ut = e.target.getAttribute("data-utility");
            const idx = parseInt(e.target.getAttribute("data-index"));
            editReading(ut, idx);
        });
    });

    lucide.createIcons();
}

// --- TABELLA AUDIT & VERIFICA ANOMALIE ---
// Soglia di tolleranza (in frazione): entro ±SOGLIA_AUDIT lo scostamento
// fatturato/rilevato è considerato allineato.
const SOGLIA_AUDIT = 0.05; // 5%

function renderAuditTab() {
    if (state.activeTab !== "tab-verifica") return;

    const utility = document.getElementById("audit-utility-select").value;
    const bills = [...state.data.bills[utility]].sort((a,b) => a.data.localeCompare(b.data));
    const readings = [...state.data.readings[utility]].sort((a,b) => a.data.localeCompare(b.data));

    const tbody = document.getElementById("table-audit-body");
    tbody.innerHTML = "";

    let countOk = 0;
    let countOver = 0; // sovrafatturate (fatturato > rilevato oltre soglia)
    let countUnder = 0; // conguaglio atteso (fatturato < rilevato oltre soglia)
    let countNa = 0; // non verificabili

    if (bills.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-secondary); padding:20px;">Nessuna bolletta registrata per questa utenza. Carica un PDF bolletta per confrontarla.</td></tr>`;
        updateAuditCounters(0, 0, 0, 0);
        renderAuditTimelineChart(utility, []);
        return;
    }

    const unit = unitForUtility(utility);
    const reportEntries = [];

    bills.forEach(bill => {
        const audit = auditConsumoForBill(bill, readings);

        // Periodo (mese leggibile) e tipo lettura.
        const periodoText = (bill.periodo_inizio || bill.periodo_fine)
            ? `${bill.periodo_inizio ? formatDate(bill.periodo_inizio) : "?"} → ${bill.periodo_fine ? formatDate(bill.periodo_fine) : "?"}`
            : "Non indicato";
        const tipoLettura = bill.tipo_lettura || "rilevata";

        let fatturatoText = audit.consumoFatturato != null ? `${audit.consumoFatturato} ${unit}` : "-";
        let rilevatoText = "-";
        let diffDisplay = "-";
        let statusBadge;
        let actionText;
        let statusClass;

        if (!audit.verifiable) {
            rilevatoText = "n/d";
            statusBadge = `<span class="badge badge-secondary">Non verificabile</span>`;
            actionText = audit.reason || "Dati insufficienti per la verifica.";
            statusClass = "secondary";
            countNa++;
        } else {
            rilevatoText = `${audit.consumoRilevato} ${unit}`;
            const pct = Math.round(audit.deltaPct * 100);
            const segno = audit.delta > 0 ? "+" : "";
            diffDisplay = `${segno}${audit.delta} ${unit} (${segno}${pct}%)`;

            if (Math.abs(audit.deltaPct) <= SOGLIA_AUDIT) {
                statusBadge = `<span class="badge badge-success">Allineata</span>`;
                actionText = "Il consumo fatturato corrisponde a quello rilevato. Nessuna azione necessaria.";
                statusClass = "success";
                countOk++;
            } else if (audit.delta > 0) {
                statusBadge = `<span class="badge badge-danger">Sovrafatturata</span>`;
                actionText = `Fatturati +${audit.delta} ${unit} (${pct}%) oltre il consumo reale rilevato. Verifica la bolletta e invia un'autolettura.`;
                statusClass = "danger";
                countOver++;
            } else {
                statusBadge = `<span class="badge badge-warning">Conguaglio atteso</span>`;
                actionText = `Consumo reale superiore di ${Math.abs(audit.delta)} ${unit} (${Math.abs(pct)}%) rispetto al fatturato. Possibile conguaglio futuro.`;
                statusClass = "warning";
                countUnder++;
            }
        }

        reportEntries.push({
            date: bill.data,
            periodoText,
            fatturatoText,
            rilevatoText,
            diffDisplay,
            tipoLettura,
            statusBadge,
            actionText,
            statusClass
        });
    });

    // Mostra in ordine decrescente di data.
    reportEntries.sort((a,b) => b.date.localeCompare(a.date));

    reportEntries.forEach(entry => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${formatDate(entry.date)}</td>
            <td style="font-size:0.85rem;">${entry.periodoText}</td>
            <td class="font-medium">${entry.fatturatoText}</td>
            <td>${entry.rilevatoText}</td>
            <td class="text-${entry.statusClass} font-medium">${entry.diffDisplay}</td>
            <td><span class="badge text-capitalize">${entry.tipoLettura}</span></td>
            <td>${entry.statusBadge}</td>
            <td style="font-size:0.85rem;" class="text-secondary">${entry.actionText}</td>
        `;
        tbody.appendChild(tr);
    });

    updateAuditCounters(countOk, countOver, countUnder, countNa);

    // Disegna il confronto consumo fatturato vs rilevato per periodo.
    renderAuditTimelineChart(utility, reportEntries.length ? bills : [], readings);

    // Avviso variazioni prezzo/consumo (tutte le utenze) → rimanda alla tab Andamento Prezzi.
    const alertEl = document.getElementById("audit-prezzi-alert");
    if (alertEl) {
        const n = contaSegnalazioniPrezzi(getPrezziSoglia());
        if (n > 0) {
            document.getElementById("audit-prezzi-alert-text").textContent =
                `Ci sono ${n} variazion${n === 1 ? "e" : "i"} di prezzo o consumo da controllare`;
            alertEl.classList.remove("hidden");
            lucide.createIcons();
        } else {
            alertEl.classList.add("hidden");
        }
    }
}

function updateAuditCounters(ok, over, under, na) {
    document.getElementById("audit-badge-ok").textContent = `Allineate: ${ok}`;
    document.getElementById("audit-badge-err").textContent = `Sovrafatturate: ${over}`;
    document.getElementById("audit-badge-warn").textContent = `Conguaglio atteso: ${under}`;
    document.getElementById("audit-badge-na").textContent = `Non verificabili: ${na}`;
}

// GRAFICO DI CONFRONTO: consumo FATTURATO vs RILEVATO per periodo.
// Una coppia di barre (rossa = fatturato, verde = rilevato) per ogni bolletta verificabile.
function renderAuditTimelineChart(utility, bills, readings) {
    const ctx = document.getElementById("chart-audit-timeline").getContext("2d");
    if (state.charts.audit) state.charts.audit.destroy();

    const unit = unitForUtility(utility);
    const sortedReadings = (readings || []).slice().sort((a,b) => a.data.localeCompare(b.data));

    // Considera solo le bollette verificabili, ordinate cronologicamente.
    const verificabili = (bills || [])
        .slice()
        .sort((a,b) => a.data.localeCompare(b.data))
        .map(b => ({ bill: b, audit: auditConsumoForBill(b, sortedReadings) }))
        .filter(x => x.audit.verifiable);

    const labels = verificabili.map(x => {
        // Etichetta = periodo "mese fine" se disponibile, altrimenti data bolletta.
        const fine = x.bill.periodo_fine || x.bill.data;
        return formatDate(fine);
    });
    const datasetFatturato = verificabili.map(x => x.audit.consumoFatturato);
    const datasetRilevato = verificabili.map(x => x.audit.consumoRilevato);

    state.charts.audit = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [
                {
                    label: `Consumo Fatturato (${unit})`,
                    data: datasetFatturato,
                    backgroundColor: "rgba(239, 68, 68, 0.65)",
                    borderColor: "#ef4444",
                    borderWidth: 1
                },
                {
                    label: `Consumo Rilevato (${unit})`,
                    data: datasetRilevato,
                    backgroundColor: "rgba(16, 185, 129, 0.65)",
                    borderColor: "#10b981",
                    borderWidth: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: "index",
                intersect: false
            },
            scales: {
                x: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } },
                y: { beginAtZero: true, grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: {
                legend: { labels: { color: "#f8fafc" } }
            }
        }
    });
}

// --- ANDAMENTO PREZZI: variazioni tra bollette consecutive ---
// Considera SOLO le bollette con dati di dettaglio reali (prezzo_unitario_energia
// presente), come da scelta: niente stime sullo storico. Restituisce la lista
// ordinata cronologicamente con prezzo unitario, consumo e variazioni % vs la
// bolletta precedente della stessa utenza. 'soglia' è una frazione (0.15 = 15%).
function computePrezziVariazioni(utility, soglia) {
    // Ordina per PERIODO di competenza (periodo_fine), non per data di emissione:
    // è il periodo che definisce la sequenza cronologica reale dei consumi.
    const bills = (state.data.bills[utility] || [])
        .slice()
        .filter(b => b && typeof b.prezzo_unitario_energia === "number" && isFinite(b.prezzo_unitario_energia) && b.prezzo_unitario_energia > 0)
        .sort((a, b) => (meseCompetenzaBolletta(a) || "").localeCompare(meseCompetenzaBolletta(b) || ""));

    const out = [];
    for (let i = 0; i < bills.length; i++) {
        const b = bills[i];
        const prezzo = b.prezzo_unitario_energia;
        const consumo = (typeof b.consumo_fatturato === "number" && isFinite(b.consumo_fatturato)) ? b.consumo_fatturato : null;
        const prev = i > 0 ? bills[i - 1] : null;

        let varPrezzo = null, varConsumo = null;
        if (prev && prev.prezzo_unitario_energia > 0) {
            varPrezzo = (prezzo - prev.prezzo_unitario_energia) / prev.prezzo_unitario_energia;
        }
        if (prev && typeof prev.consumo_fatturato === "number" && prev.consumo_fatturato > 0 && consumo != null) {
            varConsumo = (consumo - prev.consumo_fatturato) / prev.consumo_fatturato;
        }
        const segnalaPrezzo = varPrezzo != null && Math.abs(varPrezzo) >= soglia;
        const segnalaConsumo = varConsumo != null && Math.abs(varConsumo) >= soglia;

        out.push({ bill: b, prezzo, consumo, varPrezzo, varConsumo, segnalaPrezzo, segnalaConsumo });
    }
    return out;
}

// Legge la soglia dall'input (in %), con fallback a 15%. Restituisce una frazione.
function getPrezziSoglia() {
    const el = document.getElementById("prezzi-soglia");
    const v = el ? parseFloat(el.value) : NaN;
    return (isFinite(v) && v > 0) ? v / 100 : 0.15;
}

// Conta, su tutte le utenze, quante variazioni superano la soglia: usato dal badge
// nella pagina Verifica Anomalie per rimandare qui.
function contaSegnalazioniPrezzi(soglia) {
    let n = 0;
    ["LUCE", "GAS", "ACQUA"].forEach(ut => {
        computePrezziVariazioni(ut, soglia).forEach(r => {
            if (r.segnalaPrezzo || r.segnalaConsumo) n++;
        });
    });
    return n;
}

function renderPrezziTab() {
    if (state.activeTab !== "tab-prezzi") return;

    const utility = document.getElementById("prezzi-utility-select").value;
    const soglia = getPrezziSoglia();
    const unit = unitForUtility(utility);
    const rows = computePrezziVariazioni(utility, soglia);

    const tbody = document.getElementById("table-prezzi-body");
    tbody.innerHTML = "";

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-secondary); padding:20px;">Nessuna bolletta con dati di dettaglio costi per questa utenza. Carica una bolletta PDF: il prezzo unitario verrà estratto automaticamente e comparirà qui.</td></tr>`;
        renderPrezziChart(utility, []);
        return;
    }

    // Mostra in ordine decrescente di PERIODO (più recenti in alto).
    rows.slice().sort((a, b) => (meseCompetenzaBolletta(b.bill) || "").localeCompare(meseCompetenzaBolletta(a.bill) || "")).forEach(r => {
        const periodoText = (r.bill.periodo_inizio || r.bill.periodo_fine)
            ? `${r.bill.periodo_inizio ? formatDate(r.bill.periodo_inizio) : "?"} → ${r.bill.periodo_fine ? formatDate(r.bill.periodo_fine) : "?"}`
            : "Non indicato";

        const fmtVar = (v, segnala) => {
            if (v == null) return `<span class="text-secondary">—</span>`;
            const segno = v > 0 ? "+" : "";
            const cls = segnala ? (v > 0 ? "text-danger font-medium" : "text-success font-medium") : "text-secondary";
            return `<span class="${cls}">${segno}${Math.round(v * 100)}%</span>`;
        };

        // Segnalazione testuale.
        const note = [];
        if (r.segnalaPrezzo) note.push(r.varPrezzo > 0 ? "⚠️ Prezzo in aumento" : "Prezzo in calo");
        if (r.segnalaConsumo) note.push(r.varConsumo > 0 ? "⚠️ Consumo in aumento" : "Consumo in calo");
        const segnalazione = note.length
            ? `<span class="badge ${r.varPrezzo > 0 && r.segnalaPrezzo ? "badge-danger" : "badge-warning"}">${note.join(" · ")}</span>`
            : `<span class="badge badge-success">Stabile</span>`;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${formatDate(r.bill.data)}</td>
            <td style="font-size:0.85rem;">${periodoText}</td>
            <td class="font-medium">€ ${r.prezzo.toFixed(3)}/${unit}</td>
            <td>${fmtVar(r.varPrezzo, r.segnalaPrezzo)}</td>
            <td>${r.consumo != null ? r.consumo + " " + unit : "—"}</td>
            <td>${fmtVar(r.varConsumo, r.segnalaConsumo)}</td>
            <td>${segnalazione}</td>
        `;
        tbody.appendChild(tr);
    });

    renderPrezziChart(utility, rows);
}

// Grafico a linea dell'andamento del prezzo unitario nel tempo.
function renderPrezziChart(utility, rows) {
    const ctx = document.getElementById("chart-prezzi").getContext("2d");
    if (state.charts.prezzi) state.charts.prezzi.destroy();

    const unit = unitForUtility(utility);
    const labels = rows.map(r => formatDate(r.bill.periodo_fine || r.bill.data));
    const dataset = rows.map(r => r.prezzo);

    state.charts.prezzi = new Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
            datasets: [{
                label: `Prezzo Unitario (€/${unit})`,
                data: dataset,
                borderColor: "#f59e0b",
                backgroundColor: "rgba(245, 158, 11, 0.15)",
                borderWidth: 2,
                tension: 0.25,
                fill: true,
                pointRadius: 4,
                pointBackgroundColor: "#f59e0b"
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } },
                y: { beginAtZero: false, grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: {
                legend: { labels: { color: "#f8fafc" } }
            }
        }
    });
}

// --- CONFRONTO TRA PERIODI ---

// Genera la lista dei mesi 'YYYY-MM' di un periodo: da meseInizio per 'durata' mesi.
function mesiDelPeriodo(meseInizio, durata) {
    const out = [];
    let cur = meseInizio;
    for (let i = 0; i < durata && cur; i++) {
        out.push(cur);
        cur = nextMonthKey(cur);
    }
    return out;
}

// Consumo rilevato di un'utenza in un periodo di mesi: differenza tra l'ultima lettura
// del periodo e l'ultima lettura PRECEDENTE all'inizio del periodo. null se non calcolabile.
function consumoPeriodo(utility, mesi) {
    if (!mesi.length) return null;
    const reads = (state.data.readings[utility] || [])
        .filter(r => typeof r.data === "string")
        .sort((a, b) => a.data.localeCompare(b.data));
    if (reads.length === 0) return null;
    const meseInizio = mesi[0];
    const meseFine = mesi[mesi.length - 1];
    // Lettura di base = ultima lettura con mese < meseInizio.
    let base = null, fine = null;
    reads.forEach(r => {
        const ym = monthKey(r.data);
        if (!ym) return;
        if (ym < meseInizio) base = readingValue(r);           // l'ultima prima dell'inizio
        if (ym <= meseFine) fine = readingValue(r);            // l'ultima entro la fine
    });
    if (base == null || fine == null) return null;
    const diff = fine - base;
    return diff > 0 ? diff : null;
}

// Consumo di OGNI mese di un periodo: array (un valore per posizione del periodo).
// Per ogni mese: (ultima lettura del mese) − (ultima lettura del mese precedente con dati).
// 0 se quel mese non ha letture o il dato non è calcolabile.
function consumoPerMese(utility, mesi) {
    const reads = (state.data.readings[utility] || [])
        .filter(r => typeof r.data === "string");
    const ultimaDelMese = {};
    reads.forEach(r => {
        const ym = monthKey(r.data);
        if (ym) ultimaDelMese[ym] = readingValue(r);
    });
    return mesi.map(ym => {
        if (!(ym in ultimaDelMese)) return 0;
        const valFine = ultimaDelMese[ym];
        // Cerca il valore di riferimento nei mesi precedenti.
        let base = null, cur = prevMonthKey(ym), guard = 0;
        while (cur && guard < 240) {
            if (cur in ultimaDelMese) { base = ultimaDelMese[cur]; break; }
            cur = prevMonthKey(cur); guard++;
        }
        if (base == null) return 0;
        const diff = valFine - base;
        return diff > 0 ? diff : 0;
    });
}

function renderConfrontoTab() {
    if (state.activeTab !== "tab-confronto") return;

    const durata = parseInt(document.getElementById("confronto-durata").value, 10) || 3;
    const aMese = document.getElementById("confronto-a-mese").value;   // 'YYYY-MM' o ''
    const bMese = document.getElementById("confronto-b-mese").value;
    const sogliaPct = parseFloat(document.getElementById("confronto-soglia").value);
    const soglia = (isFinite(sogliaPct) && sogliaPct > 0) ? sogliaPct / 100 : 0.10;

    const tbody = document.getElementById("table-confronto-body");
    const label = document.getElementById("confronto-periodi-label");
    tbody.innerHTML = "";

    if (!aMese || !bMese) {
        label.textContent = "Seleziona il mese di partenza dei due periodi da confrontare.";
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-secondary); padding:20px;">Imposta durata, Periodo A e Periodo B.</td></tr>`;
        renderConfrontoChart([], []);
        return;
    }

    const mesiA = mesiDelPeriodo(aMese, durata);
    const mesiB = mesiDelPeriodo(bMese, durata);

    const fmtMese = (m) => formattaMeseAnno(m); // es. "gen 2025"
    label.innerHTML = `<strong>A:</strong> ${fmtMese(mesiA[0])} → ${fmtMese(mesiA[mesiA.length - 1])} &nbsp;&nbsp;|&nbsp;&nbsp; <strong>B:</strong> ${fmtMese(mesiB[0])} → ${fmtMese(mesiB[mesiB.length - 1])} &nbsp;(${durata} ${durata === 1 ? "mese" : "mesi"})`;

    const utenze = [
        { key: "LUCE", nome: "💡 Luce" },
        { key: "GAS", nome: "🔥 Gas" },
        { key: "ACQUA", nome: "💧 Acqua" }
    ];

    // Esito variazione: confronta B rispetto ad A.
    const esito = (a, b) => {
        if (a == null || b == null) return { txt: "n/d", cls: "secondary", pct: null };
        if (a === 0) return { txt: b === 0 ? "—" : "nuovo", cls: "secondary", pct: null };
        const v = (b - a) / a;
        if (Math.abs(v) <= soglia) return { txt: "Simile", cls: "success", pct: v };
        return v > 0 ? { txt: "In aumento", cls: "danger", pct: v } : { txt: "In calo", cls: "warning", pct: v };
    };

    const fmtPct = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;

    // Confronto SOLO sul CONSUMO (dalle autoletture): la spesa dipende dalle bollette,
    // che non sono sempre presenti, quindi non viene mostrata qui.
    const consumiA = [], consumiB = [], labelsUt = [];

    utenze.forEach(u => {
        const unit = unitForUtility(u.key);
        const coA = consumoPeriodo(u.key, mesiA);
        const coB = consumoPeriodo(u.key, mesiB);
        const e = esito(coA, coB);
        labelsUt.push(u.key);
        consumiA.push(coA || 0);
        consumiB.push(coB || 0);

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><span class="badge ${badgeUtenzaClass(u.key)}">${u.nome}</span></td>
            <td>Consumo</td>
            <td>${coA != null ? coA + " " + unit : "n/d"}</td>
            <td>${coB != null ? coB + " " + unit : "n/d"}</td>
            <td class="text-${e.cls} font-medium">${fmtPct(e.pct)}</td>
            <td><span class="badge badge-${e.cls}">${e.txt}</span></td>
        `;
        tbody.appendChild(tr);
    });

    renderConfrontoChart(labelsUt, [
        { label: `A (${fmtMese(mesiA[0])})`, data: consumiA },
        { label: `B (${fmtMese(mesiB[0])})`, data: consumiB }
    ]);

    // 3 grafici mese-per-mese (uno per utenza). Asse X = posizione nel periodo.
    const labelsPos = mesiA.map((_, i) => `${i + 1}° mese`);
    const labelA = `A (${fmtMese(mesiA[0])})`;
    const labelB = `B (${fmtMese(mesiB[0])})`;
    [
        { key: "LUCE", canvas: "chart-confronto-luce", chart: "confrontoLuce" },
        { key: "GAS", canvas: "chart-confronto-gas", chart: "confrontoGas" },
        { key: "ACQUA", canvas: "chart-confronto-acqua", chart: "confrontoAcqua" }
    ].forEach(g => {
        const dataA = consumoPerMese(g.key, mesiA);
        const dataB = consumoPerMese(g.key, mesiB);
        renderConfrontoMensileChart(g.canvas, g.chart, labelsPos, labelA, dataA, labelB, dataB);
    });

    lucide.createIcons();
}

// Grafico mese-per-mese (A vs B) per una singola utenza.
function renderConfrontoMensileChart(canvasId, chartKey, labels, labelA, dataA, labelB, dataB) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    if (state.charts[chartKey]) state.charts[chartKey].destroy();
    state.charts[chartKey] = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [
                { label: labelA, data: dataA, backgroundColor: "rgba(99, 102, 241, 0.7)", borderColor: "#6366f1", borderWidth: 1, borderRadius: 4 },
                { label: labelB, data: dataB, backgroundColor: "rgba(234, 179, 8, 0.7)", borderColor: "#eab308", borderWidth: 1, borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } },
                y: { beginAtZero: true, grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: { legend: { labels: { color: "#f8fafc", boxWidth: 12, font: { size: 10 } } } }
        }
    });
}

function renderConfrontoChart(labels, datasets) {
    const ctx = document.getElementById("chart-confronto").getContext("2d");
    if (state.charts.confronto) state.charts.confronto.destroy();
    state.charts.confronto = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [
                { label: datasets[0] ? datasets[0].label : "A", data: datasets[0] ? datasets[0].data : [], backgroundColor: "rgba(99, 102, 241, 0.7)", borderColor: "#6366f1", borderWidth: 1, borderRadius: 4 },
                { label: datasets[1] ? datasets[1].label : "B", data: datasets[1] ? datasets[1].data : [], backgroundColor: "rgba(234, 179, 8, 0.7)", borderColor: "#eab308", borderWidth: 1, borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } },
                y: { beginAtZero: true, grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: { legend: { labels: { color: "#f8fafc" } } }
        }
    });
}

// --- BACKUP E RESTORE (JSON BUNDLE) ---
function exportBackup() {
    if (!state.user) return;
    
    // Genera bundle
    const bundle = {
        app: "ConsumiCasa",
        export_date: new Date().toISOString().substring(0, 10),
        user: state.user.username,
        data: state.data
    };
    
    const blob = new Blob([JSON.stringify(bundle, null, 4)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup_consumi_${state.user.username}_${bundle.export_date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Valida la forma di un bundle di backup e lo normalizza a una struttura sicura
// { LUCE:{bills:[],readings:[]}, GAS:{...}, ACQUA:{...} } senza toccare state.data.
// Lancia un Error con messaggio leggibile se il bundle è inutilizzabile.
function validaBundleBackup(bundle) {
    if (!bundle || typeof bundle !== "object") {
        throw new Error("File non valido o vuoto.");
    }
    if (bundle.app !== "ConsumiCasa") {
        throw new Error("File JSON di backup non compatibile con questa applicazione.");
    }
    // La struttura di state.data (e quindi del bundle) è:
    //   data: { bills: {LUCE,GAS,ACQUA}, readings: {LUCE,GAS,ACQUA} }
    if (!bundle.data || typeof bundle.data !== "object" ||
        typeof bundle.data.bills !== "object" || typeof bundle.data.readings !== "object") {
        throw new Error("Il backup non contiene la sezione dati attesa (bills/readings).");
    }

    const utilities = ["LUCE", "GAS", "ACQUA"];
    const pulito = {};
    const recordValido = (r) => r && typeof r === "object" && typeof r.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.data);

    utilities.forEach(ut => {
        const bills = Array.isArray(bundle.data.bills[ut]) ? bundle.data.bills[ut] : [];
        const readings = Array.isArray(bundle.data.readings[ut]) ? bundle.data.readings[ut] : [];
        // Ogni record deve avere una data valida: altrimenti il salvataggio (che ordina
        // per data) si romperebbe. Se ne trovo di malformati, blocco prima di scrivere.
        const billMal = bills.filter(r => !recordValido(r)).length;
        const readMal = readings.filter(r => !recordValido(r)).length;
        if (billMal > 0 || readMal > 0) {
            throw new Error(`Dati ${ut} corrotti nel backup (${billMal} bollette e ${readMal} letture senza data valida). Importazione annullata.`);
        }
        pulito[ut] = { bills, readings };
    });
    return pulito;
}

async function importBackup(e) {
    const fileInput = e.target;
    const file = fileInput.files[0];
    const statusText = document.getElementById("import-status-text");

    if (!file) return;
    statusText.style.color = "var(--text-secondary)";
    statusText.textContent = "Analisi file...";

    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const bundle = JSON.parse(event.target.result);

            // 1) Valida e normalizza SENZA toccare state.data: se il bundle è
            //    corrotto, qui lanciamo e non abbiamo modificato nulla.
            const nuovo = validaBundleBackup(bundle);

            // 2) Conta cosa si sta per importare e cosa verrebbe SOSTITUITO,
            //    così l'utente sa esattamente cosa perde (l'import è una sostituzione totale).
            //    NB: state.data ha forma {bills:{ut:[]}, readings:{ut:[]}}, mentre `nuovo`
            //    (da validaBundleBackup) ha forma {ut:{bills:[],readings:[]}} — due conteggi distinti.
            const utilities = ["LUCE", "GAS", "ACQUA"];
            const contaStato = (d) => utilities.reduce((acc, ut) => {
                acc.bills += ((d && d.bills && d.bills[ut]) || []).length;
                acc.readings += ((d && d.readings && d.readings[ut]) || []).length;
                return acc;
            }, { bills: 0, readings: 0 });
            const contaNuovo = (n) => utilities.reduce((acc, ut) => {
                acc.bills += ((n && n[ut] && n[ut].bills) || []).length;
                acc.readings += ((n && n[ut] && n[ut].readings) || []).length;
                return acc;
            }, { bills: 0, readings: 0 });
            const attuale = contaStato(state.data);
            const inArrivo = contaNuovo(nuovo);

            // 3) Conferma esplicita: l'import SOSTITUISCE i dati attuali (e li specchia sul NAS),
            //    non li unisce. È irreversibile.
            const msg =
                "ATTENZIONE: l'importazione SOSTITUISCE tutti i dati attuali, non li unisce.\n\n" +
                `Dati attuali (verranno cancellati): ${attuale.bills} bollette, ${attuale.readings} letture.\n` +
                `Dal backup verranno caricati: ${inArrivo.bills} bollette, ${inArrivo.readings} letture.\n` +
                (bundle.export_date ? `Backup del: ${bundle.export_date}\n` : "") +
                "\nL'operazione è irreversibile" + (state.storageMode === "server" ? " e si applica anche al NAS." : ".") +
                "\n\nProcedere?";
            if (!confirm(msg)) {
                statusText.style.color = "var(--text-secondary)";
                statusText.textContent = "Importazione annullata.";
                fileInput.value = ""; // permette di riselezionare lo stesso file
                return;
            }

            // 4) Solo ora committiamo sullo stato e salviamo.
            state.data = {
                bills:    { LUCE: nuovo.LUCE.bills,    GAS: nuovo.GAS.bills,    ACQUA: nuovo.ACQUA.bills },
                readings: { LUCE: nuovo.LUCE.readings, GAS: nuovo.GAS.readings, ACQUA: nuovo.ACQUA.readings }
            };

            statusText.style.color = "var(--text-secondary)";
            statusText.textContent = "Importazione in corso...";
            for (const ut of utilities) {
                await saveUtilityData(ut, "bill");
                await saveUtilityData(ut, "manual");
            }

            statusText.style.color = "var(--color-success)";
            statusText.textContent = "Backup importato con successo! Ricarico...";
            setTimeout(() => {
                window.location.reload();
            }, 1500);

        } catch (err) {
            statusText.style.color = "var(--color-danger)";
            statusText.textContent = `Errore di importazione: ${err.message}`;
            fileInput.value = "";
        }
    };
    reader.readAsText(file);
}

// --- UTILITY E AIUTI LOCALI ---
function formatDate(dateStr) {
    if (!dateStr) return "-";
    const parts = dateStr.split("-");
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// Periodo di riferimento "inizio → fine" di un record, "—" se assente (es. molte letture).
function formattaPeriodo(rec) {
    if (!rec || (!rec.periodo_inizio && !rec.periodo_fine)) return "—";
    const i = rec.periodo_inizio ? formatDate(rec.periodo_inizio) : "?";
    const f = rec.periodo_fine ? formatDate(rec.periodo_fine) : "?";
    return `${i} → ${f}`;
}

// Filtra una lista di record per intervallo di date [from, to] sul campo `data`
// (stringhe 'YYYY-MM-DD', confronto lessicografico). Estremi inclusi; vuoti = nessun limite.
function filtraPerIntervallo(lista, from, to) {
    return lista.filter(r => {
        if (typeof r.data !== "string") return false;
        if (from && r.data < from) return false;
        if (to && r.data > to) return false;
        return true;
    });
}

function currentYear() {
    return new Date().getFullYear();
}

function unitForUtility(utility) {
    return utility === "LUCE" ? "kWh" : utility === "GAS" ? "SMC" : utility === "ACQUA" ? "m³" : "";
}

// Classe CSS del badge colorato per utenza (luce/gas/acqua/rifiuti → colore ufficiale).
function badgeUtenzaClass(utility) {
    const u = (utility || "").toUpperCase();
    return u === "LUCE" ? "badge-luce" : u === "GAS" ? "badge-gas" : u === "ACQUA" ? "badge-acqua" : u === "RIFIUTI" ? "badge-rifiuti" : "badge-secondary";
}

// --- AUDIT CONSUMI: confronto consumo FATTURATO vs RILEVATO ---
// (consumo rilevato calcolato per differenza tra autoletture progressive del contatore).
// Funzioni pure: nessun accesso al DOM, nessuno stato globale.

// Estrazione robusta del valore progressivo del contatore da un record.
// LUCE usa `lettura_totale`; GAS/ACQUA usano `lettura`. Difensivo su null/undefined/NaN.
function readingValue(rec) {
    if (!rec || typeof rec !== "object") return 0;
    // Preferisci lettura_totale (LUCE) se è un numero valido.
    if (typeof rec.lettura_totale === "number" && isFinite(rec.lettura_totale)) {
        return rec.lettura_totale;
    }
    // Altrimenti lettura (GAS/ACQUA).
    if (typeof rec.lettura === "number" && isFinite(rec.lettura)) {
        return rec.lettura;
    }
    return 0;
}

// Converte 'YYYY-MM-DD' nella chiave mese 'YYYY-MM'. Null-safe.
function monthKey(dateStr) {
    if (typeof dateStr !== "string" || dateStr.length < 7) return null;
    const ym = dateStr.slice(0, 7);
    // Validazione minima del formato 'YYYY-MM'.
    if (!/^\d{4}-\d{2}$/.test(ym)) return null;
    return ym;
}

// Restituisce il mese precedente a 'YYYY-MM' (gestisce il confine d'anno: 2026-01 -> 2025-12).
function prevMonthKey(ym) {
    if (typeof ym !== "string" || !/^\d{4}-\d{2}$/.test(ym)) return null;
    let anno = parseInt(ym.slice(0, 4), 10);
    let mese = parseInt(ym.slice(5, 7), 10); // 1..12
    mese -= 1;
    if (mese < 1) {
        // Da gennaio si torna a dicembre dell'anno precedente.
        mese = 12;
        anno -= 1;
    }
    const meseStr = (mese < 10 ? "0" : "") + mese;
    return anno + "-" + meseStr;
}

// Trova l'autolettura "utile" per un mese target:
// l'ULTIMA (data più recente) tra quelle il cui mese è <= targetYm.
// 'sortedReadings' è già ordinato crescente per data, quindi scorriamo dal fondo:
// il primo record con mese <= targetYm è il più recente che soddisfa il vincolo.
// Gestisce mese mancante (usa la più recente precedente) e mesi duplicati
// (l'ultima del mese vince). Il confronto lessicografico tra stringhe 'YYYY-MM'
// zero-padded coincide con l'ordine cronologico, anche a cavallo d'anno.
function readingForMonth(sortedReadings, targetYm) {
    if (!Array.isArray(sortedReadings) || sortedReadings.length === 0) return null;
    if (typeof targetYm !== "string" || !/^\d{4}-\d{2}$/.test(targetYm)) return null;
    for (let i = sortedReadings.length - 1; i >= 0; i--) {
        const rec = sortedReadings[i];
        const rym = monthKey(rec && rec.data);
        if (rym === null) continue; // record con data malformata: ignora
        if (rym <= targetYm) {
            return rec;
        }
    }
    return null;
}

// Audit del consumo di una singola bolletta: confronta il consumo fatturato con
// quello rilevato dalle autoletture, ragionando per MESE (non per giorno).
// 'bill': record bolletta; 'sortedReadings': autoletture (asc per data).
function auditConsumoForBill(bill, sortedReadings) {
    // Risultato di default: non verificabile finché non dimostriamo il contrario.
    const result = {
        verifiable: false,
        reason: null,
        consumoFatturato: null,
        consumoRilevato: null,
        delta: null,
        deltaPct: null,
        startMonth: null,
        endMonth: null,
        letturaInizio: null,
        letturaFine: null
    };

    if (!bill || typeof bill !== "object") {
        result.reason = "Bolletta non valida.";
        return result;
    }

    // La bolletta deve avere un periodo completo (inizio e fine).
    const pInizio = monthKey(bill.periodo_inizio);
    const pFine = monthKey(bill.periodo_fine);

    if (pInizio === null) {
        result.reason = "Manca il periodo di inizio in bolletta.";
        return result;
    }
    if (pFine === null) {
        result.reason = "Manca il periodo di fine in bolletta.";
        return result;
    }

    // consumo_fatturato deve essere un numero valido.
    if (typeof bill.consumo_fatturato !== "number" || !isFinite(bill.consumo_fatturato)) {
        result.reason = "Consumo fatturato non indicato in bolletta.";
        return result;
    }
    result.consumoFatturato = bill.consumo_fatturato;

    // endMonth   = mese di periodo_fine.
    // startMonth = mese IMMEDIATAMENTE PRECEDENTE al mese di periodo_inizio
    //              (la lettura di base è quella presa prima dell'inizio del periodo).
    const endMonth = pFine;
    const startMonth = prevMonthKey(pInizio);
    result.endMonth = endMonth;
    result.startMonth = startMonth;

    if (startMonth === null) {
        result.reason = "Impossibile determinare il mese di riferimento iniziale.";
        return result;
    }

    // letturaInizio = autolettura del mese di base (o la più recente <= startMonth).
    // letturaFine   = autolettura del mese di fine (o la più recente <= endMonth).
    const recInizio = readingForMonth(sortedReadings, startMonth);
    const recFine = readingForMonth(sortedReadings, endMonth);

    if (!recInizio) {
        result.reason = "Manca un'autolettura per il mese di riferimento iniziale (" + startMonth + ") o precedenti.";
        return result;
    }
    if (!recFine) {
        result.reason = "Manca un'autolettura per il mese di fine periodo (" + endMonth + ") o precedenti.";
        return result;
    }

    const valInizio = readingValue(recInizio);
    const valFine = readingValue(recFine);
    result.letturaInizio = valInizio;
    result.letturaFine = valFine;

    // Consumo rilevato = differenza tra le due letture progressive.
    const consumoRilevato = valFine - valInizio;

    // Un consumo <= 0 indica un azzeramento del contatore o dati incoerenti:
    // non lo consideriamo verificabile e non inventiamo un valore.
    if (consumoRilevato <= 0) {
        result.reason = "Consumo rilevato non valido (≤ 0): possibile azzeramento del contatore o letture incoerenti.";
        return result;
    }
    result.consumoRilevato = consumoRilevato;

    // delta    = fatturato - rilevato (positivo = fatturato più alto del rilevato).
    // deltaPct = delta / rilevato (frazione: 0.07 = +7%).
    result.delta = result.consumoFatturato - consumoRilevato;
    result.deltaPct = consumoRilevato !== 0 ? (result.delta / consumoRilevato) : null;

    result.verifiable = true;
    result.reason = null;
    return result;
}

// --- FUNZIONI CONTROLLO SINCRONIZZAZIONE NAS ---
async function checkSyncAndLoad() {
    if (state.storageMode === "local") {
        loadData();
        return;
    }

    // In parallelo (non bloccante) verifica anche lo stato del codice dell'app sul NAS.
    notifyAppCodeStatus();

    try {
        const response = await fetch(`${state.apiBaseUrl}/api/sync/status?user=${state.user.username}`);
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.has_conflict) {
                showSyncConflictOverlay(data.report);
            } else {
                document.getElementById("sync-overlay").classList.add("hidden");
                loadData();
            }
        } else {
            loadData();
        }
    } catch(err) {
        console.error("Errore controllo sync:", err);
        loadData();
    }
}

// --- CONTROLLO STATO CODICE APPLICAZIONE (locale vs NAS) ---

// Recupera lo stato dal backend. Ritorna l'oggetto report o null in caso di errore/offline.
async function fetchAppCodeStatus() {
    if (state.storageMode === "local") return null;
    try {
        const response = await fetch(`${state.apiBaseUrl}/api/app/status`);
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.success) return null;
        return { richiede_attenzione: data.richiede_attenzione, report: data.report };
    } catch (err) {
        console.error("Errore controllo stato app:", err);
        return null;
    }
}

// Avviso sintetico non bloccante al login se il codice app sul NAS è disallineato.
async function notifyAppCodeStatus() {
    const banner = document.getElementById("app-code-warning");
    if (!banner) return;
    const res = await fetchAppCodeStatus();
    if (!res || !res.richiede_attenzione) {
        banner.classList.add("hidden");
        return;
    }
    const r = res.report.riepilogo || {};
    const diversi = (r.diversi || 0) + (r.solo_locale || 0) + (r.solo_remoto || 0);
    document.getElementById("app-code-warning-text").textContent =
        `Il codice dell'app sul NAS è disallineato: ${diversi} file da pubblicare/verificare.`;
    banner.classList.remove("hidden");
    if (window.lucide) lucide.createIcons();
}

// Controllo dettagliato mostrato nella scheda Impostazioni.
async function checkAppCodeStatus(mostraCaricamento) {
    const resultBox = document.getElementById("app-status-result");
    const summaryBox = document.getElementById("app-status-summary");

    if (state.storageMode === "local") {
        summaryBox.style.display = "none";
        resultBox.innerHTML = `<p class="help-text">Controllo non disponibile in modalità archiviazione locale.</p>`;
        return;
    }

    if (mostraCaricamento) {
        resultBox.innerHTML = `<p class="help-text">Confronto in corso…</p>`;
    }

    const res = await fetchAppCodeStatus();
    if (!res) {
        summaryBox.style.display = "none";
        resultBox.innerHTML = `<p class="help-text">Impossibile contattare il NAS o il server backend. Riprova quando il NAS è online.</p>`;
        return;
    }

    const report = res.report;
    if (report.stato === "offline") {
        summaryBox.style.display = "none";
        resultBox.innerHTML = `<p class="help-text">NAS non raggiungibile: impossibile confrontare il codice.</p>`;
        return;
    }
    if (report.stessa_radice) {
        summaryBox.style.display = "none";
        resultBox.innerHTML = `<p class="help-text">L'applicazione sta già girando dalla cartella sul NAS: locale e produzione coincidono.</p>`;
        return;
    }
    if (!report.remoto_presente) {
        summaryBox.style.display = "none";
        resultBox.innerHTML = `<p class="help-text">La cartella dell'app sul NAS non è presente o non è accessibile.</p>`;
        return;
    }

    const c = report.riepilogo || {};
    document.getElementById("app-badge-id").textContent = `Identici: ${c.identici || 0}`;
    document.getElementById("app-badge-diff").textContent = `Diversi: ${c.diversi || 0}`;
    document.getElementById("app-badge-loc").textContent = `Solo locale: ${c.solo_locale || 0}`;
    document.getElementById("app-badge-rem").textContent = `Solo NAS: ${c.solo_remoto || 0}`;
    summaryBox.style.display = "";

    const nonAllineati = (report.dettagli || []).filter(d => d.stato !== "identico");

    if (nonAllineati.length === 0) {
        resultBox.innerHTML = `<p class="text-success font-medium"><i data-lucide="check-circle-2"></i> Il codice dell'app sul NAS è allineato a quello locale.</p>`;
        if (window.lucide) lucide.createIcons();
        return;
    }

    const badgePerStato = (stato) => {
        if (stato === "diverso") return `<span class="badge badge-warning">Diverso</span>`;
        if (stato === "solo_locale") return `<span class="badge badge-secondary">Solo su PC</span>`;
        if (stato === "solo_remoto") return `<span class="badge badge-info">Solo su NAS</span>`;
        return `<span class="badge badge-success">Identico</span>`;
    };

    const righe = nonAllineati.map(d => `
        <tr>
            <td class="font-medium">${d.file}</td>
            <td>${badgePerStato(d.stato)}</td>
            <td style="font-size:0.85rem;">${d.locale_data}</td>
            <td style="font-size:0.85rem;">${d.remoto_data}</td>
        </tr>
    `).join("");

    resultBox.innerHTML = `
        <p class="subtitle">${nonAllineati.length} file non allineati. La pubblicazione sul NAS va eseguita manualmente (copia di <code>${report.app_dir_locale || "locale"}</code> verso <code>${report.app_dir_remota || "NAS"}</code>, escludendo la cartella <code>database</code>).</p>
        <div class="table-responsive mt-2">
            <table class="data-table">
                <thead>
                    <tr><th>File</th><th>Stato</th><th>PC (data)</th><th>NAS (data)</th></tr>
                </thead>
                <tbody>${righe}</tbody>
            </table>
        </div>
    `;
    if (window.lucide) lucide.createIcons();
}

// Pubblica il codice dell'app sul NAS (specchio esatto, con backup preventivo).
// Operazione che SCRIVE e CANCELLA sul NAS: richiede conferma esplicita.
async function publishAppToNas() {
    if (state.storageMode === "local") {
        alert("La pubblicazione sul NAS non è disponibile in modalità archiviazione locale.");
        return;
    }

    // Prima mostra all'utente cosa cambierà (controllo a sola lettura).
    const pre = await fetchAppCodeStatus();
    if (!pre || !pre.report || pre.report.stato === "offline") {
        alert("NAS non raggiungibile: impossibile pubblicare ora.");
        return;
    }
    if (pre.report.stessa_radice) {
        alert("L'app sta già girando dalla cartella sul NAS: nessuna pubblicazione necessaria.");
        return;
    }
    const c = pre.report.riepilogo || {};
    const daCopiare = (c.diversi || 0) + (c.solo_locale || 0);
    const daCancellare = c.solo_remoto || 0;

    const conferma = confirm(
        "Pubblicare il codice dell'app sul NAS?\n\n" +
        `• File da copiare/aggiornare sul NAS: ${daCopiare}\n` +
        `• File da CANCELLARE dal NAS (non più presenti in locale): ${daCancellare}\n\n` +
        "Prima della pubblicazione verrà salvato un backup del NAS attuale sul PC.\n" +
        "I dati (cartella database) non vengono toccati.\n\n" +
        "Procedere?"
    );
    if (!conferma) return;

    const resultBox = document.getElementById("app-status-result");
    const btn = document.getElementById("btn-publish-app");
    btn.disabled = true;
    resultBox.innerHTML = `<p class="help-text">Backup del NAS e pubblicazione in corso…</p>`;

    try {
        const response = await fetch(`${state.apiBaseUrl}/api/app/publish`, { method: "POST" });
        const data = await response.json();

        if (response.ok && data.success) {
            const r = data.report || {};
            resultBox.innerHTML = `
                <p class="text-success font-medium"><i data-lucide="check-circle-2"></i> Pubblicazione completata.</p>
                <p class="subtitle mt-1">Copiati/aggiornati: ${r.n_copiati || 0} · Cancellati dal NAS: ${r.n_cancellati || 0}.</p>
                <p class="help-text mt-1">Backup del NAS precedente salvato in: <code>${r.backup_dir || "-"}</code></p>
            `;
        } else {
            const r = data.report || {};
            const msg = r.errore || (data.error) || "Pubblicazione non riuscita.";
            resultBox.innerHTML = `<p class="text-danger font-medium">Pubblicazione non riuscita: ${msg}</p>`;
        }
    } catch (err) {
        console.error("Errore pubblicazione su NAS:", err);
        resultBox.innerHTML = `<p class="text-danger font-medium">Impossibile contattare il server per la pubblicazione.</p>`;
    } finally {
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
        // Riallinea il riepilogo dopo l'operazione.
        checkAppCodeStatus(false);
    }
}

function showSyncConflictOverlay(report) {
    const tbody = document.getElementById("sync-conflict-tbody");
    tbody.innerHTML = "";
    
    const conflicts = Object.entries(report.dettagli).filter(([key, info]) => info.stato_confronto !== "allineato");
    
    conflicts.forEach(([key, info]) => {
        const tr = document.createElement("tr");
        
        // Formatta il nome della chiave per l'utente
        const parts = key.split("_");
        const utenza = parts[0];
        const isManual = parts.length > 1;
        const displayName = `${utenza} ${isManual ? '(Letture)' : '(Bollette)'}`;
        
        // Badge di stato
        let stateBadge = "";
        if (info.stato_confronto === "locale_piu_nuovo") {
            stateBadge = `<span class="badge badge-warning">PC più recente</span>`;
        } else if (info.stato_confronto === "remoto_piu_nuovo") {
            stateBadge = `<span class="badge badge-info">NAS più recente</span>`;
        } else if (info.stato_confronto === "solo_locale") {
            stateBadge = `<span class="badge badge-warning">Solo su PC</span>`;
        } else if (info.stato_confronto === "solo_remoto") {
            stateBadge = `<span class="badge badge-info">Solo su NAS</span>`;
        }
        
        tr.innerHTML = `
            <td class="font-medium">${displayName}</td>
            <td>${info.locale_data || 'Nessun dato'}</td>
            <td>${info.remoto_data || 'Nessun dato'}</td>
            <td>${stateBadge}</td>
            <td>
                <div style="display:flex; gap:8px;">
                    <button class="btn-secondary btn-sm btn-resolve-sync" data-action="download" data-key="${key}" style="padding: 4px 8px; font-size: 0.75rem;"><i data-lucide="download" style="width:10px; height:10px;"></i> Scarica</button>
                    <button class="btn-primary btn-sm btn-resolve-sync" data-action="upload" data-key="${key}" style="padding: 4px 8px; font-size: 0.75rem;"><i data-lucide="upload" style="width:10px; height:10px;"></i> Carica</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    // Mostra l'overlay
    document.getElementById("sync-overlay").classList.remove("hidden");
    lucide.createIcons();
    
    // Collega gli eventi dei pulsanti di risoluzione singola
    tbody.querySelectorAll(".btn-resolve-sync").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const button = e.currentTarget;
            const action = button.getAttribute("data-action");
            const key = button.getAttribute("data-key");
            
            button.disabled = true;
            button.textContent = "Sync...";
            
            const success = await resolveSyncConflict(action, key);
            if (success) {
                checkSyncAndLoad();
            } else {
                button.disabled = false;
                button.textContent = action === "download" ? "Scarica" : "Carica";
            }
        });
    });
}

async function resolveSyncConflict(action, key) {
    try {
        const response = await fetch(`${state.apiBaseUrl}/api/sync/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user: state.user.username,
                action: action,
                key: key
            })
        });
        if (response.ok) {
            const data = await response.json();
            return data.success;
        }
        return false;
    } catch(err) {
        console.error("Errore risoluzione sync:", err);
        alert("Impossibile allineare con il server NAS.");
        return false;
    }
}
