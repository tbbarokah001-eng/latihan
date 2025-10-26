let cart = [];
        let products = [
            { id: 1, name: "Nasi Putih", price: 5000, modalPrice: 3000, barcode: "001", stock: 50, minStock: 10 },
            { id: 2, name: "Ayam Goreng", price: 15000, modalPrice: 10000, barcode: "002", stock: 25, minStock: 5 },
            { id: 3, name: "Teh Manis", price: 3000, modalPrice: 1500, barcode: "003", stock: 100, minStock: 20 },
            { id: 4, name: "Kerupuk", price: 2000, modalPrice: 1200, barcode: "004", stock: 30, minStock: 10 },
            { id: 5, name: "Sambal", price: 1000, modalPrice: 500, barcode: "005", stock: 15, minStock: 5 }
        ];
        let salesData = [];
        let debtData = [];
        let thermalPrinter = null;
        let printerConnected = false;
// Array of held transactions. Each entry contains the saved cart items, discount settings and timestamp.
let holdData = [];
// Current day offset for analysis view (0 = today, negative = past, positive = future).
// When using the "Hari Sebelumnya" / "Hari Berikutnya" buttons in the Analysis tab,
// this value will change to shift the analysis date. Selecting another period or
// resetting to "Hari Ini" will reset this offset back to 0.
let analysisDateOffset = 0;

/**
 * Queue of delta changes (e.g., add/update/delete operations) that need to be
 * sent to Google Sheets when the device is online. Each entry is an object
 * with properties: { action: 'add'|'update'|'delete', objectType: string,
 * row?: Array, id?: any }.
 *
 * Deltas are persisted in localStorage under the key 'kasir_pending_deltas'
 * so that offline changes are not lost across page reloads or app restarts.
 * When network connectivity is restored, the application will process this
 * queue and send each delta sequentially to the Apps Script endpoint.
 */
let pendingDeltas = [];
try {
    const storedDeltas = localStorage.getItem('kasir_pending_deltas');
    if (storedDeltas) {
        pendingDeltas = JSON.parse(storedDeltas) || [];
    }
} catch (err) {
    // Ignore parsing errors or localStorage being unavailable
    pendingDeltas = [];
}

// ---------------------------------------------------------------------------
// Offline sync state
//
// The application keeps a copy of products, salesData and debtData in
// localStorage so that it can function without a network connection.  When
// modifications are made to these data structures, the changes are saved
// locally but not immediately sent to Google Sheets.  To track unsynced
// changes, we maintain a `syncPending` flag.  When set to true, it means
// there are updates that haven't been exported to Google Sheets yet.  This
// flag is persisted in localStorage so that offline edits made during a
// previous session will still be recognized when the user returns.

/**
 * IndexedDB instance used for offline storage.  When IndexedDB is
 * supported by the browser, this will hold a reference to the opened
 * database.  If IndexedDB is not available or fails to open, this
 * remains null and the application will fall back to localStorage only.
 *
 * We create object stores for products, sales data, debt data and
 * pending deltas so that the application can function offline and
 * persist large amounts of data beyond the 5 MB limit of localStorage.
 */
let dbInstance = null;

/**
 * Log of past synchronisation events.  Each entry is an object of
 * shape { time: number, count: number }, where `time` is the
 * timestamp (ms since epoch) when a sync completed and `count` is
 * the number of pending deltas that were processed.  The log is
 * persisted in localStorage under the key 'kasir_sync_history'.
 */
let syncHistory = [];
try {
    const savedHistory = localStorage.getItem('kasir_sync_history');
    if (savedHistory) {
        syncHistory = JSON.parse(savedHistory) || [];
    }
} catch (err) {
    syncHistory = [];
}

/**
 * Initialise the IndexedDB database for offline data storage.  Returns
 * a promise that resolves when the database is ready or immediately
 * resolves if IndexedDB is unavailable.  The database name is
 * 'kasiryes-db' with version 1.  Four object stores are created:
 *  - 'products' with keyPath 'id'
 *  - 'salesData' with keyPath 'id' and autoIncrement true
 *  - 'debtData' with keyPath 'id' and autoIncrement true
 *  - 'pendingDeltas' with autoIncrement true
 */
function initIndexedDB() {
    return new Promise((resolve) => {
        // Abort if IndexedDB is not supported
        if (!('indexedDB' in window)) {
            resolve();
            return;
        }
        try {
            const request = indexedDB.open('kasiryes-db', 1);
            request.onupgradeneeded = function(event) {
                const db = event.target.result;
                // Create stores if they don't exist
                if (!db.objectStoreNames.contains('products')) {
                    db.createObjectStore('products', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('salesData')) {
                    db.createObjectStore('salesData', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('debtData')) {
                    db.createObjectStore('debtData', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('pendingDeltas')) {
                    db.createObjectStore('pendingDeltas', { autoIncrement: true });
                }
            };
            request.onsuccess = function(event) {
                dbInstance = event.target.result;
                resolve();
            };
            request.onerror = function(event) {
                console.warn('IndexedDB initialization failed:', event.target.error);
                // Fail silently and resolve so app can fall back to localStorage
                resolve();
            };
        } catch (e) {
            // Catch security errors (e.g. private browsing) and resolve
            console.warn('IndexedDB not available:', e);
            resolve();
        }
    });
}

/**
 * Load data from IndexedDB into in-memory variables.  If stores are
 * empty or IndexedDB is not available, global variables retain their
 * current values (e.g. loaded from localStorage).  This function
 * reads all entries from 'products', 'salesData', 'debtData' and
 * 'pendingDeltas' stores using getAll() and assigns them to the
 * global variables.  Duplicate product records are removed via
 * removeDuplicateProducts().  After loading, updateSyncStatus() is
 * called to reflect pending deltas count.
 */
async function loadFromIndexedDB() {
    if (!dbInstance) {
        return;
    }
    try {
        const tx = dbInstance.transaction(['products', 'salesData', 'debtData', 'pendingDeltas'], 'readonly');
        const pStore = tx.objectStore('products');
        const sStore = tx.objectStore('salesData');
        const dStore = tx.objectStore('debtData');
        const deltasStore = tx.objectStore('pendingDeltas');
        const [productsReq, salesReq, debtReq, deltasReq] = [pStore.getAll(), sStore.getAll(), dStore.getAll(), deltasStore.getAll()];
        await Promise.all([
            new Promise(res => { productsReq.onsuccess = res; productsReq.onerror = res; }),
            new Promise(res => { salesReq.onsuccess = res; salesReq.onerror = res; }),
            new Promise(res => { debtReq.onsuccess = res; debtReq.onerror = res; }),
            new Promise(res => { deltasReq.onsuccess = res; deltasReq.onerror = res; })
        ]);
        const loadedProducts = productsReq.result || [];
        const loadedSales = salesReq.result || [];
        const loadedDebt = debtReq.result || [];
        const loadedDeltas = deltasReq.result || [];
        if (Array.isArray(loadedProducts) && loadedProducts.length > 0) {
            products = loadedProducts;
            // remove duplicates that may exist in DB
            if (typeof removeDuplicateProducts === 'function') {
                removeDuplicateProducts();
            }
        }
        if (Array.isArray(loadedSales) && loadedSales.length > 0) {
            salesData = loadedSales;
        }
        if (Array.isArray(loadedDebt) && loadedDebt.length > 0) {
            debtData = loadedDebt;
        }
        if (Array.isArray(loadedDeltas) && loadedDeltas.length > 0) {
            pendingDeltas = loadedDeltas;
            // Persist to localStorage for redundancy
            try {
                localStorage.setItem('kasir_pending_deltas', JSON.stringify(pendingDeltas));
            } catch (err) {
                // ignore
            }
        }
        // Update UI after loading
        updateSyncStatus();
    } catch (e) {
        console.warn('Failed to load data from IndexedDB:', e);
    }
}

/**
 * Save an array of records to an IndexedDB object store.  All existing
 * records in the store are cleared first, then each element of
 * dataArray is written.  If dbInstance is null, this function does
 * nothing.  Any errors are logged but do not throw.
 *
 * @param {string} storeName The name of the object store to write.
 * @param {Array} dataArray  The array of objects to save.
 */
function saveToIndexedDB(storeName, dataArray) {
    if (!dbInstance) return;
    try {
        const tx = dbInstance.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        // Clear existing data then add new records
        const clearReq = store.clear();
        clearReq.onsuccess = function() {
            if (Array.isArray(dataArray)) {
                dataArray.forEach(item => {
                    try {
                        store.put(item);
                    } catch (err) {
                        // ignore individual put errors
                    }
                });
            }
        };
        clearReq.onerror = function() {
            // ignore clear error
        };
    } catch (err) {
        console.warn('Failed to save to IndexedDB store', storeName, err);
    }
}

/**
 * Persist the current pendingDeltas array to both localStorage and
 * IndexedDB.  This helper should be called whenever the pendingDeltas
 * array is modified (e.g. in sendDeltaToGoogleSheets or after
 * processing deltas).  It also updates the sync status indicator.
 */
function persistPendingDeltas() {
    try {
        localStorage.setItem('kasir_pending_deltas', JSON.stringify(pendingDeltas));
    } catch (err) {
        // ignore
    }
    if (dbInstance) {
        try {
            const tx = dbInstance.transaction('pendingDeltas', 'readwrite');
            const store = tx.objectStore('pendingDeltas');
            // Clear existing entries then reinsert the current queue
            const clearReq = store.clear();
            clearReq.onsuccess = function() {
                pendingDeltas.forEach(item => {
                    try { store.put(item); } catch (err) { /* ignore */ }
                });
            };
        } catch (err) {
            console.warn('Failed to persist pending deltas to IndexedDB:', err);
        }
    }
    // Update sync UI to reflect new queue size
    updateSyncStatus();
}
//
// When the network connection becomes available (navigator.onLine) and the
// user is logged in, the application will automatically attempt to send
// pending changes using exportDataToGoogleSheets(true).  After a successful
// export, the flag is cleared.

/**
 * Indicates whether there are unsynced changes that need to be exported to
 * Google Sheets.  Initialized from localStorage if available.  If localStorage
 * cannot be accessed (e.g. in privacy mode), defaults to false.
 * @type {boolean}
 */
let syncPending = false;
try {
    const pendingStr = localStorage.getItem('kasir_sync_pending');
    // treat any truthy string ("true") as true
    syncPending = pendingStr === 'true';
} catch (err) {
    syncPending = false;
}

/**
 * Indicates whether we are currently importing data from Google Sheets.  When true,
 * calls to saveData() should not mark data as dirty or trigger an automatic
 * synchronisation.  This prevents re-exporting freshly imported data back to
 * Google Sheets (which could result in duplicates).
 */
let isImporting = false;

/**
 * Determine whether automatic sync of pending deltas is enabled.  When
 * true (default), pending changes are sent to Google Sheets automatically
 * when connectivity and login are available.  When false, pending
 * operations remain queued until the user initiates a manual export or
 * toggles auto sync back on.  The state persists in localStorage to
 * survive page reloads.
 * @type {boolean}
 */
let autoSyncEnabled = true;
try {
    const autoSyncStr = localStorage.getItem('kasir_auto_sync');
    if (autoSyncStr === 'false') {
        autoSyncEnabled = false;
    }
} catch (err) {
    autoSyncEnabled = true;
}

/**
 * Last time (milliseconds since epoch) when a successful sync of pending
 * changes occurred.  Stored in localStorage under 'kasir_last_sync_time'
 * and used to display sync status to the user.  Null if no sync has
 * occurred yet.
 * @type {number|null}
 */
let lastSyncTime = null;
try {
    const storedLast = localStorage.getItem('kasir_last_sync_time');
    if (storedLast) {
        lastSyncTime = parseInt(storedLast, 10);
    }
} catch (err) {
    lastSyncTime = null;
}

// Initialise IndexedDB and load persisted data.  This runs as soon as
// the script loads, ensuring that any previously saved products,
// sales data, debt data and pending deltas stored in IndexedDB are
// restored into memory.  If IndexedDB is unavailable, this call
// resolves immediately and data will continue to come from
// localStorage.  Errors are logged in initIndexedDB().
initIndexedDB().then(loadFromIndexedDB);

/**
 * Format a timestamp (ms since epoch) into a human-readable date/time string
 * in the Indonesian locale.  Returns a string like '21 Oktober 2025 13.45'.
 * @param {number|string|null} ts
 * @returns {string}
 */
function formatDateTime(ts) {
    if (!ts) return '';
    const date = new Date(Number(ts));
    return date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

/**
 * Update the sync status indicator, auto-sync toggle label and pending
 * changes badge in the UI.  This function reads the current values of
 * autoSyncEnabled, pendingDeltas, syncPending and lastSyncTime to build
 * the display.  Call this after changing any of those states or when
 * network connectivity changes.
 */
function updateSyncStatus() {
    const statusEl = document.getElementById('syncStatus');
    const toggleBtn = document.getElementById('autoSyncToggle');
    const pendingBtn = document.getElementById('pendingChangesButton');
    const pendingCountEl = document.getElementById('pendingCount');
    // Determine status text and classes
    if (statusEl) {
        let statusText = '';
        if (!navigator.onLine) {
            statusText = '🔌 Offline - Perubahan akan diantre';
            statusEl.className = 'text-red-600 text-xs sm:text-sm font-semibold';
        } else if (pendingDeltas.length > 0 || syncPending) {
            statusText = '⏳ Sinkronisasi tertunda';
            statusEl.className = 'text-yellow-600 text-xs sm:text-sm font-semibold';
        } else {
            const formatted = lastSyncTime ? formatDateTime(lastSyncTime) : '';
            statusText = formatted ? '✅ Tersinkron (terakhir: ' + formatted + ')' : '✅ Tersinkron';
            statusEl.className = 'text-green-600 text-xs sm:text-sm font-semibold';
        }
        statusEl.textContent = statusText;
    }
    if (toggleBtn) {
        toggleBtn.textContent = autoSyncEnabled ? 'Auto Sync: ON' : 'Auto Sync: OFF';
        // Reset classes before applying new ones
        toggleBtn.classList.remove('bg-green-500','bg-gray-300','text-white','text-gray-800');
        if (autoSyncEnabled) {
            toggleBtn.classList.add('bg-green-500','text-white');
        } else {
            toggleBtn.classList.add('bg-gray-300','text-gray-800');
        }
    }
    if (pendingBtn && pendingCountEl) {
        const count = pendingDeltas.length;
        pendingCountEl.textContent = String(count);
        if (count > 0) {
            pendingBtn.classList.remove('hidden');
        } else {
            pendingBtn.classList.add('hidden');
        }
    }

    // Update sync history buttons and their counters.  The desktop button is
    // hidden on small screens via Tailwind classes (`hidden sm:inline-flex`),
    // while the mobile button (`sm:hidden`) shows on small screens only.
    const countHistory = Array.isArray(syncHistory) ? syncHistory.length : 0;
    const historyCountEl = document.getElementById('historyCount');
    if (historyCountEl) {
        historyCountEl.textContent = String(countHistory);
    }
    const historyCountMobileEl = document.getElementById('historyCountMobile');
    if (historyCountMobileEl) {
        historyCountMobileEl.textContent = String(countHistory);
    }
}

/**
 * Toggle the automatic processing of pending deltas.  When auto sync is
 * enabled, any queued deltas will be sent automatically when connectivity
 * and login are available.  When disabled, queued deltas remain until
 * manual export or toggling back on.  After toggling, the UI status
 * indicators are updated and an immediate attempt is made to process
 * deltas if auto sync has been turned on and the device is online.
 */
function toggleAutoSync() {
    autoSyncEnabled = !autoSyncEnabled;
    try {
        localStorage.setItem('kasir_auto_sync', autoSyncEnabled ? 'true' : 'false');
    } catch (err) {
        // ignore
    }
    updateSyncStatus();
    if (autoSyncEnabled && navigator.onLine) {
        processPendingDeltas(true);
    }
}

/**
 * Display the modal listing all pending delta operations.  Each entry
 * shows its index and a brief description based on action and object type.
 */
function showPendingChangesModal() {
    const modal = document.getElementById('pendingChangesModal');
    const listEl = document.getElementById('pendingChangesList');
    if (!modal || !listEl) return;
    listEl.innerHTML = '';
    pendingDeltas.forEach((delta, idx) => {
        let desc = '';
        if (delta.action === 'add') {
            const label = Array.isArray(delta.row) ? (delta.row[1] || delta.row[0]) : '';
            desc = 'Tambah ' + delta.objectType + (label ? ' (' + label + ')' : '');
        } else if (delta.action === 'update') {
            const label = Array.isArray(delta.row) ? delta.row[0] : delta.id;
            desc = 'Perbarui ' + delta.objectType + (label ? ' (' + label + ')' : '');
        } else if (delta.action === 'delete') {
            desc = 'Hapus ' + delta.objectType + (delta.id ? ' (' + delta.id + ')' : '');
        } else {
            desc = delta.action + ' ' + delta.objectType;
        }
        const div = document.createElement('div');
        div.className = 'border-b border-gray-200 py-1';
        div.textContent = (idx + 1) + '. ' + desc;
        listEl.appendChild(div);
    });
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

/**
 * Hide the pending changes modal.  Used by the close button.
 */
function closePendingChangesModal() {
    const modal = document.getElementById('pendingChangesModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

/**
 * Display the sync history modal.  Lists all recorded sync events in
 * reverse chronological order (latest first).  Each entry shows the
 * formatted date/time and the number of pending deltas processed.  If
 * there is no history, a placeholder message is shown.  The modal is
 * hidden by default and becomes flex when opened.
 */
function showSyncHistoryModal() {
    const modal = document.getElementById('syncHistoryModal');
    const listEl = document.getElementById('syncHistoryList');
    if (!modal || !listEl) return;
    listEl.innerHTML = '';
    if (!syncHistory || syncHistory.length === 0) {
        const div = document.createElement('div');
        div.className = 'py-1 text-gray-600';
        div.textContent = 'Belum ada riwayat sinkron.';
        listEl.appendChild(div);
    } else {
        const historyCopy = syncHistory.slice().reverse();
        historyCopy.forEach((log, idx) => {
            const row = document.createElement('div');
            row.className = 'border-b border-gray-200 py-1';
            const timeStr = log.time ? formatDateTime(log.time) : '';
            const countStr = (log.count !== undefined && log.count !== null) ? `${log.count} perubahan` : '';
            row.textContent = `${idx + 1}. ${timeStr}${countStr ? ' – ' + countStr : ''}`;
            listEl.appendChild(row);
        });
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

/**
 * Hide the sync history modal.  Used by the close button in the modal.
 */
function closeSyncHistoryModal() {
    const modal = document.getElementById('syncHistoryModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

/**
 * Mark the data as dirty, indicating that there are local changes which
 * haven't yet been exported to Google Sheets.  This function sets the
 * `syncPending` flag and persists it to localStorage.  It then immediately
 * attempts to synchronise if the network is online and the user is logged
 * in.  The sync attempt is silent (no alerts) and will be retried on
 * subsequent calls or when the network comes online.
 */
function markDataAsDirty() {
    syncPending = true;
    try {
        localStorage.setItem('kasir_sync_pending', 'true');
    } catch (err) {
        // Ignore errors writing to localStorage (e.g. storage disabled)
    }
    // Previously this function would attempt an immediate synchronisation by
    // calling syncPendingData() here.  However, automatic export of data can
    // lead to race conditions (e.g. exports colliding with imports).  The
    // application now leaves syncPending flagged until the user explicitly
    // initiates a manual export.  Accordingly, we no longer call
    // syncPendingData() from within markDataAsDirty().  Pending changes will
    // be sent to Google Sheets only when the user taps the Export button on
    // the Analisa tab.
}

/**
 * Attempt to synchronise any pending changes with Google Sheets.  This
 * function checks whether `syncPending` is true, whether the network is
 * currently online, and whether the user is logged in (so that the
 * export request can be authenticated).  If all conditions are met, it
 * calls exportDataToGoogleSheets(true) to perform a silent export.  On
 * success, the pending flag is cleared and persisted.  Errors are logged
 * to the console and pending data remains queued for the next attempt.
 *
 * @param {boolean} [showLoading=false] Whether to show the loading overlay.  When
 * running automatically, we default to not showing the loading overlay to
 * avoid interrupting the user.  Manual calls can pass true to show
 * progress.
 */
async function syncPendingData(showLoader = false) {
    // Only attempt sync if there is data pending
    if (!syncPending) return;
    // Do nothing if offline (network unavailable)
    if (!navigator.onLine) return;
    // Ensure the user is logged in before attempting to export.  Without a
    // valid session the export will fail; skip until login is performed.
    try {
        const loggedIn = localStorage.getItem('loggedIn') === 'true';
        if (!loggedIn) return;
    } catch (err) {
        // Unable to read localStorage; assume not logged in
        return;
    }
    try {
        // First attempt to process any queued delta operations.  These are
        // operations that were recorded while offline (e.g. adding a product,
        // updating stock, or deleting a row).  If processing fails, the
        // pending deltas remain in the queue and incremental sync is skipped.
        await processPendingDeltas(true);
        // Only perform a full incremental sync if there are still
        // unsynchronised changes marked by syncPending and the delta queue
        // has been fully processed.  This avoids rewriting the entire
        // dataset unnecessarily when queued deltas have already been sent.
        if (pendingDeltas.length === 0) {
            // If showLoader is true, show the overlay; otherwise, run silent
            if (showLoader) {
                showLoading('Menyinkronkan data...');
            }
            // Perform an incremental sync to avoid overwriting entire sheets.  This
            // sends each product, sale and debt row individually via the Apps
            // Script update endpoint.  Use silent mode to suppress alerts.
            await syncDataIncrementally(true);
            // Clear pending flag after successful sync
            syncPending = false;
            try {
                localStorage.setItem('kasir_sync_pending', 'false');
            } catch (err) {
                // ignore
            }
            // Update UI status after successful sync
            updateSyncStatus();
        }
    } catch (err) {
        console.error('Automatic sync failed:', err);
        // Keep syncPending true so that another attempt is made later
    } finally {
        if (showLoader) {
            hideLoading();
        }
    }
}

/**
 * Process any queued delta operations by sending them sequentially to the
 * Google Apps Script endpoint.  This function will stop processing on the
 * first error encountered, leaving remaining deltas in the queue for the
 * next attempt.  After all deltas have been processed successfully, the
 * queue is cleared and persisted to localStorage.
 *
 * @param {boolean} silent If true, suppress alerts and loading overlays.
 */
async function processPendingDeltas(silent = false) {
    if (!pendingDeltas || pendingDeltas.length === 0) {
        // No queued operations; clear the syncPending flag so the UI does not remain in
        // a pending state.  Without this early reset, toggling auto sync while
        // syncPending is true but pendingDeltas is empty would leave the status
        // indicator stuck on "Sinkronisasi tertunda".  By clearing syncPending and
        // updating localStorage here we correctly show the data as synchronized when
        // there are no deltas to process.
        syncPending = false;
        try {
            localStorage.setItem('kasir_sync_pending', 'false');
        } catch (err) {
            // ignore localStorage errors
        }
        // Refresh the sync status indicator
        updateSyncStatus();
        return;
    }
    // Do nothing if offline
    if (!navigator.onLine) {
        return;
    }
    // Ensure the user is logged in (for web version) before sending deltas
    try {
        const loggedIn = localStorage.getItem('loggedIn') === 'true';
        if (!loggedIn) {
            return;
        }
    } catch (err) {
        // Assume not logged in if error
        return;
    }
    if (!silent) {
        // Show a full‑screen loading overlay when processing offline deltas in non‑silent mode
        showLoading('Menyinkronkan perubahan offline...');
    } else {
        // In silent mode, avoid the full overlay and instead display a subtle status message
        const statusEl = document.getElementById('syncStatus');
        if (statusEl) {
            statusEl.textContent = '⏳ Menyinkronkan perubahan offline...';
            statusEl.className = 'text-yellow-600 text-xs sm:text-sm font-semibold';
        }
    }
    try {
        let processedCount = 0;
        for (let i = 0; i < pendingDeltas.length; i++) {
            const delta = pendingDeltas[i];
            const payload = { action: delta.action, objectType: delta.objectType };
            if (delta.action === 'delete') {
                payload.id = delta.id;
            } else {
                payload.row = delta.row;
            }
            await fetch(GOOGLE_APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload)
            });
            processedCount++;
        }
        // Clear the queue after successful processing
        pendingDeltas = [];
        // Persist empty queue to storage
        persistPendingDeltas();
        // Reset the syncPending flag because all deltas have been sent.
        // Previously we relied on a full sync (syncDataIncrementally) to clear
        // this flag, but processing pending deltas fully synchronises the
        // operations recorded while offline (add/update/delete) so we can
        // safely mark the data as synced.  This prevents the UI from
        // showing "Sinkronisasi tertunda" when no operations remain.
        syncPending = false;
        try {
            localStorage.setItem('kasir_sync_pending', 'false');
        } catch (err) {
            /* ignore localStorage errors */
        }
        // Record the last successful sync time and persist it
        lastSyncTime = Date.now();
        try {
            localStorage.setItem('kasir_last_sync_time', String(lastSyncTime));
        } catch (err) {
            // ignore
        }
        // Log this sync event in the history with the number of processed deltas
        try {
            syncHistory.push({ time: lastSyncTime, count: processedCount });
            localStorage.setItem('kasir_sync_history', JSON.stringify(syncHistory));
        } catch (err) {
            // ignore history persistence errors
        }
    } catch (err) {
        console.error('Failed to process pending deltas:', err);
        // Leave deltas in queue for next time
    } finally {
        if (!silent) {
            hideLoading();
        }
        // Update UI status regardless of outcome
        updateSyncStatus();
    }
}

// Listen for network connectivity changes.  When the browser comes online,
// update the sync status indicator and, if auto sync is enabled,
// process any queued delta operations.  When offline, simply update the status.
window.addEventListener('online', () => {
    updateSyncStatus();
    if (autoSyncEnabled) {
        processPendingDeltas(true);
    }
});
window.addEventListener('offline', () => {
    updateSyncStatus();
});

// On page load register the service worker, listen for sync messages and set up
// periodic synchronisation.  Using the 'load' event ensures the DOM is
// ready and service worker registration does not block rendering.
window.addEventListener('load', () => {
    // Register service worker if supported.  The service worker listens for
    // background sync events and will post a message back to this page
    // requesting pending deltas to be processed.  Ignore registration
    // failures silently.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').catch(err => {
            console.warn('Service worker registration failed:', err);
        });
        navigator.serviceWorker.addEventListener('message', event => {
            if (event.data && event.data.type === 'sync') {
                // Received a sync trigger from the service worker; process
                // pending deltas quietly.
                processPendingDeltas(true);
            }
        });
    }
    // Start periodic sync every 30 minutes to ensure queued operations
    // eventually reach Google Sheets.  When autoSync is disabled or the
    // device is offline, this interval does nothing.  The silent flag
    // prevents loading overlays from interrupting the user.
    setInterval(() => {
        if (autoSyncEnabled && navigator.onLine) {
            processPendingDeltas(true);
        }
    }, 30 * 60 * 1000);
});

/**
 * Format a Date object into a human‑readable string for display in the analysis
 * date navigation.  Uses the local Indonesian locale and a short month name.
 * For example, 21 Oct 2025.
 * @param {Date} date
 * @returns {string}
 */
function formatDateForLabel(date) {
    if (!(date instanceof Date)) return '';
    // Use Indonesian locale with weekday, day numeric, month long, and year numeric.
    // This ensures the label includes the day of the week (e.g., "Selasa, 21 Oktober 2025").
    return date.toLocaleDateString('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

/**
 * Show or hide the analysis date navigation controls (previous/next day).
 * When showing the controls, ensure they are displayed flex to align items.
 * @param {boolean} show Whether to display the controls
 */
function toggleAnalysisNavigation(show) {
    const nav = document.getElementById('analysisDateNavigation');
    if (!nav) return;
    nav.classList[show ? 'remove' : 'add']('hidden');
}

/**
 * Shift the analysis date by the given number of days and update the analysis view.
 * A negative value moves to previous days, positive to future days.  The analysis
 * date offset is updated accordingly and persisted until the user resets to "Hari Ini"
 * via the standard filter buttons.
 * @param {number} direction Number of days to shift (e.g., -1 for previous day, 1 for next day)
 */
function moveAnalysisDate(direction) {
    if (typeof direction !== 'number' || direction === 0) return;
    analysisDateOffset += direction;
    // Calculate the new selected date based off the current real date plus offset
    const now = new Date();
    // Create a date at midnight to compare by date only
    const selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + analysisDateOffset);
    // Update the analysis view for this date
    updateAnalysisForDate(selectedDate);
}
// Expose moveAnalysisDate so that inline HTML can invoke it
window.moveAnalysisDate = moveAnalysisDate;

/**
 * Update the analysis metrics and product table for a specific date.
 * This bypasses the built‑in period filters and always treats the analysis as if
 * "Hari Ini" were selected, but for the chosen date.  It also updates the
 * navigation label and highlights the "Hari Ini" button accordingly.
 * @param {Date} date The date to analyse
 */
function updateAnalysisForDate(date) {
    if (!(date instanceof Date)) return;
    // Compute transactions for the given date
    const filteredTransactions = salesData.filter(t => {
        if (!t.timestamp) return false;
        const transactionDate = new Date(t.timestamp);
        return transactionDate.toDateString() === date.toDateString();
    });
    // Calculate totals similar to filterAnalysis()
    let totalRevenue = 0;
    let totalModal = 0;
    const transactionCount = filteredTransactions.length;
    filteredTransactions.forEach(transaction => {
        if (transaction.total && !isNaN(transaction.total)) {
            totalRevenue += transaction.total;
        }
        if (transaction.items && Array.isArray(transaction.items)) {
            transaction.items.forEach(item => {
                // Determine modal/cost price: prefer per‑item modalPrice (for services), else fall back to product modalPrice
                let costPrice = 0;
                if (item.modalPrice && !isNaN(item.modalPrice)) {
                    costPrice = item.modalPrice;
                } else {
                    const product = products.find(p => p.id === item.id);
                    if (product && product.modalPrice && !isNaN(product.modalPrice)) {
                        costPrice = product.modalPrice;
                    }
                }
                if (!isNaN(costPrice) && costPrice >= 0 && item.quantity && !isNaN(item.quantity)) {
                    totalModal += costPrice * item.quantity;
                }
            });
        }
    });
    const grossProfit = totalRevenue - totalModal;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue * 100) : 0;
    const roi = totalModal > 0 ? (grossProfit / totalModal * 100) : 0;
    // Update DOM elements
    document.getElementById('totalRevenue').textContent = formatCurrency(totalRevenue);
    document.getElementById('revenueCount').textContent = `${transactionCount} transaksi`;
    document.getElementById('totalModal').textContent = formatCurrency(totalModal);
    document.getElementById('grossProfit').textContent = formatCurrency(grossProfit);
    document.getElementById('profitMargin').textContent = `${profitMargin.toFixed(1)}% margin`;
    document.getElementById('roi').textContent = `${roi.toFixed(1)}%`;
    // Update sedekah amount for the selected date.  Use the same formula
    // (2.5% of gross profit) as the daily analysis.  Clamp to zero to avoid
    // negative donation values when gross profit is negative.
    {
        const sedekah = Math.max(grossProfit * 0.025, 0);
        const sedekahEl = document.getElementById('sedekahAmount');
        if (sedekahEl) {
            sedekahEl.textContent = formatCurrency(sedekah);
        }
    }
    updateProductAnalysisTable(filteredTransactions);
    // Update the date label
    const labelEl = document.getElementById('analysisDateLabel');
    if (labelEl) {
        labelEl.textContent = formatDateForLabel(date);
    }
    // Highlight the "Hari Ini" filter button and de‑highlight others
    ['filterToday', 'filterWeek', 'filterMonth', 'filterAll'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.classList.remove('bg-green-500', 'text-white');
            btn.classList.add('bg-gray-300', 'text-gray-700');
        }
    });
    const todayBtn = document.getElementById('filterToday');
    if (todayBtn) {
        todayBtn.classList.remove('bg-gray-300', 'text-gray-700');
        todayBtn.classList.add('bg-green-500', 'text-white');
    }
    // Ensure navigation controls are visible
    toggleAnalysisNavigation(true);
}
// Expose updateAnalysisForDate if needed externally
window.updateAnalysisForDate = updateAnalysisForDate;

// ---------------------------------------------------------------------------
// Receipt preview state
//
// After processing a transaction we no longer print a receipt immediately.
// Instead, we display a preview in a modal with options to print or skip.
// The pendingReceiptTransaction stores the transaction data awaiting printing,
// and pendingFinalizeCallback holds a function that will finalize the
// transaction (clear cart, update UI, etc.) once the user closes the preview.
let pendingReceiptTransaction = null;
let pendingFinalizeCallback = null;

/**
 * Show the receipt preview modal for a given transaction.
 * The modal displays the formatted receipt and offers "Cetak" or "Keluar".
 * @param {Object} transaction The transaction object to preview.
 */
function showReceiptPreview(transaction) {
    pendingReceiptTransaction = transaction;
    const previewModal = document.getElementById('receiptPreviewModal');
    const contentEl = document.getElementById('receiptPreviewContent');
    if (contentEl) {
        contentEl.innerHTML = generateReceiptContent(transaction);
    }
    if (previewModal) {
        previewModal.classList.remove('hidden');
        // Attach keyboard shortcuts: Enter to print, Escape to close
        attachModalKeyHandlers(previewModal, printReceiptFromPreview, closeReceiptPreview);
    }
}
// Expose globally for inline button handlers if needed
window.showReceiptPreview = showReceiptPreview;

/**
 * Close the receipt preview without printing.
 * After closing, if a finalize callback is pending it will be invoked.
 */
function closeReceiptPreview() {
    const previewModal = document.getElementById('receiptPreviewModal');
    if (previewModal) {
        previewModal.classList.add('hidden');
        // Remove keyboard handlers when modal is closed
        detachModalKeyHandlers(previewModal);
    }
    // Run finalize callback if defined
    if (typeof pendingFinalizeCallback === 'function') {
        const cb = pendingFinalizeCallback;
        pendingFinalizeCallback = null;
        pendingReceiptTransaction = null;
        cb(false);
    } else {
        pendingReceiptTransaction = null;
    }
}
window.closeReceiptPreview = closeReceiptPreview;

/**
 * Print the receipt from preview.  This will call printThermalReceipt() and
 * then invoke the pending finalization callback.
 */
function printReceiptFromPreview() {
    const previewModal = document.getElementById('receiptPreviewModal');
    if (pendingReceiptTransaction) {
        printThermalReceipt(pendingReceiptTransaction);
    }
    if (previewModal) {
        previewModal.classList.add('hidden');
        // Detach keyboard handlers when modal is closed after printing
        detachModalKeyHandlers(previewModal);
    }
    // Run finalize callback if defined
    if (typeof pendingFinalizeCallback === 'function') {
        const cb = pendingFinalizeCallback;
        pendingFinalizeCallback = null;
        pendingReceiptTransaction = null;
        cb(true);
    } else {
        pendingReceiptTransaction = null;
    }
}
window.printReceiptFromPreview = printReceiptFromPreview;

// Loading overlay helpers
// These functions control the display of a full‑screen loading indicator which
// appears during long‑running operations such as importing or exporting data.
function showLoading(message) {
    const overlay = document.getElementById('loadingOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    const messageEl = overlay.querySelector('.loading-message');
    if (messageEl) {
        messageEl.textContent = message || 'Memproses...';
    }
}
function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
}
// Expose these helpers globally in case they need to be called from inline attributes
window.showLoading = showLoading;
window.hideLoading = hideLoading;

//
// Audio feedback: play a short beep when a barcode is successfully scanned.
// Some mobile browsers block audio playback unless it originates from a user
// interaction.  Since the scan is triggered by a button click, the beep
// should play without issue.  The beep uses the Web Audio API to avoid
// external audio file dependencies.
function playBeep() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.value = 880; // frequency in Hz (A5 note)
        oscillator.start();
        // ramp down the volume quickly to avoid click noise
        gain.gain.setValueAtTime(1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        oscillator.stop(ctx.currentTime + 0.15);
    } catch (err) {
        console.warn('Unable to play beep:', err);
    }
}
// Expose beep so it can be used from other functions or inline handlers if needed
window.playBeep = playBeep;

/**
 * Attach keyboard handlers to a modal to trigger confirm or cancel callbacks.
 * When the modal is visible, pressing Enter will invoke the confirm callback
 * and pressing Escape will invoke the cancel callback.  You can optionally
 * provide a list of input element IDs to ignore; key events originating from
 * those inputs will not trigger confirm/cancel so that users can type freely.
 *
 * @param {string|HTMLElement} modalId The ID or element of the modal to watch.
 * @param {Function} confirmCallback The function to call on Enter key.
 * @param {Function} cancelCallback The function to call on Escape key.
 * @param {string[]} [ignoreInputIds] IDs of input/textarea elements to ignore.
 */
function attachModalKeyHandlers(modalId, confirmCallback, cancelCallback, ignoreInputIds = []) {
    const modal = typeof modalId === 'string' ? document.getElementById(modalId) : modalId;
    if (!modal) return;
    // Avoid attaching multiple handlers to the same modal
    if (modal._keyHandler) return;
    modal._keyHandler = function(event) {
        // Only react when modal is visible
        if (modal.classList.contains('hidden')) return;
        const target = event.target;
        // If the event originates from an input/textarea with an ignored ID, do nothing
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
            if (ignoreInputIds && ignoreInputIds.includes(target.id)) {
                return;
            }
        }
        if (event.key === 'Enter') {
            if (typeof confirmCallback === 'function') {
                event.preventDefault();
                confirmCallback();
            }
        } else if (event.key === 'Escape' || event.key === 'Esc') {
            if (typeof cancelCallback === 'function') {
                event.preventDefault();
                cancelCallback();
            }
        }
    };
    document.addEventListener('keydown', modal._keyHandler);
}

/**
 * Detach keyboard handlers from a modal previously attached with
 * attachModalKeyHandlers().  This should be called when the modal is
 * hidden or after the confirm/cancel action has completed to prevent
 * handlers from lingering.
 *
 * @param {string|HTMLElement} modalId The ID or element of the modal.
 */
function detachModalKeyHandlers(modalId) {
    const modal = typeof modalId === 'string' ? document.getElementById(modalId) : modalId;
    if (!modal) return;
    if (modal._keyHandler) {
        document.removeEventListener('keydown', modal._keyHandler);
        modal._keyHandler = null;
    }
}

// -----------------------------------------------------------------------------
// Confirmation overlay helpers
//
// The browser's native confirm() function blocks script execution and
// displays a modal dialog that cannot be styled consistently across
// platforms.  To provide a smoother experience, we implement a custom
// confirmation overlay.  The helper below shows an in‑page modal with
// customizable text and invokes a callback with the user's choice.
//
// Usage:
//   showConfirmLayer('Apakah Anda yakin?', function(result) {
//       if (result) {
//           // user clicked "Ya"
//       } else {
//           // user clicked "Batal"
//       }
//   });
//
function showConfirmLayer(message, callback) {
    const overlay = document.getElementById('confirmOverlay');
    const messageEl = document.getElementById('confirmMessage');
    const yesBtn = document.getElementById('confirmYesButton');
    const noBtn = document.getElementById('confirmNoButton');
    // Fallback to native confirm if elements are missing
    if (!overlay || !messageEl || !yesBtn || !noBtn) {
        const result = window.confirm(message);
        if (typeof callback === 'function') callback(result);
        return;
    }
    // Insert message and show overlay
    messageEl.textContent = message;
    overlay.classList.remove('hidden');
    // Define click handlers
    // Handler to remove key listener
    let keyHandler;
    function cleanup() {
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
        if (keyHandler) {
            document.removeEventListener('keydown', keyHandler);
            keyHandler = null;
        }
    }
    function onYes() {
        cleanup();
        overlay.classList.add('hidden');
        if (typeof callback === 'function') callback(true);
    }
    function onNo() {
        cleanup();
        overlay.classList.add('hidden');
        if (typeof callback === 'function') callback(false);
    }
    // Attach key handler: Enter = yes, Esc = no
    keyHandler = function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            onYes();
        } else if (event.key === 'Escape' || event.key === 'Esc') {
            event.preventDefault();
            onNo();
        }
    };
    document.addEventListener('keydown', keyHandler);
    // Attach click listeners
    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
}
// Expose to global scope so it can be used in inline onclick handlers if needed
window.showConfirmLayer = showConfirmLayer;

