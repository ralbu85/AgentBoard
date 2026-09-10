import {create} from 'zustand'
function read(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem('agentboard.inputDrafts') || '{}')
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch { return {} }
}
export const useDrafts = create<{
  drafts: Record<string, string>
  write: (key: string, value: string | ((previous: string) => string)) => void
}>((set) => ({
  drafts: read(),
  write: (key, value) => set(state => {
    const text = typeof value === 'function' ? value(state.drafts[key] || '') : value
    const drafts = {...state.drafts}
    if (text) drafts[key] = text
    else delete drafts[key]
    try { localStorage.setItem('agentboard.inputDrafts', JSON.stringify(drafts)) } catch {}
    return {drafts}
  }),
}))
