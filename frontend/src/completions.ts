import type {Session} from './types'

// Keep event identities independently of the live session snapshot. A reconnect
// or delayed replay must not turn an acknowledged event into a new notification.
export function observeCompletion(session: Session, event: string, snapshot = false): boolean {
  if (!event) return false
  const key = 'agentboard.completionEvents.' + JSON.stringify([session.host || 'local', session.sessionName || session.id])
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || 'null')
    const seen = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    if (seen.includes(event)) return false
    localStorage.setItem(key, JSON.stringify([...seen, event].slice(-100)))
    return !snapshot || seen.length > 0
  } catch { return !snapshot && event !== session.completionId }
}