// -----------------------------------------------------------------------------
// Alert overlay helper
//
// This helper replaces the built‑in alert() function with a non‑blocking
// overlay.  The overlay displays a message and a single "OK" button.  When
// the button is clicked, the overlay disappears.  Scripts that call
// alert() normally will continue executing without waiting for the user to
// acknowledge the message, which is acceptable for informational alerts.
function showAlertLayer(message, callback) {
    const overlay = document.getElementById('alertOverlay');
    const messageEl = document.getElementById('alertMessage');
    const okBtn = document.getElementById('alertOkButton');
    if (!overlay || !messageEl || !okBtn) {
        // If elements are missing, fall back to native alert (stored below)
        if (typeof _nativeAlert === 'function') {
            _nativeAlert(message);
        }
        if (typeof callback === 'function') callback();
        return;
    }
    messageEl.textContent = message;
    overlay.classList.remove('hidden');
    function handler() {
        // Remove both the click and keydown handlers when closing
        okBtn.removeEventListener('click', handler);
        document.removeEventListener('keydown', keyHandler);
        overlay.classList.add('hidden');
        if (typeof callback === 'function') callback();
    }
    // Handle Enter key presses anywhere on the page while the alert is visible.
    function keyHandler(event) {
        // Only react when overlay is visible and the pressed key is Enter
        if (!overlay.classList.contains('hidden') && event.key === 'Enter') {
            event.preventDefault();
            handler();
        }
    }
    okBtn.addEventListener('click', handler);
    document.addEventListener('keydown', keyHandler);
}
// Expose globally so other functions or inline handlers can call it directly
window.showAlertLayer = showAlertLayer;
// Capture a reference to the browser's native alert() implementation before
// overriding it.  This allows showAlertLayer() to fall back to the native
// dialog if the overlay elements are not yet present in the DOM (e.g. during
// early script execution) without causing infinite recursion.
const _nativeAlert = window.alert.bind(window);

// Override the native alert() function to use our overlay.  This will
// intercept calls to alert() throughout the application and display the
// message in our styled overlay.  Since this implementation does not block
// script execution, any subsequent code will run immediately after the
// overlay is shown.  If blocking behavior is required, refactor the
// specific callsite to use showAlertLayer() with a callback instead.
window.alert = function(message) {
    showAlertLayer(String(message));
};

// -----------------------------------------------------------------------------
// Barcode scan result post‑processing helpers
//
// When scanning 1D codes using Quagga or html5‑qrcode, it is common to see
// occasional misreads (incorrect digits) due to motion blur, lighting, or
// partial frames.  To mitigate this, we employ a small buffer that collects
// successive scan results and only accepts a code when the same value has been
// seen multiple times in a row.  For EAN‑13 barcodes, which include a
// check‑digit, we further validate the code using the check‑digit algorithm.

// Buffer of the last few scanned codes.  When the same code appears multiple
// times, it is accepted and the buffer is cleared.  This reduces false
// positives from transient misreads.
const _scanBuffer = [];

/**
 * Compute and verify the check‑digit for an EAN‑13 code.  The last digit of an
 * EAN‑13 barcode is a checksum calculated from the preceding 12 digits.  This
 * function returns true if the checksum is valid.  If the code contains any
 * non‑digits or does not have 13 characters, it returns false.
 *
 * @param {string} code A 13‑digit numeric string representing the EAN‑13 code.
 * @returns {boolean} True if the checksum is valid, false otherwise.
 */
function validateEAN13(code) {
    if (!/^[0-9]{13}$/.test(code)) {
        return false;
    }
    // Convert string to array of integers
    const digits = code.split('').map(d => parseInt(d, 10));
    // Compute sum of digits multiplied by weights: 1 for even positions, 3 for odd positions
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        // Even index (0-based) uses weight 1; odd uses weight 3
        const weight = (i % 2 === 0) ? 1 : 3;
        sum += digits[i] * weight;
    }
    const computedCheck = (10 - (sum % 10)) % 10;
    return computedCheck === digits[12];
}

/**
 * Process a scanned code by buffering and validating it before taking action.
 *
 * This helper aims to improve accuracy by waiting for the same code to be
 * detected multiple times in succession before passing it to the core handler.
 * For EAN‑13 codes, it verifies the checksum.  Codes that do not pass
 * validation or fail to repeat are ignored.
 *
 * @param {string} rawCode The raw barcode string returned by the scanner.
 */
function processScannedCode(rawCode) {
    if (!rawCode) return;
    // Remove whitespace and newline characters
    const code = rawCode.trim();
    // Validate EAN‑13 checksum if applicable
    if (/^[0-9]{13}$/.test(code) && !validateEAN13(code)) {
        // Invalid checksum: likely a misread; ignore it
        return;
    }
    // Add code to the buffer and keep only the last 5 entries
    _scanBuffer.push(code);
    if (_scanBuffer.length > 5) {
        _scanBuffer.shift();
    }
    // Count how many times this code appears in the buffer
    const occurrences = _scanBuffer.filter(c => c === code).length;
    // If we have seen this code at least twice, accept it
    if (occurrences >= 2) {
        // Clear the buffer to avoid duplicate triggers
        _scanBuffer.length = 0;
        // Delegate to the standard handler
        handleDecodedBarcode(code);
    }
}

// URL of your deployed Google Apps Script Web App
// IMPORTANT: Replace the value below with the Web App URL obtained
// from deploying the Apps Script in Google Sheets.
// Example: "https://script.google.com/macros/s/AKfycb1234567890/exec"
// Inserted by request: Use the actual Web App URL provided by the user for Google Apps Script integration
// Placeholder to disable auto-import in offline test environment during testing
// URL for Google Apps Script integration.  This value is used for
// importing and exporting data to Google Sheets.  It was copied from
// the original version of the project to preserve the existing
// synchronization functionality.  If you deploy a new Apps Script,
// update this URL accordingly.
// Updated Apps Script URL provided by the user. This URL is used for all
// communication between the POS application and Google Sheets (importing
// and exporting data, and handling login authentication). Make sure to
// redeploy your Apps Script as a web app whenever this URL changes.
// Updated Apps Script URL provided by the user (latest deployment). This URL is used for all
// communication between the POS application and Google Sheets (importing/exporting data and login).
const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz9UwktV8yA2luS_zO3ceJg5o4-goS-l6LzLvGmsyC7Z-3tf3k7C3sK-0dxqku0270X/exec';


        // Global state for products tab view mode
        // Default to grid layout. Values can be 'grid', 'table' or 'list'
// Load initial data from a server-side database when running via Node.js.
// On static hosts like GitHub Pages, there is no `/api/database` endpoint,
// so this function returns immediately to avoid network errors.
async function loadDatabase() {
    // Detect if the application is served from a static host (e.g., GitHub Pages)
    // by checking if the current origin matches localhost or a development port.
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocal) {
        // Skip loading from /api/database when not running on a local server.
        return;
    }
    try {
        const response = await fetch('/api/database');
        if (response.ok) {
            const data = await response.json();
            products = data.products ?? products;
            salesData = data.salesData ?? salesData;
            debtData = data.debtData ?? debtData;
        }
    } catch (error) {
        console.error('Failed to load database:', error);
    }
}

let productViewMode = 'grid';

// Index of the currently highlighted product suggestion when using keyboard navigation.
// A value of -1 means no suggestion is selected.  This is reset whenever
// suggestions are shown or hidden.  Arrow key presses will update this value
// and visually highlight the corresponding suggestion element.
let currentSuggestionIndex = -1;

// Flag controlling whether the global USB barcode scanner listener is active.
// The initial value is true so that scanning works by default.  Toggled via
// a button in the header.  When false, keystrokes are not interpreted as
// barcode scans and only the barcode input field handles scanning.
let globalScannerEnabled = true;

// -----------------------------------------------------------------------------
// Table sorting state
//
// When displaying products in table view, we allow the user to sort by
// clicking column headers (name, price, stock).  This section defines
// variables to keep track of the current list being displayed and the
// direction of sorting for each sortable column.  The sort state toggles
// between 'asc' and 'desc' each time a header is clicked.

// Holds the array of products currently rendered in the table.  It is
// initialised in displayProductsTable() so that sortTableBy() can sort the
// same list without re-fetching or re-filtering.  When a search filter is
// applied, this list is replaced with the filtered results.
let currentTableList = [];

// Stores the sort direction for each sortable column.  The value toggles
// between 'asc' and 'desc' when a header is clicked.  Default values set
// initial order (name ascending, price descending, stock descending).
const tableSortState = {
    name: 'asc',
    price: 'desc',
    stock: 'desc'
};

/**
 * Sort the current table list by the specified column.  Toggling the sort
 * direction each time a header is clicked.  After sorting, the table is
 * re-rendered via displayProductsTable().  Columns supported: 'name',
 * 'price', 'stock'.
 *
 * @param {string} column The column key to sort by.
 */
function sortTableBy(column) {
    if (!currentTableList || !Array.isArray(currentTableList)) {
        return;
    }
    // Toggle sort direction for the column
    if (tableSortState[column] === 'asc') {
        tableSortState[column] = 'desc';
    } else {
        tableSortState[column] = 'asc';
    }
    const direction = tableSortState[column];
    currentTableList.sort((a, b) => {
        let valA;
        let valB;
        if (column === 'name') {
            valA = (a.name || '').toString().toLowerCase();
            valB = (b.name || '').toString().toLowerCase();
            if (valA < valB) return direction === 'asc' ? -1 : 1;
            if (valA > valB) return direction === 'asc' ? 1 : -1;
            return 0;
        }
        if (column === 'price') {
            valA = a.price || 0;
            valB = b.price || 0;
        } else if (column === 'stock') {
            // Service products with unlimited stock are treated as 0 for sorting
            valA = (a.isService || a.price === 0) ? 0 : (a.stock || 0);
            valB = (b.isService || b.price === 0) ? 0 : (b.stock || 0);
        } else {
            return 0;
        }
        return direction === 'asc' ? valA - valB : valB - valA;
    });
    // Re-render the table with the sorted list
    displayProductsTable(currentTableList);
}

// -----------------------------------------------------------------------------
// Global USB barcode scanner handling
//
// Many USB barcode scanners emulate a keyboard by sending a rapid sequence
// of keystrokes that represent the barcode digits followed by an Enter key.
// This helper listens for keydown events at the document level, accumulates
// characters into a buffer, and when the Enter key is received within a
// short time window it treats the buffer as a scanned barcode.  This allows
// barcode scanning to work regardless of which input field currently has
// focus or which tab is active.  If the scanned code matches an existing
// product, it is immediately added to the cart.  Otherwise, a new product
// modal is shown with the barcode prefilled so the operator can quickly
// create a new item.

// Time (in milliseconds) allowed between the first and last keystroke of a
// barcode scan.  If the total duration exceeds this threshold the input
// sequence is considered manual typing rather than a barcode scan.
// Adjusted threshold: allow up to 1000ms between first and last keystroke
// to accommodate slower synthetic input sequences during testing or when the
// scanner introduces slight delays.  In production a lower value (e.g. 500ms)
// may be preferable.
const BARCODE_SCAN_DURATION_THRESHOLD = 1000;

/**
 * Initialize the global barcode scanner listener.  This attaches a keydown
 * handler to the document that collects keystrokes into a buffer and
 * dispatches the scanned barcode when the Enter key is pressed within the
 * configured time threshold.  Non‑alphanumeric keys reset the buffer.
 */
