import type { SessionStatusInfo } from '../sessionStatus'

export function SessionStatusBadge({status, className = ''}: {status: SessionStatusInfo; className?: string}) {
  return <span className={`session-status-badge status-${status.state} ${className}`} data-status={status.state}>
    <span className="session-status-symbol" aria-hidden="true">{status.icon}</span>
    <span>{status.label}</span>
  </span>
}
