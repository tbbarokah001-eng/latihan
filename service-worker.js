/*
 * Service Worker for KasirYes
 *
 * This service worker is responsible for receiving background sync events
 * triggered by the application via the SyncManager API.  When a sync
 * event fires (e.g. when network connectivity returns), the service
 * worker broadcasts a message to all connected clients (browser tabs)
 * instructing them to process any queued pending deltas.  The actual
 * synchronisation logic remains in the main application code, which
 * responds to the 'sync' message by calling processPendingDeltas().
 */

self.addEventListener('install', event => {
    // Skip waiting so that the newly installed service worker becomes
    // active immediately.  Without this call, a new service worker
    // waits until existing clients are closed before it takes control.
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    // Claim control of any existing clients as soon as the service
    // worker activates.  This ensures that pages loaded before the
    // service worker was installed can still receive messages.
    event.waitUntil(self.clients.claim());
});

self.addEventListener('sync', event => {
    if (event.tag === 'kasir-sync') {
        event.waitUntil(handleSyncEvent());
    }
});

/**
 * Handle a sync event by notifying all connected clients.  We avoid
 * performing fetches directly in the service worker to keep the logic
 * contained in the page, where IndexedDB and other stateful APIs are
 * already available.  If there are no clients, the message will be
 * dropped silently.
 */
async function handleSyncEvent() {
    try {
        const clientList = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clientList) {
            client.postMessage({ type: 'sync' });
        }
    } catch (err) {
        // Ignore errors; background sync will retry automatically.
    }
}