function initGlobalBarcodeScanner() {
    let scanBuffer = '';
    let scanStartTime = null;
    document.addEventListener('keydown', function(event) {
        // If the global scanner is disabled, do nothing.  This allows the
        // operator to type freely without triggering scan actions when the
        // standby mode is turned off via the toggle button.
        if (!globalScannerEnabled) {
            return;
        }
        // Do not treat keystrokes inside the primary barcode search input as a
        // hardware scan.  The barcode input has its own handler (handleBarcodeInput)
        // that performs lookup and cart actions appropriately.  Without this
        // check, typing a product name in the search field followed by Enter
        // would inadvertently trigger the global scanner logic and open the
        // "Tambah Produk" modal when the name does not match an exact barcode.
        const target = event.target;
        // Avoid treating keystrokes within any input or editable element as a scanner input.
        // This prevents manual quantity edits or text fields from triggering the global
        // barcode scan logic.  The barcode input has its own handlers via handleBarcodeInput().
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        // Ignore modifier keys and system shortcuts
        if (event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        const key = event.key;
        const now = Date.now();
        // Reset the buffer if a long pause has occurred
        if (scanStartTime && now - scanStartTime > BARCODE_SCAN_DURATION_THRESHOLD) {
            scanBuffer = '';
            scanStartTime = null;
        }
        // When Enter is pressed, evaluate the buffer
        if (key === 'Enter') {
            if (scanBuffer.length > 0) {
                // If the sequence was entered quickly, treat it as a scan
                const duration = scanStartTime ? (now - scanStartTime) : 0;
                if (duration > 0 && duration <= BARCODE_SCAN_DURATION_THRESHOLD) {
                    const scannedCode = scanBuffer;
                    scanBuffer = '';
                    scanStartTime = null;
                    // Handle the scanned code globally
                    handleGlobalScannedBarcode(scannedCode);
                    // Prevent default behaviour to avoid triggering form submissions
                    event.preventDefault();
                    return;
                }
            }
            // Always reset the buffer when Enter is pressed
            scanBuffer = '';
            scanStartTime = null;
            return;
        }
        // Only accept single alphanumeric characters as part of the barcode
        if (key && key.length === 1 && /^[A-Za-z0-9]$/.test(key)) {
            if (!scanStartTime) {
                scanStartTime = now;
            }
            scanBuffer += key;
            return;
        }
        // Any other key resets the buffer
        scanBuffer = '';
        scanStartTime = null;
    });
}

// Keyboard shortcuts: Ctrl + Alt + Shift + '+' to increase quantity of the most recently added item,
// and Ctrl + Alt + Shift + '-' to decrease it. This avoids conflicting with browser zoom shortcuts.
document.addEventListener('keydown', function (e) {
    // Respond only when Ctrl, Alt and Shift are pressed, and Meta is not (Meta is the Command key on Mac).
    if (e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey) {
        // Normalize key detection for plus (+) and minus (-) across keyboard layouts
        const key = e.key;
        if (key === '+' || key === '=' || key === 'Add') {
            // Increase quantity if cart has items
            if (cart && cart.length > 0) {
                const item = cart[0];
                updateQuantity(item.id, 1);
                e.preventDefault();
            }
        } else if (key === '-' || key === '_' || key === 'Subtract') {
            // Decrease quantity if cart has items
            if (cart && cart.length > 0) {
                const item = cart[0];
                updateQuantity(item.id, -1);
                e.preventDefault();
            }
        }
        // Shortcut handled; do not propagate further
        return;
    }
    // If the pressed keys do not match the shortcut, allow default behaviour.
});

/**
 * Process a globally scanned barcode.  If the barcode matches an existing
 * product, add it directly to the cart and play a beep.  If no match is
 * found, open the new product modal and prefill the barcode field so the
 * operator can quickly add the product to the catalog.
 *
 * @param {string} code The scanned barcode string.
 */
function handleGlobalScannedBarcode(code) {
    const trimmed = (code || '').trim();
    if (!trimmed) return;
    // Attempt to find the product by barcode
    const matchedProduct = products.find(p => p.barcode && p.barcode.toString() === trimmed);
    if (matchedProduct) {
        // Only add if stock is available
        if (matchedProduct.stock > 0) {
            addToCart({ id: matchedProduct.id, name: matchedProduct.name, price: matchedProduct.price, stock: matchedProduct.stock });
            playBeep();
        } else {
            alert(`Produk "${matchedProduct.name}" stok habis!`);
        }
    } else {
        // If no product matches, open the add product modal with barcode prefilled
        showAddProductModal();
        const barcodeInput = document.getElementById('newProductBarcode');
        if (barcodeInput) {
            barcodeInput.value = trimmed;
        }
        // Inform the operator that a new product needs to be added
        alert('Produk belum terdaftar. Silakan isi detail produk baru.');
    }
}

        // Initialize
document.addEventListener('DOMContentLoaded', async function() {
    await loadDatabase();
    loadData();
    // Load any held transactions saved in localStorage and update the hold count.  This ensures previously saved holds persist across sessions.
    loadHoldData();
    updateHoldCount();
    // generateSampleTransactions();
    updateTime();
    setInterval(updateTime, 1000);
    displaySavedProducts();
    displayScannerProductTable();
    // Ensure the view toggle buttons reflect the default view mode on load
    updateViewButtons();

    // Attach dynamic search events for barcode and product search inputs
    attachSearchListeners();

    // Secara otomatis mengimpor data dari Google Sheets pada saat halaman pertama kali dimuat.
    // Fungsi importDataFromGoogleSheets() akan menangani sendiri pengecekan URL dan menampilkan
    // peringatan jika konstanta GOOGLE_APPS_SCRIPT_URL belum diatur.
    try {
        await importDataFromGoogleSheets();
    } catch (err) {
        // Jika impor gagal, kesalahan dicetak ke konsol tetapi aplikasi tetap berjalan.
        console.error('Import otomatis gagal:', err);
    }

    // Inisialisasi opsi pemindai untuk perangkat mobile. Ini akan menampilkan
    // tombol untuk memulai dan menghentikan pemindaian kamera jika perangkat
    // yang digunakan terdeteksi sebagai ponsel atau tablet. Pada perangkat
    // desktop, opsi ini tetap disembunyikan.
    initializeMobileScanner();

    // Mulai pemindai barcode global untuk pemindai USB.  Ini memastikan aplikasi
    // selalu siap menerima input dari pemindai, baik ketika field scan aktif
    // maupun tidak, dan bahkan saat berada di tab selain tab pemindai.  Pastikan
    // fungsi initGlobalBarcodeScanner() telah terdefinisi sebelum panggilan ini.
    initGlobalBarcodeScanner();

    // Perbarui tampilan tombol toggle scan berdasarkan status awal.  Ini memastikan
    // pengguna melihat status ON/OFF yang benar setelah memuat halaman.
    updateScanToggleButton();

    /**
     * Global event delegation for search inputs.
     *
     * After the import process the DOM elements may be re-rendered, causing
     * previously attached listeners to be lost.  Rather than attaching
     * listeners directly to each input every time the DOM is updated, we
     * delegate the handling of input and keydown events to the document
     * level.  When an event bubbles up from an element with a specific
     * ID we run the appropriate handler.  This ensures that search and
     * suggestion functionality continue to work even after dynamic
     * updates to the DOM (e.g. import or view mode changes).
     */
    document.addEventListener('input', function (event) {
        const target = event.target;
        if (!target) return;
        // Barcode input: show product suggestions while typing
        if (target.id === 'barcodeInput') {
            const term = target.value.trim();
            // Only show suggestions when user is not pressing Enter; Enter is handled in keydown
            showProductSuggestions(term);
        }
        // Product search input: filter saved products in Produk tab
        if (target.id === 'productSearchInput') {
            const term = target.value.trim();
            searchProducts(term);
        }
    });

    document.addEventListener('keydown', function (event) {
        const target = event.target;
        if (!target) return;
        // If the keypress originated from the barcode input, only delegate
        // Enter key events.  Arrow keys and other keys are handled by the
        // element‑specific listener attached in attachSearchListeners().  Without
        // this guard, handleBarcodeInput would be called twice (both via this
        // delegation and the element listener), causing suggestion navigation
        // indexes to increment unexpectedly.
        if (target.id === 'barcodeInput' && event.key === 'Enter') {
            handleBarcodeInput(event);
        }
    });

    document.addEventListener('click', function(event) {
        const suggestionsContainer = document.getElementById('productSuggestions');
        const barcodeInput = document.getElementById('barcodeInput');
        
        if (!suggestionsContainer.contains(event.target) && event.target !== barcodeInput) {
            hideProductSuggestions();
        }
    });
});

/**
 * Attach search listeners to relevant inputs (barcode and product search).
 * This helper ensures that listeners are bound both on initial page load and after
 * dynamic updates such as data imports. Without reattaching, the inputs may
 * lose their event handlers when the DOM is rebuilt, causing search and
 * suggestion features to stop working.  Calling this multiple times is safe;
 * duplicate listeners will simply result in multiple event invocations.
 */
function attachSearchListeners() {
    // Barcode input: handle arrow navigation, Enter and suggestion filtering.
    // To avoid attaching duplicate listeners when the DOM is refreshed (e.g.
    // after importing data or re-rendering views), check a custom property on
    // the element before registering new handlers. Once a listener has been
    // attached, set the `_hasBarcodeListeners` flag to true so subsequent
    // calls to attachSearchListeners() will skip adding additional listeners.
    // This prevents the handleBarcodeInput function from being invoked
    // multiple times on each keydown event, which would otherwise cause
    // the highlighted suggestion index to increment unexpectedly.
    const barcodeInputEl = document.getElementById('barcodeInput');
    if (barcodeInputEl && !barcodeInputEl._hasBarcodeListeners) {
        // Attach keydown listener for arrow keys and Enter navigation
        barcodeInputEl.addEventListener('keydown', handleBarcodeInput);
        // Attach input listener to show suggestions as the user types
        barcodeInputEl.addEventListener('input', function(e) {
            const term = e.target.value.trim();
            showProductSuggestions(term);
        });
        // Mark that listeners have been attached to avoid duplicates
        barcodeInputEl._hasBarcodeListeners = true;
    }
    // Products tab search input: attach its listener only once
    const productSearchEl = document.getElementById('productSearchInput');
    if (productSearchEl && !productSearchEl._hasProductSearchListener) {
        productSearchEl.addEventListener('input', function(e) {
            searchProducts(e.target.value.trim());
        });
        productSearchEl._hasProductSearchListener = true;
    }
}

        // Tab switching
        function switchTab(tabName) {
            const tabContents = document.querySelectorAll('.tab-content');
            // Hide all content panels and remove any existing fade-in classes
            tabContents.forEach(content => {
                content.classList.add('hidden');
                content.classList.remove('fade-in');
            });

            // Reset all tab buttons to their inactive state
            const tabs = ['scannerTab', 'productsTab', 'historyTab', 'analysisTab'];
            tabs.forEach(tab => {
                const tabElement = document.getElementById(tab);
                tabElement.classList.remove('bg-green-500', 'text-white');
                tabElement.classList.add('text-gray-600', 'hover:text-green-600', 'hover:bg-green-50');
            });

            // Show the selected tab content and apply a fade-in effect
            const targetContent = document.getElementById(tabName + 'Content');
            if (targetContent) {
                targetContent.classList.remove('hidden');
                targetContent.classList.add('fade-in');
                // Remove the fade-in class after the animation completes to avoid
                // leaving it on the element, which could interfere with future
                // animations.  The duration matches the CSS animation length.
                setTimeout(() => {
                    targetContent.classList.remove('fade-in');
                }, 300);
            }

            // Highlight the active tab button
            const activeTab = document.getElementById(tabName + 'Tab');
            if (activeTab) {
                activeTab.classList.add('bg-green-500', 'text-white');
                activeTab.classList.remove('text-gray-600', 'hover:text-green-600', 'hover:bg-green-50');
            }

            // If returning to the scanner tab and there is text in the barcode input,
            // automatically re-display the product suggestions.  Without this logic,
            // suggestions disappear when switching away and back, leaving just the
            // search term in the input.  When no text is present, ensure any
            // lingering suggestion list is hidden.
            if (tabName === 'scanner') {
                const barcodeInput = document.getElementById('barcodeInput');
                if (barcodeInput && barcodeInput.value && barcodeInput.value.trim() !== '') {
                    // Delay showing suggestions until after the current click event has
                    // fully propagated.  When switching tabs, the global click
                    // listener hides the suggestion list (to close any open
                    // dropdown).  Without a delay, calling showProductSuggestions()
                    // here would be immediately undone by that handler.  Using
                    // setTimeout with a small delay ensures suggestions are
                    // displayed after the click handler completes.
                    setTimeout(() => {
                        showProductSuggestions(barcodeInput.value.trim());
                    }, 0);
                } else {
                    // No search term present; ensure any lingering suggestions are hidden
                    hideProductSuggestions();
                }
            }

            // Perform tab-specific actions
            if (tabName === 'analysis') {
                updateAnalysis();
            } else if (tabName === 'history') {
                // When switching to the history tab we need to respect any
                // previously selected filter or search term.  Previously the code
                // always called displayTransactionHistory(), which shows all
                // transactions regardless of the currently selected filter.  This
                // caused the filter dropdown to remain on "Hari Ini" (today) but the
                // list reverted to showing all transactions once the user switched
                // away from and back to the history tab.  To fix this we reapply
                // the appropriate filtering/searching logic on tab activation.
                const searchInput = document.getElementById('historySearchInput');
                if (searchInput && searchInput.value && searchInput.value.trim() !== '') {
                    // If a search term is present, perform search on current data
                    searchTransactionHistory(searchInput.value.trim());
                } else {
                    // Otherwise apply the selected filter (or "all" by default)
                    filterTransactionHistory();
                }
            }
        }

        // Load/Save data
        function loadData() {
            const savedProducts = localStorage.getItem('kasir_products');
    if (savedProducts) {
        products = JSON.parse(savedProducts);
        // Remove duplicate products loaded from local storage.  Duplicates can
        // accumulate over time if the same record is imported multiple times
        // from Google Sheets or added manually.  A duplicate is defined as
        // having the same name, price, modal price, barcode, wholesale rules
        // and service flag as another product.  Only the first occurrence is kept.
        removeDuplicateProducts();
    }
            
            const savedSales = localStorage.getItem('kasir_sales');
            if (savedSales) salesData = JSON.parse(savedSales);
            
            const savedDebt = localStorage.getItem('kasir_debt');
            if (savedDebt) debtData = JSON.parse(savedDebt);
        }

        // Save data to localStorage and optionally mark it as dirty for sync.
        // When skipMarkDirty is true, the syncPending flag will not be set
        // and no automatic incremental export will be triggered.  This is used
        // for operations where the data is immediately synced via the delta
        // mechanism (e.g. sending a new sale or debt payment) to avoid
        // duplicates.
        function saveData(skipMarkDirty = false) {
            /*
             * Deduplicate sales records before persisting.  Under certain race conditions
             * (for example when a payment handler fires more than once or the same
             * transaction is merged from multiple data sources) identical sales with
             * the same ID can accumulate in the salesData array.  When this happens
             * the transaction history displays duplicate rows even though the sale
             * exists only once in Google Sheets.  To guard against this we filter
             * salesData by the unique transaction ID, keeping only the first
             * occurrence of each ID.  This de-duplication is performed each time
             * data is saved so that localStorage, IndexedDB and the UI remain clean.
             */
            if (Array.isArray(salesData) && salesData.length > 1) {
                const seenSaleIds = new Set();
                salesData = salesData.filter(sale => {
                    if (!sale || sale.id === undefined || sale.id === null) return true;
                    const key = String(sale.id);
                    if (seenSaleIds.has(key)) {
                        return false;
                    }
                    seenSaleIds.add(key);
                    return true;
                });
            }
            // Persist arrays to localStorage
            localStorage.setItem('kasir_products', JSON.stringify(products));
            localStorage.setItem('kasir_sales', JSON.stringify(salesData));
            localStorage.setItem('kasir_debt', JSON.stringify(debtData));
            // Persist updated data to IndexedDB for offline use.  We write
            // products, salesData and debtData to their respective object
            // stores.  If IndexedDB is unavailable this call does nothing.
            saveToIndexedDB('products', products);
            saveToIndexedDB('salesData', salesData);
            saveToIndexedDB('debtData', debtData);

            // Mark data as dirty only when not importing and skipMarkDirty is false.
            // During imports we don't want to immediately re-export the freshly imported data.
            // When skipMarkDirty is true, we suppress marking the data as dirty because
            // the relevant changes have already been exported via the delta mechanism.
            if (!isImporting && !skipMarkDirty) {
                // Mark data as dirty so it can be synchronised when network is available
                // This call will set the syncPending flag and attempt a silent sync
                markDataAsDirty();
            }
        }

        /**
         * Load held transactions from localStorage into the global holdData array.
         * If none exist the array remains empty.
         */
        function loadHoldData() {
            const savedHold = localStorage.getItem('kasir_hold');
            if (savedHold) {
                try {
                    holdData = JSON.parse(savedHold);
                } catch (err) {
                    console.error('Failed to parse held data:', err);
                    holdData = [];
                }
            }
        }

        /**
         * Persist the current holdData array to localStorage.
         */
        function saveHoldData() {
            localStorage.setItem('kasir_hold', JSON.stringify(holdData));
        }

        /**
         * Update the number displayed on the hold toggle button.
         * This should be called whenever holdData changes.
         */
        function updateHoldCount() {
            const holdCountEl = document.getElementById('holdCount');
            const holdToggleEl = document.getElementById('holdToggle');
            if (holdCountEl) {
                holdCountEl.textContent = holdData.length;
            }
            // Show or hide the hold toggle depending on whether any holds exist. If no holds exist, hide the button entirely.
            if (holdToggleEl) {
                if (holdData.length === 0) {
                    holdToggleEl.classList.add('hidden');
                } else {
                    // Only show the hold toggle if the floating cart is not open
                    const floatingCart = document.getElementById('floatingCart');
                    if (floatingCart && !floatingCart.classList.contains('hidden')) {
                        // If cart is open, keep hold toggle hidden
                        holdToggleEl.classList.add('hidden');
                    } else {
                        holdToggleEl.classList.remove('hidden');
                    }
                }
            }

            // Update the hold sidebar next to the cart when hold count changes
            if (typeof renderHoldSidebar === 'function') {
                renderHoldSidebar();
            }
        }

        /**
         * Save the current cart and discount settings as a held transaction.
         * Empties the cart afterwards so the cashier can serve the next customer quickly.
         */
        function holdTransaction(name) {
            if (!cart || cart.length === 0) {
                alert('Tidak ada item di keranjang untuk ditahan!');
                return;
            }
            // Capture discount settings
            const discountInputEl = document.getElementById('discountInput');
            const discountTypeEl = document.getElementById('discountType');
            const holdEntry = {
                id: Date.now(),
                name: name || '',
                items: cart.map(item => Object.assign({}, item)),
                discountInput: discountInputEl ? parseInt(discountInputEl.value) || 0 : 0,
                discountType: discountTypeEl ? discountTypeEl.value : 'percent',
                timestamp: new Date().toISOString()
            };
            holdData.push(holdEntry);
            saveHoldData();
            updateHoldCount();
            // Clear cart and reset discount
            cart = [];
            if (discountInputEl) discountInputEl.value = 0;
            if (discountTypeEl) discountTypeEl.value = 'percent';
            updateCartDisplay();
            updateTotal();
            // Close the cart if open
            const floatingCart = document.getElementById('floatingCart');
            const cartToggle = document.getElementById('cartToggle');
            if (floatingCart && cartToggle) {
                floatingCart.classList.add('hidden');
                cartToggle.classList.remove('hidden');
            }
            // After closing the cart, recompute the hold toggle visibility.  updateHoldCount()
            // will show or hide the hold toggle based on the number of held transactions and
            // the current cart state (closed).  Without this call, the hold toggle remains
            // hidden because updateHoldCount() was previously invoked while the cart was still
            // open.
            updateHoldCount();
            // Provide subtle feedback without requiring user confirmation
            // Optionally this can be replaced with a toast/notification
        }

        /**
         * Open or close the hold modal. When opening the modal the list is rendered.
         */
        function toggleHoldModal() {
            const modal = document.getElementById('holdModal');
            if (!modal) return;
            if (modal.classList.contains('hidden')) {
                renderHoldList();
                modal.classList.remove('hidden');
                modal.classList.add('flex');
                // Attach keyboard shortcuts: Enter/Esc closes hold list
                attachModalKeyHandlers(modal, () => { toggleHoldModal(); }, () => { toggleHoldModal(); });
            } else {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                // Detach keyboard shortcuts when closing
                detachModalKeyHandlers(modal);
            }
        }

        /**
         * Close the hold modal explicitly.
         */
        function closeHoldModal() {
            const modal = document.getElementById('holdModal');
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            // Detach keyboard shortcuts when closing hold modal
            detachModalKeyHandlers(modal);
        }

        /**
         * Render the list of held transactions inside the hold modal.
         */
        function renderHoldList() {
            const listEl = document.getElementById('holdList');
            if (!listEl) return;
            if (!holdData || holdData.length === 0) {
                listEl.innerHTML = '<p class="text-sm text-gray-500 text-center">Belum ada transaksi tertahan</p>';
                return;
            }
            // Build entries
            const html = holdData.map((entry, idx) => {
                const date = new Date(entry.timestamp);
                const formatted = date.toLocaleString('id-ID');
                const itemsCount = entry.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
                const label = entry.name && entry.name.trim() !== '' ? entry.name : `Hold #${idx + 1}`;
                return `
                    <div class="bg-gray-50 p-3 rounded-lg flex justify-between items-center">
                        <div class="flex-1">
                            <div class="font-semibold text-sm text-gray-800">${label}</div>
                            <div class="text-xs text-gray-600">${formatted} • ${itemsCount} item</div>
                        </div>
                        <div class="flex space-x-2">
                            <button onclick="resumeHold(${idx})" class="bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded text-xs font-semibold">Lanjut</button>
                            <button onclick="deleteHold(${idx})" class="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded text-xs font-semibold">Hapus</button>
                        </div>
                    </div>
                `;
            }).join('');
            listEl.innerHTML = html;
        }

        /**
         * Render the list of held transactions inside the sidebar next to the cart.
         * This sidebar will only be visible when there are held transactions.
         */
        function renderHoldSidebar() {
            const box = document.getElementById('holdListBox');
            const listEl = document.getElementById('holdSidebarList');
            // If the DOM elements are not present, do nothing
            if (!box || !listEl) return;
            // If there are no held transactions, hide the entire box and clear its contents
            if (!holdData || holdData.length === 0) {
                box.classList.add('hidden');
                listEl.innerHTML = '';
                return;
            }
            // Show the box when holds exist
            box.classList.remove('hidden');
            // Build a compact card for each held entry.  We display the name (or Hold #),
            // the number of items and provide buttons to resume or delete.
            const html = holdData.map((entry, idx) => {
                // Determine label: if user supplied a name, use it; otherwise generate a default label
                const label = entry.name && entry.name.trim() !== '' ? entry.name : `Hold #${idx + 1}`;
                const itemsCount = entry.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
                return `
                    <div class="bg-white border border-gray-200 rounded-lg p-3 flex justify-between items-center shadow-sm">
                        <div>
                            <div class="font-semibold text-sm text-gray-800">${label}</div>
                            <div class="text-xs text-gray-500">${itemsCount} item${itemsCount > 1 ? 's' : ''}</div>
                        </div>
                        <div class="flex space-x-1">
                            <button onclick="resumeHold(${idx})" class="bg-green-500 hover:bg-green-600 text-white px-2 py-1 rounded text-xs">Lanjut</button>
                            <button onclick="deleteHold(${idx})" class="bg-red-500 hover:bg-red-600 text-white px-2 py-1 rounded text-xs">Hapus</button>
                        </div>
                    </div>
                `;
            }).join('');
            listEl.innerHTML = html;
        }

        // Expose the sidebar rendering function globally so it can be invoked from HTML attributes if needed
        window.renderHoldSidebar = renderHoldSidebar;

        /**
         * Restore a held transaction back into the cart.
         * Removes the entry from the hold list and updates the UI accordingly.
         * @param {number} index Index of the held entry to resume.
         */
        function resumeHold(index) {
            if (index < 0 || index >= holdData.length) return;
            const entry = holdData.splice(index, 1)[0];
            saveHoldData();
            updateHoldCount();
            // Restore cart
            cart = entry.items.map(it => Object.assign({}, it));
            // Restore discount values
            const discountInputEl = document.getElementById('discountInput');
            const discountTypeEl = document.getElementById('discountType');
            if (discountInputEl) discountInputEl.value = entry.discountInput || 0;
            if (discountTypeEl) discountTypeEl.value = entry.discountType || 'percent';
            updateCartDisplay();
            updateTotal();
            renderHoldList();
            // Show cart: open the floating cart and hide the cart toggle.  Also hide the hold toggle since
            // the cart is now open.  updateHoldCount() will take care of showing the hold toggle again
            // only when there are held transactions and the cart is closed.
            const floatingCart = document.getElementById('floatingCart');
            const cartToggle = document.getElementById('cartToggle');
            const holdToggle = document.getElementById('holdToggle');
            if (floatingCart && cartToggle) {
                floatingCart.classList.remove('hidden');
                cartToggle.classList.add('hidden');
                if (holdToggle) holdToggle.classList.add('hidden');
            }
            // Automatically close hold modal
            closeHoldModal();
            // After opening the cart, update the hold toggle visibility based on current holds and cart state
            updateHoldCount();
        }

        /**
         * Remove a held transaction from the list after confirming with the user.
         * @param {number} index Index of the held entry to delete.
         */
        function deleteHold(index) {
            if (index < 0 || index >= holdData.length) return;
            const confirmMessage = 'Yakin ingin menghapus transaksi tertahan ini?';
            // Use the custom confirmation layer if available, otherwise fall back to default confirm()
            if (typeof showConfirmLayer === 'function') {
                showConfirmLayer(confirmMessage, function(confirmed) {
                    if (!confirmed) return;
                    holdData.splice(index, 1);
                    saveHoldData();
                    updateHoldCount();
                    renderHoldList();
                });
            } else if (confirm(confirmMessage)) {
                holdData.splice(index, 1);
                saveHoldData();
                updateHoldCount();
                renderHoldList();
            }
        }

        /**
         * Show the modal to input a name for the held transaction.
         */
        function showHoldNameModal() {
            const input = document.getElementById('holdNameInput');
            if (input) {
                input.value = '';
            }
            const modal = document.getElementById('holdNameModal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
                // Attach keyboard shortcuts: Enter to save, Escape to cancel
                attachModalKeyHandlers(modal, saveHoldName, closeHoldNameModal);
                // Focus the input after the modal is displayed
                setTimeout(() => {
                    if (input) input.focus();
                }, 100);
            }
        }

        /**
         * Close the hold name modal without holding.
         */
        function closeHoldNameModal() {
            const modal = document.getElementById('holdNameModal');
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            // Detach keyboard handlers when modal is closed
            detachModalKeyHandlers(modal);
        }

        /**
         * Save the transaction with the provided name and hold it.
         */
        function saveHoldName() {
            const input = document.getElementById('holdNameInput');
            const name = input ? input.value.trim() : '';
            holdTransaction(name);
            // Detach handlers before closing to avoid lingering key events
            const modal = document.getElementById('holdNameModal');
            detachModalKeyHandlers(modal);
            closeHoldNameModal();
        }

        // Expose hold-related functions globally for use in HTML onclick attributes
        window.holdTransaction = holdTransaction;
        window.toggleHoldModal = toggleHoldModal;
        window.closeHoldModal = closeHoldModal;
        window.resumeHold = resumeHold;
        window.deleteHold = deleteHold;
        // Expose hold name modal functions globally
        window.showHoldNameModal = showHoldNameModal;
        window.closeHoldNameModal = closeHoldNameModal;
        window.saveHoldName = saveHoldName;

/**
 * Remove duplicate products from the global `products` array.  Two products are
 * considered duplicates if they share the same name, price, modal price,
 * barcode, wholesale minimum quantity, wholesale price and service flag.  Only
 * the first occurrence of each unique product is kept.  This helps prevent
 * clutter in the product list caused by importing the same data multiple
 * times or other bugs that inadvertently add identical entries.  After
 * deduplication, the `products` array is updated in place.
 */
function removeDuplicateProducts() {
    // Ensure products is a valid array
    if (!Array.isArray(products) || products.length === 0) {
        return;
    }
    /*
     * Deduplicate products by their identity fields (name, price, modalPrice,
     * barcode, wholesale minimum quantity, wholesale price and service flag).
     * When duplicates are found, the **last occurrence** is kept.  This
     * behaviour is important when offline updates are merged into the
     * imported data because the updated record will be appended to the
     * products array.  If we were to keep the first occurrence, the
     * freshly updated product would be discarded in favour of the remote
     * record.  By keeping the last occurrence, we ensure that offline edits
     * override the remote copy.
     */
    const map = new Map();
    for (const product of products) {
        const key = JSON.stringify([
            product.name ?? '',
            product.price ?? 0,
            product.modalPrice ?? 0,
            product.barcode ?? '',
            product.wholesaleMinQty ?? null,
            product.wholesalePrice ?? null,
            product.isService ?? false
        ]);
        // Always overwrite with the latest product for this key
        map.set(key, product);
    }
    // Replace the products array with the deduplicated values
    products.length = 0;
    for (const value of map.values()) {
        products.push(value);
    }
}

        // Generate sample data
        function generateSampleTransactions() {
            if (salesData.length > 0) return;

            const sampleTransactions = [];
            const customerNames = ['Budi', 'Sari', 'Ahmad', 'Rina', 'Joko'];
            
            for (let dayOffset = 6; dayOffset >= 0; dayOffset--) {
                const date = new Date();
                date.setDate(date.getDate() - dayOffset);
                
                const transactionsPerDay = Math.floor(Math.random() * 7) + 2;
                
                for (let i = 0; i < transactionsPerDay; i++) {
                    const hour = Math.floor(Math.random() * 12) + 8;
                    const minute = Math.floor(Math.random() * 60);
                    date.setHours(hour, minute, 0, 0);
                    
                    const itemCount = Math.floor(Math.random() * 4) + 1;
                    const transactionItems = [];
                    
                    for (let j = 0; j < itemCount; j++) {
                        const randomProduct = products[Math.floor(Math.random() * products.length)];
                        const quantity = Math.floor(Math.random() * 3) + 1;
                        
                        const existingItem = transactionItems.find(item => item.id === randomProduct.id);
                        if (existingItem) {
                            existingItem.quantity += quantity;
                        } else {
                            transactionItems.push({
                                id: randomProduct.id,
                                name: randomProduct.name,
                                price: randomProduct.price,
                                quantity: quantity
                            });
                        }
                    }
                    
                    const subtotal = transactionItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                    const discount = Math.random() < 0.3 ? Math.floor(Math.random() * 15) : 0;
                    const total = subtotal - (subtotal * discount / 100);
                    
                    const isPartialPayment = Math.random() < 0.1;
                    
                    if (isPartialPayment) {
                        const paid = Math.floor(total * (0.3 + Math.random() * 0.4));
                        const debt = total - paid;
                        const customerName = customerNames[Math.floor(Math.random() * customerNames.length)];
                        
                        const transaction = {
                            id: Date.now() + Math.random() * 1000,
                            items: transactionItems,
                            subtotal: subtotal,
                            discount: discount,
                            total: total,
                            paid: paid,
                            debt: debt,
                            customerName: customerName,
                            timestamp: date.toISOString(),
                            type: 'partial'
                        };
                        
                        sampleTransactions.push(transaction);
                        
                        const existingDebt = debtData.find(d => d.customerName === customerName);
                        if (existingDebt) {
                            existingDebt.amount += debt;
                            existingDebt.transactions.push({
                                id: transaction.id,
                                amount: debt,
                                date: date.toLocaleDateString('id-ID')
                            });
                        } else {
                            debtData.push({
                                customerName: customerName,
                                amount: debt,
                                transactions: [{
                                    id: transaction.id,
                                    amount: debt,
                                    date: date.toLocaleDateString('id-ID')
                                }]
                            });
                        }
                    } else {
                        const paid = total + Math.floor(Math.random() * 50000);
                        
                        const transaction = {
                            id: Date.now() + Math.random() * 1000,
                            items: transactionItems,
                            subtotal: subtotal,
                            discount: discount,
                            total: total,
                            paid: paid,
                            change: paid - total,
                            timestamp: date.toISOString(),
                            type: 'full'
                        };
                        
                        sampleTransactions.push(transaction);
                    }
                }
            }
            
            salesData.push(...sampleTransactions);
            saveData();
        }

        // Update time
        function updateTime() {
            const now = new Date();
            const timeString = now.toLocaleString('id-ID', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            document.getElementById('currentTime').textContent = timeString;
        }

        // Format currency
        function formatCurrency(amount) {
            return new Intl.NumberFormat('id-ID', {
                style: 'currency',
                currency: 'IDR',
                minimumFractionDigits: 0
            }).format(amount);
        }

        // Barcode input handling
        function handleBarcodeInput(event) {
            // Always capture the current search term
            const searchTerm = event.target.value.trim();
            // Keyboard navigation: handle arrow keys to navigate suggestions
            const suggestionsContainer = document.getElementById('productSuggestions');
            const suggestions = suggestionsContainer ? suggestionsContainer.children : [];
            if (event.key === 'ArrowDown' && suggestions.length > 0) {
                // Move selection down.  When the last suggestion is reached, stay
                // there instead of wrapping back to the top.  This behaviour
                // prevents confusion when users attempt to navigate beyond the last
                // visible item: they can still use the mouse or scroll wheel to
                // reveal additional suggestions instead of unexpectedly jumping to
                // the first item.
                event.preventDefault();
                if (event.stopPropagation) event.stopPropagation();
                if (currentSuggestionIndex < suggestions.length - 1) {
                    currentSuggestionIndex++;
                } else {
                    // Stay on the last item; do not wrap
                    currentSuggestionIndex = suggestions.length - 1;
                }
                setTimeout(() => {
                    highlightSuggestionAtIndex(currentSuggestionIndex);
                }, 0);
                return;
            }
            if (event.key === 'ArrowUp' && suggestions.length > 0) {
                // Move selection up.  When the first suggestion is reached, stay
                // there instead of wrapping to the bottom.
                event.preventDefault();
                if (event.stopPropagation) event.stopPropagation();
                if (currentSuggestionIndex > 0) {
                    currentSuggestionIndex--;
                } else {
                    // Stay at the first item; do not wrap
                    currentSuggestionIndex = 0;
                }
                setTimeout(() => {
                    highlightSuggestionAtIndex(currentSuggestionIndex);
                }, 0);
                return;
            }
            // If Enter is pressed and a suggestion is highlighted, select it
            if (event.key === 'Enter' && suggestions.length > 0 && currentSuggestionIndex >= 0) {
                event.preventDefault();
                const selectedEl = suggestions[currentSuggestionIndex];
                const productIdAttr = selectedEl ? selectedEl.getAttribute('data-product-id') : null;
                const productId = productIdAttr ? parseInt(productIdAttr, 10) : null;
                if (productId) {
                    selectProductFromSuggestion(productId);
                }
                currentSuggestionIndex = -1;
                hideProductSuggestions();
                // Clear input to prepare for next scan or search
                event.target.value = '';
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                if (searchTerm) {
                    // First check for exact barcode match
                    const exactBarcodeMatch = products.find(p => p.barcode === searchTerm);
                    if (exactBarcodeMatch) {
                        if (exactBarcodeMatch.stock > 0) {
                            addToCart(exactBarcodeMatch);
                            event.target.value = '';
                            hideProductSuggestions();
                            return;
                        } else {
                            alert(`Produk "${exactBarcodeMatch.name}" stok habis!`);
                            return;
                        }
                    }
                    
                    // If no exact barcode match, check filtered products
                    const filteredProducts = products.filter(product => {
                        // Ensure name and barcode are strings to avoid TypeError when calling includes()
                        const name = (product.name || '').toString().toLowerCase();
                        const barcode = (product.barcode || '').toString();
                        return name.includes(searchTerm.toLowerCase()) || barcode.includes(searchTerm);
                    });
                    
                    // If only one product matches, add it to cart automatically
                    if (filteredProducts.length === 1) {
                        const product = filteredProducts[0];
                        if (product.stock > 0) {
                            addToCart(product);
                            event.target.value = '';
                            hideProductSuggestions();
                        } else {
                            alert(`Produk "${product.name}" stok habis!`);
                        }
                    } else if (filteredProducts.length === 0) {
                        alert('Produk tidak ditemukan!');
                    } else {
                        // Multiple matches found, keep showing suggestions
                        showProductSuggestions(searchTerm);
                    }
                }
            } else {
                // On every keystroke except Enter, show suggestions instantly
                showProductSuggestions(searchTerm);
            }
        }

        // Product suggestions
        function showProductSuggestions(searchTerm) {
            const suggestionsContainer = document.getElementById('productSuggestions');
            
            if (!searchTerm.trim()) {
                hideProductSuggestions();
                return;
            }

            let filteredProducts;
            try {
                filteredProducts = products.filter(product => {
                    const name = (product.name || '').toString().toLowerCase();
                    const barcode = (product.barcode || '').toString();
                    return name.includes(searchTerm.toLowerCase()) || barcode.includes(searchTerm);
                });
            } catch (err) {
                // Fallback: load products from localStorage if global products array is unavailable
                try {
                    const stored = localStorage.getItem('kasir_products');
                    const fallbackList = stored ? JSON.parse(stored) : [];
                    filteredProducts = fallbackList.filter(product => {
                        const name = (product.name || '').toString().toLowerCase();
                        const barcode = (product.barcode || '').toString();
                        return name.includes(searchTerm.toLowerCase()) || barcode.includes(searchTerm);
                    });
                } catch (_) {
                    filteredProducts = [];
                }
            }

            if (filteredProducts.length === 0) {
                hideProductSuggestions();
                return;
            }

            // Render all matching products instead of limiting to a fixed subset.
            // Previously we sliced to the first 5 items, which prevented keyboard
            // navigation from moving past the last visible row and forced a
            // wrap‑around to the top.  Removing the slice allows the user to
            // continue scrolling through the entire filtered list using the
            // arrow keys or mouse wheel.
            suggestionsContainer.innerHTML = filteredProducts.map(product => {
                const stockBadge = product.stock === 0 ?
                    '<span class="text-xs bg-red-500 text-white px-2 py-1 rounded ml-2">HABIS</span>' :
                    product.stock <= product.minStock ?
                    '<span class="text-xs bg-yellow-500 text-white px-2 py-1 rounded ml-2">MENIPIS</span>' : '';

                return `
                    <!--
                      Each suggestion row uses a darker blue hover state to improve contrast
                      on dark themes.  The previous light blue highlight made dark text
                      difficult to read.  By switching to a mid‑tone blue and forcing the
                      text color to white on hover (via the hover:text-white utility), the
                      suggestion remains legible when the user hovers or selects it.  When
                      highlighted via keyboard navigation the row will receive an even
                      darker blue background (bg-blue-700) applied in highlightSuggestionAtIndex().
                    -->
                    <div class="p-3 hover:bg-blue-600 hover:text-white group cursor-pointer border-b border-gray-100 last:border-b-0 ${product.stock === 0 ? 'opacity-50' : ''}"
                         data-product-id="${product.id}"
                         onclick="selectProductFromSuggestion(${product.id})">
                        <div class="flex justify-between items-center">
                            <div class="flex-1">
                                <div class="font-semibold text-gray-100 text-sm truncate group-hover:text-white">
                                    ${product.name}${stockBadge}
                                </div>
                                <div class="text-xs text-gray-400 group-hover:text-gray-200">
                                    ${product.barcode ? `Barcode: ${product.barcode}` : 'Tanpa barcode'} | Stok: ${product.stock}
                                </div>
                            </div>
                            <div class="text-right ml-2">
                                <div class="font-bold text-green-600 text-sm group-hover:text-white">${formatCurrency(product.price)}</div>
                                <div class="text-xs text-gray-500 group-hover:text-gray-200">${product.stock === 0 ? 'Stok habis' : 'Tap untuk tambah'}</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // Reset highlighted suggestion index and clear previous highlights.
            // By not limiting the suggestions list, we need to ensure
            // currentSuggestionIndex is reset so that navigation starts at
            // the beginning of the new list.
            currentSuggestionIndex = -1;
            clearSuggestionHighlights();
            suggestionsContainer.classList.remove('hidden');
        }

    /**
     * Remove highlight from all suggestion items.  When the suggestion index changes
     * (via arrow keys) or when suggestions are refreshed, this function clears
     * any previously applied highlight class.  The highlight class used here
     * matches the hover colour (bg‑yellow‑100) defined in Tailwind CSS.
     */
    function clearSuggestionHighlights() {
        const container = document.getElementById('productSuggestions');
        if (!container) return;
        const items = container.children;
        for (let i = 0; i < items.length; i++) {
            // Remove any previous highlight classes.  In earlier versions the highlight
            // used the bg-green-100 class; we remove all potential highlight classes
            // (green, yellow or blue) to ensure only one background class is applied.
            items[i].classList.remove('bg-green-100');
            items[i].classList.remove('bg-yellow-200');
            items[i].classList.remove('bg-blue-200');
            // Also remove the updated highlight colour class in case the
            // configuration has changed.  See highlightSuggestionAtIndex().
            items[i].classList.remove('bg-blue-300');
            // Remove the darker highlight class and text colour applied when navigating
            // suggestions with arrow keys.  This ensures that newly generated
            // suggestions do not retain the old highlight styling.
            items[i].classList.remove('bg-blue-700');
            items[i].classList.remove('text-white');
        }
    }

    /**
     * Highlight the suggestion item at the given index.  Adds the
     * bg‑yellow‑200 class to the selected item and removes it from others.
     * If the index is out of range, no highlight is applied.  This helper
     * depends on clearSuggestionHighlights() being defined in the same scope.
     *
     * @param {number} index The zero‑based index of the suggestion to highlight.
     */
    function highlightSuggestionAtIndex(index) {
        const container = document.getElementById('productSuggestions');
        if (!container) return;
        const items = container.children;
        clearSuggestionHighlights();
        if (index >= 0 && index < items.length) {
            // Apply a more visible highlight colour.  We use a dark blue (700) with a
            // white foreground to maintain high contrast on both dark and light themes.
            // The previous light blue (200/300) made the dark text difficult to read
            // when the row was selected.  Adding the text-white class ensures the
            // suggestion label remains legible while highlighted.
            items[index].classList.add('bg-blue-700', 'text-white');
            // Ensure the highlighted item is visible by scrolling it into view.
            // Use the 'nearest' block option so that scrolling only occurs when
            // the item is outside the visible portion of the suggestion list.
            try {
                items[index].scrollIntoView({ block: 'nearest' });
            } catch (err) {
                // Fallback: if scrollIntoView is not supported, adjust scrollTop manually
                const containerRect = container.getBoundingClientRect();
                const itemRect = items[index].getBoundingClientRect();
                if (itemRect.top < containerRect.top) {
                    container.scrollTop -= (containerRect.top - itemRect.top);
                } else if (itemRect.bottom > containerRect.bottom) {
                    container.scrollTop += (itemRect.bottom - containerRect.bottom);
                }
            }
        }
    }

        function hideProductSuggestions() {
            const container = document.getElementById('productSuggestions');
            if (container) {
                container.classList.add('hidden');
            }
            // Reset selection index and remove any highlights when hiding suggestions
            currentSuggestionIndex = -1;
            clearSuggestionHighlights();
        }

        function selectProductFromSuggestion(productId) {
            const product = products.find(p => p.id === productId);
            if (product && product.stock > 0) {
                addToCart(product);
                const barcodeInput = document.getElementById('barcodeInput');
                hideProductSuggestions();
                setTimeout(() => {
                    barcodeInput.value = '';
                    barcodeInput.focus();
                }, 300);
            }
        }

        // Cart functions
        function addToCart(product, quantity = 1) {
            // Check if it's a service product
            if (product.isService || product.price === 0) {
                showServiceProductModal(product);
                return;
            }

            if (product.stock < quantity) {
                alert(`Stok tidak mencukupi! Stok tersedia: ${product.stock}`);
                return;
            }

            const existingItem = cart.find(item => item.id === product.id);

            if (existingItem) {
                // If item already exists in the cart, update its quantity and
                // wholesale pricing then move it to the top of the cart array
                const newQuantity = existingItem.quantity + quantity;
                if (product.stock < newQuantity) {
                    alert(`Stok tidak mencukupi! Stok tersedia: ${product.stock}`);
                    return;
                }
                existingItem.quantity = newQuantity;
                // Update price based on wholesale pricing rules
                const fullProduct = products.find(p => p.id === product.id);
                if (fullProduct && fullProduct.wholesaleMinQty && fullProduct.wholesalePrice) {
                    if (existingItem.quantity >= fullProduct.wholesaleMinQty) {
                        existingItem.price = fullProduct.wholesalePrice;
                        existingItem.isWholesale = true;
                    } else {
                        existingItem.price = fullProduct.price;
                        existingItem.isWholesale = false;
                    }
                }
                // Move the updated item to the top of the cart to reflect recency
                const index = cart.indexOf(existingItem);
                if (index > 0) {
                    cart.splice(index, 1);
                    cart.unshift(existingItem);
                }
            } else {
                // New item: calculate wholesale pricing if applicable
                const fullProduct = products.find(p => p.id === product.id);
                let itemPrice = product.price;
                let isWholesale = false;
                if (fullProduct && fullProduct.wholesaleMinQty && fullProduct.wholesalePrice && quantity >= fullProduct.wholesaleMinQty) {
                    itemPrice = fullProduct.wholesalePrice;
                    isWholesale = true;
                }
                // Add new item to the beginning of the cart so it appears at the top of the list
                cart.unshift({
                    id: product.id,
                    name: product.name,
                    price: itemPrice,
                    quantity: quantity,
                    isWholesale: isWholesale,
                    // per-item discount fields (default no discount)
                    discountValue: 0,
                    // Default per‑item discount type is nominal (Rp) instead of percentage.
                    discountType: 'amount'
                });
            }
            
            showAddToCartFeedback(product.name);
            updateCartDisplay();
            updateTotal();
        }

        function showAddToCartFeedback(productName) {
            const notification = document.createElement('div');
            notification.className = 'fixed top-20 right-4 bg-green-500 text-white px-4 py-2 rounded-lg shadow-lg z-50 bounce-in';
            notification.innerHTML = `
                <div class="flex items-center space-x-2">
                    <span>✅</span>
                    <span class="text-sm font-semibold">${productName} ditambahkan!</span>
                </div>
            `;
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.style.opacity = '0';
                setTimeout(() => document.body.removeChild(notification), 300);
            }, 2000);
        }

        function toggleCart() {
            const floatingCart = document.getElementById('floatingCart');
            const cartToggle = document.getElementById('cartToggle');
            const holdToggle = document.getElementById('holdToggle');

            // When opening the floating cart hide both the cart toggle and hold toggle to prevent
            // them from obscuring any content (especially the total pay section).  When closing
            // the floating cart, show the cart toggle again and let updateHoldCount() decide
            // whether the hold toggle should be visible based on current data.
            if (floatingCart.classList.contains('hidden')) {
                // Opening the floating cart
                floatingCart.classList.remove('hidden');
                if (cartToggle) cartToggle.classList.add('hidden');
                if (holdToggle) holdToggle.classList.add('hidden');
            } else {
                // Closing the floating cart
                floatingCart.classList.add('hidden');
                if (cartToggle) cartToggle.classList.remove('hidden');
                // Recompute hold toggle visibility based on current holds and cart state
                updateHoldCount();
            }
        }

        // Service Product Modal Functions
        let currentServiceProduct = null;

        function showServiceProductModal(product) {
            currentServiceProduct = product;
            document.getElementById('serviceProductName').textContent = product.name;
            document.getElementById('serviceProductPrice').value = '';
            document.getElementById('serviceProductDescription').value = '';
            document.getElementById('serviceProductQuantity').value = '1';
            // reset modal price for services
            const modalInput = document.getElementById('serviceProductModalPrice');
            if (modalInput) {
                modalInput.value = '';
            }
            
            const modalEl = document.getElementById('serviceProductModal');
            modalEl.classList.remove('hidden');
            modalEl.classList.add('flex');
            // Attach keyboard shortcuts: Enter adds service to cart, Esc cancels
            attachModalKeyHandlers(modalEl, addServiceToCart, closeServiceProductModal, ['serviceProductPrice','serviceProductModalPrice','serviceProductDescription','serviceProductQuantity']);
            
            setTimeout(() => document.getElementById('serviceProductPrice').focus(), 100);
        }

        function closeServiceProductModal() {
            const modalEl = document.getElementById('serviceProductModal');
            modalEl.classList.add('hidden');
            modalEl.classList.remove('flex');
            // Detach keyboard handlers when closing the service product modal
            detachModalKeyHandlers(modalEl);
            currentServiceProduct = null;
        }

        function handleServicePriceEnter(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                document.getElementById('serviceProductDescription').focus();
            }
        }

        function addServiceToCart() {
            if (!currentServiceProduct) {
                alert('Error: Produk jasa tidak ditemukan!');
                return;
            }

            const price = parseInt(document.getElementById('serviceProductPrice').value) || 0;
            const modalPrice = parseInt(document.getElementById('serviceProductModalPrice').value) || 0;
            const description = document.getElementById('serviceProductDescription').value.trim();
            const quantity = parseInt(document.getElementById('serviceProductQuantity').value) || 1;

            if (price <= 0) {
                alert('Harga jasa harus diisi dan lebih dari 0!');
                return;
            }

            if (quantity <= 0) {
                alert('Jumlah harus lebih dari 0!');
                return;
            }

            // Create service item with unique ID to allow multiple service entries
            const serviceItem = {
                id: Date.now() + Math.random(), // Unique ID for each service entry
                originalId: currentServiceProduct.id, // Keep reference to original product
                name: currentServiceProduct.name,
                price: price,
                quantity: quantity,
                isService: true,
                description: description || null,
                // store modalPrice if provided for profit calculations
                modalPrice: modalPrice > 0 ? modalPrice : undefined,
                // per-item discount fields for services (default no discount).  By default, service items use nominal (Rp) discounts rather than percentage.
                discountValue: 0,
                discountType: 'amount'
            };

            cart.push(serviceItem);
            
            showAddToCartFeedback(`${currentServiceProduct.name} - ${formatCurrency(price)}`);
            updateCartDisplay();
            updateTotal();
            closeServiceProductModal();
        }

        function updateCartDisplay() {
            const cartItems = document.getElementById('cartItems');
            const cartItemCount = document.getElementById('cartItemCount');
            
            const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
            cartItemCount.textContent = totalItems;
            
            if (cart.length === 0) {
                cartItems.innerHTML = '<div class="text-center text-gray-500 py-8"><p class="text-sm">Keranjang masih kosong</p></div>';
                // Also update the scanner tab to show empty cart
                displayScannerProductTable();
                return;
            }

            cartItems.innerHTML = cart.map(item => {
                const isServiceItem = item.isService;
                const itemId = item.id;
                
                return `
                    <div class="bg-gray-50 p-2 rounded-lg fade-in ${isServiceItem ? 'border-l-4 border-purple-500' : ''}">
                        <div class="flex justify-between items-center">
                            <div class="flex-1">
                                <div class="font-semibold text-sm text-gray-800 truncate">
                                    ${item.name}
                                    ${isServiceItem ? '<span class="bg-purple-500 text-white px-1 rounded text-xs ml-1">🔧 JASA</span>' : ''}
                                </div>
                                <div class="text-xs text-gray-600">
                                    ${formatCurrency(item.price)} x ${item.quantity}
                                    ${item.isWholesale ? '<span class="bg-blue-500 text-white px-1 rounded text-xs ml-1">🏪 GROSIR</span>' : ''}
                                </div>
                                ${item.description ? `<div class="text-xs text-purple-600 italic mt-1">"${item.description}"</div>` : ''}
                                <!-- Per‑item discount controls: allow percentage or nominal discount per product -->
                                <div class="mt-1 flex items-center space-x-1 text-xs text-gray-600">
                                    <span>Diskon:</span>
                                    <!-- Place the discount type selector (Rp/% dropdown) before the numeric input to align with scanner table ordering -->
                                    <select class="px-1 py-0 border rounded text-xs"
                                            onchange="updateItemDiscountType('${itemId}', this.value)">
                                        <option value="percent" ${item.discountType === 'percent' ? 'selected' : ''}>%</option>
                                        <option value="amount" ${item.discountType === 'amount' ? 'selected' : ''}>Rp</option>
                                    </select>
                                    <input type="number" value="${item.discountValue || 0}" min="0"
                                           class="w-20 px-1 py-0 border rounded text-right text-xs"
                                           onchange="updateItemDiscount('${itemId}', this.value)"
                                           onclick="this.select()">
                                </div>
                            </div>
                            <div class="flex items-center space-x-1 ml-2">
                                <div class="font-bold ${isServiceItem ? 'text-purple-600' : item.isWholesale ? 'text-blue-600' : 'text-green-600'} text-sm">${formatCurrency(item.price * item.quantity)}</div>
                                <div class="flex items-center space-x-1">
                                    ${isServiceItem ? `
                                        <button onclick="removeFromCart('${itemId}')" class="bg-red-500 hover:bg-red-600 text-white w-5 h-5 rounded text-xs">×</button>
                                    ` : `
                                        <button onclick="updateQuantity(${item.id}, -1)" class="bg-red-500 hover:bg-red-600 text-white w-5 h-5 rounded text-xs">-</button>
                                        <input type="number" value="${item.quantity}" min="1" max="999" 
                                               class="w-10 px-1 py-0 border rounded text-xs text-center" 
                                               onchange="setQuantity(${item.id}, this.value)"
                                               onkeypress="handleQuantityKeypress(event, ${item.id})"
                                               onclick="this.select()">
                                        <button onclick="updateQuantity(${item.id}, 1)" class="bg-green-500 hover:bg-green-600 text-white w-5 h-5 rounded text-xs">+</button>
                                        <button onclick="removeFromCart(${item.id})" class="bg-gray-500 hover:bg-gray-600 text-white w-5 h-5 rounded text-xs">×</button>
                                    `}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // Always update the scanner cart table when cart contents change.  Without
            // this call, changes to per‑item discount or quantity only update the
            // floating cart, leaving the scanner tab stale.  By refreshing the
            // scanner table here, we ensure the row totals and discount values
            // reflect the latest cart state.  Only call once to avoid redundant
            // rendering.
            displayScannerProductTable();
        }

        function updateQuantity(id, change) {
            const item = cart.find(item => item.id === id);
            if (!item) {
                return;
            }
            const newQuantity = item.quantity + change;
            if (newQuantity <= 0) {
                // Jika kuantitas turun di bawah atau sama dengan nol, hapus item dari keranjang
                removeFromCart(id);
                return;
            }
            // Temukan produk dalam daftar master untuk referensi stok dan harga
            const product = products.find(p => p.id === id);
            // Tentukan apakah item ini merupakan jasa (service) atau memiliki harga nol.
            const isServiceOrFree = item.isService || item.price === 0;
            // Jika item adalah jasa/free, atau stok mencukupi, perbarui kuantitas
            if (isServiceOrFree || (product && product.stock >= newQuantity)) {
                item.quantity = newQuantity;
                // Perbarui harga berdasarkan aturan grosir jika berlaku
                if (product && product.wholesaleMinQty && product.wholesalePrice) {
                    if (item.quantity >= product.wholesaleMinQty) {
                        item.price = product.wholesalePrice;
                        item.isWholesale = true;
                    } else {
                        item.price = product.price;
                        item.isWholesale = false;
                    }
                }
                // Segarkan tampilan dan hitung total
                updateCartDisplay();
                updateTotal();
            } else {
                // Jika stok tidak mencukupi, gunakan stok yang tersedia (atau 0 jika tidak ada produk)
                const available = product && typeof product.stock === 'number' ? product.stock : 0;
                alert(`Stok tidak mencukupi! Stok tersedia: ${available}`);
            }
        }

        function setQuantity(id, newQuantity) {
            const quantity = parseInt(newQuantity) || 1;
            const item = cart.find(item => item.id === id);
            
            if (item) {
                if (quantity <= 0) {
                    removeFromCart(id);
                    return;
                }
                
                const product = products.find(p => p.id === id);
                if (product && (product.isService || product.price === 0 || product.stock >= quantity)) {
                    item.quantity = quantity;
                    
                    // Update price based on wholesale pricing
                    if (product.wholesaleMinQty && product.wholesalePrice) {
                        if (item.quantity >= product.wholesaleMinQty) {
                            item.price = product.wholesalePrice;
                            item.isWholesale = true;
                        } else {
                            item.price = product.price;
                            item.isWholesale = false;
                        }
                    }
                    
                    updateCartDisplay();
                    updateTotal();
                } else {
                    alert(`Stok tidak mencukupi! Stok tersedia: ${product.stock}`);
                    // Reset input to current quantity
                    updateCartDisplay();
                }
            }
        }

        function handleQuantityKeypress(event, id) {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.target.blur(); // Remove focus to trigger onchange
            }
        }

        function removeFromCart(id) {
            // Handle both numeric IDs and string IDs (for service items)
            cart = cart.filter(item => item.id != id);
    updateCartDisplay();
    // If the cart is now empty, reset any global discount values so that
    // subsequent transactions start with a clean slate.  This prevents
    // previously entered discounts from carrying over when the user
    // removes all items one by one.
    if (cart.length === 0) {
        resetGlobalDiscount();
    }
    updateTotal();
        }

        function clearCart() {
            // Only prompt if there are items in the cart
            if (cart.length === 0) return;
            showConfirmLayer('Yakin ingin mengosongkan keranjang?', function(confirmed) {
                if (confirmed) {
                    cart = [];
                    updateCartDisplay();
            // Reset global discount whenever the cart is completely emptied.
            resetGlobalDiscount();
            updateTotal();
                }
            });
        }

    /**
     * Reset the global discount inputs back to their defaults (0 value and
     * percentage type).  This function should be called whenever the cart is
     * emptied, either via clearCart() or by removing items one by one until
     * none remain.  Without this reset, any previously entered discount
     * amount would erroneously apply to the next transaction.
     */
    function resetGlobalDiscount() {
        const discountInputEl = document.getElementById('discountInput');
        const discountTypeEl = document.getElementById('discountType');
        if (discountInputEl) {
            discountInputEl.value = 0;
        }
        if (discountTypeEl) {
            // Default to percentage discount
            discountTypeEl.value = 'percent';
        }
    }

        /**
         * Hitung subtotal (setelah diskon per item) dan total (setelah diskon global).
         * Fungsi ini mengembalikan objek dengan properti intermediateTotal dan total.
         * Dengan memusatkan logika perhitungan di satu tempat, kita menghindari
         * duplikasi kode antara updateTotal() dan updateTotalPayNotice().
         *
         * @returns {{intermediateTotal: number, total: number}}
         */
        function computeTotals() {
            // Hitung subtotal setelah diskon per item
            let intermediateTotal = 0;
            cart.forEach(item => {
                const itemSubtotal = item.price * item.quantity;
                let itemDiscount = 0;
                if (item.discountType === 'percent') {
                    itemDiscount = itemSubtotal * (item.discountValue || 0) / 100;
                } else {
                    itemDiscount = item.discountValue || 0;
                }
                // Jangan biarkan diskon melebihi subtotal item
                if (itemDiscount > itemSubtotal) itemDiscount = itemSubtotal;
                intermediateTotal += (itemSubtotal - itemDiscount);
            });
            // Ambil nilai diskon global dari UI
            const discountInputEl = document.getElementById('discountInput');
            const discountTypeEl = document.getElementById('discountType');
            const globalValue = discountInputEl ? parseInt(discountInputEl.value) || 0 : 0;
            const globalType = discountTypeEl ? discountTypeEl.value : 'percent';
            // Hitung jumlah diskon global berdasarkan tipe
            let globalAmount = 0;
            if (globalType === 'percent') {
                globalAmount = intermediateTotal * globalValue / 100;
            } else {
                globalAmount = globalValue;
            }
            // Jangan biarkan diskon global melebihi subtotal
            if (globalAmount > intermediateTotal) {
                globalAmount = intermediateTotal;
            }
            const total = intermediateTotal - globalAmount;
            return { intermediateTotal, total };
        }

        function updateTotal() {
            // Gunakan fungsi utilitas untuk menghitung subtotal dan total
            const totals = computeTotals();
            document.getElementById('subtotal').textContent = formatCurrency(totals.intermediateTotal);
            document.getElementById('total').textContent = formatCurrency(totals.total);
            // Perbarui notifikasi total bayar di daftar produk
            updateTotalPayNotice();
        }

    /**
     * Menampilkan atau menyembunyikan notifikasi total bayar pada tab Scanner.
     * Jika keranjang kosong maka elemen disembunyikan. Jika ada item,
     * total setelah diskon akan ditampilkan dalam format mata uang.
     */
    function updateTotalPayNotice() {
        const notice = document.getElementById('totalPayNotice');
        if (!notice) return;
        const amountSpan = document.getElementById('totalPayAmount');
        // Gunakan computeTotals() untuk mengambil total terkini
        const totals = computeTotals();
        if (cart.length === 0) {
            // Sembunyikan pemberitahuan bila keranjang kosong
            notice.classList.add('hidden');
        } else {
            // Tampilkan total bayar setelah diskon global
            if (amountSpan) {
                amountSpan.textContent = formatCurrency(totals.total);
            }
            notice.classList.remove('hidden');
        }
    }

        // Scanner product table functions
        function displayScannerProductTable() {
            const tableBody = document.getElementById('scannerProductTable');
            if (!tableBody) return;
            
            // Show cart items instead of product list in the scanner tab
            if (cart.length === 0) {
                // When adding new columns to the scanner cart (e.g. Diskon (Rp)), update the colspan accordingly.
                tableBody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-gray-500">Keranjang masih kosong</td></tr>';
                return;
            }

            tableBody.innerHTML = cart.map(item => {
                // Determine if this is a service item (no quantity adjustments and price may be zero)
                const isServiceItem = item.isService || item.price === 0;
                // Compute the item's subtotal and discount.  The discount is based on
                // the per‑item discount value and type.  If the discount exceeds the
                // subtotal, clamp it to the subtotal so totals never go negative.
                const itemSubtotal = item.price * item.quantity;
                let itemDiscount = 0;
                if (item.discountType === 'percent') {
                    itemDiscount = itemSubtotal * (item.discountValue || 0) / 100;
                } else {
                    itemDiscount = item.discountValue || 0;
                }
                if (itemDiscount > itemSubtotal) itemDiscount = itemSubtotal;
                const itemTotal = itemSubtotal - itemDiscount;
                return `
                    <tr class="border-b border-gray-100 hover:bg-blue-50">
                        <td class="px-3 py-3">
                            <!-- Tampilkan nama produk dengan ukuran lebih besar agar seimbang dengan notifikasi Total Bayar -->
                            <div class="font-bold text-gray-800 text-lg">${item.name}${isServiceItem ? '<span class="bg-purple-500 text-white px-1 rounded text-xs ml-1">🔧 JASA</span>' : ''}</div>
                            ${isServiceItem && item.description ? `<div class="text-xs text-purple-600 italic mt-1">"${item.description}"</div>` : ''}
                        </td>
                        <td class="px-3 py-3 text-right text-lg font-bold">
                            ${formatCurrency(item.price)}
                        </td>
                        <td class="px-3 py-3 text-center text-lg font-bold">
                            ${isServiceItem ? '1' : `
                                <div class="flex items-center justify-center space-x-1">
                                    <button onclick="updateQuantity(${item.id}, -1)" class="bg-red-500 hover:bg-red-600 text-white px-3 py-2 rounded text-sm">-</button>
                                    <input type="number" value="${item.quantity}" min="1" max="999" 
                                           class="w-16 px-2 py-1 border rounded text-base text-center" 
                                           onchange="setQuantity(${item.id}, this.value)"
                                           onkeypress="handleQuantityKeypress(event, ${item.id})"
                                           onclick="this.select()">
                                    <button onclick="updateQuantity(${item.id}, 1)" class="bg-green-500 hover:bg-green-600 text-white px-3 py-2 rounded text-sm">+</button>
                                </div>
                            `}
                        </td>
                        <!-- New discount column with editable controls (type and value).  Place the type selector before the numeric field. -->
                        <td class="px-3 py-3 text-center text-lg">
                            <div class="flex items-center justify-center space-x-1">
                                <select class="px-2 py-1 border rounded text-base"
                                        onchange="updateItemDiscountType('${item.id}', this.value)">
                                    <option value="percent" ${item.discountType === 'percent' ? 'selected' : ''}>%</option>
                                    <option value="amount" ${item.discountType === 'amount' ? 'selected' : ''}>Rp</option>
                                </select>
                                <input type="number" value="${item.discountValue || 0}" min="0"
                                       class="w-24 px-2 py-1 border rounded text-base text-right"
                                       onchange="updateItemDiscount('${item.id}', this.value)"
                                       onclick="this.select()">
                            </div>
                        </td>
                        <!-- Display the row total after discount to align with the top total bayar notice -->
                        <td class="px-3 py-3 text-right font-bold text-lg">${formatCurrency(itemTotal)}</td>
                        <td class="px-3 py-3 text-center text-lg">
                            <button onclick="removeFromCart('${item.id}')" class="bg-gray-500 hover:bg-gray-600 text-white px-3 py-2 rounded text-sm">×</button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function handleScannerTableSearch(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                const searchTerm = event.target.value.trim();
                
                if (searchTerm) {
                    const filtered = products.filter(product => {
                        const name = (product.name || '').toString().toLowerCase();
                        const barcode = (product.barcode || '').toString();
                        return name.includes(searchTerm.toLowerCase()) || barcode.includes(searchTerm);
                    });
                    
                    // If only one product matches, add it to cart automatically
                    if (filtered.length === 1) {
                        const product = filtered[0];
                        if (product.isService || product.price === 0 || product.stock > 0) {
                            const cartProduct = {
                                id: product.id,
                                name: product.name,
                                price: product.price,
                                stock: product.isService || product.price === 0 ? 999999 : product.stock
                            };
                            addToCart(cartProduct);
                            event.target.value = '';
                            displayScannerProductTable(); // Reset table display
                        } else {
                            alert(`Produk "${product.name}" stok habis!`);
                        }
                    } else if (filtered.length === 0) {
                        alert('Produk tidak ditemukan!');
                    }
                    // If multiple matches, keep showing filtered results
                }
            }
        }

        function searchScannerProducts(searchTerm) {
            const tableBody = document.getElementById('scannerProductTable');
            
            if (!searchTerm.trim()) {
                displayScannerProductTable();
                return;
            }

            const filtered = products.filter(product => {
                const name = (product.name || '').toString().toLowerCase();
                const barcode = (product.barcode || '').toString();
                return name.includes(searchTerm.toLowerCase()) || barcode.includes(searchTerm);
            });

            if (filtered.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-gray-500">Tidak ada produk ditemukan</td></tr>';
                return;
            }

            // Sort filtered products by ID descending (newest first)
            const sortedFiltered = filtered.sort((a, b) => b.id - a.id);

            tableBody.innerHTML = sortedFiltered.map(product => {
                // Special handling for service products
                if (product.isService || product.price === 0) {
                    return `
                        <tr class="border-b border-gray-100 hover:bg-purple-50 bg-purple-25">
                            <td class="px-3 py-3">
                                <div class="font-medium text-gray-800">${product.name}</div>
                                <div class="text-xs text-purple-600 font-semibold">🔧 Produk Jasa</div>
                            </td>
                            <td class="px-3 py-3">
                                <div class="font-mono text-sm text-gray-400">
                                    Tidak ada
                                </div>
                            </td>
                            <td class="px-3 py-3 text-right">
                                <div class="font-bold text-purple-600">JASA</div>
                            </td>
                            <td class="px-3 py-3 text-center">
                                <span class="px-2 py-1 rounded-full text-xs font-semibold text-purple-600">
                                    ∞
                                </span>
                                <div class="text-xs text-purple-600 mt-1">UNLIMITED</div>
                            </td>
                            <td class="px-3 py-3 text-center">
                                <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: 999999})" 
                                        class="px-3 py-1 rounded text-xs font-semibold transition-colors bg-purple-500 hover:bg-purple-600 text-white">
                                    ➕ Tambah
                                </button>
                            </td>
                        </tr>
                    `;
                }
                
                // Regular product display
                const stockStatus = product.stock === 0 ? 'critical' : product.stock <= product.minStock ? 'low' : 'ok';
                const stockClass = stockStatus === 'critical' ? 'text-red-600 font-bold' : 
                                 stockStatus === 'low' ? 'text-yellow-600 font-semibold' : 'text-green-600';
                const rowClass = stockStatus === 'critical' ? 'bg-red-50' : 
                               stockStatus === 'low' ? 'bg-yellow-50' : '';
                
                return `
                    <tr class="border-b border-gray-100 hover:bg-blue-50 ${rowClass}">
                        <td class="px-3 py-3">
                            <div class="font-medium text-gray-800">${product.name}</div>
                            <div class="text-xs text-gray-500">Modal: ${formatCurrency(product.modalPrice || 0)}</div>
                        </td>
                        <td class="px-3 py-3">
                            <div class="font-mono text-sm ${product.barcode ? 'text-gray-700' : 'text-gray-400'}">
                                ${product.barcode || 'Tidak ada'}
                            </div>
                        </td>
                        <td class="px-3 py-3 text-right">
                            <div class="font-bold text-green-600">${formatCurrency(product.price)}</div>
                        </td>
                        <td class="px-3 py-3 text-center">
                            <span class="px-2 py-1 rounded-full text-xs font-semibold ${stockClass}">
                                ${product.stock}
                            </span>
                            ${stockStatus === 'critical' ? '<div class="text-xs text-red-500 mt-1">HABIS</div>' : 
                              stockStatus === 'low' ? '<div class="text-xs text-yellow-600 mt-1">MENIPIS</div>' : ''}
                        </td>
                        <td class="px-3 py-3 text-center">
                            <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: ${product.stock}})" 
                                    class="px-3 py-1 rounded text-xs font-semibold transition-colors ${product.stock === 0 ? 'bg-gray-400 text-white cursor-not-allowed' : 'bg-green-500 hover:bg-green-600 text-white'}"
                                    ${product.stock === 0 ? 'disabled' : ''}>
                                ${product.stock === 0 ? '❌ Habis' : '➕ Tambah'}
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        // Product management
        // Render products in grid layout
        function displayProductsGrid(list) {
            const container = document.getElementById('savedProducts');
            container.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3';
            container.innerHTML = list.map(product => {
                // Service product
                if (product.isService || product.price === 0) {
                    return `
                        <div class="border-2 rounded-lg p-3 hover-lift bg-gradient-to-br from-purple-50 to-purple-100 border-purple-300">
                            <div class="font-semibold text-sm text-gray-800 truncate mb-1">${product.name}</div>
                            <div class="text-xs text-purple-600 font-bold mb-1">🔧 JASA</div>
                            <div class="text-xs text-gray-500 mb-1">Produk Layanan</div>
                            <div class="text-xs font-semibold mb-1 text-purple-600">
                                Stok: Unlimited
                            </div>
                            <div class="mb-2"></div>
                            <div class="flex space-x-1">
                                <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: 999999})" 
                                        class="flex-1 bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                    ➕
                                </button>
                                <button onclick="editProduct(${product.id})" 
                                        class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                    ✏️
                                </button>
                            </div>
                        </div>
                    `;
                }
                // Determine stock classes
                const stockStatusInner = product.stock === 0 ? 'critical' : product.stock <= product.minStock ? 'low' : 'ok';
                const stockClass = stockStatusInner === 'critical' ? 'stock-critical' : stockStatusInner === 'low' ? 'stock-low' : 'stock-ok';
                return `
                    <div class="border-2 rounded-lg p-3 hover-lift ${stockClass}">
                        <div class="font-semibold text-sm text-gray-800 truncate mb-1">${product.name}</div>
                        <div class="text-xs text-green-600 font-bold mb-1">${formatCurrency(product.price)}</div>
                        ${product.wholesaleMinQty && product.wholesalePrice ? 
                            `<div class="text-xs text-blue-600 font-semibold mb-1">🏪 ${formatCurrency(product.wholesalePrice)} (${product.wholesaleMinQty}+ pcs)</div>` : 
                            ''
                        }
                        <div class="text-xs text-gray-500 mb-1">Modal: ${formatCurrency(product.modalPrice || 0)}</div>
                        <div class="text-xs font-semibold mb-1 ${stockStatusInner === 'critical' ? 'text-red-600' : stockStatusInner === 'low' ? 'text-yellow-600' : 'text-green-600'}">
                            Stok: ${product.stock}
                        </div>
                        ${product.barcode ? `<div class="text-xs text-gray-400 mb-2">Barcode: ${product.barcode}</div>` : '<div class="mb-2"></div>'}
                        <div class="flex space-x-1">
                            <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: ${product.stock}})" 
                                    class="flex-1 ${product.stock === 0 ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-500 hover:bg-green-600'} text-white px-2 py-1 rounded text-xs font-semibold active-press"
                                    ${product.stock === 0 ? 'disabled' : ''}>
                                ${product.stock === 0 ? '❌' : '➕'}
                            </button>
                            <button onclick="editProduct(${product.id})" 
                                    class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                ✏️
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Render products in table layout
        function displayProductsTable(list) {
            const container = document.getElementById('savedProducts');
            // Save the list to a global variable so sorting can operate on the
            // same dataset without re-filtering.  Use a shallow copy to avoid
            // mutating the original array passed in.
            currentTableList = Array.isArray(list) ? list.slice() : [];
            container.className = 'overflow-x-auto';
            let tableHtml = '<table class="w-full text-sm">';
            // Build table header with clickable columns for sorting
            tableHtml += '<thead class="bg-gray-100"><tr>' +
                         '<th class="px-4 py-2 text-left font-semibold text-gray-700 cursor-pointer" onclick="sortTableBy(\'name\')">Nama Produk</th>' +
                         '<th class="px-4 py-2 text-left font-semibold text-gray-700 cursor-pointer" onclick="sortTableBy(\'price\')">Harga</th>' +
                         '<th class="px-4 py-2 text-left font-semibold text-gray-700">Modal</th>' +
                         '<th class="px-4 py-2 text-left font-semibold text-gray-700 cursor-pointer" onclick="sortTableBy(\'stock\')">Stok</th>' +
                         '<th class="px-4 py-2 text-left font-semibold text-gray-700">Barcode</th>' +
                         '<th class="px-4 py-2 text-center font-semibold text-gray-700">Aksi</th>' +
                         '</tr></thead><tbody>';
            tableHtml += currentTableList.map(product => {
                const stockStatus = product.stock === 0 ? 'critical' : product.stock <= product.minStock ? 'low' : 'ok';
                const stockColor = stockStatus === 'critical' ? 'text-red-600' : stockStatus === 'low' ? 'text-yellow-600' : 'text-green-600';
                if (product.isService || product.price === 0) {
                    return `
                        <tr class="border-b border-gray-100 hover:bg-purple-50">
                            <td class="px-4 py-2 font-medium text-gray-800">${product.name}<div class="text-xs text-purple-600 font-semibold">🔧 JASA</div></td>
                            <td class="px-4 py-2 text-purple-600 font-bold">JASA</td>
                            <td class="px-4 py-2 text-gray-500">-</td>
                            <td class="px-4 py-2 ${stockColor}">∞</td>
                            <td class="px-4 py-2 text-gray-400">-</td>
                            <td class="px-4 py-2 text-center">
                                <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: 999999})" 
                                        class="px-2 py-1 rounded text-xs font-semibold transition-colors bg-purple-500 hover:bg-purple-600 text-white">
                                    ➕
                                </button>
                                <button onclick="editProduct(${product.id})" 
                                        class="ml-1 px-2 py-1 rounded text-xs font-semibold transition-colors bg-blue-500 hover:bg-blue-600 text-white">
                                    ✏️
                                </button>
                            </td>
                        </tr>
                    `;
                }
                return `
                    <tr class="border-b border-gray-100 hover:bg-blue-50">
                        <td class="px-4 py-2 font-medium text-gray-800">${product.name}</td>
                        <td class="px-4 py-2 text-green-600 font-bold">${formatCurrency(product.price)}</td>
                        <td class="px-4 py-2 text-gray-500">${formatCurrency(product.modalPrice || 0)}</td>
                        <td class="px-4 py-2 ${stockColor}">${product.stock}</td>
                        <td class="px-4 py-2 text-gray-400">${product.barcode || '-'}</td>
                        <td class="px-4 py-2 text-center">
                            <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: ${product.stock}})" 
                                    class="px-2 py-1 rounded text-xs font-semibold transition-colors ${product.stock === 0 ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-500 hover:bg-green-600'} text-white"
                                    ${product.stock === 0 ? 'disabled' : ''}>
                                ${product.stock === 0 ? '❌' : '➕'}
                            </button>
                            <button onclick="editProduct(${product.id})" 
                                    class="ml-1 px-2 py-1 rounded text-xs font-semibold transition-colors bg-blue-500 hover:bg-blue-600 text-white">
                                ✏️
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
            tableHtml += '</tbody></table>';
            container.innerHTML = tableHtml;
        }

        // Render products in list layout
        function displayProductsList(list) {
            const container = document.getElementById('savedProducts');
            container.className = 'space-y-3';
            container.innerHTML = list.map(product => {
                const stockStatus = product.stock === 0 ? 'critical' : product.stock <= product.minStock ? 'low' : 'ok';
                const stockColorClass = stockStatus === 'critical' ? 'text-red-600' : stockStatus === 'low' ? 'text-yellow-600' : 'text-green-600';
                if (product.isService || product.price === 0) {
                    return `
                        <div class="border-2 rounded-lg p-3 hover-lift bg-gradient-to-br from-purple-50 to-purple-100 border-purple-300 flex justify-between items-start">
                            <div>
                                <div class="font-semibold text-sm text-gray-800 mb-1">${product.name}</div>
                                <div class="text-xs text-purple-600 font-bold mb-1">🔧 JASA</div>
                                <div class="text-xs text-gray-500 mb-1">Produk Layanan</div>
                                <div class="text-xs font-semibold mb-1 text-purple-600">Stok: Unlimited</div>
                            </div>
                            <div class="flex space-x-1 mt-1 ml-2">
                                <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: 999999})" 
                                        class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                    ➕
                                </button>
                                <button onclick="editProduct(${product.id})" 
                                        class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                    ✏️
                                </button>
                            </div>
                        </div>
                    `;
                }
                const wholesaleInfo = (product.wholesaleMinQty && product.wholesalePrice) ? `<div class="text-xs text-blue-600 font-semibold mb-1">🏪 ${formatCurrency(product.wholesalePrice)} (${product.wholesaleMinQty}+ pcs)</div>` : '';
                return `
                    <div class="border-2 rounded-lg p-3 hover-lift ${stockStatus === 'critical' ? 'bg-red-50' : stockStatus === 'low' ? 'bg-yellow-50' : 'bg-gray-50'} flex justify-between items-start">
                        <div>
                            <div class="font-semibold text-sm text-gray-800 mb-1">${product.name}</div>
                            <div class="text-xs text-green-600 font-bold mb-1">${formatCurrency(product.price)}</div>
                            ${wholesaleInfo}
                            <div class="text-xs text-gray-500 mb-1">Modal: ${formatCurrency(product.modalPrice || 0)}</div>
                            <div class="text-xs font-semibold mb-1 ${stockColorClass}">Stok: ${product.stock}</div>
                            ${product.barcode ? `<div class="text-xs text-gray-400 mb-1">Barcode: ${product.barcode}</div>` : ''}
                        </div>
                        <div class="flex space-x-1 mt-1 ml-2">
                            <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: ${product.stock}})" 
                                    class="${product.stock === 0 ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-500 hover:bg-green-600'} text-white px-2 py-1 rounded text-xs font-semibold active-press"
                                    ${product.stock === 0 ? 'disabled' : ''}>
                                ${product.stock === 0 ? '❌' : '➕'}
                            </button>
                            <button onclick="editProduct(${product.id})" 
                                    class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                ✏️
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Update the view mode buttons to reflect the current selection
        function updateViewButtons() {
            const modes = ['grid', 'table', 'list'];
            modes.forEach(mode => {
                const buttonId = 'view' + mode.charAt(0).toUpperCase() + mode.slice(1) + 'Button';
                const btn = document.getElementById(buttonId);
                if (!btn) return;
                if (productViewMode === mode) {
                    // Active button styling: green background and white text with green hover state
                    btn.classList.add('bg-green-500', 'text-white', 'hover:bg-green-600');
                    btn.classList.remove('bg-gray-200', 'text-gray-700', 'hover:bg-gray-300');
                } else {
                    // Inactive button styling: gray background and dark text with gray hover state
                    btn.classList.add('bg-gray-200', 'text-gray-700', 'hover:bg-gray-300');
                    btn.classList.remove('bg-green-500', 'text-white', 'hover:bg-green-600');
                }
            });
        }

        // Change the product view mode and render products accordingly
        function setProductViewMode(mode) {
            productViewMode = mode;
            // Check if there is an active search term
            const searchInput = document.getElementById('productSearchInput');
            const searchTerm = searchInput ? searchInput.value.trim() : '';
            if (searchTerm) {
                // Re-filter products based on the search term with the new view
                searchProducts(searchTerm);
            } else {
                // No search filter: sort and render all products in the selected mode
                const sorted = [...products].sort((a, b) => b.id - a.id);
                if (mode === 'table') {
                    displayProductsTable(sorted);
                } else if (mode === 'list') {
                    displayProductsList(sorted);
                } else {
                    displayProductsGrid(sorted);
                }
            }
            updateViewButtons();
        }

        function displaySavedProducts() {
            const container = document.getElementById('savedProducts');
            
            if (products.length === 0) {
                container.innerHTML = '<div class="col-span-full text-center text-gray-500 py-8">Belum ada produk</div>';
                return;
            }

            // Sort products by ID descending (newest first)
            const sortedProducts = [...products].sort((a, b) => b.id - a.id);

            container.innerHTML = sortedProducts.map(product => {
                // Special handling for service products
                if (product.isService || product.price === 0) {
                    return `
                        <div class="border-2 rounded-lg p-3 hover-lift bg-gradient-to-br from-purple-50 to-purple-100 border-purple-300">
                            <div class="font-semibold text-sm text-gray-800 truncate mb-1">${product.name}</div>
                            <div class="text-xs text-purple-600 font-bold mb-1">🔧 JASA</div>
                            <div class="text-xs text-gray-500 mb-1">Produk Layanan</div>
                            <div class="text-xs font-semibold mb-1 text-purple-600">
                                Stok: Unlimited
                            </div>
                            <div class="mb-2"></div>
                            
                            <div class="flex space-x-1">
                                <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: 999999})" 
                                        class="flex-1 bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                    ➕
                                </button>
                                <button onclick="editProduct(${product.id})" 
                                        class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                    ✏️
                                </button>
                            </div>
                        </div>
                    `;
                }
                
                // Regular product display
                const stockStatus = product.stock === 0 ? 'critical' : product.stock <= product.minStock ? 'low' : 'ok';
                const stockClass = stockStatus === 'critical' ? 'stock-critical' : stockStatus === 'low' ? 'stock-low' : 'stock-ok';
                
                return `
                    <div class="border-2 rounded-lg p-3 hover-lift ${stockClass}">
                        <div class="font-semibold text-sm text-gray-800 truncate mb-1">${product.name}</div>
                        <div class="text-xs text-green-600 font-bold mb-1">${formatCurrency(product.price)}</div>
                        ${product.wholesaleMinQty && product.wholesalePrice ? 
                            `<div class="text-xs text-blue-600 font-semibold mb-1">🏪 ${formatCurrency(product.wholesalePrice)} (${product.wholesaleMinQty}+ pcs)</div>` : 
                            ''
                        }
                        <div class="text-xs text-gray-500 mb-1">Modal: ${formatCurrency(product.modalPrice || 0)}</div>
                        <div class="text-xs font-semibold mb-1 ${stockStatus === 'critical' ? 'text-red-600' : stockStatus === 'low' ? 'text-yellow-600' : 'text-green-600'}">
                            Stok: ${product.stock}
                        </div>
                        ${product.barcode ? `<div class="text-xs text-gray-400 mb-2">Barcode: ${product.barcode}</div>` : '<div class="mb-2"></div>'}
                        
                        <div class="flex space-x-1">
                            <button onclick="addToCart({id: ${product.id}, name: '${product.name}', price: ${product.price}, stock: ${product.stock}})" 
                                    class="flex-1 ${product.stock === 0 ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-500 hover:bg-green-600'} text-white px-2 py-1 rounded text-xs font-semibold active-press"
                                    ${product.stock === 0 ? 'disabled' : ''}>
                                ${product.stock === 0 ? '❌' : '➕'}
                            </button>
                            <button onclick="editProduct(${product.id})" 
                                    class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-semibold active-press">
                                ✏️
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function searchProducts(searchTerm) {
            // If search term is empty, show all products in the current view mode
            if (!searchTerm.trim()) {
                const sorted = [...products].sort((a, b) => b.id - a.id);
                if (productViewMode === 'table') {
                    displayProductsTable(sorted);
                } else if (productViewMode === 'list') {
                    displayProductsList(sorted);
                } else {
                    displayProductsGrid(sorted);
                }
                return;
            }
            let filtered;
            try {
                // Filter products based on name or barcode
                filtered = products.filter(product => {
                    // Coerce properties to strings in case of undefined
                    const name = (product.name || '').toString().toLowerCase();
                    const barcode = (product.barcode || '').toString();
                    return name.includes(searchTerm.toLowerCase()) || barcode.includes(searchTerm);
                });
            } catch (err) {
                // If an error occurs (e.g. products is undefined or product has unexpected structure),
                // fall back to using the locally saved products from localStorage.  This ensures the
                // search functionality continues to work even after dynamic updates or import operations
                // that may replace or unset the global `products` array.
                try {
                    const stored = localStorage.getItem('kasir_products');
                    const fallbackList = stored ? JSON.parse(stored) : [];
                    filtered = fallbackList.filter(product => {
                        const name = (product.name || '').toString().toLowerCase();
                        const barcode = (product.barcode || '').toString();
                        return name.includes(searchTerm.toLowerCase()) || barcode.includes(searchTerm);
                    });
                } catch (_) {
                    filtered = [];
                }
            }
            if (!Array.isArray(filtered) || filtered.length === 0) {
                const container = document.getElementById('savedProducts');
                if (container) {
                    container.innerHTML = '<div class="col-span-full text-center text-gray-500 py-8">Tidak ada produk ditemukan</div>';
                }
                return;
            }
            // Sort filtered products by ID descending (newest first)
            const sortedFiltered = filtered.sort((a, b) => b.id - a.id);
            // Render the filtered list according to the current view mode
            if (productViewMode === 'table') {
                displayProductsTable(sortedFiltered);
            } else if (productViewMode === 'list') {
                displayProductsList(sortedFiltered);
            } else {
                displayProductsGrid(sortedFiltered);
            }
        }

        function showAddProductModal() {
            const modalEl = document.getElementById('addProductModal');
            modalEl.classList.remove('hidden');
            modalEl.classList.add('flex');
            // Attach keyboard shortcuts: Enter saves new product, Escape cancels
            attachModalKeyHandlers(modalEl, saveNewProduct, closeAddProductModal);
        }

        function closeAddProductModal() {
            const modalEl = document.getElementById('addProductModal');
            modalEl.classList.add('hidden');
            modalEl.classList.remove('flex');
            // Detach keyboard handlers when closing
            detachModalKeyHandlers(modalEl);
            // Clear form
            document.getElementById('newProductName').value = '';
            document.getElementById('newProductPrice').value = '';
            document.getElementById('newProductModalPrice').value = '';
            document.getElementById('newProductBarcode').value = '';
            document.getElementById('newProductStock').value = '0';
            document.getElementById('newProductMinStock').value = '5';
            document.getElementById('newProductWholesaleMinQty').value = '';
            document.getElementById('newProductWholesalePrice').value = '';
        }

        function saveNewProduct() {
            const name = document.getElementById('newProductName').value.trim();
            const price = parseInt(document.getElementById('newProductPrice').value) || 0;
            const modalPrice = parseInt(document.getElementById('newProductModalPrice').value) || 0;
            const barcode = document.getElementById('newProductBarcode').value.trim();
            const stock = parseInt(document.getElementById('newProductStock').value) || 0;
            const minStock = parseInt(document.getElementById('newProductMinStock').value) || 5;
            const wholesaleMinQty = parseInt(document.getElementById('newProductWholesaleMinQty').value) || 0;
            const wholesalePrice = parseInt(document.getElementById('newProductWholesalePrice').value) || 0;

            if (!name) {
                alert('Nama produk harus diisi!');
                return;
            }

            // Validate wholesale pricing if provided
            if (wholesaleMinQty > 0 || wholesalePrice > 0) {
                if (wholesaleMinQty < 2) {
                    alert('Minimal quantity grosir harus minimal 2!');
                    return;
                }
                if (wholesalePrice <= 0) {
                    alert('Harga grosir harus diisi jika ada minimal quantity!');
                    return;
                }
                if (wholesalePrice >= price) {
                    alert('Harga grosir harus lebih kecil dari harga normal!');
                    return;
                }
                if (wholesalePrice <= modalPrice) {
                    alert('Harga grosir harus lebih besar dari harga modal!');
                    return;
                }
            }

            // Special handling for service products (price = 0)
            if (price === 0) {
                const newProduct = {
                    id: Date.now(),
                    name: name,
                    price: 0,
                    modalPrice: 0,
                    barcode: null,
                    stock: 999999, // Unlimited stock for services
                    minStock: 0,
                    isService: true
                };

                products.push(newProduct);
                // Sync new service product to server database so it persists across devices.
                // Only attempt to sync when running over HTTP/HTTPS; when the app is opened via the file protocol,
                // the request will fail due to CORS/same-origin restrictions, so we skip it to avoid console errors.
                if (window.location.protocol.startsWith('http')) {
                    fetch('/api/products', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(newProduct)
                    }).catch(err => console.error('Failed to sync new service product', err));
                }
                // Save data without marking it dirty because this new service product will be synced via the delta mechanism.
                saveData(true);
                // Remove any duplicate products to keep the list clean
                removeDuplicateProducts();
                // Re-render products according to the current view mode instead of always switching to the grid view.
                const sortedAfterAddService = [...products].sort((a, b) => b.id - a.id);
                if (productViewMode === 'table') {
                    displayProductsTable(sortedAfterAddService);
                } else if (productViewMode === 'list') {
                    displayProductsList(sortedAfterAddService);
                } else {
                    displayProductsGrid(sortedAfterAddService);
                }
                // Update the view buttons to reflect the current mode
                updateViewButtons();
                // Refresh the scanner tab's product table so the new service appears
                displayScannerProductTable();
                // Close the add product modal
                closeAddProductModal();
                alert(`Produk jasa "${name}" berhasil ditambahkan!`);
                // Queue the new service product and immediately flush the queue.  Calling
                // processPendingDeltas() directly after enqueueing the delta avoids relying
                // on promise resolution semantics of sendDeltaToGoogleSheets(), which may
                // resolve immediately.  This ensures the change is sent to Google Sheets
                // without waiting for another user action.
                try {
                    sendDeltaToGoogleSheets('add', 'products', productToRow(newProduct));
                    // Flush queued deltas in silent mode so the UI is not blocked by a full overlay
                    processPendingDeltas(true);
                } catch (err) {
                    console.error('Auto sync failed:', err);
                }
                return;
            }

            // Regular product validation
            if (price < 0 || modalPrice < 0 || stock < 0) {
                alert('Harga dan stok tidak boleh negatif!');
                return;
            }

            if (modalPrice >= price) {
                alert('Harga modal harus lebih kecil dari harga jual!');
                return;
            }

            if (barcode && products.some(p => p.barcode === barcode)) {
                alert('Barcode sudah digunakan!');
                return;
            }

            const newProduct = {
                id: Date.now(),
                name: name,
                price: price,
                modalPrice: modalPrice,
                barcode: barcode || null,
                stock: stock,
                minStock: minStock,
                isService: false,
                wholesaleMinQty: wholesaleMinQty > 0 ? wholesaleMinQty : null,
                wholesalePrice: wholesalePrice > 0 ? wholesalePrice : null
            };

            products.push(newProduct);
            // Sync new product to server database so it persists across devices
            // Only attempt to sync when running over HTTP/HTTPS; skip when using the file protocol to avoid CORS errors
            if (window.location.protocol.startsWith('http')) {
                fetch('/api/products', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newProduct)
                }).catch(err => console.error('Failed to sync new product', err));
            }
            // Save data without marking it dirty because this new product will be synced via the delta mechanism.
            saveData(true);
            // Remove any duplicate products to keep the list tidy
            removeDuplicateProducts();
            // Re-render the product list according to the current view mode.  Using displaySavedProducts() would force
            // the grid view and disrupt the table/list view.
            const sortedAfterAddRegular = [...products].sort((a, b) => b.id - a.id);
            if (productViewMode === 'table') {
                displayProductsTable(sortedAfterAddRegular);
            } else if (productViewMode === 'list') {
                displayProductsList(sortedAfterAddRegular);
            } else {
                displayProductsGrid(sortedAfterAddRegular);
            }
            // Update view buttons to reflect the current mode
            updateViewButtons();
            // Refresh the scanner tab's product table so the new product appears
            displayScannerProductTable();
            // Close the add product modal
            closeAddProductModal();
            
            let message = `Produk "${name}" berhasil ditambahkan!`;
            if (wholesaleMinQty > 0 && wholesalePrice > 0) {
                message += `\n🏪 Harga grosir: ${formatCurrency(wholesalePrice)} (min ${wholesaleMinQty} pcs)`;
            }
            alert(message);
            // Queue the new product and immediately flush the queue.  By calling
            // processPendingDeltas() right after enqueueing, the update is sent
            // to Google Sheets without waiting for another operation to trigger
            // synchronisation.  The silent flag prevents the full‑screen overlay.
            try {
                sendDeltaToGoogleSheets('add', 'products', productToRow(newProduct));
                processPendingDeltas(true);
            } catch (err) {
                console.error('Auto sync failed:', err);
            }
        }

        // Edit product functions
        let editingProductId = null;

        function editProduct(productId) {
            const product = products.find(p => p.id === productId);
            if (!product) {
                alert('Produk tidak ditemukan!');
                return;
            }

            editingProductId = productId;
            
            // Fill form with current product data
            document.getElementById('editProductName').value = product.name;
            document.getElementById('editProductPrice').value = product.price;
            document.getElementById('editProductModalPrice').value = product.modalPrice || 0;
            document.getElementById('editProductBarcode').value = product.barcode || '';
            document.getElementById('editProductStock').value = product.stock;
            document.getElementById('editProductMinStock').value = product.minStock;
            document.getElementById('editProductWholesaleMinQty').value = product.wholesaleMinQty || '';
            document.getElementById('editProductWholesalePrice').value = product.wholesalePrice || '';

            // Show modal
            const editModal = document.getElementById('editProductModal');
            editModal.classList.remove('hidden');
            editModal.classList.add('flex');
            // Attach keyboard shortcuts: Enter saves edits, Escape cancels
            attachModalKeyHandlers(editModal, saveEditedProduct, closeEditProductModal);
        }

        function closeEditProductModal() {
            const editModal = document.getElementById('editProductModal');
            editModal.classList.add('hidden');
            editModal.classList.remove('flex');
            // Detach keyboard handlers when closing the edit modal
            detachModalKeyHandlers(editModal);
            editingProductId = null;
            
            // Clear form
            document.getElementById('editProductName').value = '';
            document.getElementById('editProductPrice').value = '';
            document.getElementById('editProductModalPrice').value = '';
            document.getElementById('editProductBarcode').value = '';
            document.getElementById('editProductStock').value = '';
            document.getElementById('editProductMinStock').value = '';
            document.getElementById('editProductWholesaleMinQty').value = '';
            document.getElementById('editProductWholesalePrice').value = '';
        }

        function saveEditedProduct() {
            if (!editingProductId) {
                alert('Error: Tidak ada produk yang sedang diedit!');
                return;
            }

            // Preserve the current product ID before it gets reset when the modal is closed.
            const currentId = editingProductId;

            const name = document.getElementById('editProductName').value.trim();
            const price = parseInt(document.getElementById('editProductPrice').value) || 0;
            const modalPrice = parseInt(document.getElementById('editProductModalPrice').value) || 0;
            const barcode = document.getElementById('editProductBarcode').value.trim();
            const stock = parseInt(document.getElementById('editProductStock').value) || 0;
            const minStock = parseInt(document.getElementById('editProductMinStock').value) || 5;
            const wholesaleMinQty = parseInt(document.getElementById('editProductWholesaleMinQty').value) || 0;
            const wholesalePrice = parseInt(document.getElementById('editProductWholesalePrice').value) || 0;

            if (!name || price <= 0 || modalPrice < 0 || stock < 0) {
                alert('Mohon isi semua field dengan benar!');
                return;
            }

            if (modalPrice >= price) {
                alert('Harga modal harus lebih kecil dari harga jual!');
                return;
            }

            // Validate wholesale pricing if provided
            if (wholesaleMinQty > 0 || wholesalePrice > 0) {
                if (wholesaleMinQty < 2) {
                    alert('Minimal quantity grosir harus minimal 2!');
                    return;
                }
                if (wholesalePrice <= 0) {
                    alert('Harga grosir harus diisi jika ada minimal quantity!');
                    return;
                }
                if (wholesalePrice >= price) {
                    alert('Harga grosir harus lebih kecil dari harga normal!');
                    return;
                }
                if (wholesalePrice <= modalPrice) {
                    alert('Harga grosir harus lebih besar dari harga modal!');
                    return;
                }
            }

            // Check if barcode is already used by another product
            if (barcode && products.some(p => p.barcode === barcode && p.id !== editingProductId)) {
                alert('Barcode sudah digunakan oleh produk lain!');
                return;
            }

            // Find and update the product
            const productIndex = products.findIndex(p => p.id === editingProductId);
            if (productIndex === -1) {
                alert('Produk tidak ditemukan!');
                return;
            }

            products[productIndex] = {
                ...products[productIndex],
                name: name,
                price: price,
                modalPrice: modalPrice,
                barcode: barcode || null,
                stock: stock,
                minStock: minStock,
                wholesaleMinQty: wholesaleMinQty > 0 ? wholesaleMinQty : null,
                wholesalePrice: wholesalePrice > 0 ? wholesalePrice : null
            };

            // Save data without marking it dirty because this edit will be synced via the delta mechanism.
            saveData(true);

            // Immediately queue an update delta and flush the queue before the editingProductId gets reset.
            try {
                const updatedProductForSync = products.find(p => p.id === currentId);
                if (updatedProductForSync) {
                    // Queue the update and then flush the pending deltas.  This avoids
                    // relying on promise chaining semantics of sendDeltaToGoogleSheets().
                    sendDeltaToGoogleSheets('update', 'products', productToRow(updatedProductForSync));
                    processPendingDeltas(true);
                }
            } catch (err) {
                console.error('Auto sync failed:', err);
            }
            // Refresh the product display according to the current view mode.  Using
            // displaySavedProducts() here would unconditionally render the grid
            // view, which disrupts the selected table or list view.  Instead we
            // choose the appropriate display function based on productViewMode.
            const sorted = [...products].sort((a, b) => b.id - a.id);
            if (productViewMode === 'table') {
                displayProductsTable(sorted);
            } else if (productViewMode === 'list') {
                displayProductsList(sorted);
            } else {
                displayProductsGrid(sorted);
            }
            // Update view buttons to reflect current mode after re-render
            updateViewButtons();
            // Refresh the scanner tab's cart table
            displayScannerProductTable();
            // Close the edit modal
            closeEditProductModal();

            let message = `Produk "${name}" berhasil diupdate!`;
            if (wholesaleMinQty > 0 && wholesalePrice > 0) {
                message += `\n🏪 Harga grosir: ${formatCurrency(wholesalePrice)} (min ${wholesaleMinQty} pcs)`;
            }
            alert(message);
            // (delta sync moved above to ensure editingProductId is still valid when queuing the delta)
        }

        function deleteProduct() {
            if (!editingProductId) {
                alert('Error: Tidak ada produk yang sedang diedit!');
                return;
            }

            const product = products.find(p => p.id === editingProductId);
            if (!product) {
                alert('Produk tidak ditemukan!');
                return;
            }

            // Use custom confirmation layer instead of native confirm()
            const confirmMessage = `Yakin ingin menghapus produk "${product.name}"?\n\nPerhatian: Data ini tidak dapat dikembalikan!`;
            showConfirmLayer(confirmMessage, function(confirmed) {
                if (!confirmed) return;
                // Remove product from array
                const productIndex = products.findIndex(p => p.id === editingProductId);
                if (productIndex !== -1) {
                    products.splice(productIndex, 1);
                    // Save the updated list to persistent storage without marking the data dirty,
                    // because this deletion will be synced via the delta mechanism.  Skipping
                    // markDataAsDirty() avoids triggering a full incremental sync that would
                    // duplicate the deletion on the next export.
                    saveData(true);
                    // After deleting a product, re-render the product list in the same
                    // view mode the user is currently using.  Previously this function
                    // always called displaySavedProducts() (grid view), which caused
                    // the layout to switch unexpectedly when a user was in table or
                    // list view.  Use productViewMode to determine which renderer to
                    // invoke and sort by ID descending to mimic grid ordering.
                    const sortedList = [...products].sort((a, b) => b.id - a.id);
                    if (productViewMode === 'table') {
                        displayProductsTable(sortedList);
                    } else if (productViewMode === 'list') {
                        displayProductsList(sortedList);
                    } else {
                        displaySavedProducts();
                    }
                    // Also update the scanner product table to remove the deleted
                    // product from quick-scan suggestions.
                    displayScannerProductTable();
                    // Capture the ID before it gets reset so we can sync deletion
                    const idToDelete = editingProductId;
                    // Close the edit modal (this will reset editingProductId)
                    closeEditProductModal();
                    alert(`Produk "${product.name}" berhasil dihapus!`);
                    // Sync deletion of this product to Google Sheets using the captured ID and
                    // immediately flush the pending queue in silent mode.  This ensures that
                    // the deletion is sent without showing the full‑screen loading overlay.
                    try {
                        // Enqueue the deletion delta
                        sendDeltaToGoogleSheets('delete', 'products', idToDelete);
                        // Immediately flush the queue so the row is removed from Google Sheets
                        processPendingDeltas(true);
                    } catch (err) {
                        console.error('Auto sync failed:', err);
                    }
                }
            });
        }

        // Unified Payment functions
        function showUnifiedPaymentModal() {
            if (cart.length === 0) {
                alert('Keranjang masih kosong!');
                return;
            }

            // Hitung total bayar dengan memperhitungkan diskon per item dan diskon global.
            let intermediateTotal = 0;
            cart.forEach(item => {
                const itemSubtotal = item.price * item.quantity;
                let itemDiscount = 0;
                if (item.discountType === 'percent') {
                    itemDiscount = itemSubtotal * (item.discountValue || 0) / 100;
                } else {
                    itemDiscount = item.discountValue || 0;
                }
                if (itemDiscount > itemSubtotal) itemDiscount = itemSubtotal;
                intermediateTotal += (itemSubtotal - itemDiscount);
            });
            const discountInputEl = document.getElementById('discountInput');
            const discountTypeEl = document.getElementById('discountType');
            const globalValue = discountInputEl ? parseInt(discountInputEl.value) || 0 : 0;
            const globalType = discountTypeEl ? discountTypeEl.value : 'percent';
            let globalAmount = 0;
            if (globalType === 'percent') {
                globalAmount = intermediateTotal * globalValue / 100;
            } else {
                globalAmount = globalValue;
            }
            if (globalAmount > intermediateTotal) globalAmount = intermediateTotal;
            const total = intermediateTotal - globalAmount;

            document.getElementById('unifiedPaymentTotal').textContent = formatCurrency(total);
            document.getElementById('unifiedPaymentAmount').value = '';
            document.getElementById('unifiedCustomerName').value = '';
            
            // Hide customer name section initially
            document.getElementById('customerNameSection').classList.add('hidden');
            
            // Reset payment status
            const statusContainer = document.getElementById('paymentStatusContainer');
            statusContainer.className = 'bg-gray-50 p-4 rounded-lg';
            document.getElementById('paymentStatusLabel').textContent = 'Status pembayaran:';
            document.getElementById('paymentStatusAmount').textContent = 'Masukkan jumlah bayar';
            document.getElementById('paymentStatusAmount').className = 'text-xl font-bold text-gray-600';
            document.getElementById('paymentStatusHint').textContent = '';
            
            const modal = document.getElementById('unifiedPaymentModal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            // Attach keyboard shortcuts: Enter processes payment, Escape cancels
            attachModalKeyHandlers(modal, processUnifiedPayment, closeUnifiedPaymentModal, ['unifiedPaymentAmount','unifiedCustomerName']);

            setTimeout(() => document.getElementById('unifiedPaymentAmount').focus(), 100);
        }

        function closeUnifiedPaymentModal() {
            const modal = document.getElementById('unifiedPaymentModal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            // Detach keyboard handlers when closing the unified payment modal
            detachModalKeyHandlers(modal);
        }

        function calculateUnifiedPayment() {
            // Hitung total dengan diskon per item + diskon global
            let intermediateTotal = 0;
            cart.forEach(item => {
                const itemSubtotal = item.price * item.quantity;
                let itemDiscount = 0;
                if (item.discountType === 'percent') {
                    itemDiscount = itemSubtotal * (item.discountValue || 0) / 100;
                } else {
                    itemDiscount = item.discountValue || 0;
                }
                if (itemDiscount > itemSubtotal) itemDiscount = itemSubtotal;
                intermediateTotal += (itemSubtotal - itemDiscount);
            });
            const discountInputEl = document.getElementById('discountInput');
            const discountTypeEl = document.getElementById('discountType');
            const globalValue = discountInputEl ? parseInt(discountInputEl.value) || 0 : 0;
            const globalType = discountTypeEl ? discountTypeEl.value : 'percent';
            let globalAmount = 0;
            if (globalType === 'percent') {
                globalAmount = intermediateTotal * globalValue / 100;
            } else {
                globalAmount = globalValue;
            }
            if (globalAmount > intermediateTotal) globalAmount = intermediateTotal;
            const total = intermediateTotal - globalAmount;
            const paid = parseInt(document.getElementById('unifiedPaymentAmount').value) || 0;
            
            const statusContainer = document.getElementById('paymentStatusContainer');
            const statusLabel = document.getElementById('paymentStatusLabel');
            const statusAmount = document.getElementById('paymentStatusAmount');
            const statusHint = document.getElementById('paymentStatusHint');
            const customerNameSection = document.getElementById('customerNameSection');
            
            if (paid === 0) {
                // No payment entered
                statusContainer.className = 'bg-gray-50 p-4 rounded-lg';
                statusLabel.textContent = 'Status pembayaran:';
                statusAmount.textContent = 'Masukkan jumlah bayar';
                statusAmount.className = 'text-xl font-bold text-gray-600';
                statusHint.textContent = '';
                customerNameSection.classList.add('hidden');
            } else if (paid < total) {
                // Insufficient payment - will be partial payment
                const debt = total - paid;
                const percentage = ((paid / total) * 100).toFixed(1);
                statusContainer.className = 'bg-red-50 p-4 rounded-lg';
                statusLabel.textContent = 'Kurang Bayar:';
                statusAmount.textContent = formatCurrency(debt);
                statusAmount.className = 'text-xl font-bold text-red-600';
                statusHint.textContent = `💡 Masih kurang ${formatCurrency(debt)} lagi`;
                statusHint.className = 'text-xs mt-1 text-red-600 font-medium';
                customerNameSection.classList.remove('hidden');
            } else if (paid === total) {
                // Exact payment
                statusContainer.className = 'bg-green-50 p-4 rounded-lg';
                statusLabel.textContent = 'Pembayaran:';
                statusAmount.textContent = 'PAS! 🎯';
                statusAmount.className = 'text-xl font-bold text-green-600';
                statusHint.textContent = '✅ Pembayaran tepat, tidak ada kembalian';
                statusHint.className = 'text-xs mt-1 text-green-600 font-medium';
                customerNameSection.classList.add('hidden');
            } else {
                // Overpayment - full payment with change
                const change = paid - total;
                statusContainer.className = 'bg-blue-50 p-4 rounded-lg';
                statusLabel.textContent = 'Kembalian:';
                statusAmount.textContent = formatCurrency(change);
                statusAmount.className = 'text-xl font-bold text-blue-600';
                statusHint.textContent = '💰 Kembalian untuk pelanggan';
                statusHint.className = 'text-xs mt-1 text-blue-600 font-medium';
                customerNameSection.classList.add('hidden');
            }
        }

        function handleUnifiedPaymentEnter(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                processUnifiedPayment();
            }
        }

        function processUnifiedPayment() {
            // Hitung subtotal awal, total diskon per item, subtotal setelah diskon item, kemudian diskon global
            let itemsSubtotal = 0;
            let itemsDiscountTotal = 0;
            let intermediateTotal = 0;
            cart.forEach(item => {
                const itemSubtotal = item.price * item.quantity;
                itemsSubtotal += itemSubtotal;
                let itemDiscount = 0;
                if (item.discountType === 'percent') {
                    itemDiscount = itemSubtotal * (item.discountValue || 0) / 100;
                } else {
                    itemDiscount = item.discountValue || 0;
                }
                if (itemDiscount > itemSubtotal) itemDiscount = itemSubtotal;
                itemsDiscountTotal += itemDiscount;
                intermediateTotal += (itemSubtotal - itemDiscount);
            });
            // Global discount
            const discountInputEl = document.getElementById('discountInput');
            const discountTypeEl = document.getElementById('discountType');
            const globalValue = discountInputEl ? parseInt(discountInputEl.value) || 0 : 0;
            const globalType = discountTypeEl ? discountTypeEl.value : 'percent';
            let globalAmount = 0;
            if (globalType === 'percent') {
                globalAmount = intermediateTotal * globalValue / 100;
            } else {
                globalAmount = globalValue;
            }
            if (globalAmount > intermediateTotal) globalAmount = intermediateTotal;
            const total = intermediateTotal - globalAmount;
            const paid = parseInt(document.getElementById('unifiedPaymentAmount').value) || 0;

            if (paid <= 0) {
                alert('Jumlah bayar harus lebih dari 0!');
                return;
            }

            if (paid < total) {
                // Partial payment - need customer name
                const customerName = document.getElementById('unifiedCustomerName').value.trim();
                if (!customerName) {
                    alert('Mohon isi nama pelanggan untuk pembayaran hutang!');
                    return;
                }
                processPartialPaymentUnified(itemsSubtotal, itemsDiscountTotal, intermediateTotal, globalValue, globalAmount, globalType, total, paid, customerName);
            } else {
                // Full payment (exact or with change)
                processFullPaymentUnified(itemsSubtotal, itemsDiscountTotal, intermediateTotal, globalValue, globalAmount, globalType, total, paid);
            }
        }

        function processFullPaymentUnified(itemsSubtotal, itemsDiscountTotal, intermediateSubtotal, globalDiscountValue, globalDiscountAmount, globalDiscountType, total, paid) {
            // Build a transaction object that includes item-level and global discount
            const transaction = {
                id: Date.now(),
                items: [...cart],
                // Total of all items before any discounts
                itemsSubtotal: itemsSubtotal,
                // Total discount applied on individual items
                itemsDiscountTotal: itemsDiscountTotal,
                // Subtotal after item discounts but before global discount
                subtotal: intermediateSubtotal,
                // For backward compatibility store global discount value and type like previous discount fields
                discount: globalDiscountValue,
                discountValue: globalDiscountValue,
                discountAmount: globalDiscountAmount,
                discountType: globalDiscountType,
                // Also keep named fields describing global discount
                globalDiscountValue: globalDiscountValue,
                globalDiscountAmount: globalDiscountAmount,
                globalDiscountType: globalDiscountType,
                total: total,
                paid: paid,
                change: paid - total,
                timestamp: new Date().toISOString(),
                type: 'full'
            };

            // Update stock
            cart.forEach(item => {
                const product = products.find(p => p.id === item.id);
                if (product) {
                    product.stock -= item.quantity;
                }
            });

            salesData.push(transaction);
            // Skip marking data as dirty because transaction and stock updates are synced via delta
            saveData(true);

            // Immediately sync the sale and updated product stocks to Google Sheets.  In the previous
            // implementation these calls lived inside the pendingFinalizeCallback, which meant
            // synchronisation only occurred after the user printed or closed the receipt preview.
            // If the preview was dismissed unexpectedly (e.g. by closing the tab) the updates were never
            // sent.  Moving the sync here ensures the sale and stock changes are queued for export
            // immediately after saving.
            try {
                // Send the new sale record
                sendDeltaToGoogleSheets('add', 'sales', saleToRow(transaction)).catch(err => console.error('Auto sync failed:', err));
                // Send stock updates for each purchased product
                transaction.items.forEach(item => {
                    const p = products.find(prod => prod.id === item.id);
                    if (p) {
                        sendDeltaToGoogleSheets('update', 'products', productToRow(p)).catch(err => console.error('Auto sync failed:', err));
                    }
                });
                // Process pending deltas immediately to ensure stock updates are flushed to Google Sheets
                processPendingDeltas();
            } catch (err) {
                console.error('Auto sync failed:', err);
            }

            // Instead of printing immediately, show a receipt preview.
            // Store a callback that will run after the user chooses to print or close the preview.
            pendingFinalizeCallback = function() {
                // Clear cart
                cart = [];
                updateCartDisplay();
                updateTotal();
                closeUnifiedPaymentModal();

                // Close cart automatically
                const floatingCart = document.getElementById('floatingCart');
                const cartToggle = document.getElementById('cartToggle');
                floatingCart.classList.add('hidden');
                cartToggle.classList.remove('hidden');

                // Show success message based on whether there is change
                if (paid === total) {
                    alert('Pembayaran berhasil! Pembayaran pas, tidak ada kembalian.');
                } else {
                    alert(`Pembayaran berhasil! Kembalian: ${formatCurrency(paid - total)}`);
                }
                displaySavedProducts(); // Refresh product display
                displayScannerProductTable(); // Refresh scanner table
                // Synchronisation has already been queued immediately after the data was saved.  Do not
                // send deltas again here to avoid duplicate updates.
            };
            showReceiptPreview(transaction);
            return;
        }

        function processPartialPaymentUnified(itemsSubtotal, itemsDiscountTotal, intermediateSubtotal, globalDiscountValue, globalDiscountAmount, globalDiscountType, total, paid, customerName) {
            const debt = total - paid;
            // Build transaction for partial payment including detailed discount fields
            const transaction = {
                id: Date.now(),
                items: [...cart],
                itemsSubtotal: itemsSubtotal,
                itemsDiscountTotal: itemsDiscountTotal,
                subtotal: intermediateSubtotal,
                // Compatibility fields for old discount reporting
                discount: globalDiscountValue,
                discountValue: globalDiscountValue,
                discountAmount: globalDiscountAmount,
                discountType: globalDiscountType,
                // Explicit global discount fields
                globalDiscountValue: globalDiscountValue,
                globalDiscountAmount: globalDiscountAmount,
                globalDiscountType: globalDiscountType,
                total: total,
                paid: paid,
                debt: debt,
                customerName: customerName,
                timestamp: new Date().toISOString(),
                type: 'partial'
            };

            // Update stock
            cart.forEach(item => {
                const product = products.find(p => p.id === item.id);
                if (product) {
                    product.stock -= item.quantity;
                }
            });

            // Add to debt data
            const existingDebt = debtData.find(d => d.customerName === customerName);
            if (existingDebt) {
                existingDebt.amount += debt;
                existingDebt.transactions.push({
                    id: transaction.id,
                    amount: debt,
                    date: new Date().toLocaleDateString('id-ID')
                });
            } else {
                debtData.push({
                    customerName: customerName,
                    amount: debt,
                    transactions: [{
                        id: transaction.id,
                        amount: debt,
                        date: new Date().toLocaleDateString('id-ID')
                    }]
                });
            }

            salesData.push(transaction);
            // Skip marking data as dirty because transaction and debt updates are synced via delta
            saveData(true);

            // Immediately sync the sale, product stock updates and updated debt record to Google Sheets.
            // Previously, these delta operations were performed in the pendingFinalizeCallback, which only
            // runs when the user closes or prints the receipt preview.  If the preview is closed
            // unexpectedly, the updates might never be sent.  By sending the deltas here we ensure
            // consistency even if the UI actions are interrupted.
            try {
                // Send the new sale record
                sendDeltaToGoogleSheets('add', 'sales', saleToRow(transaction)).catch(err => console.error('Auto sync failed:', err));
                // Send stock updates for each purchased product
                transaction.items.forEach(item => {
                    const p = products.find(prod => prod.id === item.id);
                    if (p) {
                        sendDeltaToGoogleSheets('update', 'products', productToRow(p)).catch(err => console.error('Auto sync failed:', err));
                    }
                });
                // Send the updated debt record
                const debtRecordImmediate = debtData.find(d => d.customerName === customerName);
                if (debtRecordImmediate) {
                    sendDeltaToGoogleSheets('update', 'debts', debtToRow(debtRecordImmediate)).catch(err => console.error('Auto sync failed:', err));
                }
                // Flush all queued deltas immediately so stock and debt updates are written to Google Sheets
                processPendingDeltas();
            } catch (err) {
                console.error('Auto sync failed:', err);
            }

            // Instead of printing immediately, show a receipt preview.
            // Store a callback that will run after the user chooses to print or close the preview.
            pendingFinalizeCallback = function() {
                // Clear cart
                cart = [];
                updateCartDisplay();
                updateTotal();
                closeUnifiedPaymentModal();

                // Close cart automatically
                const floatingCart = document.getElementById('floatingCart');
                const cartToggle = document.getElementById('cartToggle');
                floatingCart.classList.add('hidden');
                cartToggle.classList.remove('hidden');

                alert(`Transaksi berhasil! Hutang ${customerName}: ${formatCurrency(debt)}`);
                displaySavedProducts(); // Refresh product display
                displayScannerProductTable(); // Refresh scanner table
                // Synchronisation has already been queued immediately after the data was saved.  Do not
                // send deltas again here to avoid duplicate updates.
            };
            showReceiptPreview(transaction);
            return;
        }

        function handlePaymentEnter(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                processPayment();
            }
        }

        function handlePartialPaymentEnter(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                processPartialPayment();
            }
        }

        function handleDebtPaymentEnter(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                processDebtPayment();
            }
        }

        function showPartialPaymentModal() {
            if (cart.length === 0) {
                alert('Keranjang masih kosong!');
                return;
            }

            const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const discount = parseInt(document.getElementById('discountInput').value) || 0;
            const total = subtotal - (subtotal * discount / 100);

            document.getElementById('partialTotal').textContent = formatCurrency(total);
            document.getElementById('customerName').value = '';
            document.getElementById('partialAmount').value = '';
            document.getElementById('debtAmount').textContent = formatCurrency(total);
            
            const modal = document.getElementById('partialPaymentModal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            // Attach keyboard shortcuts: Enter processes partial payment, Esc cancels
            attachModalKeyHandlers(modal, processPartialPayment, closePartialPaymentModal, ['partialAmount','customerName']);
        }

        function closePartialPaymentModal() {
            const modal = document.getElementById('partialPaymentModal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            // Detach keyboard handlers when closing the partial payment modal
            detachModalKeyHandlers(modal);
        }

        function calculatePartialDebt() {
            const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const discount = parseInt(document.getElementById('discountInput').value) || 0;
            const total = subtotal - (subtotal * discount / 100);
            const paid = parseInt(document.getElementById('partialAmount').value) || 0;
            const difference = total - paid;
            
            const debtContainer = document.getElementById('debtContainer');
            const debtLabel = document.getElementById('debtLabel');
            const debtAmount = document.getElementById('debtAmount');
            const debtStatus = document.getElementById('debtStatus');
            
            if (paid === 0) {
                // No payment entered
                debtContainer.className = 'bg-red-50 p-4 rounded-lg';
                debtLabel.textContent = 'Sisa hutang:';
                debtAmount.textContent = formatCurrency(total);
                debtAmount.className = 'text-xl font-bold text-red-600';
                debtStatus.textContent = '';
            } else if (paid >= total) {
                // Full payment or overpayment
                debtContainer.className = 'bg-green-50 p-4 rounded-lg';
                debtLabel.textContent = 'Status:';
                debtAmount.textContent = 'LUNAS! ✅';
                debtAmount.className = 'text-xl font-bold text-green-600';
                if (paid > total) {
                    debtStatus.textContent = `💰 Kembalian: ${formatCurrency(paid - total)}`;
                    debtStatus.className = 'text-xs mt-1 text-green-600 font-medium';
                } else {
                    debtStatus.textContent = '🎯 Pembayaran tepat, tidak ada hutang';
                    debtStatus.className = 'text-xs mt-1 text-green-600 font-medium';
                }
            } else {
                // Partial payment
                const debt = difference;
                const percentage = ((paid / total) * 100).toFixed(1);
                debtContainer.className = 'bg-orange-50 p-4 rounded-lg';
                debtLabel.textContent = 'Sisa hutang:';
                debtAmount.textContent = formatCurrency(debt);
                debtAmount.className = 'text-xl font-bold text-orange-600';
                debtStatus.textContent = `💳 Sudah bayar ${percentage}% (${formatCurrency(paid)})`;
                debtStatus.className = 'text-xs mt-1 text-orange-600 font-medium';
            }
        }

        function processPartialPayment() {
            const customerName = document.getElementById('customerName').value.trim();
            const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const discount = parseInt(document.getElementById('discountInput').value) || 0;
            const total = subtotal - (subtotal * discount / 100);
            const paid = parseInt(document.getElementById('partialAmount').value) || 0;
            const debt = total - paid;

            if (!customerName) {
                alert('Mohon isi nama pelanggan!');
                return;
            }

            if (paid <= 0 || paid >= total) {
                alert('Jumlah bayar tidak valid!');
                return;
            }

            const transaction = {
                id: Date.now(),
                items: [...cart],
                subtotal: subtotal,
                discount: discount,
                total: total,
                paid: paid,
                debt: debt,
                customerName: customerName,
                timestamp: new Date().toISOString(),
                type: 'partial'
            };

            // Update stock
            cart.forEach(item => {
                const product = products.find(p => p.id === item.id);
                if (product) {
                    product.stock -= item.quantity;
                }
            });

            // Add to debt data
            const existingDebt = debtData.find(d => d.customerName === customerName);
            if (existingDebt) {
                existingDebt.amount += debt;
                existingDebt.transactions.push({
                    id: transaction.id,
                    amount: debt,
                    date: new Date().toLocaleDateString('id-ID')
                });
            } else {
                debtData.push({
                    customerName: customerName,
                    amount: debt,
                    transactions: [{
                        id: transaction.id,
                        amount: debt,
                        date: new Date().toLocaleDateString('id-ID')
                    }]
                });
            }

            salesData.push(transaction);
            // Skip marking data as dirty because transaction and debt updates are synced via delta
            saveData(true);

            // Immediately sync the sale, product stock updates and updated debt record to Google Sheets.
            // Without this, the old implementation relied on the user to close the receipt preview
            // before deltas were sent, which could result in unsynchronised stock or debt data if
            // the preview was never finalised.  Sending deltas here ensures consistency.
            try {
                // Send the new sale record
                sendDeltaToGoogleSheets('add', 'sales', saleToRow(transaction)).catch(err => console.error('Auto sync failed:', err));
                // Send stock updates for each purchased product
                transaction.items.forEach(item => {
                    const p = products.find(prod => prod.id === item.id);
                    if (p) {
                        sendDeltaToGoogleSheets('update', 'products', productToRow(p)).catch(err => console.error('Auto sync failed:', err));
                    }
                });
                // Send the updated debt record
                const debtRecordImmediate = debtData.find(d => d.customerName === customerName);
                if (debtRecordImmediate) {
                    sendDeltaToGoogleSheets('update', 'debts', debtToRow(debtRecordImmediate)).catch(err => console.error('Auto sync failed:', err));
                }
                // Immediately process any queued deltas so they are sent without waiting for a full sync
                processPendingDeltas();
            } catch (err) {
                console.error('Auto sync failed:', err);
            }

            // Instead of printing immediately, show a receipt preview.
            // Store a callback that will run after the user chooses to print or close the preview.
            pendingFinalizeCallback = function() {
                // Clear cart
                cart = [];
                updateCartDisplay();
                updateTotal();
                closePartialPaymentModal();

                // Close cart automatically
                const floatingCart = document.getElementById('floatingCart');
                const cartToggle = document.getElementById('cartToggle');
                floatingCart.classList.add('hidden');
                cartToggle.classList.remove('hidden');

                alert(`Transaksi berhasil! Hutang ${customerName}: ${formatCurrency(debt)}`);
                displaySavedProducts(); // Refresh product display
                displayScannerProductTable(); // Refresh scanner table
            };
            showReceiptPreview(transaction);
            return;
        }

        // Transaction history
        function displayTransactionHistory() {
            const container = document.getElementById('transactionHistory');
            
            if (salesData.length === 0) {
                container.innerHTML = '<div class="text-center text-gray-500 py-8">Belum ada transaksi</div>';
                return;
            }

            const sortedTransactions = [...salesData].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            container.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="w-full bg-white border border-gray-200 rounded-lg">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">ID Transaksi</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Tanggal</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Pelanggan</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Item</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Total</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Bayar</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Status</th>
                                <th class="px-4 py-3 text-center font-semibold text-gray-700">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sortedTransactions.map(transaction => {
                                const date = new Date(transaction.timestamp);
                                const isPartial = transaction.type === 'partial';
                                const isDebtPayment = transaction.type === 'debt_payment';
                                
                                if (isDebtPayment) {
                                    return `
                                        <tr class="border-b border-gray-100 hover:bg-blue-50">
                                            <td class="px-4 py-3 font-mono text-sm">${transaction.id}</td>
                                            <td class="px-4 py-3 text-sm">${date.toLocaleDateString('id-ID')}<br><span class="text-xs text-gray-500">${date.toLocaleTimeString('id-ID')}</span></td>
                                            <td class="px-4 py-3 text-sm font-semibold text-blue-600">${transaction.customerName}</td>
                                            <td class="px-4 py-3 text-sm text-blue-600">Pembayaran Hutang</td>
                                            <td class="px-4 py-3 text-right font-semibold text-blue-600">${formatCurrency(transaction.total ?? transaction.paid ?? transaction.amount ?? 0)}</td>
                                            <td class="px-4 py-3 text-right font-semibold text-blue-600">${formatCurrency(transaction.paid ?? transaction.total ?? transaction.amount ?? 0)}</td>
                                            <td class="px-4 py-3 text-right">
                                                <span class="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-semibold">
                                                    💰 Cicilan
                                                </span>
                                                ${((transaction.remainingDebt ?? transaction.debt) > 0) ? `<br><span class="text-xs text-red-600">Sisa: ${formatCurrency(transaction.remainingDebt ?? transaction.debt)}</span>` : '<br><span class="text-xs text-green-600">Lunas</span>'}
                                            </td>
                                            <td class="px-4 py-3 text-center">
                                                <button onclick="printDebtPaymentReceipt(${JSON.stringify(transaction).replace(/"/g, '&quot;')})" 
                                                        class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs">
                                                    🖨️
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                }
                                
                                return `
                                    <tr class="border-b border-gray-100 hover:bg-gray-50">
                                        <td class="px-4 py-3 font-mono text-sm">${transaction.id}</td>
                                        <td class="px-4 py-3 text-sm">${date.toLocaleDateString('id-ID')}<br><span class="text-xs text-gray-500">${date.toLocaleTimeString('id-ID')}</span></td>
                                        <td class="px-4 py-3 text-sm ${isPartial ? 'font-semibold text-orange-600' : 'text-gray-500'}">
                                            ${isPartial ? transaction.customerName : 'Umum'}
                                        </td>
                                        <td class="px-4 py-3 text-sm">
                                            <div class="max-w-xs">
                                                ${transaction.items ? transaction.items.map(item => `${item.name} (${item.quantity}x)`).join(', ') : 'N/A'}
                                            </div>
                                            <div class="text-xs text-gray-500 mt-1">${transaction.items ? transaction.items.length : 0} item(s)</div>
                                        </td>
                                        <td class="px-4 py-3 text-right font-semibold ${isPartial ? 'text-orange-600' : 'text-green-600'}">
                                            ${formatCurrency(transaction.total || 0)}
                                        </td>
                                        <td class="px-4 py-3 text-right font-semibold text-blue-600">
                                            ${formatCurrency(transaction.paid || 0)}
                                        </td>
                                        <td class="px-4 py-3 text-right">
                                            ${isPartial ? 
                                                `<span class="bg-orange-100 text-orange-800 px-2 py-1 rounded-full text-xs font-semibold">💳 Hutang</span><br><span class="text-xs text-red-600">Sisa: ${formatCurrency(transaction.debt || 0)}</span>` :
                                                `<span class="bg-green-100 text-green-800 px-2 py-1 rounded-full text-xs font-semibold">✅ Lunas</span><br><span class="text-xs text-green-600">Kembalian: ${formatCurrency(transaction.change || 0)}</span>`
                                            }
                                        </td>
                                        <td class="px-4 py-3 text-center">
                                            <button onclick="printThermalReceipt(${JSON.stringify(transaction).replace(/"/g, '&quot;')})" 
                                                    class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs">
                                                🖨️
                                            </button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        function filterTransactionHistory() {
            const filter = document.getElementById('historyFilter').value;
            const now = new Date();
            let filtered = [...salesData];

            switch (filter) {
                case 'today':
                    filtered = salesData.filter(t => {
                        const transactionDate = new Date(t.timestamp);
                        return transactionDate.toDateString() === now.toDateString();
                    });
                    break;
                case 'week':
                    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    filtered = salesData.filter(t => new Date(t.timestamp) >= weekAgo);
                    break;
                case 'month':
                    const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
                    filtered = salesData.filter(t => new Date(t.timestamp) >= monthAgo);
                    break;
                case 'full':
                    filtered = salesData.filter(t => t.type === 'full');
                    break;
                case 'partial':
                    filtered = salesData.filter(t => t.type === 'partial');
                    break;
            }

            const container = document.getElementById('transactionHistory');
            
            if (filtered.length === 0) {
                container.innerHTML = '<div class="text-center text-gray-500 py-8">Tidak ada transaksi ditemukan</div>';
                return;
            }

            const sortedTransactions = filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            container.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="w-full bg-white border border-gray-200 rounded-lg">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">ID Transaksi</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Tanggal</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Pelanggan</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Item</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Total</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Bayar</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Status</th>
                                <th class="px-4 py-3 text-center font-semibold text-gray-700">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sortedTransactions.map(transaction => {
                                const date = new Date(transaction.timestamp);
                                const isPartial = transaction.type === 'partial';
                                const isDebtPayment = transaction.type === 'debt_payment';
                                
                                if (isDebtPayment) {
                                    return `
                                        <tr class="border-b border-gray-100 hover:bg-blue-50">
                                            <td class="px-4 py-3 font-mono text-sm">${transaction.id}</td>
                                            <td class="px-4 py-3 text-sm">${date.toLocaleDateString('id-ID')}<br><span class="text-xs text-gray-500">${date.toLocaleTimeString('id-ID')}</span></td>
                                            <td class="px-4 py-3 text-sm font-semibold text-blue-600">${transaction.customerName}</td>
                                            <td class="px-4 py-3 text-sm text-blue-600">Pembayaran Hutang</td>
                                            <td class="px-4 py-3 text-right font-semibold text-blue-600">${formatCurrency(transaction.total ?? transaction.paid ?? transaction.amount ?? 0)}</td>
                                            <td class="px-4 py-3 text-right font-semibold text-blue-600">${formatCurrency(transaction.paid ?? transaction.total ?? transaction.amount ?? 0)}</td>
                                            <td class="px-4 py-3 text-right">
                                                <span class="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-semibold">
                                                    💰 Cicilan
                                                </span>
                                                ${((transaction.remainingDebt ?? transaction.debt) > 0) ? `<br><span class="text-xs text-red-600">Sisa: ${formatCurrency(transaction.remainingDebt ?? transaction.debt)}</span>` : '<br><span class="text-xs text-green-600">Lunas</span>'}
                                            </td>
                                            <td class="px-4 py-3 text-center">
                                                <button onclick="printDebtPaymentReceipt(${JSON.stringify(transaction).replace(/"/g, '&quot;')})" 
                                                        class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs">
                                                    🖨️
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                }
                                
                                return `
                                    <tr class="border-b border-gray-100 hover:bg-gray-50">
                                        <td class="px-4 py-3 font-mono text-sm">${transaction.id}</td>
                                        <td class="px-4 py-3 text-sm">${date.toLocaleDateString('id-ID')}<br><span class="text-xs text-gray-500">${date.toLocaleTimeString('id-ID')}</span></td>
                                        <td class="px-4 py-3 text-sm ${isPartial ? 'font-semibold text-orange-600' : 'text-gray-500'}">
                                            ${isPartial ? transaction.customerName : 'Umum'}
                                        </td>
                                        <td class="px-4 py-3 text-sm">
                                            <div class="max-w-xs">
                                                ${transaction.items ? transaction.items.map(item => `${item.name} (${item.quantity}x)`).join(', ') : 'N/A'}
                                            </div>
                                            <div class="text-xs text-gray-500 mt-1">${transaction.items ? transaction.items.length : 0} item(s)</div>
                                        </td>
                                        <td class="px-4 py-3 text-right font-semibold ${isPartial ? 'text-orange-600' : 'text-green-600'}">
                                            ${formatCurrency(transaction.total || 0)}
                                        </td>
                                        <td class="px-4 py-3 text-right font-semibold text-blue-600">
                                            ${formatCurrency(transaction.paid || 0)}
                                        </td>
                                        <td class="px-4 py-3 text-right">
                                            ${isPartial ? 
                                                `<span class="bg-orange-100 text-orange-800 px-2 py-1 rounded-full text-xs font-semibold">💳 Hutang</span><br><span class="text-xs text-red-600">Sisa: ${formatCurrency(transaction.debt || 0)}</span>` :
                                                `<span class="bg-green-100 text-green-800 px-2 py-1 rounded-full text-xs font-semibold">✅ Lunas</span><br><span class="text-xs text-green-600">Kembalian: ${formatCurrency(transaction.change || 0)}</span>`
                                            }
                                        </td>
                                        <td class="px-4 py-3 text-center">
                                            <button onclick="printThermalReceipt(${JSON.stringify(transaction).replace(/"/g, '&quot;')})" 
                                                    class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs">
                                                🖨️
                                            </button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        function searchTransactionHistory(searchTerm) {
            if (!searchTerm.trim()) {
                displayTransactionHistory();
                return;
            }

            const filtered = salesData.filter(transaction => 
                transaction.id.toString().includes(searchTerm) ||
                (transaction.customerName && transaction.customerName.toLowerCase().includes(searchTerm.toLowerCase())) ||
                (transaction.items && transaction.items.some(item => item.name.toLowerCase().includes(searchTerm.toLowerCase())))
            );

            const container = document.getElementById('transactionHistory');
            
            if (filtered.length === 0) {
                container.innerHTML = '<div class="text-center text-gray-500 py-8">Tidak ada transaksi ditemukan</div>';
                return;
            }

            const sortedTransactions = filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            container.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="w-full bg-white border border-gray-200 rounded-lg">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">ID Transaksi</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Tanggal</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Pelanggan</th>
                                <th class="px-4 py-3 text-left font-semibold text-gray-700">Item</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Total</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Bayar</th>
                                <th class="px-4 py-3 text-right font-semibold text-gray-700">Status</th>
                                <th class="px-4 py-3 text-center font-semibold text-gray-700">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sortedTransactions.map(transaction => {
                                const date = new Date(transaction.timestamp);
                                const isPartial = transaction.type === 'partial';
                                const isDebtPayment = transaction.type === 'debt_payment';
                                
                                if (isDebtPayment) {
                                    return `
                                        <tr class="border-b border-gray-100 hover:bg-blue-50">
                                            <td class="px-4 py-3 font-mono text-sm">${transaction.id}</td>
                                            <td class="px-4 py-3 text-sm">${date.toLocaleDateString('id-ID')}<br><span class="text-xs text-gray-500">${date.toLocaleTimeString('id-ID')}</span></td>
                                            <td class="px-4 py-3 text-sm font-semibold text-blue-600">${transaction.customerName}</td>
                                            <td class="px-4 py-3 text-sm text-blue-600">Pembayaran Hutang</td>
                                            <td class="px-4 py-3 text-right font-semibold text-blue-600">${formatCurrency(transaction.total ?? transaction.paid ?? transaction.amount ?? 0)}</td>
                                            <td class="px-4 py-3 text-right font-semibold text-blue-600">${formatCurrency(transaction.paid ?? transaction.total ?? transaction.amount ?? 0)}</td>
                                            <td class="px-4 py-3 text-right">
                                                <span class="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-semibold">
                                                    💰 Cicilan
                                                </span>
                                                ${((transaction.remainingDebt ?? transaction.debt) > 0) ? `<br><span class="text-xs text-red-600">Sisa: ${formatCurrency(transaction.remainingDebt ?? transaction.debt)}</span>` : '<br><span class="text-xs text-green-600">Lunas</span>'}
                                            </td>
                                            <td class="px-4 py-3 text-center">
                                                <button onclick="printDebtPaymentReceipt(${JSON.stringify(transaction).replace(/"/g, '&quot;')})" 
                                                        class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs">
                                                    🖨️
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                }
                                
                                return `
                                    <tr class="border-b border-gray-100 hover:bg-gray-50">
                                        <td class="px-4 py-3 font-mono text-sm">${transaction.id}</td>
                                        <td class="px-4 py-3 text-sm">${date.toLocaleDateString('id-ID')}<br><span class="text-xs text-gray-500">${date.toLocaleTimeString('id-ID')}</span></td>
                                        <td class="px-4 py-3 text-sm ${isPartial ? 'font-semibold text-orange-600' : 'text-gray-500'}">
                                            ${isPartial ? transaction.customerName : 'Umum'}
                                        </td>
                                        <td class="px-4 py-3 text-sm">
                                            <div class="max-w-xs">
                                                ${transaction.items ? transaction.items.map(item => `${item.name} (${item.quantity}x)`).join(', ') : 'N/A'}
                                            </div>
                                            <div class="text-xs text-gray-500 mt-1">${transaction.items ? transaction.items.length : 0} item(s)</div>
                                        </td>
                                        <td class="px-4 py-3 text-right font-semibold ${isPartial ? 'text-orange-600' : 'text-green-600'}">
                                            ${formatCurrency(transaction.total || 0)}
                                        </td>
                                        <td class="px-4 py-3 text-right font-semibold text-blue-600">
                                            ${formatCurrency(transaction.paid || 0)}
                                        </td>
                                        <td class="px-4 py-3 text-right">
                                            ${isPartial ? 
                                                `<span class="bg-orange-100 text-orange-800 px-2 py-1 rounded-full text-xs font-semibold">💳 Hutang</span><br><span class="text-xs text-red-600">Sisa: ${formatCurrency(transaction.debt || 0)}</span>` :
                                                `<span class="bg-green-100 text-green-800 px-2 py-1 rounded-full text-xs font-semibold">✅ Lunas</span><br><span class="text-xs text-green-600">Kembalian: ${formatCurrency(transaction.change || 0)}</span>`
                                            }
                                        </td>
                                        <td class="px-4 py-3 text-center">
                                            <button onclick="printThermalReceipt(${JSON.stringify(transaction).replace(/"/g, '&quot;')})" 
                                                    class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs">
                                                🖨️
                                            </button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        // Analysis functions
        function updateAnalysis() {
            const today = new Date();
            // If there are no transactions for today but there is historical data,
            // automatically show a broader period instead of leaving the analysis empty.  This
            // improves the user experience by displaying meaningful statistics when data
            // exists but not for the current day.
            if (Array.isArray(salesData) && salesData.length > 0) {
                const hasToday = salesData.some(t => {
                    if (!t || !t.timestamp) return false;
                    const transactionDate = new Date(t.timestamp);
                    return transactionDate.toDateString() === today.toDateString();
                });
                if (!hasToday) {
                    // Default to showing all transactions when no sales exist for today.
                    filterAnalysis('all');
                    return;
                }
            }
            const todayTransactions = salesData.filter(t => {
                if (!t.timestamp) return false;
                const transactionDate = new Date(t.timestamp);
                return transactionDate.toDateString() === today.toDateString();
            });

            let totalRevenue = 0;
            let totalModal = 0;
            let transactionCount = 0;

            todayTransactions.forEach(transaction => {
                if (transaction.total && !isNaN(transaction.total)) {
                    totalRevenue += transaction.total;
                    transactionCount++;
                }
                
                if (transaction.items && Array.isArray(transaction.items)) {
                    transaction.items.forEach(item => {
                        // Determine modal/cost price: prefer per-item modalPrice (for services), else fall back to product modalPrice
                        let costPrice = 0;
                        if (item.modalPrice && !isNaN(item.modalPrice)) {
                            costPrice = item.modalPrice;
                        } else {
                            const product = products.find(p => p.id === item.id);
                            if (product && product.modalPrice && !isNaN(product.modalPrice)) {
                                costPrice = product.modalPrice;
                            }
                        }
                        if (!isNaN(costPrice) && costPrice >= 0 && item.quantity && !isNaN(item.quantity)) {
                            totalModal += costPrice * item.quantity;
                        }
                    });
                }
            });

            const grossProfit = totalRevenue - totalModal;
            const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue * 100) : 0;
            const roi = totalModal > 0 ? (grossProfit / totalModal * 100) : 0;

            document.getElementById('totalRevenue').textContent = formatCurrency(totalRevenue);
            document.getElementById('revenueCount').textContent = `${transactionCount} transaksi`;
            document.getElementById('totalModal').textContent = formatCurrency(totalModal);
            document.getElementById('grossProfit').textContent = formatCurrency(grossProfit);
            document.getElementById('profitMargin').textContent = `${profitMargin.toFixed(1)}% margin`;
            document.getElementById('roi').textContent = `${roi.toFixed(1)}%`;
            // Compute and display the sedekah amount.  Sedekah is defined as
            // 2.5% of the gross profit for the current period.  Ensure that the
            // value does not become negative if gross profit is negative.  Use
            // Math.max() to clamp at zero.  Display the result using
            // formatCurrency() for consistency with other monetary values.
            {
                const sedekah = Math.max(grossProfit * 0.025, 0);
                const sedekahEl = document.getElementById('sedekahAmount');
                if (sedekahEl) {
                    sedekahEl.textContent = formatCurrency(sedekah);
                }
            }

            updateProductAnalysisTable(todayTransactions);

            // Reset analysis date offset and show navigation controls for the default 'Hari Ini' view.
            // When users switch to the Analysis tab without selecting a custom period, we want them to
            // immediately see the navigation for previous/next day.  Setting analysisDateOffset to 0
            // ensures that the next call to updateAnalysis() behaves like a fresh 'today' filter.
            analysisDateOffset = 0;
            toggleAnalysisNavigation(true);
            const navLabel = document.getElementById('analysisDateLabel');
            if (navLabel) {
                navLabel.textContent = formatDateForLabel(new Date());
            }
            // Highlight the 'Hari Ini' button as active by default
            ['filterToday', 'filterWeek', 'filterMonth', 'filterAll'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.classList.remove('bg-green-500', 'text-white');
                    btn.classList.add('bg-gray-300', 'text-gray-700');
                }
            });
            const todayBtn2 = document.getElementById('filterToday');
            if (todayBtn2) {
                todayBtn2.classList.remove('bg-gray-300', 'text-gray-700');
                todayBtn2.classList.add('bg-green-500', 'text-white');
            }
        }

        function updateProductAnalysisTable(transactions) {
            const productStats = {};

            transactions.forEach(transaction => {
                if (transaction.items && Array.isArray(transaction.items)) {
                    transaction.items.forEach(item => {
                        if (!item.id || !item.name || !item.price || !item.quantity) return;
                        
                        // Determine cost price for this item (either per-item modalPrice for services or product.modalPrice)
                        const product = products.find(p => p.id === item.id);
                        const costPrice = (item.modalPrice && !isNaN(item.modalPrice)) ? item.modalPrice :
                                          (product && product.modalPrice && !isNaN(product.modalPrice)) ? product.modalPrice : 0;

                        if (!productStats[item.id]) {
                            productStats[item.id] = {
                                name: item.name,
                                sold: 0,
                                revenue: 0,
                                modal: 0,
                                modalPrice: costPrice
                            };
                        }

                        if (!isNaN(item.quantity) && !isNaN(item.price)) {
                            productStats[item.id].sold += item.quantity;
                            productStats[item.id].revenue += item.price * item.quantity;
                            productStats[item.id].modal += costPrice * item.quantity;
                        }
                    });
                }
            });

            const tableBody = document.getElementById('productAnalysisTable');
            
            if (Object.keys(productStats).length === 0) {
                tableBody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-gray-500">Belum ada data penjualan</td></tr>';
                return;
            }

            tableBody.innerHTML = Object.values(productStats).map(stat => {
                const profit = stat.revenue - stat.modal;
                const margin = stat.revenue > 0 ? (profit / stat.revenue * 100) : 0;
                const marginClass = margin > 50 ? 'text-green-600' : margin > 25 ? 'text-yellow-600' : 'text-red-600';
                
                return `
                    <tr class="border-b border-gray-100">
                        <td class="px-4 py-3 font-medium">${stat.name}</td>
                        <td class="px-4 py-3 text-right">${stat.sold}</td>
                        <td class="px-4 py-3 text-right font-semibold text-green-600">${formatCurrency(stat.revenue)}</td>
                        <td class="px-4 py-3 text-right text-red-600">${formatCurrency(stat.modal)}</td>
                        <td class="px-4 py-3 text-right font-semibold text-blue-600">${formatCurrency(profit)}</td>
                        <td class="px-4 py-3 text-right font-semibold ${marginClass}">${margin.toFixed(1)}%</td>
                    </tr>
                `;
            }).join('');
        }

        function filterAnalysis(period) {
            // Update button styles
            ['filterToday', 'filterWeek', 'filterMonth', 'filterAll'].forEach(id => {
                const btn = document.getElementById(id);
                btn.classList.remove('bg-green-500', 'text-white');
                btn.classList.add('bg-gray-300', 'text-gray-700');
            });
            
            document.getElementById('filter' + period.charAt(0).toUpperCase() + period.slice(1)).classList.remove('bg-gray-300', 'text-gray-700');
            document.getElementById('filter' + period.charAt(0).toUpperCase() + period.slice(1)).classList.add('bg-green-500', 'text-white');

            // Reset the analysis date offset whenever a period filter is selected.
            // Show or hide the previous/next day navigation controls depending on whether
            // the user chose the 'today' filter.  Update the navigation label to today's date.
            analysisDateOffset = 0;
            if (period === 'today') {
                toggleAnalysisNavigation(true);
                const label = document.getElementById('analysisDateLabel');
                if (label) {
                    label.textContent = formatDateForLabel(new Date());
                }
            } else {
                toggleAnalysisNavigation(false);
            }

            const now = new Date();
            let filteredTransactions = [];

            switch (period) {
                case 'today':
                    filteredTransactions = salesData.filter(t => {
                        const transactionDate = new Date(t.timestamp);
                        return transactionDate.toDateString() === now.toDateString();
                    });
                    break;
                case 'week':
                    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    filteredTransactions = salesData.filter(t => new Date(t.timestamp) >= weekAgo);
                    break;
                case 'month':
                    const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
                    filteredTransactions = salesData.filter(t => new Date(t.timestamp) >= monthAgo);
                    break;
                case 'all':
                    filteredTransactions = [...salesData];
                    break;
            }

            let totalRevenue = 0;
            let totalModal = 0;
            let transactionCount = filteredTransactions.length;

            filteredTransactions.forEach(transaction => {
                if (transaction.total && !isNaN(transaction.total)) {
                    totalRevenue += transaction.total;
                }
                
                if (transaction.items && Array.isArray(transaction.items)) {
                    transaction.items.forEach(item => {
                        // Determine modal/cost price: prefer per-item modalPrice (for services), else fall back to product modalPrice
                        let costPrice = 0;
                        if (item.modalPrice && !isNaN(item.modalPrice)) {
                            costPrice = item.modalPrice;
                        } else {
                            const product = products.find(p => p.id === item.id);
                            if (product && product.modalPrice && !isNaN(product.modalPrice)) {
                                costPrice = product.modalPrice;
                            }
                        }
                        if (!isNaN(costPrice) && costPrice >= 0 && item.quantity && !isNaN(item.quantity)) {
                            totalModal += costPrice * item.quantity;
                        }
                    });
                }
            });

            const grossProfit = totalRevenue - totalModal;
            const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue * 100) : 0;
            const roi = totalModal > 0 ? (grossProfit / totalModal * 100) : 0;

            document.getElementById('totalRevenue').textContent = formatCurrency(totalRevenue);
            document.getElementById('revenueCount').textContent = `${transactionCount} transaksi`;
            document.getElementById('totalModal').textContent = formatCurrency(totalModal);
            document.getElementById('grossProfit').textContent = formatCurrency(grossProfit);
            document.getElementById('profitMargin').textContent = `${profitMargin.toFixed(1)}% margin`;
            document.getElementById('roi').textContent = `${roi.toFixed(1)}%`;
            // Update the sedekah amount for the selected period.  Sedekah is
            // defined as 2.5% of the gross profit.  Negative gross profit
            // yields a zero sedekah.  Display using formatCurrency() so it
            // matches the currency formatting of other metrics.
            {
                const sedekah = Math.max(grossProfit * 0.025, 0);
                const sedekahEl = document.getElementById('sedekahAmount');
                if (sedekahEl) {
                    sedekahEl.textContent = formatCurrency(sedekah);
                }
            }

            updateProductAnalysisTable(filteredTransactions);
        }

        // Reports
        function showReports() {
            const today = new Date();
            const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
            const monthAgo = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());

            // Daily report
            const dailyTransactions = salesData.filter(t => {
                if (!t.timestamp) return false;
                const transactionDate = new Date(t.timestamp);
                return transactionDate.toDateString() === today.toDateString();
            });
            const dailyTotal = dailyTransactions.reduce((sum, t) => sum + (t.total || 0), 0);

            // Weekly report
            const weeklyTransactions = salesData.filter(t => {
                if (!t.timestamp) return false;
                return new Date(t.timestamp) >= weekAgo;
            });
            const weeklyTotal = weeklyTransactions.reduce((sum, t) => sum + (t.total || 0), 0);

            // Monthly report
            const monthlyTransactions = salesData.filter(t => {
                if (!t.timestamp) return false;
                return new Date(t.timestamp) >= monthAgo;
            });
            const monthlyTotal = monthlyTransactions.reduce((sum, t) => sum + (t.total || 0), 0);

            document.getElementById('dailyTotal').textContent = formatCurrency(dailyTotal);
            document.getElementById('dailyTransactions').textContent = `${dailyTransactions.length} transaksi`;
            document.getElementById('weeklyTotal').textContent = formatCurrency(weeklyTotal);
            document.getElementById('weeklyTransactions').textContent = `${weeklyTransactions.length} transaksi`;
            document.getElementById('monthlyTotal').textContent = formatCurrency(monthlyTotal);
            document.getElementById('monthlyTransactions').textContent = `${monthlyTransactions.length} transaksi`;

            // Debt list
            const debtListContainer = document.getElementById('debtList');
            if (debtData.length === 0) {
                debtListContainer.innerHTML = '<div class="text-center text-gray-500 py-4">Tidak ada hutang pelanggan</div>';
            } else {
                debtListContainer.innerHTML = debtData.map((debt, index) => `
                    <div class="bg-white p-3 rounded border">
                        <div class="flex justify-between items-center mb-2">
                            <div class="font-semibold text-gray-800">${debt.customerName}</div>
                            <div class="font-bold text-red-600">${formatCurrency(debt.amount)}</div>
                        </div>
                        <div class="text-sm text-gray-600 mb-3">${debt.transactions.length} transaksi hutang</div>
                        <div class="flex space-x-2">
                            <button onclick="payOffDebt('${debt.customerName}', ${debt.amount})" 
                                    class="flex-1 bg-green-500 hover:bg-green-600 text-white py-1 px-3 rounded text-sm font-semibold">
                                💳 Lunasi
                            </button>
                            <button onclick="showDebtPaymentModal('${debt.customerName}', ${debt.amount})" 
                                    class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-1 px-3 rounded text-sm font-semibold">
                                💰 Cicil
                            </button>
                        </div>
                    </div>
                `).join('');
            }

            // Stock report
            const stockReportContainer = document.getElementById('stockReport');
            const outOfStock = products.filter(p => p.stock === 0);
            const lowStock = products.filter(p => p.stock > 0 && p.stock <= p.minStock);
            
            let stockReportHTML = '';
            
            if (outOfStock.length > 0) {
                stockReportHTML += `
                    <div class="mb-4">
                        <h5 class="font-semibold text-red-700 mb-2">🚫 Stok Habis (${outOfStock.length} produk)</h5>
                        <div class="space-y-1">
                            ${outOfStock.map(product => `
                                <div class="bg-red-100 p-2 rounded text-sm">
                                    <div class="font-medium text-red-800">${product.name}</div>
                                    <div class="text-red-600 text-xs">Stok: ${product.stock} | Min: ${product.minStock}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }
            
            if (lowStock.length > 0) {
                stockReportHTML += `
                    <div class="mb-4">
                        <h5 class="font-semibold text-yellow-700 mb-2">⚠️ Stok Menipis (${lowStock.length} produk)</h5>
                        <div class="space-y-1">
                            ${lowStock.map(product => `
                                <div class="bg-yellow-100 p-2 rounded text-sm">
                                    <div class="font-medium text-yellow-800">${product.name}</div>
                                    <div class="text-yellow-600 text-xs">Stok: ${product.stock} | Min: ${product.minStock}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }
            
            if (outOfStock.length === 0 && lowStock.length === 0) {
                stockReportHTML = '<div class="text-center text-gray-500 py-4">Semua produk stok aman ✅</div>';
            }
            
            stockReportContainer.innerHTML = stockReportHTML;

            const modalEl = document.getElementById('reportsModal');
            modalEl.classList.remove('hidden');
            modalEl.classList.add('flex');
            // Attach keyboard shortcuts: Enter or Esc closes the reports modal
            attachModalKeyHandlers(modalEl, closeReportsModal, closeReportsModal);
        }

        function closeReportsModal() {
            const modalEl = document.getElementById('reportsModal');
            modalEl.classList.add('hidden');
            modalEl.classList.remove('flex');
            // Detach keyboard handlers when closing the reports modal
            detachModalKeyHandlers(modalEl);
        }

        // Debt payment functions
        let currentDebtCustomer = '';
        let currentDebtAmount = 0;

        function payOffDebt(customerName, amount) {
            const confirmMessage = `Yakin ingin melunasi hutang ${customerName} sebesar ${formatCurrency(amount)}?`;
            showConfirmLayer(confirmMessage, function(confirmed) {
                if (!confirmed) return;
                // Remove debt from debtData
                const debtIndex = debtData.findIndex(d => d.customerName === customerName);
                if (debtIndex !== -1) {
                    debtData.splice(debtIndex, 1);
                    // Skip marking data as dirty because debt deletion will be synced via delta
                    saveData(true);
                    // Create payment record
                    const paymentRecord = {
                        id: Date.now(),
                        customerName: customerName,
                        amount: amount,
                        type: 'debt_payment',
                        timestamp: new Date().toISOString(),
                        total: amount,
                        paid: amount,
                        debt: 0,
                        remainingDebt: 0
                    };
                    salesData.push(paymentRecord);
                    // Skip marking data as dirty because the payment record is synced via delta
                    saveData(true);
                    alert(`Hutang ${customerName} sebesar ${formatCurrency(amount)} telah dilunasi!`);
                    showReports(); // Refresh the reports modal
                    // Synchronize deletion of the debt and the new payment record to Google Sheets
                    try {
                        // Remove the debt row
                        sendDeltaToGoogleSheets('delete', 'debts', customerName).catch(err => {
                            console.error('Auto sync failed:', err);
                        });
                        // Add the payment record as a sale
                        sendDeltaToGoogleSheets('add', 'sales', saleToRow(paymentRecord)).catch(err => {
                            console.error('Auto sync failed:', err);
                        });
                        // Immediately process queued deltas for the removed debt and new payment record
                        processPendingDeltas();
                    } catch (err) {
                        console.error('Auto sync failed:', err);
                    }
                }
            });
        }

        function showDebtPaymentModal(customerName, amount) {
            currentDebtCustomer = customerName;
            currentDebtAmount = amount;
            
            document.getElementById('debtCustomerName').textContent = customerName;
            document.getElementById('debtTotalAmount').textContent = formatCurrency(amount);
            document.getElementById('debtPaymentAmount').value = '';
            document.getElementById('debtRemainingAmount').textContent = formatCurrency(amount);
            
            const modal = document.getElementById('debtPaymentModal');
            modal.classList.remove('hidden');
            modal.style.display = 'block';
            // Attach keyboard shortcuts: Enter processes debt payment, Esc cancels
            attachModalKeyHandlers(modal, processDebtPayment, closeDebtPaymentModal, ['debtPaymentAmount']);
            
            setTimeout(() => document.getElementById('debtPaymentAmount').focus(), 100);
        }

        function closeDebtPaymentModal() {
            const modal = document.getElementById('debtPaymentModal');
            modal.classList.add('hidden');
            modal.style.display = 'none';
            // Detach keyboard handlers when closing the debt payment modal
            detachModalKeyHandlers(modal);
            currentDebtCustomer = '';
            currentDebtAmount = 0;
        }

        function calculateDebtRemaining() {
            const paymentAmount = parseInt(document.getElementById('debtPaymentAmount').value) || 0;
            const remaining = currentDebtAmount - paymentAmount;
            
            const debtRemainingContainer = document.getElementById('debtRemainingContainer');
            const debtRemainingLabel = document.getElementById('debtRemainingLabel');
            const debtRemainingAmount = document.getElementById('debtRemainingAmount');
            const debtRemainingStatus = document.getElementById('debtRemainingStatus');
            
            if (paymentAmount === 0) {
                // No payment entered
                debtRemainingContainer.className = 'bg-gray-50 p-4 rounded-lg';
                debtRemainingLabel.textContent = 'Sisa hutang setelah bayar:';
                debtRemainingAmount.textContent = formatCurrency(currentDebtAmount);
                debtRemainingAmount.className = 'text-xl font-bold text-gray-600';
                debtRemainingStatus.textContent = '';
            } else if (paymentAmount > currentDebtAmount) {
                // Overpayment
                const overpayment = paymentAmount - currentDebtAmount;
                debtRemainingContainer.className = 'bg-red-50 p-4 rounded-lg';
                debtRemainingLabel.textContent = 'Kelebihan bayar:';
                debtRemainingAmount.textContent = formatCurrency(overpayment);
                debtRemainingAmount.className = 'text-xl font-bold text-red-600';
                debtRemainingStatus.textContent = '⚠️ Jumlah bayar melebihi total hutang';
                debtRemainingStatus.className = 'text-xs mt-1 text-red-600 font-medium';
            } else if (paymentAmount === currentDebtAmount) {
                // Full payment
                debtRemainingContainer.className = 'bg-green-50 p-4 rounded-lg';
                debtRemainingLabel.textContent = 'Status:';
                debtRemainingAmount.textContent = 'LUNAS! ✅';
                debtRemainingAmount.className = 'text-xl font-bold text-green-600';
                debtRemainingStatus.textContent = '🎉 Hutang akan terlunasi sepenuhnya';
                debtRemainingStatus.className = 'text-xs mt-1 text-green-600 font-medium';
            } else {
                // Partial payment
                const percentage = ((paymentAmount / currentDebtAmount) * 100).toFixed(1);
                debtRemainingContainer.className = 'bg-blue-50 p-4 rounded-lg';
                debtRemainingLabel.textContent = 'Sisa hutang:';
                debtRemainingAmount.textContent = formatCurrency(remaining);
                debtRemainingAmount.className = 'text-xl font-bold text-blue-600';
                debtRemainingStatus.textContent = `💳 Cicilan ${percentage}% dari total hutang`;
                debtRemainingStatus.className = 'text-xs mt-1 text-blue-600 font-medium';
            }
        }

        function processDebtPayment() {
            const paymentAmount = parseInt(document.getElementById('debtPaymentAmount').value) || 0;
            
            if (paymentAmount <= 0) {
                alert('Jumlah bayar harus lebih dari 0!');
                return;
            }
            
            if (paymentAmount > currentDebtAmount) {
                alert('Jumlah bayar tidak boleh lebih dari total hutang!');
                return;
            }
            
            // Find and update debt
            const debtIndex = debtData.findIndex(d => d.customerName === currentDebtCustomer);
            if (debtIndex !== -1) {
                const remainingDebt = currentDebtAmount - paymentAmount;
                
                if (remainingDebt === 0) {
                    // Fully paid - remove debt
                    debtData.splice(debtIndex, 1);
                    alert(`Hutang ${currentDebtCustomer} telah lunas!`);
                } else {
                    // Partial payment - update debt amount
                    debtData[debtIndex].amount = remainingDebt;
                    debtData[debtIndex].transactions.push({
                        id: Date.now(),
                        amount: -paymentAmount, // Negative amount indicates payment
                        date: new Date().toLocaleDateString('id-ID'),
                        type: 'payment'
                    });
                    alert(`Pembayaran ${formatCurrency(paymentAmount)} berhasil! Sisa hutang: ${formatCurrency(remainingDebt)}`);
                }
                
                // Create payment record
                const paymentRecord = {
                    id: Date.now(),
                    customerName: currentDebtCustomer,
                    amount: paymentAmount,
                    remainingDebt: remainingDebt,
                    type: 'debt_payment',
                    timestamp: new Date().toISOString(),
                    // Populate total and paid for debt payment transactions so that history views do not render NaN.
                    total: paymentAmount,
                    paid: paymentAmount,
                    // Also set `debt` to the remaining balance.  When exported/imported, the debt column
                    // will map back to this property, ensuring the remaining debt is preserved.
                    debt: remainingDebt
                };
                
                salesData.push(paymentRecord);
                // Skip marking data as dirty because the debt payment record will be synced via delta
                saveData(true);
                
                // Capture values needed for synchronization before resetting modal state
                const customerNameToSync = currentDebtCustomer;
                // Clone the updated debt record (if any) before we modify global state
                let debtRecordToSync = null;
                if (remainingDebt > 0 && debtIndex !== -1) {
                    debtRecordToSync = { ...debtData[debtIndex] };
                }
                // Close the modal and reset state variables
                closeDebtPaymentModal();
                showReports(); // Refresh the reports modal
                // Synchronize the debt payment with Google Sheets
                try {
                    // Add the payment record to Sales sheet
                    sendDeltaToGoogleSheets('add', 'sales', saleToRow(paymentRecord)).catch(err => console.error('Auto sync failed:', err));
                    if (remainingDebt === 0) {
                        // Debt is fully paid off: remove the debt row
                        sendDeltaToGoogleSheets('delete', 'debts', customerNameToSync).catch(err => console.error('Auto sync failed:', err));
                    } else {
                        // Partial payment: update the debt row with new balance and transactions
                        if (debtRecordToSync) {
                            sendDeltaToGoogleSheets('update', 'debts', debtToRow(debtRecordToSync)).catch(err => console.error('Auto sync failed:', err));
                        }
                    }
                    // Immediately process pending deltas so updates are flushed to Google Sheets
                    processPendingDeltas();
                } catch (err) {
                    console.error('Auto sync failed:', err);
                }
            }
        }

        // Thermal printer functions
        function connectThermalPrinter() {
            if ('serial' in navigator) {
                navigator.serial.requestPort()
                    .then(port => {
                        thermalPrinter = port;
                        return port.open({ baudRate: 9600 });
                    })
                    .then(() => {
                        printerConnected = true;
                        updatePrinterStatus('connected');
                        alert('Printer thermal berhasil terhubung!');
                    })
                    .catch(err => {
                        console.error('Error connecting to printer:', err);
                        alert('Gagal menghubungkan printer thermal. Pastikan printer sudah terhubung dan driver terinstall.');
                        updatePrinterStatus('disconnected');
                    });
            } else {
                alert('Browser tidak mendukung koneksi serial. Gunakan Chrome/Edge terbaru.');
            }
        }

        function updatePrinterStatus(status) {
            const statusElement = document.getElementById('printerStatus');
            statusElement.classList.remove('hidden');
            
            if (status === 'connected') {
                statusElement.textContent = '🖨️ Printer Terhubung';
                statusElement.className = 'printer-status printer-connected';
            } else {
                statusElement.textContent = '🖨️ Printer Terputus';
                statusElement.className = 'printer-status printer-disconnected';
            }
            
            setTimeout(() => {
                statusElement.classList.add('hidden');
            }, 3000);
        }

        function printThermalReceipt(transaction) {
            // Create receipt content
            const receiptContent = generateReceiptContent(transaction);
            
            if (printerConnected && thermalPrinter) {
                // Send to thermal printer
                sendToThermalPrinter(receiptContent);
            } else {
                // Fallback: print to browser
                printToBrowser(receiptContent);
            }
        }

        function generateReceiptContent(transaction) {
            const date = new Date(transaction.timestamp);
            const isPartial = transaction.type === 'partial';
            
            return `
                <!--
                    Receipt styles tuned for better readability on 58mm thermal printers.  The base
                    font-size has been increased and line-height loosened so text prints larger and
                    clearer on small paper.  Header fonts are also larger to stand out.  Adjust
                    these values if you use a different paper size or require different scaling.
                -->
                <div style="width: 300px; font-family: monospace; font-size: 14px; line-height: 1.3;">
                    <div style="text-align: center; margin-bottom: 10px;">
                        <div style="font-size: 20px; font-weight: bold;">TOKO BAROKAH</div>
                        <div style="font-size: 12px;">RT 02 Desa Pematang Gadung</div>
                        <div style="font-size: 12px;">================================</div>
                    </div>
                    
                    <div style="margin-bottom: 10px; font-size: 14px;">
                        <div>No: ${transaction.id}</div>
                        <div>Tanggal: ${date.toLocaleString('id-ID')}</div>
                        <div>Kasir: Admin</div>
                        ${isPartial ? `<div>Pelanggan: ${transaction.customerName}</div>` : ''}
                        <div>================================</div>
                    </div>
                    
                    <div style="margin-bottom: 10px; font-size: 14px;">
                        ${transaction.items.map(item => {
                            // Calculate per-item discount and net values for receipt display
                            const itemSubtotal = item.price * item.quantity;
                            let itemDiscount = 0;
                            if (item.discountType === 'percent') {
                                itemDiscount = itemSubtotal * (item.discountValue || 0) / 100;
                            } else {
                                itemDiscount = item.discountValue || 0;
                            }
                            if (itemDiscount > itemSubtotal) itemDiscount = itemSubtotal;
                            const itemNet = itemSubtotal - itemDiscount;
                            const discountLabel = item.discountValue && item.discountValue > 0 ?
                                (item.discountType === 'percent' ? ` (${item.discountValue}% off)` : ` (-${formatCurrency(item.discountValue)})`) : '';
                            return `
                            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                                <div style="flex: 1;">${item.name}${item.isService ? ' (JASA)' : ''}</div>
                            </div>
                            ${item.description ? `<div style="font-size: 10px; color: #666; margin-bottom: 2px;">\"${item.description}\"</div>` : ''}
                            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                <div>${item.quantity} x ${formatCurrency(item.price)}${discountLabel}</div>
                                <div>${formatCurrency(itemNet)}</div>
                            </div>
                            `;
                        }).join('')}
                        <div>================================</div>
                    </div>
                    
                    <div style="margin-bottom: 10px;">
                        <div style="display: flex; justify-content: space-between;">
                            <div>Subtotal:</div>
                            <div>${formatCurrency(transaction.subtotal)}</div>
                        </div>
                        ${
                            (transaction.discountAmount && transaction.discountAmount > 0) || (transaction.discount && transaction.discount > 0)
                            ? `
                            <div style="display: flex; justify-content: space-between;">
                                <div>Diskon${transaction.discountType === 'amount' ? '' : ' (' + (transaction.discountValue ?? transaction.discount) + '%)'}:</div>
                                <div>-${formatCurrency(transaction.discountAmount ?? (transaction.subtotal * transaction.discount / 100))}</div>
                            </div>
                            `
                            : ''
                        }
                        <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 18px;">
                            <div>TOTAL:</div>
                            <div>${formatCurrency(transaction.total)}</div>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <div>Bayar:</div>
                            <div>${formatCurrency(transaction.paid)}</div>
                        </div>
                        ${!isPartial ? `
                            <div style="display: flex; justify-content: space-between;">
                                <div>Kembalian:</div>
                                <div>${formatCurrency(transaction.change)}</div>
                            </div>
                        ` : `
                            <div style="display: flex; justify-content: space-between; color: red;">
                                <div>Sisa Hutang:</div>
                                <div>${formatCurrency(transaction.debt)}</div>
                            </div>
                        `}
                    </div>
                    
                    <div style="text-align: center; margin-top: 15px; font-size: 10px;">
                        <div>Terima kasih atas kunjungan Anda</div>
                        <div>Barang yang sudah dibeli tidak dapat dikembalikan</div>
                        <div style="margin-top: 10px;">================================</div>
                    </div>
                </div>
            `;
        }

        function sendToThermalPrinter(content) {
            // Convert HTML content to thermal printer commands
            // This is a simplified version - actual implementation would need proper ESC/POS commands
            const commands = convertToThermalCommands(content);
            
            if (thermalPrinter && thermalPrinter.writable) {
                const writer = thermalPrinter.writable.getWriter();
                writer.write(new TextEncoder().encode(commands))
                    .then(() => {
                        writer.releaseLock();
                        console.log('Receipt sent to thermal printer');
                    })
                    .catch(err => {
                        console.error('Error printing:', err);
                        writer.releaseLock();
                        // Fallback to browser print
                        printToBrowser(content);
                    });
            } else {
                printToBrowser(content);
            }
        }

        function convertToThermalCommands(htmlContent) {
            // Convert HTML to plain text for thermal printer
            // This is a basic conversion - real implementation would use ESC/POS commands
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlContent;
            return tempDiv.textContent || tempDiv.innerText || '';
        }

        function printToBrowser(content) {
            const printArea = document.getElementById('printArea');
            printArea.innerHTML = content;
            printArea.classList.remove('hidden');
            
            setTimeout(() => {
                window.print();
                printArea.classList.add('hidden');
            }, 100);
        }

        function printDebtPaymentReceipt(transaction) {
            const receiptContent = `
                <!--
                    Adjusted styling for debt payment receipts to improve legibility on
                    small 58mm thermal printers.  Larger fonts and increased line
                    height make the printed text more readable.
                -->
                <div style="width: 300px; font-family: monospace; font-size: 14px; line-height: 1.3;">
                    <div style="text-align: center; margin-bottom: 10px;">
                        <div style="font-size: 20px; font-weight: bold;">TOKO BAROKAH</div>
                        <div style="font-size: 12px;">RT 02 Desa Pematang Gadung</div>
                        <div style="font-size: 12px;">================================</div>
                        <div style="font-size: 18px; font-weight: bold; margin-top: 5px;">BUKTI PEMBAYARAN HUTANG</div>
                    </div>
                    
                    <div style="margin-bottom: 10px; font-size: 14px;">
                        <div>No: ${transaction.id}</div>
                        <div>Tanggal: ${new Date(transaction.timestamp).toLocaleString('id-ID')}</div>
                        <div>Kasir: Admin</div>
                        <div>Pelanggan: ${transaction.customerName}</div>
                        <div>================================</div>
                    </div>
                    
                    <div style="margin-bottom: 10px; font-size: 14px;">
                        <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 18px;">
                            <div>PEMBAYARAN HUTANG:</div>
                            <div>${formatCurrency(transaction.total ?? transaction.paid ?? transaction.amount ?? 0)}</div>
                        </div>
                        ${((transaction.remainingDebt ?? transaction.debt) > 0) ? `
                            <div style="display: flex; justify-content: space-between; color: red;">
                                <div>Sisa Hutang:</div>
                                <div>${formatCurrency(transaction.remainingDebt ?? transaction.debt)}</div>
                            </div>
                        ` : `
                            <div style="display: flex; justify-content: space-between; color: green;">
                                <div>Status:</div>
                                <div>LUNAS</div>
                            </div>
                        `}
                    </div>
                    
                    <div style="text-align: center; margin-top: 15px; font-size: 12px;">
                        <div>Terima kasih atas pembayaran Anda</div>
                        <div style="margin-top: 10px;">================================</div>
                    </div>
                </div>
            `;
            
            printToBrowser(receiptContent);
        }

