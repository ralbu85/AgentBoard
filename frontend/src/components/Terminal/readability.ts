export interface TerminalPreferences { fontSize: number; lineHeight: number; adaptiveColumns: boolean }
const defaults: TerminalPreferences = { fontSize: 15, lineHeight: 1, adaptiveColumns: true }
export const terminalPreferenceKey = (mobile = window.innerWidth <= 768) => mobile ? 'agentboard.terminalPreferences.mobile' : 'agentboard.terminalPreferences'
export function loadTerminalPreferences(mobile = window.innerWidth <= 768): TerminalPreferences {
  const fallback = {...defaults, fontSize: mobile ? 12 : 15}
  try {
    const saved = JSON.parse(localStorage.getItem(terminalPreferenceKey(mobile)) || 'null')
    return {
      fontSize: Number.isFinite(saved?.fontSize) ? Math.min(22, Math.max(12, saved.fontSize)) : fallback.fontSize,
      lineHeight: 1, // Compact spacing also replaces the previous persisted 1.25 default.
      adaptiveColumns: mobile || (typeof saved?.adaptiveColumns === 'boolean' ? saved.adaptiveColumns : true),
    }
  } catch { return { ...fallback } }
}
export function terminalGeometry(width: number, height: number, cellWidth: number, cellHeight: number, adaptive: boolean) {
  return {
    cols: adaptive ? Math.max(30, Math.min(80, Math.floor(Math.max(0, width) / cellWidth))) : 80,
    rows: Math.max(40, Math.min(200, Math.floor(Math.max(0, height) / cellHeight))),
  }
}
