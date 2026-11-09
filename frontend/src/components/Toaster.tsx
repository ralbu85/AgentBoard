import { reloadApp, useAppUpdate } from '../appUpdate'
import { useToasts } from '../toasts'

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  const outdated = useAppUpdate((s) => s.outdated)
  if (toasts.length === 0 && !outdated) return null
  return (
    <div className="toaster">
      {outdated && (
        <div className="toast toast-info app-update" role="status">
          <span>AgentBoard가 새 버전으로 바뀌었습니다. 이 화면은 이전 버전입니다.</span>
          <button onClick={() => void reloadApp()}>새로고침</button>
        </div>
      )}
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