// ===================== Google Sheets Integration =====================
// These functions integrate the application with a Google Apps Script Web App.
// Set the constant GOOGLE_APPS_SCRIPT_URL (defined near the top of this file)
// to your own Web App URL. See google_apps_script_template.gs for the Apps
// Script code. The export/import functions below convert the application’s
// in-memory data structures (products, salesData, debtData) into plain
// arrays of values that can be stored in a spreadsheet, and vice versa.

/**
 * Export local data (products, sales, debts) to Google Sheets via Apps Script.
 * Converts objects into arrays of values matching the expected sheet columns.
 */
/*
 * Kirim data lokal (produk, penjualan, hutang) ke Google Sheets melalui
 * Apps Script. Permintaan menggunakan Content‑Type `text/plain` untuk
 * menghindari preflight CORS. Respons tidak dibaca karena browser
 * memblokirnya untuk domain berbeda, sehingga notifikasi hanya
 * memberitahu bahwa data telah dikirim.
 */
// Modified export function to support silent exports.
// When `silent` is true, the export will run quietly without showing loading
// indicators or alert popups.  When false (default), the user sees a loading
// overlay and an alert message on success or failure.
async function exportDataToGoogleSheets(silent = false) {
    if (!GOOGLE_APPS_SCRIPT_URL || GOOGLE_APPS_SCRIPT_URL.includes('PASTE')) {
        if (!silent) {
            alert('URL Google Apps Script belum diatur. Silakan ganti konstanta GOOGLE_APPS_SCRIPT_URL di script.js.');
        }
        return;
    }
    // Only show loading overlay when not running silently
    if (!silent) {
        showLoading('Mengekspor data...');
    }
    // Ubah objek produk menjadi array
    // Include wholesaleMinQty and wholesalePrice when exporting products.
    // Some products may not have wholesale settings; in that case we export empty strings
    // to maintain consistent column positions in the spreadsheet.
    const productsRows = products.map(p => [
        p.id,
        p.name,
        p.price,
        p.modalPrice,
        p.barcode,
        p.stock,
        p.minStock,
        p.wholesaleMinQty ?? '',
        p.wholesalePrice ?? ''
    ]);
    const salesRows = salesData.map(s => [
        s.id,
        JSON.stringify(s.items),
        s.subtotal,
        s.discount,
        s.total,
        s.paid ?? '',
        s.change ?? '',
        // Export the remaining debt.  Fallback to remainingDebt if debt is undefined to
        // support older transactions that used remainingDebt instead of debt.
        (s.debt ?? s.remainingDebt ?? ''),
        s.customerName ?? '',
        s.timestamp,
        s.type
    ]);
    const debtsRows = debtData.map(d => [
        d.customerName,
        d.amount,
        JSON.stringify(d.transactions)
    ]);
    const payload = {
        products: productsRows,
        sales: salesRows,
        debts: debtsRows
    };
    try {
        await fetch(GOOGLE_APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        if (!silent) {
            alert('Data berhasil dikirim ke Google Sheets. Silakan periksa spreadsheet.');
        }
    } catch (error) {
        if (!silent) {
            alert('Ekspor data gagal: ' + error.message);
        } else {
            console.error('Silent export failed:', error);
        }
    } finally {
        // Hide the overlay only if it was shown
        if (!silent) {
            hideLoading();
        }
    }
}

/**
 * Synchronise the local data to Google Sheets using incremental updates.  Instead of
 * clearing the entire sheet, this function iterates over every product, sale and debt
 * row and performs an `update` action via the Apps Script endpoint.  This approach
 * minimises the chance of race conditions because it does not delete any existing
 * rows on the server; instead it updates rows with matching IDs or appends new
 * ones if they do not exist.  Note that this function does not handle deletions;
 * rows removed locally will remain on the server.  If you need to remove rows,
 * call delete actions separately before invoking this function.
 *
 * @param {boolean} silent If true, suppress user alerts and show no overlay.
 */
async function syncDataIncrementally(silent = false) {
    if (!GOOGLE_APPS_SCRIPT_URL || GOOGLE_APPS_SCRIPT_URL.includes('PASTE')) {
        if (!silent) {
            alert('URL Google Apps Script belum diatur. Silakan ganti konstanta GOOGLE_APPS_SCRIPT_URL di script.js.');
        }
        return;
    }
    if (!silent) {
        showLoading('Menyinkronkan data...');
    }
    // Build rows for products, sales and debts, similar to exportDataToGoogleSheets().
    const productRows = products.map(p => [
        p.id,
        p.name,
        p.price,
        p.modalPrice,
        p.barcode,
        p.stock,
        p.minStock,
        p.wholesaleMinQty ?? '',
        p.wholesalePrice ?? ''
    ]);
    const salesRows = salesData.map(s => [
        s.id,
        JSON.stringify(s.items),
        s.subtotal,
        s.discount,
        s.total,
        s.paid ?? '',
        s.change ?? '',
        (s.debt ?? s.remainingDebt ?? ''),
        s.customerName ?? '',
        s.timestamp,
        s.type
    ]);
    const debtRows = debtData.map(d => [
        d.customerName,
        d.amount,
        JSON.stringify(d.transactions)
    ]);
    // Helper to send update requests sequentially.  Because Google Apps Script
    // may not handle high concurrency well, we await each fetch.  You could
    // parallelise with Promise.all if your script supports concurrent writes.
    async function updateRow(objectType, row) {
        const payload = {
            action: 'update',
            objectType: objectType,
            row: row
        };
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return;
            } catch (err) {
                if (attempt >= maxAttempts) {
                    // On final failure, queue the update as a pending delta for later
                    sendDeltaToGoogleSheets('update', objectType, row);
                    throw err;
                }
                // Wait with exponential backoff before retrying
                await new Promise(res => setTimeout(res, 1000 * attempt));
            }
        }
    }
    try {
        // Update products
        for (const row of productRows) {
            await updateRow('products', row);
        }
        // Update sales
        for (const row of salesRows) {
            await updateRow('sales', row);
        }
        // Update debts
        for (const row of debtRows) {
            await updateRow('debts', row);
        }
        // Record the last successful sync time and update UI
        lastSyncTime = Date.now();
        try {
            localStorage.setItem('kasir_last_sync_time', String(lastSyncTime));
        } catch (err) {
            // ignore
        }
        updateSyncStatus();
        if (!silent) {
            alert('Data berhasil disinkronkan ke Google Sheets.');
        }
    } catch (err) {
        if (!silent) {
            alert('Sinkronisasi incremental gagal: ' + err.message);
        } else {
            console.error('Incremental sync failed:', err);
        }
    } finally {
        if (!silent) {
            hideLoading();
        }
    }
}

        /**
         * Update the discount value for a specific item in the cart.
         * This function is called when the user changes the discount input
         * associated with an item in the cart UI.  It casts the value to
         * an integer and updates the item's discountValue, then refreshes
         * the cart display and totals.
         *
         * @param {string|number} itemId The ID of the cart item (string for service items)
         * @param {string|number} newDiscountValue The new discount value entered by the user
         */
        function updateItemDiscount(itemId, newDiscountValue) {
            const item = cart.find(i => String(i.id) === String(itemId));
            if (item) {
                const val = parseInt(newDiscountValue) || 0;
                item.discountValue = val;
                updateCartDisplay();
                updateTotal();
            }
        }

        /**
         * Update the discount type for a specific item in the cart.  The type can
         * be either 'percent' or 'amount'.  After updating, the cart display
         * and totals are refreshed.  This is used by the per-item discount
         * selector in the cart UI.
         *
         * @param {string|number} itemId The ID of the cart item
         * @param {string} newType The new discount type ('percent' or 'amount')
         */
        function updateItemDiscountType(itemId, newType) {
            const item = cart.find(i => String(i.id) === String(itemId));
            if (item) {
                item.discountType = newType;
                updateCartDisplay();
                updateTotal();
            }
        }

