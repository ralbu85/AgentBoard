import { useState, useEffect } from 'react'
import { useStore } from '../../store'
import type { SpawnProfile } from '../../types'

// In-app editor for launch profiles (what the "+ | ▾" launcher offers).
export function ProfileEditor() {
  const open = useStore((s) => s.profileEditorOpen)
  const close = useStore((s) => s.closeProfileEditor)
  const profiles = useStore((s) => s.profiles)
  const saveProfiles = useStore((s) => s.saveProfiles)
  const [rows, setRows] = useState<SpawnProfile[]>([])

  useEffect(() => { if (open) setRows(profiles.map((p) => ({ ...p }))) }, [open])
  if (!open) return null

  const update = (i: number, key: keyof SpawnProfile, val: string) =>
    setRows((r) => r.map((p, idx) => (idx === i ? { ...p, [key]: val } : p)))
  const setDefault = (i: number) =>
    setRows((r) => r.map((p, idx) => ({ ...p, default: idx === i })))
  const del = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i))
  const add = () =>
    setRows((r) => [...r, { id: `p${Date.now()}`, label: '새 프로필', icon: '›', command: 'claude', default: r.length === 0 }])

  const save = () => {
    const cleaned = rows.filter((p) => p.label.trim() && p.command.trim())
    if (cleaned.length && !cleaned.some((p) => p.default)) cleaned[0].default = true
    saveProfiles(cleaned)
    close()
  }

  return (
    <div className="spawn-backdrop" onClick={close}>
      <div className="spawn-modal profile-editor" onClick={(e) => e.stopPropagation()}>
        <div className="spawn-header">
          <span>실행 프로필 편집</span>
          <button className="btn btn-xs" onClick={close}>&times;</button>
        </div>
        <div className="spawn-body">
          <div className="pe-hint">
            "+" 버튼에 뜨는 세션 실행 프로필입니다. 명령에 플래그·env를 넣을 수 있어요
            (예: <code>claude --dangerously-skip-permissions</code>, <code>claude --resume</code>).
            ◉ = 기본(“+” 클릭 시 실행).
          </div>
          <div className="pe-head">
            <span style={{ width: 22 }}></span>
            <span style={{ width: 40 }}>아이콘</span>
            <span style={{ flex: '0 0 120px' }}>이름</span>
            <span style={{ flex: 1 }}>명령</span>
            <span style={{ width: 26 }}></span>
          </div>
          {rows.map((p, i) => (
            <div className="pe-row" key={i}>
              <input className="pe-default" type="radio" name="pe-default" checked={!!p.default} onChange={() => setDefault(i)} title="기본" />
              <input className="pe-icon" value={p.icon} onChange={(e) => update(i, 'icon', e.target.value)} placeholder="🤖" maxLength={4} />
              <input className="pe-label" value={p.label} onChange={(e) => update(i, 'label', e.target.value)} placeholder="이름" />
              <input className="pe-cmd" value={p.command} onChange={(e) => update(i, 'command', e.target.value)} placeholder="claude --flag" spellCheck={false} />
              <button className="pe-del" onClick={() => del(i)} title="삭제">🗑</button>
            </div>
          ))}
          <button className="pe-add" onClick={add}>+ 프로필 추가</button>
        </div>
        <div className="spawn-footer">
          <button className="btn" onClick={close}>취소</button>
          <button className="btn btn-primary" onClick={save}>저장</button>
        </div>
      </div>
    </div>
  )
}
