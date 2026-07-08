/* AgentBoard service worker — Web Push receiver.
   Kept minimal on purpose: no asset caching (the app is cache-busted server-side
   and must never be served stale — see CLAUDE.md). This SW exists only to render
   push notifications when the tab is closed and to focus the app on click. */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (_) { data = {} }
  const title = data.title || 'AgentBoard'
  const options = {
    body: data.body || '',
    tag: data.tag || 'agentboard',        // same tag replaces the previous notif for that session
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of all) {
      // Reuse an open tab: focus it and tell the app which session to open.
      if ('focus' in client) {
        await client.focus()
        client.postMessage({ type: 'open-session', url })
        return
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})