// Alias for backward compatibility: the client originally used an "export"
// operation to synchronise local data with the Google Sheets backend.  In
// practice this function performs a full update of the underlying sheets
// by clearing old rows and writing the current state (see the Apps Script
// implementation in code.gs).  To align with terminology that emphasises
// updating rather than exporting, we provide updateDataToGoogleSheets() as
// a wrapper around exportDataToGoogleSheets().  If you want to add more
// granular update behaviour (for example, sending only changed rows), you
// can implement that logic here and adjust your Apps Script accordingly.
async function updateDataToGoogleSheets(silent = false) {
    return exportDataToGoogleSheets(silent);
}

// -----------------------------------------------------------------------------
// Incremental synchronization helpers
//
// The functions below convert application objects into arrays of values that
// correspond to the columns in the Google Sheets. They are used by
// sendDeltaToGoogleSheets() to send only the changed record instead of
// rewriting the entire dataset. This reduces bandwidth and avoids race
// conditions when multiple devices are synchronizing simultaneously.

/**
 * Convert a product object into an array matching the Products sheet structure.
 * @param {Object} product
 * @returns {Array}
 */
function productToRow(product) {
    return [
        product.id,
        product.name,
        product.price,
        product.modalPrice,
        product.barcode,
        product.stock,
        product.minStock,
        product.wholesaleMinQty ?? '',
        product.wholesalePrice ?? ''
    ];
}

