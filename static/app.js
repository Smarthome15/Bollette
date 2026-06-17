// app.js

// --- STATO DELL'APPLICAZIONE ---
const state = {
    user: null, // conterrà { username, ruolo, prefix }
    apiBaseUrl: "",
    storageMode: "server", // 'server' o 'local'
    data: {
        bills: { LUCE: [], GAS: [], ACQUA: [] },
        readings: { LUCE: [], GAS: [], ACQUA: [] }
    },
    charts: {
        spese: null,
        consumi: null,
        audit: null
    },
    activeTab: "tab-dashboard",
    currentBillFilter: "all",
    currentReadingFilter: "all",
    tempPdfFile: null // File temporaneo caricato durante l'inserimento bolletta
};

// Mappa traduzione mesi
const MESI_IT_BREVE = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

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
        state.apiBaseUrl = savedApiUrl;
    } else {
        // Se siamo su una porta diversa da quella del backend (es: 8123 di Home Assistant),
        // impostiamo l'indirizzo IP corrente sulla porta 8000 di default
        if (window.location.port !== "8000" && window.location.hostname) {
            state.apiBaseUrl = `${window.location.protocol}//${window.location.hostname}:8000`;
        } else {
            state.apiBaseUrl = ""; // percorso relativo
        }
    }
    
    // Compila i campi form impostazioni
    document.getElementById("settings-storage-mode").value = state.storageMode;
    document.getElementById("settings-api-url").value = state.apiBaseUrl || `${window.location.protocol}//${window.location.hostname}:8000`;
    
    if (state.storageMode === "local") {
        document.getElementById("settings-api-url-group").classList.add("hidden");
    }
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

    // Filtri tabelle Letture
    document.querySelectorAll(".filter-btn-reading").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".filter-btn-reading").forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            state.currentReadingFilter = e.target.getAttribute("data-utility");
            renderReadingsTable();
        });
    });

    // Panel Inserimento Bolletta (Apri/Chiudi)
    document.getElementById("btn-nuova-bolletta").addEventListener("click", () => {
        document.getElementById("panel-inserimento-bolletta").classList.remove("hidden");
        resetBillForm();
    });
    
    document.getElementById("btn-chiudi-inserimento").addEventListener("click", () => {
        document.getElementById("panel-inserimento-bolletta").classList.add("hidden");
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

    // Modal close
    document.getElementById("btn-close-modal").addEventListener("click", () => {
        document.getElementById("modal-dettaglio-bolletta").classList.add("hidden");
        document.getElementById("modal-pdf-frame").src = "";
    });

    // Utenza select in Verifica
    document.getElementById("audit-utility-select").addEventListener("change", () => {
        renderAuditTab();
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
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";

    if (state.storageMode === "local") {
        // In modalità local storage, simuliamo un login di successo istantaneo
        const prefixMap = { Matteo: "UserA", Dario: "UserB", Test: "UserC", Test_2: "UserD" };
        state.user = { username, ruolo: username === "Matteo" ? "admin" : "user", prefix: prefixMap[username] };
        sessionStorage.setItem("consumicasa_user", JSON.stringify(state.user));
        checkLogin();
        return;
    }

    try {
        const response = await fetch(`${state.apiBaseUrl}/api/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (response.ok && data.success) {
            state.user = { username: data.username, ruolo: data.ruolo, prefix: data.prefix };
            sessionStorage.setItem("consumicasa_user", JSON.stringify(state.user));
            checkLogin();
        } else {
            errorEl.textContent = data.message || "Credenziali non valide.";
        }
    } catch (err) {
        console.error("Errore login:", err);
        errorEl.textContent = "Impossibile connettersi al server backend.";
    }
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
    
    const utilities = ["LUCE", "GAS", "ACQUA"];
    
    if (state.storageMode === "local") {
        // Carica da LocalStorage
        utilities.forEach(ut => {
            const bKey = `local_${state.user.prefix}_${ut.toLowerCase()}`;
            const rKey = `local_${state.user.prefix}_man_${ut.toLowerCase()}`;
            state.data.bills[ut] = JSON.parse(localStorage.getItem(bKey)) || [];
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
                // Carica bollette
                const bRes = await fetch(`${state.apiBaseUrl}/api/data?user=${state.user.username}&utility=${ut}&type=bill`);
                if (bRes.ok) state.data.bills[ut] = await bRes.json();
                
                // Carica letture
                const rRes = await fetch(`${state.apiBaseUrl}/api/data?user=${state.user.username}&utility=${ut}&type=manual`);
                if (rRes.ok) state.data.readings[ut] = await rRes.json();
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
                    
                    const controllerR = new AbortController();
                    const timeoutR = setTimeout(() => controllerR.abort(), 1500);
                    const rRes = await fetch(`../database/${prefix}_man_${ut.toLowerCase()}.json`, { signal: controllerR.signal });
                    if (rRes.ok) {
                        state.data.readings[ut] = await rRes.json();
                        loadedFromHAStatic = true;
                    }
                    clearTimeout(timeoutR);
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

async function saveUtilityData(utility, dataType) {
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
            // Se stiamo salvando un'autolettura e il server è offline, la salviamo localmente come "pending"
            savePendingReadingOffline(utility, records[records.length - 1]);
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
}

// --- RICEZIONE E CARICAMENTO PDF ---
async function handlePdfSelected(file) {
    state.tempPdfFile = file;
    
    const dragDropArea = document.getElementById("pdf-drag-drop");
    const uploadingBadge = document.getElementById("uploading-badge");
    const previewBox = document.getElementById("pdf-preview-box");
    const previewFrame = document.getElementById("pdf-preview-frame");
    
    dragDropArea.classList.add("hidden");
    uploadingBadge.classList.remove("hidden");
    
    // Genera URL locale per anteprima istantanea nel browser
    const blobUrl = URL.createObjectURL(file);
    previewFrame.src = blobUrl;
    previewBox.classList.remove("hidden");
    
    // Se siamo offline o in locale, saltiamo il parsing server
    if (state.storageMode === "local") {
        uploadingBadge.classList.add("hidden");
        return;
    }
    
    // Invia al backend per l'estrazione dati con pdfplumber/Gemini
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
            prefillBillForm(parsed);
            
            // Visualizza banner IA
            const aiBanner = document.getElementById("ai-status-banner");
            const aiText = document.getElementById("ai-status-text");
            aiBanner.classList.remove("hidden");
            if (parsed.parsed_via === "gemini") {
                aiText.textContent = "Analisi Gemini AI completata con successo!";
            } else {
                aiText.textContent = "Estrazione dati completata tramite motore euristico locale.";
            }
        }
    } catch (err) {
        console.error("Errore parsing PDF:", err);
    } finally {
        uploadingBadge.classList.add("hidden");
    }
}

function prefillBillForm(data) {
    if (data.data) document.getElementById("bill-date").value = data.data;
    if (data.periodo_inizio) document.getElementById("bill-periodo-inizio").value = data.periodo_inizio;
    if (data.periodo_fine) document.getElementById("bill-periodo-fine").value = data.periodo_fine;
    if (data.consumo_fatturato != null) document.getElementById("bill-consumo-fatturato").value = data.consumo_fatturato;
    if (data.fattura) document.getElementById("bill-amount").value = data.fattura;

    const utility = document.getElementById("bill-utility").value;
    if (utility === "LUCE") {
        document.getElementById("bill-f1").value = data.lettura_f1 || 0;
        document.getElementById("bill-f2").value = data.lettura_f2 || 0;
        document.getElementById("bill-f3").value = data.lettura_f3 || 0;
        document.getElementById("bill-luce-totale").value = data.lettura_totale || (data.lettura_f1 + data.lettura_f2 + data.lettura_f3) || 0;
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
    document.getElementById("ai-status-banner").classList.add("hidden");
}

function resetBillForm() {
    document.getElementById("form-bolletta").reset();
    removePdfFile();
    toggleUtilityFields("LUCE", "bill");
}

// --- FUNZIONI DI SALVATAGGIO DEI MODULI ---
async function saveNewBill(e) {
    e.preventDefault();
    const utility = document.getElementById("bill-utility").value;
    const date = document.getElementById("bill-date").value;
    const amount = parseFloat(document.getElementById("bill-amount").value) || null;
    const billType = document.getElementById("bill-type").value;
    const notes = document.getElementById("bill-notes").value.trim();
    
    let pdfPath = null;
    
    // 1. Carica il PDF sul server se presente
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

    // Costruisci record
    const record = {
        data: date,
        periodo_inizio: periodoInizio,
        periodo_fine: periodoFine,
        consumo_fatturato: consumoFatturato,
        fattura: amount,
        pdf_path: pdfPath,
        tipo_lettura: billType, // Stimata, Rilevata, Mista
        note: notes
    };

    if (utility === "LUCE") {
        const f1 = parseInt(document.getElementById("bill-f1").value) || 0;
        const f2 = parseInt(document.getElementById("bill-f2").value) || 0;
        const f3 = parseInt(document.getElementById("bill-f3").value) || 0;
        record.lettura_f1 = f1;
        record.lettura_f2 = f2;
        record.lettura_f3 = f3;
        record.lettura_totale = parseInt(document.getElementById("bill-luce-totale").value) || (f1 + f2 + f3);
    } else {
        record.lettura = parseInt(document.getElementById("bill-reading").value) || 0;
    }

    // 2. Aggiungi all'array dello stato
    state.data.bills[utility].push(record);
    
    // 3. Salva
    await saveUtilityData(utility, "bill");
    
    // Pulisci e chiudi form
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
    } else {
        record.lettura = parseInt(document.getElementById("read-value").value) || 0;
    }

    state.data.readings[utility].push(record);
    await saveUtilityData(utility, "manual");
    
    document.getElementById("form-lettura").reset();
    toggleUtilityFields("LUCE", "read");
}

async function deleteBill(utility, index) {
    if (!confirm("Sei sicuro di voler eliminare questa bolletta dallo storico?")) return;
    state.data.bills[utility].splice(index, 1);
    await saveUtilityData(utility, "bill");
}

async function deleteReading(utility, index) {
    if (!confirm("Sei sicuro di voler eliminare questa autolettura?")) return;
    state.data.readings[utility].splice(index, 1);
    await saveUtilityData(utility, "manual");
}

// --- CODICE RENDERIZZAZIONE INTERFACCIA (TAB) ---

// DASHBOARD RENDER
function renderDashboard() {
    if (state.activeTab !== "tab-dashboard") return;
    
    const bills = state.data.bills;
    const readings = state.data.readings;
    
    // 1. Calcola Spesa Totale Anno Corrente
    const currentYear = new Date().getFullYear();
    let totalSpentThisYear = 0;
    let totalSpentLastYear = 0;
    
    Object.keys(bills).forEach(ut => {
        bills[ut].forEach(b => {
            if (!b.fattura) return;
            const bYear = new Date(b.data).getFullYear();
            if (bYear === currentYear) {
                totalSpentThisYear += b.fattura;
            } else if (bYear === currentYear - 1) {
                totalSpentLastYear += b.fattura;
            }
        });
    });

    document.getElementById("kpi-spesa-totale").textContent = `€ ${totalSpentThisYear.toFixed(2)}`;
    
    const trendEl = document.getElementById("kpi-spesa-trend");
    if (totalSpentLastYear > 0) {
        const pctDiff = ((totalSpentThisYear - totalSpentLastYear) / totalSpentLastYear) * 100;
        if (pctDiff > 0) {
            trendEl.className = "kpi-trend up";
            trendEl.innerHTML = `<i data-lucide="trending-up" style="display:inline-block; width:12px; height:12px;"></i> +${pctDiff.toFixed(1)}% rispetto all'anno scorso`;
        } else {
            trendEl.className = "kpi-trend down";
            trendEl.innerHTML = `<i data-lucide="trending-down" style="display:inline-block; width:12px; height:12px;"></i> ${pctDiff.toFixed(1)}% rispetto all'anno scorso`;
        }
    } else {
        trendEl.className = "kpi-trend";
        trendEl.textContent = "Nessun dato storico precedente";
    }

    // 2. Compila KPI specifici per Luce, Gas, Acqua
    const updateKpi = (utility, kpiId, subId, unit) => {
        const list = bills[utility].filter(x => x.fattura > 0);
        if (list.length > 0) {
            const last = list[list.length - 1];
            document.getElementById(kpiId).textContent = `€ ${last.fattura.toFixed(2)}`;
            const cons = last.lettura_totale !== undefined ? last.lettura_totale : (last.lettura || 0);
            
            // Calcolo del consumo parziale se presente un record precedente
            let consumed = 0;
            const idx = bills[utility].indexOf(last);
            if (idx > 0) {
                const prev = bills[utility][idx - 1];
                const prevVal = prev.lettura_totale !== undefined ? prev.lettura_totale : (prev.lettura || 0);
                consumed = cons - prevVal;
            }
            document.getElementById(subId).textContent = consumed > 0 ? `${consumed} ${unit} (Fatturato)` : `${cons} ${unit} (Totale)`;
        } else {
            document.getElementById(kpiId).textContent = "€ 0.00";
            document.getElementById(subId).textContent = `0 ${unit}`;
        }
    };
    
    updateKpi("LUCE", "kpi-spesa-luce", "kpi-consumo-luce", "kWh");
    updateKpi("GAS", "kpi-spesa-gas", "kpi-consumo-gas", "SMC");
    updateKpi("ACQUA", "kpi-spesa-acqua", "kpi-consumo-acqua", "m³");

    // 3. Tabella Ultime Rilevazioni
    const activities = [];
    Object.keys(bills).forEach(ut => {
        bills[ut].forEach((b, idx) => {
            const readingVal = b.lettura_totale !== undefined ? b.lettura_totale : (b.lettura || 0);
            let partial = 0;
            if (idx > 0) {
                const prevReading = bills[ut][idx - 1].lettura_totale !== undefined ? bills[ut][idx - 1].lettura_totale : (bills[ut][idx - 1].lettura || 0);
                partial = readingVal - prevReading;
            }
            
            activities.push({
                data: b.data,
                utenza: ut,
                tipo: "Bolletta PDF",
                valore: b.fattura ? `€ ${b.fattura.toFixed(2)}` : "Lettura stimata",
                consumo: partial > 0 ? `${partial} ${ut === 'LUCE' ? 'kWh' : ut === 'GAS' ? 'SMC' : 'm³'}` : "-",
                lettura: readingVal
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
                <td><span class="badge badge-secondary">${act.utenza}</span></td>
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
    
    // Aggrega spese per mese/anno
    const speseMensili = {};
    const consumiLuce = {};
    const consumiGas = {};
    const consumiAcqua = {};
    
    // Inizializza gli ultimi 12 mesi
    const labels = [];
    const dateToday = new Date();
    for (let i = 11; i >= 0; i--) {
        const d = new Date(dateToday.getFullYear(), dateToday.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        speseMensili[key] = { LUCE: 0, GAS: 0, ACQUA: 0 };
        labels.push(key);
    }

    Object.keys(bills).forEach(ut => {
        bills[ut].forEach(b => {
            if (!b.fattura) return;
            const monthKey = b.data.substring(0, 7); // YYYY-MM
            if (speseMensili[monthKey]) {
                speseMensili[monthKey][ut] += b.fattura;
            }
        });
    });

    // Label formattate (es: Gen 24)
    const formattedLabels = labels.map(lbl => {
        const [year, month] = lbl.split("-");
        return `${MESI_IT_BREVE[parseInt(month) - 1]} ${year.substring(2)}`;
    });

    const datasetLuce = labels.map(lbl => speseMensili[lbl].LUCE);
    const datasetGas = labels.map(lbl => speseMensili[lbl].GAS);
    const datasetAcqua = labels.map(lbl => speseMensili[lbl].ACQUA);

    // --- GRAFICO SPESE ---
    const ctxSpese = document.getElementById("chart-spese").getContext("2d");
    if (state.charts.spese) state.charts.spese.destroy();
    
    state.charts.spese = new Chart(ctxSpese, {
        type: "bar",
        data: {
            labels: formattedLabels,
            datasets: [
                { label: "Luce", data: datasetLuce, backgroundColor: "#eab308", borderRadius: 4 },
                { label: "Gas", data: datasetGas, backgroundColor: "#3b82f6", borderRadius: 4 },
                { label: "Acqua", data: datasetAcqua, backgroundColor: "#0d9488", borderRadius: 4 }
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

    // --- GRAFICO CONSUMI (LINE CHART ANNUALE) ---
    // Calcoliamo consumi per anno solare per utenza
    const years = [currentYear() - 2, currentYear() - 1, currentYear()];
    const consLuceAnnuo = [0, 0, 0];
    const consGasAnnuo = [0, 0, 0];
    const consAcquaAnnuo = [0, 0, 0];

    const calcolaConsumoAnnuo = (utility, arrayDest) => {
        const list = bills[utility];
        list.forEach((b, idx) => {
            const bYear = new Date(b.data).getFullYear();
            const yearIdx = years.indexOf(bYear);
            if (yearIdx !== -1 && idx > 0) {
                const val = b.lettura_totale !== undefined ? b.lettura_totale : (b.lettura || 0);
                const prev = list[idx - 1].lettura_totale !== undefined ? list[idx - 1].lettura_totale : (list[idx - 1].lettura || 0);
                const diff = val - prev;
                if (diff > 0) {
                    arrayDest[yearIdx] += diff;
                }
            }
        });
    };

    calcolaConsumoAnnuo("LUCE", consLuceAnnuo);
    calcolaConsumoAnnuo("GAS", consGasAnnuo);
    calcolaConsumoAnnuo("ACQUA", consAcquaAnnuo);

    const ctxConsumi = document.getElementById("chart-consumi").getContext("2d");
    if (state.charts.consumi) state.charts.consumi.destroy();

    state.charts.consumi = new Chart(ctxConsumi, {
        type: "bar",
        data: {
            labels: years.map(String),
            datasets: [
                { label: "Luce (kWh)", data: consLuceAnnuo, backgroundColor: "rgba(234, 179, 8, 0.7)", borderColor: "#eab308", borderWidth: 1 },
                { label: "Gas (SMC)", data: consGasAnnuo, backgroundColor: "rgba(59, 130, 246, 0.7)", borderColor: "#3b82f6", borderWidth: 1 },
                { label: "Acqua (m³)", data: consAcquaAnnuo, backgroundColor: "rgba(13, 148, 136, 0.7)", borderColor: "#0d9488", borderWidth: 1 }
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

    // Ordina per data decrescente
    listToShow.sort((a, b) => b.data.localeCompare(a.data));

    if (listToShow.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-secondary); padding:20px;">Nessuna bolletta salvata.</td></tr>`;
        return;
    }

    listToShow.forEach(bill => {
        const tr = document.createElement("tr");
        const amountDisplay = bill.fattura ? `€ ${bill.fattura.toFixed(2)}` : "-";
        
        // Calcola il consumo periodo da bolletta
        const utilityBills = state.data.bills[bill.utility];
        const currentVal = bill.lettura_totale !== undefined ? bill.lettura_totale : (bill.lettura || 0);
        let consPeriodo = "-";
        
        // Trova l'indice nel database originale ordinato
        const origList = [...utilityBills].sort((a,b) => a.data.localeCompare(b.data));
        const matchingRecord = origList.find(x => x.data === bill.data);
        const oIndex = origList.indexOf(matchingRecord);
        if (oIndex > 0) {
            const prev = origList[oIndex - 1];
            const prevVal = prev.lettura_totale !== undefined ? prev.lettura_totale : (prev.lettura || 0);
            const diff = currentVal - prevVal;
            if (diff >= 0) {
                consPeriodo = `${diff} ${bill.utility === 'LUCE' ? 'kWh' : bill.utility === 'GAS' ? 'SMC' : 'm³'}`;
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

        tr.innerHTML = `
            <td>${formatDate(bill.data)}</td>
            <td><span class="badge badge-secondary">${bill.utility}</span></td>
            <td class="font-medium">${amountDisplay}</td>
            <td>${currentVal}</td>
            <td>${consPeriodo}</td>
            <td>${tipoDisplay}</td>
            <td>${pdfDisplay}</td>
            <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${bill.note || ''}">${bill.note || "-"}</td>
            <td>
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
        <div class="details-row"><span class="details-label">Utenza</span><span class="details-val badge badge-secondary">${bill.utility}</span></div>
        <div class="details-row"><span class="details-label">Data Bolletta</span><span class="details-val">${formatDate(bill.data)}</span></div>
        <div class="details-row"><span class="details-label">Periodo Fatturazione</span><span class="details-val">${periodoText}</span></div>
        <div class="details-row"><span class="details-label">Consumo Fatturato</span><span class="details-val">${consumoFattText}</span></div>
        <div class="details-row"><span class="details-label">Importo Fatturato</span><span class="details-val text-primary" style="font-size:1.15rem; font-weight:700;">€ ${(bill.fattura || 0).toFixed(2)}</span></div>
        <div class="details-row"><span class="details-label">Lettura Totale</span><span class="details-val">${reading}</span></div>
        ${specificContent}
        <div class="details-row"><span class="details-label">Tipo Rilevazione</span><span class="details-val text-capitalize">${bill.tipo_lettura || 'Non specificata'}</span></div>
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

    // Ordina per data decrescente
    listToShow.sort((a, b) => b.data.localeCompare(a.data));

    if (listToShow.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-secondary); padding:20px;">Nessuna lettura contatore registrata.</td></tr>`;
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
            <td><span class="badge badge-secondary">${read.utility}</span></td>
            <td class="font-medium">${val} ${read.utility === 'LUCE' ? 'kWh' : read.utility === 'GAS' ? 'SMC' : 'm³'}</td>
            <td>${details}</td>
            <td>
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
}

// --- TABELLA AUDIT & VERIFICA ANOMALIE ---
function renderAuditTab() {
    if (state.activeTab !== "tab-verifica") return;

    const utility = document.getElementById("audit-utility-select").value;
    const bills = [...state.data.bills[utility]].sort((a,b) => a.data.localeCompare(b.data));
    const readings = [...state.data.readings[utility]].sort((a,b) => a.data.localeCompare(b.data));
    
    const tbody = document.getElementById("table-audit-body");
    tbody.innerHTML = "";

    let countOk = 0;
    let countWarn = 0;
    let countErr = 0;

    if (bills.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-secondary); padding:20px;">Nessuna bolletta registrata per questa utenza. Carica un PDF bolletta per confrontarla.</td></tr>`;
        updateAuditCounters(0, 0, 0);
        return;
    }

    const reportEntries = [];

    // Per ciascuna bolletta, cerca una lettura manuale vicina alla data di fine/emissione
    bills.forEach(bill => {
        const billVal = bill.lettura_totale !== undefined ? bill.lettura_totale : (bill.lettura || 0);
        const billDate = new Date(bill.data);
        
        // Trova la lettura manuale più vicina (max ±7 giorni)
        let closestRead = null;
        let minDiffDays = 999;
        
        readings.forEach(read => {
            const readDate = new Date(read.data);
            const diffTime = Math.abs(readDate - billDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays <= 7 && diffDays < minDiffDays) {
                minDiffDays = diffDays;
                closestRead = read;
            }
        });

        let comparisonText = "-";
        let diffVal = null;
        let statusBadge = `<span class="badge badge-secondary">Manca Lettura Reale</span>`;
        let actionText = "Esegui lettura contatore vicino alla data della bolletta";
        let statusClass = "secondary";

        if (closestRead) {
            const readVal = closestRead.lettura_totale !== undefined ? closestRead.lettura_totale : (closestRead.lettura || 0);
            comparisonText = `${readVal} (${formatDate(closestRead.data)})`;
            diffVal = billVal - readVal;
            
            // Logica di valutazione discrepanza
            if (bill.tipo_lettura === "stimata") {
                if (diffVal > 10) {
                    statusBadge = `<span class="badge badge-warning">Stima Eccessiva</span>`;
                    actionText = `Contesta bolletta: addebitati +${diffVal} unità stimati oltre il valore reale. Invia autolettura!`;
                    countWarn++;
                    statusClass = "warning";
                } else if (diffVal < -10) {
                    statusBadge = `<span class="badge badge-danger">Conguaglio Pendente</span>`;
                    actionText = `Attenzione: stima sottodimensionata di ${Math.abs(diffVal)} unità. Il conguaglio futuro sarà elevato.`;
                    countErr++;
                    statusClass = "danger";
                } else {
                    statusBadge = `<span class="badge badge-success">Stima Corretta</span>`;
                    actionText = "La stima è in linea con le tue letture. Nessuna azione necessaria.";
                    countOk++;
                    statusClass = "success";
                }
            } else {
                // Rilevata o mista
                if (Math.abs(diffVal) <= 15) {
                    statusBadge = `<span class="badge badge-success">Corrisponde</span>`;
                    actionText = "I valori corrispondono. La fatturazione è corretta.";
                    countOk++;
                    statusClass = "success";
                } else if (diffVal > 15) {
                    statusBadge = `<span class="badge badge-danger">Discrepanza Positiva</span>`;
                    actionText = `Anomalia: la bolletta riporta +${diffVal} unità in più rispetto alla tua lettura fisica del contatore. Richiedi verifica.`;
                    countErr++;
                    statusClass = "danger";
                } else {
                    statusBadge = `<span class="badge badge-warning">Discrepanza Negativa</span>`;
                    actionText = `Consumo reale superiore di ${Math.abs(diffVal)} unità rispetto a quanto fatturato. Possibile conguaglio futuro.`;
                    countWarn++;
                    statusClass = "warning";
                }
            }
        }

        const unit = utility === "LUCE" ? "kWh" : utility === "GAS" ? "SMC" : "m³";
        const diffDisplay = diffVal !== null ? `${diffVal > 0 ? '+' : ''}${diffVal} ${unit}` : "-";

        reportEntries.push({
            date: bill.data,
            billVal: `${billVal} ${unit}`,
            comparisonText,
            diffDisplay,
            tipo_lettura: bill.tipo_lettura || "rilevata",
            statusBadge,
            actionText,
            statusClass
        });
    });

    // Mostra in ordine decrescente di data
    reportEntries.sort((a,b) => b.date.localeCompare(a.date));

    reportEntries.forEach(entry => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${formatDate(entry.date)}</td>
            <td class="font-medium">${entry.billVal}</td>
            <td>${entry.comparisonText}</td>
            <td class="text-${entry.statusClass} font-medium">${entry.diffDisplay}</td>
            <td><span class="badge text-capitalize">${entry.tipo_lettura}</span></td>
            <td>${entry.statusBadge}</td>
            <td style="font-size:0.85rem;" class="text-secondary">${entry.actionText}</td>
        `;
        tbody.appendChild(tr);
    });

    updateAuditCounters(countOk, countWarn, countErr);

    // Disegna la timeline temporale di allineamento
    renderAuditTimelineChart(utility, bills, readings);
}

function updateAuditCounters(ok, warn, err) {
    document.getElementById("audit-badge-ok").textContent = `Allineato: ${ok}`;
    document.getElementById("audit-badge-warn").textContent = `Stime Eccessive: ${warn}`;
    document.getElementById("audit-badge-err").textContent = `Anomalie/Conguagli: ${err}`;
}

// TIMELINE GRAFICO DI CONFRONTO DIRETTO LETTURE
function renderAuditTimelineChart(utility, bills, readings) {
    const ctx = document.getElementById("chart-audit-timeline").getContext("2d");
    if (state.charts.audit) state.charts.audit.destroy();

    // Filtra e mappa i dati per anno solare corrente e precedente
    const currentYearVal = new Date().getFullYear();
    const filterYear = (item) => new Date(item.data).getFullYear() >= currentYearVal - 1;
    
    const billsFiltered = bills.filter(filterYear);
    const readingsFiltered = readings.filter(filterYear);

    // Raccogli tutte le date uniche e ordinale per l'asse X
    const allDates = Array.from(new Set([
        ...billsFiltered.map(b => b.data),
        ...readingsFiltered.map(r => r.data)
    ])).sort();

    const unit = utility === "LUCE" ? "kWh" : utility === "GAS" ? "SMC" : "m³";

    // Costruisci le serie di dati (se il dato non c'è su quella data, Chart.js supporta spanGaps: true)
    const datasetBills = allDates.map(d => {
        const b = billsFiltered.find(x => x.data === d);
        if (!b) return null;
        return b.lettura_totale !== undefined ? b.lettura_totale : (b.lettura || 0);
    });

    const datasetReadings = allDates.map(d => {
        const r = readingsFiltered.find(x => x.data === d);
        if (!r) return null;
        return r.lettura_totale !== undefined ? r.lettura_totale : (r.lettura || 0);
    });

    state.charts.audit = new Chart(ctx, {
        type: "line",
        data: {
            labels: allDates.map(formatDate),
            datasets: [
                {
                    label: `Letture in Bolletta (${unit})`,
                    data: datasetBills,
                    borderColor: "#ef4444",
                    backgroundColor: "rgba(239, 68, 68, 0.1)",
                    borderWidth: 2,
                    pointRadius: 4,
                    spanGaps: true,
                    tension: 0.15
                },
                {
                    label: `Autoletture Reali (${unit})`,
                    data: datasetReadings,
                    borderColor: "#10b981",
                    backgroundColor: "rgba(16, 185, 129, 0.1)",
                    borderWidth: 2,
                    pointRadius: 4,
                    spanGaps: true,
                    tension: 0.15
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
                y: { grid: { color: "rgba(255, 255, 255, 0.05)" }, ticks: { color: "#94a3b8" } }
            },
            plugins: {
                legend: { labels: { color: "#f8fafc" } }
            }
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

async function importBackup(e) {
    const file = e.target.files[0];
    const statusText = document.getElementById("import-status-text");
    
    if (!file) return;
    statusText.style.color = "var(--text-secondary)";
    statusText.textContent = "Analisi file...";
    
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const bundle = JSON.parse(event.target.result);
            if (bundle.app !== "ConsumiCasa" || !bundle.data) {
                throw new Error("File JSON di backup non compatibile con questa applicazione.");
            }
            
            // Ripristina nello stato
            state.data = bundle.data;
            
            // Salva nel database (remoto o locale) per tutte le utenze del bundle
            const utilities = ["LUCE", "GAS", "ACQUA"];
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

function currentYear() {
    return new Date().getFullYear();
}

function unitForUtility(utility) {
    return utility === "LUCE" ? "kWh" : utility === "GAS" ? "SMC" : "m³";
}

// --- FUNZIONI CONTROLLO SINCRONIZZAZIONE NAS ---
async function checkSyncAndLoad() {
    if (state.storageMode === "local") {
        loadData();
        return;
    }
    
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
