import { useState } from 'react'
import { sessionLabel, useStore } from '../../store'
import { useDrafts } from '../Terminal/drafts'

/** Puts a file's memos into the input of a session of this workspace. Nothing
 *  is sent: the reader checks the request there first. Text files and PDFs. */
export function MemoChatButton({ ownerKey, count, disabled, compose }: { ownerKey: string; count: number; disabled?: boolean; compose: () => string }) {
  const sessions = useStore(s => s.sessions)
  const titles = useStore(s => s.titles)
  const activeId = useStore(s => s.activeId)
  const [chosen, choose] = useState('')
  const running = Object.values(sessions).filter(s => JSON.stringify([s.host || 'local', s.cwd || '~']) === ownerKey && s.status === 'running' && s.online !== false)
  const target = running.some(s => s.id === chosen) ? chosen : running.some(s => s.id === activeId) ? activeId || '' : running.length === 1 ? running[0].id : ''
  const put = () => {
    const session = sessions[target]
    if (!session || disabled || !count) return
    const key = JSON.stringify([session.host || 'local', session.id, session.cwd || '~'])
    useDrafts.getState().write(key, previous => [previous, compose()].filter(Boolean).join('\n\n'))
    useStore.getState().setActive(target)
  }
  return <>
    <select className="memo-target-select" aria-label="메모를 받을 세션" value={target} onChange={e => choose(e.target.value)}>
      <option value="">대상 세션 선택</option>
      {running.map(s => <option key={s.id} value={s.id}>{sessionLabel(s, titles)}</option>)}
    </select>
    <button className="vtab-action vtab-send" disabled={disabled || !target || !count} onClick={put} title="기존 입력에 메모를 추가합니다. 전송 전 내용을 확인하세요.">채팅에 넣기 · {count}</button>
  </>
}