/**
 * Convert a sale/transaction object into an array matching the Sales sheet.
 * @param {Object} sale
 * @returns {Array}
 */
function saleToRow(sale) {
    return [
        sale.id,
        JSON.stringify(sale.items),
        sale.subtotal,
        sale.discount,
        sale.total,
        sale.paid ?? '',
        sale.change ?? '',
        (sale.debt ?? sale.remainingDebt ?? ''),
        sale.customerName ?? '',
        sale.timestamp,
        sale.type
    ];
}

/**
 * Convert a debt record into an array matching the Debts sheet structure.
 * @param {Object} debt
 * @returns {Array}
 */
function debtToRow(debt) {
    return [
        debt.customerName,
        debt.amount,
        JSON.stringify(debt.transactions)
    ];
}

/**
 * Apply pending delta operations to the imported data arrays.  When data is
 * imported from Google Sheets while offline changes are still pending, the
 * remote data could overwrite local modifications.  This helper merges
 * each queued delta into the in-memory products, salesData and debtData
 * arrays so that offline edits persist.  Each delta entry contains an
 * action ('add', 'update' or 'delete'), an objectType ('products', 'sales' or
 * 'debts') and a row array or ID.  The row arrays follow the same
 * column order used by exportDataToGoogleSheets().  Note that wholesale
 * fields may be optional and need to be parsed as numbers or null.
 */
