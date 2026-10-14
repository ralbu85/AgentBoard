import type { Session } from './types'

const statuses = {
  working: {label:'작업 중', icon:''},
  waiting: {label:'입력 대기', icon:'◆'},
  completed: {label:'완료', icon:'✓'},
  idle: {label:'대기', icon:'○'},
  stopped: {label:'종료', icon:'■'},
  disconnected: {label:'연결 끊김', icon:'×'},
  running: {label:'확인 중', icon:'…'},
}

export function sessionStatus(session: Session | undefined, activity: string | null) {
  // Acknowledging a result clears its unread marker, not the fact it finished.
  // Current work/waiting/disconnection always takes precedence over old results.
  const value = activity === 'idle' && session?.completionEvent ? 'completed' : activity || 'running'
  const state = Object.prototype.hasOwnProperty.call(statuses, value) ? value as keyof typeof statuses : 'running'
  return {state, ...statuses[state]}
}

export type SessionStatusInfo = ReturnType<typeof sessionStatus>
