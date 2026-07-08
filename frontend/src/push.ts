// Web Push subscription lifecycle (browser side).
// The service worker (/sw.js) renders notifications; this module wires the
// subscription to the backend and exposes enable/disable for the Header toggle.
import { api } from './api'

function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch {
    return null
  }
}

export async function notificationsEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return false
  return !!(await reg.pushManager.getSubscription())
}

export type EnableResult = 'ok' | 'denied' | 'unsupported' | 'error'

export async function enableNotifications(): Promise<EnableResult> {
  if (!pushSupported()) return 'unsupported'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'denied'
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSW())
  if (!reg) return 'error'
  await navigator.serviceWorker.ready
  try {
    const { key } = await api.pushKey()
    if (!key) return 'error'
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      }))
    const j = sub.toJSON() as { endpoint?: string; keys?: object; expirationTime?: number | null }
    await api.pushSubscribe({ endpoint: j.endpoint, keys: j.keys, expirationTime: j.expirationTime ?? null })
    return 'ok'
  } catch {
    return 'error'
  }
}

export async function disableNotifications(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = reg && (await reg.pushManager.getSubscription())
  if (sub) {
    try {
      await api.pushUnsubscribe(sub.endpoint)
    } catch {
      /* best-effort */
    }
    await sub.unsubscribe()
  }
}