function applyPendingDeltasToImportedData() {
    if (!Array.isArray(pendingDeltas) || pendingDeltas.length === 0) {
        return;
    }
    // Helper to parse optional numbers (similar to importDataFromGoogleSheets)
    const parseOptionalNumber = (v) => {
        if (v === undefined || v === null || v === '' || v === 'null' || v === 'undefined') {
            return null;
        }
        const num = Number(v);
        return Number.isNaN(num) ? null : num;
    };
    for (const delta of pendingDeltas) {
        const type = delta.objectType;
        if (type === 'products') {
            if (delta.action === 'update' || delta.action === 'add') {
                const row = delta.row;
                // Convert row array back into a product object
                const productObj = {
                    id: parseInt(row[0]),
                    name: row[1],
                    price: Number(row[2]),
                    modalPrice: Number(row[3]),
                    barcode: row[4],
                    stock: Number(row[5]),
                    minStock: Number(row[6]),
                    wholesaleMinQty: parseOptionalNumber(row[7]),
                    wholesalePrice: parseOptionalNumber(row[8])
                };
                // Remove any existing product with the same ID
                products = products.filter(p => String(p.id) !== String(productObj.id));
                // Add the updated/new product
                products.push(productObj);
            } else if (delta.action === 'delete') {
                const id = delta.id;
                products = products.filter(p => String(p.id) !== String(id));
            }
        } else if (type === 'sales') {
            if (delta.action === 'update' || delta.action === 'add') {
                const row = delta.row;
                const saleObj = {
                    id: Number(row[0]),
                    items: JSON.parse(row[1] || '[]'),
                    subtotal: Number(row[2]),
                    discount: Number(row[3]),
                    total: Number(row[4]),
                    paid: row[5] !== '' ? Number(row[5]) : undefined,
                    change: row[6] !== '' ? Number(row[6]) : undefined,
                    debt: row[7] !== '' ? Number(row[7]) : undefined,
                    customerName: row[8] || undefined,
                    timestamp: row[9],
                    type: row[10]
                };
                salesData = salesData.filter(s => String(s.id) !== String(saleObj.id));
                salesData.push(saleObj);
            } else if (delta.action === 'delete') {
                const id = delta.id;
                salesData = salesData.filter(s => String(s.id) !== String(id));
            }
        } else if (type === 'debts') {
            if (delta.action === 'update' || delta.action === 'add') {
                const row = delta.row;
                const debtObj = {
                    customerName: row[0],
                    amount: Number(row[1]),
                    transactions: JSON.parse(row[2] || '[]')
                };
                debtData = debtData.filter(d => d.customerName !== debtObj.customerName);
                debtData.push(debtObj);
            } else if (delta.action === 'delete') {
                const custName = delta.id;
                debtData = debtData.filter(d => d.customerName !== custName);
            }
        }
    }
}

/**
 * Send a single-row change to Google Sheets via the Apps Script. The payload
 * includes an action (add, update or delete), the object type (products,
 * sales, debts), and either a row array (for add/update) or an ID (for delete).
 * This function returns a promise and logs errors to the console if any.
 *
 * @param {string} action One of 'add', 'update' or 'delete'.
 * @param {string} objectType The object type ('products', 'sales', or 'debts').
 * @param {Array|number|string} rowOrId Array of values for add/update or ID for delete.
 */
async function sendDeltaToGoogleSheets(action, objectType, rowOrId) {
    if (!GOOGLE_APPS_SCRIPT_URL || GOOGLE_APPS_SCRIPT_URL.includes('PASTE')) {
        console.warn('URL Google Apps Script belum diatur. Perubahan tidak akan tersinkron.');
        return;
    }
    // Validate inputs to avoid queuing undefined values
    if (action === 'delete') {
        if (rowOrId === undefined || rowOrId === null) {
            console.warn('sendDeltaToGoogleSheets: invalid delete ID for', objectType);
            return;
        }
    } else {
        if (!rowOrId) {
            console.warn('sendDeltaToGoogleSheets: invalid row for action', action, 'object', objectType);
            return;
        }
    }
    // Construct a delta record
    const delta = { action: action, objectType: objectType };
    if (action === 'delete') {
        delta.id = rowOrId;
    } else {
        delta.row = rowOrId;
    }
    /*
     * Always queue delta operations rather than attempting to send them
     * immediately.  Even when the browser is online, the network
     * connectivity to the Apps Script may be unreliable and sending
     * updates synchronously can lead to race conditions with the import
     * routine.  By enqueuing the delta and marking the data as pending,
     * we guarantee that offline edits are persisted locally and will
     * override imported data on the next import.  Deltas will be sent
     * to Google Sheets when processPendingDeltas() runs (e.g. when
     * network connectivity is restored or on manual export).
     */
    pendingDeltas.push(delta);
    // Persist the updated queue to both localStorage and IndexedDB.  This
    // also updates the sync status indicator.
    persistPendingDeltas();
    // Mark data as pending for sync and persist this flag.  We store
    // syncPending separately from the delta queue so that a full sync
    // (products/sales/debts) can still be triggered even when no
    // individual deltas are present.
    syncPending = true;
    try {
        localStorage.setItem('kasir_sync_pending', 'true');
    } catch (err) {
        // ignore
    }
    /*
     * If the device is currently online and the user is logged in, process
     * the pending deltas immediately.  This allows transactions and
     * product updates made while online to be synchronised to Google
     * Sheets without waiting for a manual export.  When offline, the
     * deltas remain in the queue and will be processed when the network
     * connectivity is restored or when the user manually exports.
     */
    // NOTE: Do not automatically flush pending deltas here.  Previously the
    // function attempted to call processPendingDeltas() immediately whenever
    // a delta was queued and the device was online.  In practice this could
    // result in duplicate exports when callers also invoked
    // processPendingDeltas() explicitly after batching multiple deltas (for
    // example, when processing a sale and updating several product stocks).
    // By deferring delta processing to the calling context we ensure the
    // queue is flushed exactly once per operation and avoid race conditions
    // that send the same delta multiple times.  Callers that wish to flush
    // immediately should call processPendingDeltas() themselves after
    // enqueuing all necessary deltas.
    try {
        const loggedIn = localStorage.getItem('loggedIn') === 'true';
        // The loggedIn read is kept here to maintain parity with the previous
        // implementation and to provide a place for potential future logic.
        // No automatic sync is triggered at this point.
        void loggedIn;
    } catch (err) {
        // If localStorage is inaccessible, skip immediate sync
    }
    // Register a background sync event with the service worker so that
    // queued deltas are processed automatically even if the user closes
    // the tab.  This requires the SyncManager API to be supported and
    // autoSyncEnabled to be true.  Errors are ignored because not all
    // browsers implement Background Sync.
    if (autoSyncEnabled && 'serviceWorker' in navigator && 'SyncManager' in window) {
        try {
            navigator.serviceWorker.ready.then(reg => {
                reg.sync.register('kasir-sync').catch(() => { /* ignore */ });
            });
        } catch (err) {
            // ignore registration errors
        }
    }
    return;
}

/**
 * Import data from Google Sheets via Apps Script and update local data.
 * Parses arrays of values back into objects used by the application.
 */
/*
 * Ambil data dari Google Sheets melalui Apps Script menggunakan JSONP.
 * Metode ini menambahkan script tag dinamis ke halaman dengan parameter `callback`.
 * Apps Script akan memanggil fungsi callback di browser dengan data.
 */
async function importDataFromGoogleSheets() {
    if (!GOOGLE_APPS_SCRIPT_URL || GOOGLE_APPS_SCRIPT_URL.includes('PASTE')) {
        alert('URL Google Apps Script belum diatur. Silakan ganti konstanta GOOGLE_APPS_SCRIPT_URL di script.js.');
        return;
    }
    // Tampilkan indikator loading saat proses impor dimulai
    showLoading('Mengimpor data...');
    return new Promise((resolve, reject) => {
        const callbackName = 'importCallback_' + Date.now();
        window[callbackName] = function(data) {
            try {
                // Map products
                if (Array.isArray(data.products)) {
                    /**
                     * Parse a numeric field from the imported data.
                     * Some backends may serialize missing values as the string "null" or "undefined";
                     * convert those to null.  Also convert empty strings or undefined to null.
                     * Return null when parsing fails (e.g. NaN) so downstream UI logic
                     * treats the value as absent rather than a falsy number.
                     * @param {any} v
                     * @returns {number|null}
                     */
                    function parseOptionalNumber(v) {
                        if (v === undefined || v === null || v === '' || v === 'null' || v === 'undefined') {
                            return null;
                        }
                        const num = Number(v);
                        return Number.isNaN(num) ? null : num;
                    }
                    products = data.products.map(row => {
                        const product = {
                            id: parseInt(row[0]),
                            name: row[1],
                            price: Number(row[2]),
                            modalPrice: Number(row[3]),
                            barcode: row[4],
                            stock: Number(row[5]),
                            minStock: Number(row[6])
                        };
                        // Optional wholesale fields may be undefined when older data is imported.
                        // Use parseOptionalNumber to handle strings like "null" or "undefined".
                        product.wholesaleMinQty = parseOptionalNumber(row[7]);
                        product.wholesalePrice = parseOptionalNumber(row[8]);
                        return product;
                    });
                }
                // Map sales
                if (Array.isArray(data.sales)) {
                    salesData = data.sales.map(row => ({
                        id: Number(row[0]),
                        items: JSON.parse(row[1] || '[]'),
                        subtotal: Number(row[2]),
                        discount: Number(row[3]),
                        total: Number(row[4]),
                        paid: row[5] !== '' ? Number(row[5]) : undefined,
                        change: row[6] !== '' ? Number(row[6]) : undefined,
                        debt: row[7] !== '' ? Number(row[7]) : undefined,
                        customerName: row[8] || undefined,
                        timestamp: row[9],
                        type: row[10]
                    }));
                }
                // Map debts
                if (Array.isArray(data.debts)) {
                    debtData = data.debts.map(row => ({
                        customerName: row[0],
                        amount: Number(row[1]),
                        transactions: JSON.parse(row[2] || '[]')
                    }));
                }
                // Before deduplicating and saving, apply any pending offline
                // delta operations to the imported data.  Offline edits stored
                // in pendingDeltas could otherwise be lost when remote data is
                // imported.  This call merges queued updates/adds/deletes into
                // the products, salesData and debtData arrays.
                applyPendingDeltasToImportedData();

                // If there are unsynchronised changes flagged by syncPending,
                // overlay the locally stored products, sales and debt data
                // onto the imported arrays.  This ensures that offline edits
                // persisted in localStorage are not lost when the application
                // automatically imports fresh data from Google Sheets.  The
                // local records override remote records with matching IDs.
                try {
                    const syncFlag = localStorage.getItem('kasir_sync_pending') === 'true';
                    if (syncFlag) {
                        // Merge local products
                        const storedProducts = localStorage.getItem('kasir_products');
                        if (storedProducts) {
                            const localProducts = JSON.parse(storedProducts);
                            if (Array.isArray(localProducts)) {
                                for (const lp of localProducts) {
                                    const idx = products.findIndex(p => String(p.id) === String(lp.id));
                                    if (idx !== -1) {
                                        products[idx] = lp;
                                    } else {
                                        products.push(lp);
                                    }
                                }
                            }
                        }
                        // Merge local sales
                        const storedSales = localStorage.getItem('kasir_sales');
                        if (storedSales) {
                            const localSales = JSON.parse(storedSales);
                            if (Array.isArray(localSales)) {
                                for (const ls of localSales) {
                                    const idx = salesData.findIndex(s => String(s.id) === String(ls.id));
                                    if (idx !== -1) {
                                        salesData[idx] = ls;
                                    } else {
                                        salesData.push(ls);
                                    }
                                }
                            }
                        }
                        // Merge local debts
                        const storedDebts = localStorage.getItem('kasir_debt');
                        if (storedDebts) {
                            const localDebts = JSON.parse(storedDebts);
                            if (Array.isArray(localDebts)) {
                                for (const ld of localDebts) {
                                    const idx = debtData.findIndex(d => d.customerName === ld.customerName);
                                    if (idx !== -1) {
                                        debtData[idx] = ld;
                                    } else {
                                        debtData.push(ld);
                                    }
                                }
                            }
                        }
                    }
                } catch (mergeErr) {
                    console.error('Failed to merge local unsynced data:', mergeErr);
                }
                // Remove duplicate products before saving so the database and UI
                // don't accumulate identical entries.  This deduplication
                // compares product fields and keeps only the first occurrence of
                // each unique combination.  See `removeDuplicateProducts()` for
                // details.
                removeDuplicateProducts();
                // When importing from Google Sheets, temporarily disable dirty marking
                // to avoid re-exporting the freshly imported data.  Once the import
                // is done, re-enable and attempt to sync any previously pending data.
                isImporting = true;
                saveData();
                isImporting = false;
                // Previously the import routine attempted to automatically
                // synchronise any pending changes after the import completed.
                // Automatic exports have been disabled to prevent race
                // conditions (exports running before imports finish).
                // Pending changes remain flagged and will be exported only
                // when the user performs a manual export.
                // refresh UI
                displaySavedProducts();
                displayScannerProductTable();
                // Reattach event listeners to search inputs after the DOM may have been updated
                // The import process replaces the products array and triggers UI updates, which can cause
                // event listeners on inputs (e.g., barcode and product searches) to be lost.  Calling
                // attachSearchListeners() ensures search and suggestion functionality continues to work.
                attachSearchListeners();
                // Sembunyikan loading sebelum menampilkan pesan
                hideLoading();
                alert('Impor data berhasil.');
                resolve();
            } catch (err) {
                // Pastikan overlay disembunyikan jika terjadi error saat memproses data
                hideLoading();
                reject(err);
            } finally {
                delete window[callbackName];
            }
        };
        const script = document.createElement('script');
        script.src = GOOGLE_APPS_SCRIPT_URL + '?callback=' + callbackName;
        script.onerror = function() {
            // Sembunyikan overlay jika gagal memuat script
            hideLoading();
            delete window[callbackName];
            alert('Impor data gagal: Gagal memuat data dari Google Sheets.');
            reject(new Error('Impor data gagal'));
        };
        document.body.appendChild(script);
    });
}

// Ensure that key functions used by inline HTML attributes are globally
// accessible.  When functions are declared within this module scope they
// may not automatically become properties of the window object, which
// causes inline attributes like `oninput="searchProducts(...)"` or
// `onkeypress="handleBarcodeInput(event)"` to fail after certain
// operations (e.g. imports) that reload or replace portions of the DOM.
// Explicitly assign these functions to the window object so they remain
// callable from HTML event attributes regardless of module scoping or
// bundling transformations.
window.searchProducts = searchProducts;
window.showProductSuggestions = showProductSuggestions;
window.hideProductSuggestions = hideProductSuggestions;
window.selectProductFromSuggestion = selectProductFromSuggestion;
window.handleBarcodeInput = handleBarcodeInput;
window.searchScannerProducts = searchScannerProducts;
window.handleScannerTableSearch = handleScannerTableSearch;

// ----------------------------------------------------------
// Kamera Barcode Scanner (Mobile)
//
// Fitur ini memungkinkan pemindaian barcode menggunakan kamera pada perangkat
// seluler. Ketika fungsi ini diaktifkan, pengguna dapat memilih untuk
// memulai pemindaian via kamera atau menghentikannya. Hasil scan
// otomatis akan dimasukkan ke dalam kolom barcode dan produk akan
// ditambahkan ke keranjang bila ada kecocokan barcode.

/**
 * Deteksi apakah perangkat yang digunakan adalah ponsel atau tablet.
 * @returns {boolean}
 */
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

// Instance dari Html5Qrcode yang sedang aktif untuk pemindaian kamera.
let cameraScannerInstance = null;
// Flag indicating whether QuaggaJS is currently scanning.  When true,
// QuaggaJS has been initialized and is processing camera frames.  This flag
// prevents multiple concurrent scans and helps stop the scanner cleanly.
let quaggaScannerActive = false;

/**
 * Inisialisasi tampilan dan event handler untuk pemindai kamera di perangkat mobile.
 * Menampilkan tombol pemindaian jika perangkat adalah mobile dan library
 * Html5Qrcode tersedia. Jika library belum dimuat (misal offline), maka
 * tombol akan tetap tersembunyi.
 */
function initializeMobileScanner() {
    // Pemindaian kamera di ponsel telah dinonaktifkan.  Fungsi ini dibiarkan
    // kosong agar opsi kamera tidak ditampilkan dan event handler tidak
    // didaftarkan.  USB/Bluetooth barcode scanner tetap berfungsi melalui
    // pemindai global.
    return;
}

/**
 * Memulai pemindaian barcode menggunakan kamera. Fungsi ini akan meminta izin
 * kamera, menampilkan stream di dalam elemen dengan id "cameraScanner", dan
 * memproses hasil scan. Jika pemindaian berhasil, barcode otomatis
 * dimasukkan ke input barcode dan produk akan ditambahkan ke keranjang.
 */
async function startCameraScan() {
    const startBtn = document.getElementById('startCameraScanButton');
    const stopBtn = document.getElementById('stopCameraScanButton');
    const scannerDiv = document.getElementById('cameraScanner');
    if (!startBtn || !stopBtn || !scannerDiv) return;

    // Jika scanner sudah aktif, jangan memulai lagi.
    if (cameraScannerInstance || quaggaScannerActive) {
        return;
    }

    // If neither library is available, abort early and inform the user.
    if (typeof Quagga === 'undefined' && typeof Html5Qrcode === 'undefined') {
        alert('Fitur scan kamera tidak tersedia. Pastikan koneksi internet atau library disertakan.');
        return;
    }

    // Tampilkan container dan tombol stop, sembunyikan tombol start
    scannerDiv.classList.remove('hidden');
    stopBtn.classList.remove('hidden');
    startBtn.classList.add('hidden');

    try {
        // Prefer using QuaggaJS for 1D barcode scanning if available.  Quagga
        // provides better decoding for linear barcodes such as EAN, UPC, and Code
        // series.  If initialization fails for any reason, fall back to
        // html5-qrcode.
        if (typeof Quagga !== 'undefined') {
            await startQuaggaScan(scannerDiv);
            return;
        }
        // If Quagga is not available, use html5-qrcode (as loaded from CDN).
        if (typeof Html5Qrcode !== 'undefined') {
            cameraScannerInstance = new Html5Qrcode('cameraScanner');
            const config = {
                fps: 10,
                rememberLastUsedCamera: true,
                useBarCodeDetectorIfSupported: true,
                formatsToSupport: [
                    Html5QrcodeSupportedFormats.CODE_128,
                    Html5QrcodeSupportedFormats.CODE_39,
                    Html5QrcodeSupportedFormats.CODE_93,
                    Html5QrcodeSupportedFormats.EAN_13,
                    Html5QrcodeSupportedFormats.EAN_8,
                    Html5QrcodeSupportedFormats.UPC_A,
                    Html5QrcodeSupportedFormats.UPC_E,
                    Html5QrcodeSupportedFormats.QR_CODE
                ]
            };
            await cameraScannerInstance.start(
                { facingMode: "environment" },
                config,
                (decodedText, decodedResult) => {
                    // Use post‑processing to validate and buffer scanned codes
                    processScannedCode(decodedText);
                },
                (errorMessage) => {
                    console.debug('Scan error:', errorMessage);
                }
            );
            return;
        }
    } catch (err) {
        console.error('Gagal memulai scan kamera:', err);
        alert('Gagal memulai scan kamera. Pastikan kamera tersedia dan izin diberikan.');
        // Bersihkan UI jika gagal memulai
        await stopCameraScan();
    }
}

/**
 * Menangani hasil barcode yang dipindai dari kamera. Fungsi ini akan
 * memasukkan hasil scan ke input barcode, memproses saran produk, dan jika
 * barcode persis ada dalam daftar produk maka produk akan langsung
 * ditambahkan ke keranjang.
 * @param {string} code
 */
function handleDecodedBarcode(code) {
    const barcodeInput = document.getElementById('barcodeInput');
    if (!barcodeInput) return;
    // Masukkan hasil ke input dan tampilkan saran
    barcodeInput.value = code;
    showProductSuggestions(code);

    // Jika barcode cocok dengan produk, tambahkan ke keranjang secara otomatis
    const matchedProduct = products.find(p => p.barcode && p.barcode.toString() === code);
    if (matchedProduct) {
        addToCart({ id: matchedProduct.id, name: matchedProduct.name, price: matchedProduct.price, stock: matchedProduct.stock });
        // Play a short beep to provide audible feedback that the barcode has been captured
        playBeep();
        // Setelah menambahkan ke keranjang, kosongkan input untuk scan berikutnya
        barcodeInput.value = '';
        hideProductSuggestions();
    }
}

/**
 * Menghentikan pemindaian kamera dan membersihkan UI. Digunakan ketika
 * pengguna menekan tombol stop atau ketika pemindaian selesai.
 */
async function stopCameraScan() {
    const startBtn = document.getElementById('startCameraScanButton');
    const stopBtn = document.getElementById('stopCameraScanButton');
    const scannerDiv = document.getElementById('cameraScanner');
    if (!startBtn || !stopBtn || !scannerDiv) return;
    try {
        if (cameraScannerInstance) {
            await cameraScannerInstance.stop();
            cameraScannerInstance.clear();
            cameraScannerInstance = null;
        }
        // Stop QuaggaJS scanning if active
        if (quaggaScannerActive && typeof Quagga !== 'undefined') {
            // Removing event listener before stopping ensures no further callbacks fire
            if (_onQuaggaDetected) {
                Quagga.offDetected(_onQuaggaDetected);
            }
            Quagga.stop();
            quaggaScannerActive = false;
        }
    } catch (err) {
        console.error('Gagal menghentikan scan kamera:', err);
    } finally {
        // Sembunyikan container dan tombol stop, tampilkan tombol start
        scannerDiv.classList.add('hidden');
        stopBtn.classList.add('hidden');
        startBtn.classList.remove('hidden');
    }
}

// Pastikan fungsi tersedia secara global bila dipanggil dari HTML
window.isMobileDevice = isMobileDevice;
window.initializeMobileScanner = initializeMobileScanner;
window.startCameraScan = startCameraScan;
window.stopCameraScan = stopCameraScan;

/**
 * Reference to the currently registered Quagga onDetected callback.
 * Used to unregister the callback when the scanner is stopped to prevent
 * memory leaks and duplicate events.
 * @type {function|null}
 */
let _onQuaggaDetected = null;

/**
 * Memulai pemindaian menggunakan QuaggaJS.  Fungsi ini membungkus inisialisasi
 * QuaggaJS ke dalam sebuah Promise sehingga dapat digunakan dengan async/await.
 * @param {HTMLElement} targetEl Elemen DOM tempat video stream ditampilkan.
 * @returns {Promise<void>} Menyelesaikan ketika Quagga berhasil diinisialisasi.
 */
function startQuaggaScan(targetEl) {
    return new Promise((resolve, reject) => {
        if (typeof Quagga === 'undefined') {
            reject(new Error('QuaggaJS tidak tersedia'));
            return;
        }
        // Konfigurasi QuaggaJS untuk menggunakan kamera belakang dan mendekode
        // berbagai format barcode 1D. Parameter locate=true meningkatkan
        // kemungkinan menemukan kode di frame meskipun posisinya tidak ideal.
        const config = {
            inputStream: {
                name: 'Live',
                type: 'LiveStream',
                target: targetEl,
                constraints: {
                    facingMode: 'environment'
                }
            },
            decoder: {
                readers: [
                    'ean_reader',
                    'ean_8_reader',
                    'code_128_reader',
                    'code_39_reader',
                    'code_39_vin_reader',
                    'upc_reader',
                    'upc_e_reader',
                    'codabar_reader',
                    'i2of5_reader',
                    '2of5_reader',
                    'code_93_reader'
                ]
            },
            locate: true,
            numOfWorkers: navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
        };
        _onQuaggaDetected = function(result) {
            if (result && result.codeResult && result.codeResult.code) {
                const code = result.codeResult.code;
                // Process the code using our buffer and checksum validation
                processScannedCode(code);
            }
        };
        Quagga.init(config, function(err) {
            if (err) {
                console.error('Quagga init error:', err);
                reject(err);
                return;
            }
            Quagga.onDetected(_onQuaggaDetected);
            Quagga.start();
            quaggaScannerActive = true;
            resolve();
        });
    });
}

// -----------------------------------------------------------------------------
// Global scanner toggle utilities
//
// These helpers manage the UI state of the standby toggle button and flip
// the globalScannerEnabled flag.  When disabled, keystrokes are ignored by
// the global scanner listener so that operators can type product names or
// perform other interactions without triggering unintended barcode actions.

/**
 * Update the appearance and label of the global scanner toggle button to
 * reflect whether scanning is currently enabled.  Called after toggling
 * and on initial page load.
 */
function updateScanToggleButton() {
    const btn = document.getElementById('toggleScanButton');
    if (!btn) return;
    if (globalScannerEnabled) {
        // Enabled: yellow background and 'Scan ON'
        btn.classList.remove('bg-gray-400', 'hover:bg-gray-500');
        btn.classList.add('bg-yellow-500', 'hover:bg-yellow-600');
        btn.innerHTML = '🔄 <span class="hidden sm:inline">Scan ON</span>';
    } else {
        // Disabled: gray background and 'Scan OFF'
        btn.classList.remove('bg-yellow-500', 'hover:bg-yellow-600');
        btn.classList.add('bg-gray-400', 'hover:bg-gray-500');
        btn.innerHTML = '⏸️ <span class="hidden sm:inline">Scan OFF</span>';
    }
}

/**
 * Toggle the global scanner standby state on or off.  When disabled the
 * listener early returns and scanning must be performed via the dedicated
 * input field.  After flipping the state the toggle button is updated.
 */
function toggleGlobalScanner() {
    globalScannerEnabled = !globalScannerEnabled;
    updateScanToggleButton();
}

// Expose the toggle functions globally so they can be called from inline
// onclick attributes defined in the HTML.
window.toggleGlobalScanner = toggleGlobalScanner;
window.updateScanToggleButton = updateScanToggleButton;

// Keyboard shortcut: Ctrl+Enter to initiate payment from the Scanner tab
// When the scanner tab is active and the cart has items, pressing Ctrl+Enter
// will open the unified payment modal. This helps operators quickly proceed
// to payment without manually clicking the pay button in the floating cart.
document.addEventListener('keydown', function(e) {
    // Only act on Ctrl + Enter
    const isCtrlEnter = e.ctrlKey && (e.key === 'Enter' || e.keyCode === 13);
    if (!isCtrlEnter) return;

    // Determine if Scanner tab content is currently visible
    const scannerContent = document.getElementById('scannerContent');
    if (!scannerContent || scannerContent.classList.contains('hidden')) {
        return;
    }

    // If there are items in the cart, open the payment modal
    if (Array.isArray(cart) && cart.length > 0) {
        e.preventDefault();
        showUnifiedPaymentModal();
    }
});

// -----------------------------------------------------------------------------
// Tema (Theme) System
//
// To provide a customizable look and feel, this section defines several
// distinct themes and exposes functions to toggle a theme selection menu
// and apply a chosen theme. Each theme contains a unique palette for the
// overall page background, card surfaces, text colors and borders. When a
// theme is applied, an existing <style> tag with id "activeTheme" is removed
// and replaced with a new one containing the selected theme's CSS. This
// modular approach allows the rest of the application to rely on Tailwind
// classes while still enabling high-level theming via CSS overrides.

// An array of theme definitions. Each entry contains a descriptive name
// and a CSS string that overrides common colors. The CSS strings use
// '!important' where necessary to outrank Tailwind's defaults. Adjust or
// extend this array to change the available themes.
const themes = [
    {
        name: 'Tema 1',
        css: `
            body {
                background: linear-gradient(to bottom right, #eff6ff, #eef2ff);
            }
            .bg-white {
                background-color: #ffffff !important;
            }
            .bg-gray-50 {
                background-color: #f9fafb !important;
            }
            .bg-gray-100 {
                background-color: #f3f4f6 !important;
            }
            .text-gray-800 {
                color: #374151 !important;
            }
            .text-gray-700,
            .text-gray-600 {
                color: #4b5563 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #6b7280 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #e5e7eb !important;
            }

            /* Ensure product and service cards follow the theme colors */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #ffffff !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #e5e7eb !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark neutral override for Tema 1: dark colors and vertical sidebar layout */
            body { background-color: #0f172a !important; color: #e2e8f0 !important; }
            /* Sidebar and navigation layout */
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #1f2937 !important;
                border-right: 1px solid #334155 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #e2e8f0 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #334155 !important;
            }
            #navContainer button:hover {
                background-color: #334155 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            /* Override background colors */
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #1f2937 !important;
            }
            /* Override text colors */
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #f3f4f6 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #cbd5e1 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #334155 !important;
            }
            /* Card backgrounds and borders */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #1f2937 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #334155 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 2',
        css: `
            body {
                background: #0f172a;
                color: #e2e8f0;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #1f2937 !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #f3f4f6 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #9ca3af !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #334155 !important;
            }

            /* Theme colors for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #1f2937 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #334155 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark blue override for Tema 2: dark palette and vertical sidebar layout */
            body { background-color: #0a192f !important; color: #d1d5db !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #071e3d !important;
                border-right: 1px solid #0e3a63 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #d1d5db !important;
                background-color: transparent !important;
                border-bottom: 1px solid #0e3a63 !important;
            }
            #navContainer button:hover {
                background-color: #0e3a63 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #0e244a !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #e5e7eb !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #9ca3af !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #0e3a63 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #071e3d !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #0e3a63 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 3',
        css: `
            body {
                background: linear-gradient(to bottom right, #f0fdf4, #dcfce7);
            }
            .bg-white {
                background-color: #ffffff !important;
            }
            .bg-gray-50 {
                background-color: #f7fee7 !important;
            }
            .bg-gray-100 {
                background-color: #ecfccb !important;
            }
            .text-gray-800 {
                color: #064e3b !important;
            }
            .text-gray-700 {
                color: #065f46 !important;
            }
            .text-gray-600 {
                color: #047857 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #065f46 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #bbf7d0 !important;
            }

            /* Apply soft green palette to product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f7fee7 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #bbf7d0 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark green override for Tema 3: dark palette and vertical sidebar layout */
            body { background-color: #032d26 !important; color: #d1fae5 !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #064e3b !important;
                border-right: 1px solid #065f46 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #d1fae5 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #065f46 !important;
            }
            #navContainer button:hover {
                background-color: #065f46 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #064e3b !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #def7ec !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #6ee7b7 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #065f46 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #064e3b !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #065f46 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 4',
        css: `
            body {
                background: linear-gradient(to bottom right, #faf5ff, #ede9fe);
            }
            .bg-white {
                background-color: #ffffff !important;
            }
            .bg-gray-50 {
                background-color: #f5f3ff !important;
            }
            .bg-gray-100 {
                background-color: #ede9fe !important;
            }
            .text-gray-800 {
                color: #4c1d95 !important;
            }
            .text-gray-700 {
                color: #5b21b6 !important;
            }
            .text-gray-600 {
                color: #6b21a8 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #7c3aed !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #ddd6fe !important;
            }

            /* Purple palette for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f5f3ff !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #ddd6fe !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark purple override for Tema 4: dark palette and vertical sidebar layout */
            body { background-color: #2b1b4f !important; color: #e0e7ff !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #4c1d95 !important;
                border-right: 1px solid #5b21b6 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #e0e7ff !important;
                background-color: transparent !important;
                border-bottom: 1px solid #5b21b6 !important;
            }
            #navContainer button:hover {
                background-color: #5b21b6 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #4c1d95 !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #e0e7ff !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #c4b5fd !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #5b21b6 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #4c1d95 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #5b21b6 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 5',
        css: `
            body {
                background: linear-gradient(to bottom right, #eff6ff, #dbeafe);
            }
            .bg-white {
                background-color: #ffffff !important;
            }
            .bg-gray-50 {
                background-color: #eff6ff !important;
            }
            .bg-gray-100 {
                background-color: #dbeafe !important;
            }
            .text-gray-800 {
                color: #1e3a8a !important;
            }
            .text-gray-700 {
                color: #1e40af !important;
            }
            .text-gray-600 {
                color: #1e3a8a !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #2563eb !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #bfdbfe !important;
            }

            /* Blue palette for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #eff6ff !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #bfdbfe !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark teal override for Tema 5: dark palette and vertical sidebar layout */
            body { background-color: #073642 !important; color: #d1e7e7 !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #0d3b3b !important;
                border-right: 1px solid #134e4a !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #d1e7e7 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #134e4a !important;
            }
            #navContainer button:hover {
                background-color: #134e4a !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #0d3b3b !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #d1e7e7 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #5eead4 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #134e4a !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #0d3b3b !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #134e4a !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 6',
        css: `
            body {
                background: linear-gradient(to bottom right, #fff7ed, #ffedd5);
            }
            .bg-white {
                background-color: #ffffff !important;
            }
            .bg-gray-50 {
                background-color: #fff7ed !important;
            }
            .bg-gray-100 {
                background-color: #ffedd5 !important;
            }
            .text-gray-800 {
                color: #7c2d12 !important;
            }
            .text-gray-700 {
                color: #9a3412 !important;
            }
            .text-gray-600 {
                color: #c2410c !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #ea580c !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #fed7aa !important;
            }

            /* Orange palette for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #fff7ed !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #fed7aa !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark brown/orange override for Tema 6: dark palette and vertical sidebar layout */
            body { background-color: #3f1f0b !important; color: #fde68a !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #7c2d12 !important;
                border-right: 1px solid #9a3412 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #fde68a !important;
                background-color: transparent !important;
                border-bottom: 1px solid #9a3412 !important;
            }
            #navContainer button:hover {
                background-color: #9a3412 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #7c2d12 !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #fde68a !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #fcd34d !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #9a3412 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #7c2d12 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #9a3412 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 7',
        css: `
            body {
                background: #000000;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #111111 !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #ffffff !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #facc15 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #374151 !important;
            }

            /* High contrast palette for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #111111 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #374151 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* High contrast override for Tema 7: dark palette and vertical sidebar layout */
            body { background-color: #000000 !important; color: #f3f4f6 !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #111111 !important;
                border-right: 1px solid #333333 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #f3f4f6 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #333333 !important;
            }
            #navContainer button:hover {
                background-color: #222222 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #111111 !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #f3f4f6 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #eab308 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #333333 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #111111 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #333333 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 8',
        css: `
            body {
                background: #f8fafc;
            }
            .bg-white {
                background-color: #ffffff !important;
            }
            .bg-gray-50 {
                background-color: #f1f5f9 !important;
            }
            .bg-gray-100 {
                background-color: #e2e8f0 !important;
            }
            .text-gray-800 {
                color: #111827 !important;
            }
            .text-gray-700 {
                color: #1f2937 !important;
            }
            .text-gray-600 {
                color: #374151 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #475569 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #e5e7eb !important;
            }

            /* Minimal palette for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f1f5f9 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #e5e7eb !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark minimal grey override for Tema 8: dark palette and vertical sidebar layout */
            body { background-color: #1a1a2e !important; color: #e5e7eb !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #16192c !important;
                border-right: 1px solid #262b46 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #e5e7eb !important;
                background-color: transparent !important;
                border-bottom: 1px solid #262b46 !important;
            }
            #navContainer button:hover {
                background-color: #262b46 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #16192c !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #e5e7eb !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #a1a6c4 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #262b46 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #16192c !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #262b46 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 9',
        css: `
            body {
                background: linear-gradient(to bottom right, #fdf6e3, #fcefcf);
            }
            .bg-white {
                background-color: #fffaf0 !important;
            }
            .bg-gray-50 {
                background-color: #fdf6e3 !important;
            }
            .bg-gray-100 {
                background-color: #fef3c7 !important;
            }
            .text-gray-800 {
                color: #5b3a29 !important;
            }
            .text-gray-700 {
                color: #7c4a2d !important;
            }
            .text-gray-600 {
                color: #8f563b !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #a06b4f !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #fae8bd !important;
            }

            /* Warm beige palette for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #fdf6e3 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #fae8bd !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark warm brown override for Tema 9: dark palette and vertical sidebar layout */
            body { background-color: #2d1e16 !important; color: #f5e0c3 !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #3f2c23 !important;
                border-right: 1px solid #59351d !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #f5e0c3 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #59351d !important;
            }
            #navContainer button:hover {
                background-color: #59351d !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #3f2c23 !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #f5e0c3 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #e9cfa6 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #59351d !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #3f2c23 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #59351d !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    },
    {
        name: 'Tema 10',
        css: `
            body {
                background: linear-gradient(to bottom right, #fdf2f8, #fce7f3);
            }
            .bg-white {
                background-color: #ffffff !important;
            }
            .bg-gray-50 {
                background-color: #fdf2f8 !important;
            }
            .bg-gray-100 {
                background-color: #fce7f3 !important;
            }
            .text-gray-800 {
                color: #9d174d !important;
            }
            .text-gray-700 {
                color: #be185d !important;
            }
            .text-gray-600 {
                color: #e11d48 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #db2777 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #fbcfe8 !important;
            }

            /* Pastel pink palette for product and service cards */
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #fdf2f8 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #fbcfe8 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
            /* Dark pink override for Tema 10: dark palette and vertical sidebar layout */
            body { background-color: #341f2e !important; color: #fce7f3 !important; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #5b2c51 !important;
                border-right: 1px solid #7a3d63 !important;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #fce7f3 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #7a3d63 !important;
            }
            #navContainer button:hover {
                background-color: #7a3d63 !important;
            }
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button { width: 100% !important; }
            #contentContainer {
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white,
            .bg-gray-50,
            .bg-gray-100 {
                background-color: #5b2c51 !important;
            }
            .text-gray-800,
            .text-gray-700,
            .text-gray-600 {
                color: #fce7f3 !important;
            }
            .text-gray-500,
            .text-gray-400 {
                color: #fbcfe8 !important;
            }
            .border-gray-200,
            .border-gray-300 {
                border-color: #7a3d63 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #5b2c51 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 {
                border-color: #7a3d63 !important;
            }
            .bg-gradient-to-br {
                background-image: none !important;
            }
        `
    }
];
// Append additional Zen Minimal color variations (Themes 21-30) by injecting after the primary theme list.
const additionalThemes = [
    {
        name: 'Tema 21',
        css: `
            /* Zen Minimal Variation: Pastel Blue */
            body { background-color: #eff6ff; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #bfdbfe;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #1e3a8a !important;
                background-color: transparent !important;
                border-bottom: 1px solid #bfdbfe !important;
            }
            #navContainer button:hover {
                background-color: #dbeafe !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Match Zen Minimal layout: content starts after a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #eff6ff !important; }
            .bg-gray-100 { background-color: #dbeafe !important; }
            .text-gray-800 { color: #1e3a8a !important; }
            .text-gray-700 { color: #1d4ed8 !important; }
            .text-gray-600 { color: #2563eb !important; }
            .text-gray-500,
            .text-gray-400 { color: #3b82f6 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #bfdbfe !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #eff6ff !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #bfdbfe !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 22',
        css: `
            /* Zen Minimal Variation: Pastel Green */
            body { background-color: #f0fdf4; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #bbf7d0;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #064e3b !important;
                background-color: transparent !important;
                border-bottom: 1px solid #bbf7d0 !important;
            }
            #navContainer button:hover {
                background-color: #dcfce7 !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #f0fdf4 !important; }
            .bg-gray-100 { background-color: #dcfce7 !important; }
            .text-gray-800 { color: #064e3b !important; }
            .text-gray-700 { color: #047857 !important; }
            .text-gray-600 { color: #065f46 !important; }
            .text-gray-500,
            .text-gray-400 { color: #059669 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #bbf7d0 !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f0fdf4 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #bbf7d0 !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 23',
        css: `
            /* Zen Minimal Variation: Pastel Purple */
            body { background-color: #faf5ff; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #ddd6fe;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #4c1d95 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #ddd6fe !important;
            }
            #navContainer button:hover {
                background-color: #ede9fe !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #faf5ff !important; }
            .bg-gray-100 { background-color: #ede9fe !important; }
            .text-gray-800 { color: #4c1d95 !important; }
            .text-gray-700 { color: #5b21b6 !important; }
            .text-gray-600 { color: #6b21a8 !important; }
            .text-gray-500,
            .text-gray-400 { color: #7c3aed !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #ddd6fe !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #faf5ff !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #ddd6fe !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 24',
        css: `
            /* Zen Minimal Variation: Pastel Orange */
            body { background-color: #fff7ed; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #fed7aa;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #7c2d12 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #fed7aa !important;
            }
            #navContainer button:hover {
                background-color: #ffedd5 !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #fff7ed !important; }
            .bg-gray-100 { background-color: #ffedd5 !important; }
            .text-gray-800 { color: #7c2d12 !important; }
            .text-gray-700 { color: #9a3412 !important; }
            .text-gray-600 { color: #c2410c !important; }
            .text-gray-500,
            .text-gray-400 { color: #ea580c !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #fed7aa !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #fff7ed !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #fed7aa !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 25',
        css: `
            /* Zen Minimal Variation: Pastel Yellow */
            body { background-color: #fffbeb; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #fde68a;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #92400e !important;
                background-color: transparent !important;
                border-bottom: 1px solid #fde68a !important;
            }
            #navContainer button:hover {
                background-color: #fef3c7 !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #fffbeb !important; }
            .bg-gray-100 { background-color: #fef3c7 !important; }
            .text-gray-800 { color: #92400e !important; }
            .text-gray-700 { color: #b45309 !important; }
            .text-gray-600 { color: #d97706 !important; }
            .text-gray-500,
            .text-gray-400 { color: #eab308 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #fde68a !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #fffbeb !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #fde68a !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 26',
        css: `
            /* Zen Minimal Variation: Pastel Pink */
            body { background-color: #fdf2f8; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #fbcfe8;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #9d174d !important;
                background-color: transparent !important;
                border-bottom: 1px solid #fbcfe8 !important;
            }
            #navContainer button:hover {
                background-color: #fce7f3 !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #fdf2f8 !important; }
            .bg-gray-100 { background-color: #fce7f3 !important; }
            .text-gray-800 { color: #9d174d !important; }
            .text-gray-700 { color: #be185d !important; }
            .text-gray-600 { color: #e11d48 !important; }
            .text-gray-500,
            .text-gray-400 { color: #db2777 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #fbcfe8 !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #fdf2f8 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #fbcfe8 !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 27',
        css: `
            /* Zen Minimal Variation: Earth Tones */
            body { background-color: #f3eee9; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #d7ccc8;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #7f5539 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #d7ccc8 !important;
            }
            #navContainer button:hover {
                background-color: #e8dad4 !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #f9f5f0 !important; }
            .bg-gray-100 { background-color: #f3eee9 !important; }
            .text-gray-800 { color: #7f5539 !important; }
            .text-gray-700 { color: #9a6c52 !important; }
            .text-gray-600 { color: #b28a6a !important; }
            .text-gray-500,
            .text-gray-400 { color: #cba682 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #d7ccc8 !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f3eee9 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #d7ccc8 !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 28',
        css: `
            /* Zen Minimal Variation: Teal */
            body { background-color: #f0fdfa; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #99f6e4;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #0f766e !important;
                background-color: transparent !important;
                border-bottom: 1px solid #99f6e4 !important;
            }
            #navContainer button:hover {
                background-color: #ccfbf1 !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #f0fdfa !important; }
            .bg-gray-100 { background-color: #ccfbf1 !important; }
            .text-gray-800 { color: #0f766e !important; }
            .text-gray-700 { color: #115e59 !important; }
            .text-gray-600 { color: #134e4a !important; }
            .text-gray-500,
            .text-gray-400 { color: #0d9488 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #99f6e4 !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f0fdfa !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #99f6e4 !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 29',
        css: `
            /* Zen Minimal Variation: Gray */
            body { background-color: #f8fafc; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #d1d5db;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #374151 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #d1d5db !important;
            }
            #navContainer button:hover {
                background-color: #e5e7eb !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #f8fafc !important; }
            .bg-gray-100 { background-color: #e5e7eb !important; }
            .text-gray-800 { color: #374151 !important; }
            .text-gray-700 { color: #475569 !important; }
            .text-gray-600 { color: #64748b !important; }
            .text-gray-500,
            .text-gray-400 { color: #6b7280 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #d1d5db !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f8fafc !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #d1d5db !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    },
    {
        name: 'Tema 30',
        css: `
            /* Zen Minimal Variation: Blue Gray */
            body { background-color: #f3f4f6; }
            #navWrapper {
                position: fixed;
                top: 0;
                left: 0;
                width: 120px;
                height: 100%;
                background-color: #ffffff;
                border-right: 1px solid #cbd5e1;
                z-index: 30;
            }
            #navContainer { flex-direction: column !important; }
            #navContainer button {
                justify-content: flex-start !important;
                padding: 0.5rem 1rem !important;
                color: #4b5563 !important;
                background-color: transparent !important;
                border-bottom: 1px solid #cbd5e1 !important;
            }
            #navContainer button:hover {
                background-color: #e5e7eb !important;
            }
            /* For Zen Minimal layouts: orient the nav buttons vertically and disable horizontal overflow */
            #navContainer > div {
                flex-direction: column !important;
                overflow-x: hidden !important;
                border-bottom: none !important;
            }
            #navContainer > div button {
                width: 100% !important;
            }
            #contentContainer {
                /* Align main content next to a 120px sidebar */
                margin-left: 120px !important;
                margin-right: 0 !important;
            }
            .bg-white { background-color: #ffffff !important; }
            .bg-gray-50 { background-color: #f3f4f6 !important; }
            .bg-gray-100 { background-color: #e5e7eb !important; }
            .text-gray-800 { color: #4b5563 !important; }
            .text-gray-700 { color: #374151 !important; }
            .text-gray-600 { color: #1f2937 !important; }
            .text-gray-500,
            .text-gray-400 { color: #6b7280 !important; }
            .border-gray-200,
            .border-gray-300 { border-color: #cbd5e1 !important; }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .from-purple-50,
            .to-purple-100 {
                background-image: none !important;
                background-color: #f3f4f6 !important;
            }
            .stock-critical,
            .stock-low,
            .stock-ok,
            .border-purple-300 { border-color: #cbd5e1 !important; }
            .bg-gradient-to-br { background-image: none !important; }
        `
    }
];
// Extend the themes array with Zen Minimal variations
themes.push(...additionalThemes);

/**
 * Toggle the visibility of the theme selection menu. When called, this
 * function locates the element with id "themeMenu" and toggles its
 * "hidden" class. If the menu is currently hidden, it will slide into view;
 * otherwise it will disappear.
 */
function toggleThemeMenu() {
    const menu = document.getElementById('themeMenu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}
// Expose globally for inline onclick handlers
window.toggleThemeMenu = toggleThemeMenu;

/**
 * Apply a theme by its index (1-based). This function removes any
 * previously applied theme by deleting the existing <style id="activeTheme">
 * element. It then creates a new <style> element, assigns it the same id,
 * populates it with the CSS of the selected theme, and appends it to
 * document.head. After applying the theme, the theme menu is hidden.
 *
 * @param {number} idx The 1-based index of the theme to apply.
 */
function applyTheme(idx) {
    // Determine the zero-based index within the themes array.  The first 10
    // themes map directly (1→0, 2→1, ..., 10→9).  Additional Zen Minimal
    // variants are numbered 21–30 in the UI but occupy positions 10–19
    // internally.  For these, subtract 11 from the requested number to map
    // 21→10, 22→11, ..., 30→19.  If other numbers are passed they map
    // normally or are ignored when out of range.
    const idNum = parseInt(idx, 10);
    let index;
    if (isNaN(idNum)) {
        return;
    }
    if (idNum >= 21) {
        index = idNum - 11;
    } else {
        index = idNum - 1;
    }
    if (index < 0 || index >= themes.length) return;
    // Remove old theme
    const oldStyle = document.getElementById('activeTheme');
    if (oldStyle && oldStyle.parentNode) {
        oldStyle.parentNode.removeChild(oldStyle);
    }
    // Create new style element for the selected theme
    const style = document.createElement('style');
    style.id = 'activeTheme';
    style.textContent = themes[index].css;
    document.head.appendChild(style);
    // Hide the menu after applying
    const menu = document.getElementById('themeMenu');
    if (menu) menu.classList.add('hidden');
}
// Expose globally for inline onclick handlers
window.applyTheme = applyTheme;

// -----------------------------------------------------------------------------
// Login functionality
// -----------------------------------------------------------------------------
/**
 * Initialize the login overlay.  This function should be called once the
 * DOM has finished loading.  It checks if a user is already logged in by
 * reading from localStorage.  If so, the overlay is hidden.  Otherwise,
 * the overlay is displayed, and a click handler is attached to the login
 * button to process authentication via Google Apps Script.
 */
function initializeLogin() {
    const loginOverlay = document.getElementById('loginOverlay');
    const loginButton = document.getElementById('loginButton');
    if (!loginOverlay || !loginButton) {
        return;
    }
    // Determine login state and show or hide overlay accordingly
    const loggedIn = localStorage.getItem('loggedIn') === 'true';
    if (loggedIn) {
        loginOverlay.classList.add('hidden');
    } else {
        loginOverlay.classList.remove('hidden');
    }
    // Toggle visibility of the logout button based on login state
    const logoutBtn = document.getElementById('logoutButton');
    if (logoutBtn) {
        if (loggedIn) {
            logoutBtn.classList.remove('hidden');
        } else {
            logoutBtn.classList.add('hidden');
        }
    }
    // Attach a single submit handler to the login form.  This ensures both clicking the login button
    // and pressing Enter in the username/password fields trigger loginUser() exactly once.  We
    // prevent the default submit behaviour to avoid a page reload.  Note: we intentionally do not
    // attach a separate click listener to the login button, because submitting the form already
    // triggers this handler and avoids duplicate calls.
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        // Remove any existing submit listeners to prevent duplicate bindings if initializeLogin()
        // is accidentally called more than once.
        loginForm.onsubmit = null;
        loginForm.addEventListener('submit', function(e) {
            e.preventDefault();
            loginUser();
        });
    }

    // Bind Enter key on username and password inputs to trigger login.  While the form's submit
    // handler should normally fire when the user presses Enter, browsers may not submit forms
    // automatically when multiple inputs are present.  This explicit handler ensures pressing
    // Enter in either field triggers loginUser() exactly once.  Duplicate handlers are cleared
    // by overwriting the onkeydown property prior to assignment.
    const usernameField = document.getElementById('loginUsername');
    const passwordField = document.getElementById('loginPassword');
    const bindEnterKey = (input) => {
        if (!input) return;
        input.onkeydown = null;
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                loginUser();
            }
        });
    };
    bindEnterKey(usernameField);
    bindEnterKey(passwordField);

    // We no longer need a click handler here because the form's submit event covers both button
    // clicks and pressing Enter.  Additional keypress listeners are unnecessary.

    // If a user is already logged in on page load, we previously attempted
    // to synchronise any pending data immediately.  Automatic synchronisation
    // has been removed to avoid unexpected exports and potential data races.
    // Pending changes will remain until the user manually triggers an export.
    //if (loggedIn) {
    //    syncPendingData();
    //}
}

/**
 * Authenticate the user against the Google Apps Script endpoint.  It sends
 * the username and password as query parameters to the script URL with
 * action=login.  The Apps Script should return JSON with a 'success'
 * property and optionally a 'message' or 'user' object.  On success, this
 * function stores the login state in localStorage and hides the overlay.
 * On failure, it displays an error message.
 */
async function loginUser() {
    const usernameInput = document.getElementById('loginUsername');
    const passwordInput = document.getElementById('loginPassword');
    const errorDiv = document.getElementById('loginError');
    const overlay = document.getElementById('loginOverlay');
    // Elements for loading state and login button
    const loadingDiv = document.getElementById('loginLoading');
    const loginBtn = document.getElementById('loginButton');
    if (!usernameInput || !passwordInput || !errorDiv || !overlay) {
        return;
    }
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    // Hide any previous error message
    errorDiv.classList.add('hidden');
    // Simple validation: ensure fields are not empty
    if (!username || !password) {
        errorDiv.textContent = 'Nama pengguna dan kata sandi wajib diisi.';
        errorDiv.classList.remove('hidden');
        return;
    }
    // Show loading indicator and disable the login button while verifying credentials
    if (loadingDiv) {
        loadingDiv.classList.remove('hidden');
    }
    if (loginBtn) {
        loginBtn.disabled = true;
        // Add classes to visually indicate disabled state
        loginBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    try {
        const params = new URLSearchParams({
            action: 'login',
            username: username,
            password: password
        });
        const response = await fetch(`${GOOGLE_APPS_SCRIPT_URL}?${params.toString()}`);
        if (!response.ok) {
            throw new Error('Network error: ' + response.status);
        }
        const result = await response.json();
        if (result.success) {
            // Save login state
            localStorage.setItem('loggedIn', 'true');
            if (result.user) {
                localStorage.setItem('loggedUser', JSON.stringify(result.user));
            }
            overlay.classList.add('hidden');
            // Show the logout button now that the user is logged in
            const logoutBtn = document.getElementById('logoutButton');
            if (logoutBtn) {
                logoutBtn.classList.remove('hidden');
            }

            // After a successful login, process any queued delta operations
            // created while offline.  This will send individual add/update/delete
            // requests to the server without performing a full export.  If the
            // queue is empty or the user is offline, this call returns immediately.
            processPendingDeltas(true);
            // Hide loading indicator and re-enable login button
            if (loadingDiv) {
                loadingDiv.classList.add('hidden');
            }
            if (loginBtn) {
                loginBtn.disabled = false;
                loginBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        } else {
            // Display error returned from server or generic message
            const message = result.message || 'Nama pengguna atau kata sandi salah.';
            errorDiv.textContent = message;
            errorDiv.classList.remove('hidden');
            // Hide loading indicator and re-enable login button on error
            if (loadingDiv) {
                loadingDiv.classList.add('hidden');
            }
            if (loginBtn) {
                loginBtn.disabled = false;
                loginBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    } catch (err) {
        console.error('Login error:', err);
        errorDiv.textContent = 'Terjadi kesalahan saat masuk. Silakan coba lagi.';
        errorDiv.classList.remove('hidden');
        // Hide loading indicator and re-enable login button on network or code error
        if (loadingDiv) {
            loadingDiv.classList.add('hidden');
        }
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
}

/**
 * Log out the current user.  This function clears any stored login state
 * from localStorage, hides the logout button and shows the login overlay
 * again so that another user can authenticate.  After logging out, the
 * application remains loaded but interaction is blocked by the overlay.
 */
function logout() {
    // Remove login-related keys from localStorage
    localStorage.removeItem('loggedIn');
    localStorage.removeItem('loggedUser');
    // Show the login overlay again
    const overlay = document.getElementById('loginOverlay');
    if (overlay) {
        overlay.classList.remove('hidden');
    }
    // Hide the logout button
    const btn = document.getElementById('logoutButton');
    if (btn) {
        btn.classList.add('hidden');
    }

    // Clear the username and password fields so they are blank for the next login
    const usernameField = document.getElementById('loginUsername');
    if (usernameField) {
        usernameField.value = '';
    }
    const passwordField = document.getElementById('loginPassword');
    if (passwordField) {
        passwordField.value = '';
    }
}

/**
 * Trigger a manual synchronisation of any pending changes to Google Sheets.
 * This function should be invoked by the Export button on the Analisa tab.
 * It calls syncPendingData(true) to process any offline deltas and
 * perform an incremental sync, displaying a loading overlay during the
 * operation.  Because automatic export has been disabled, this is the
 * only mechanism by which changes are sent to Google Sheets.
 */
function manualExport() {
    // Only attempt an export if there are pending changes.  If nothing is
    // pending, simply notify the user and return.
    if (!syncPending) {
        alert('Tidak ada perubahan yang perlu diekspor.');
        return;
    }
    // Trigger the synchronisation with a loading indicator.  The
    // syncPendingData function will clear the pending flag on success.
    syncPendingData(true);
}
// Expose login functions to allow external scripts or debugging if needed
window.initializeLogin = initializeLogin;
window.loginUser = loginUser;
window.logout = logout;
// Expose manual export function so it can be called from the Analisa tab
window.manualExport = manualExport;
// Expose sync control functions for the UI
window.toggleAutoSync = toggleAutoSync;
window.showPendingChangesModal = showPendingChangesModal;
window.closePendingChangesModal = closePendingChangesModal;
// Expose sync history modal functions for use by HTML buttons
window.showSyncHistoryModal = showSyncHistoryModal;
window.closeSyncHistoryModal = closeSyncHistoryModal;

// Apply the default theme (Theme 1) once the DOM is fully loaded. This
// ensures consistent styling from the moment the page finishes rendering.
document.addEventListener('DOMContentLoaded', () => {
    applyTheme(1);
    // After applying the default theme, initialize the login overlay.
    // This ensures the login overlay is properly toggled based on the stored login state
    // before the user interacts with the application.
    initializeLogin();
    // Update sync status UI on initial load
    updateSyncStatus();
});
