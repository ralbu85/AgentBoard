export interface TerminalPreferences { fontSize: number; lineHeight: number; adaptiveColumns: boolean }
const defaults: TerminalPreferences = { fontSize: 15, lineHeight: 1.25, adaptiveColumns: true }
export function loadTerminalPreferences(): TerminalPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem('agentboard.terminalPreferences') || 'null')
    return {
      fontSize: Number.isFinite(saved?.fontSize) ? Math.min(22, Math.max(12, saved.fontSize)) : defaults.fontSize,
      lineHeight: Number.isFinite(saved?.lineHeight) ? Math.min(1.5, Math.max(1, saved.lineHeight)) : defaults.lineHeight,
      adaptiveColumns: typeof saved?.adaptiveColumns === 'boolean' ? saved.adaptiveColumns : true,
    }
  } catch { return { ...defaults } }
}
export function terminalGeometry(width: number, height: number, cellWidth: number, cellHeight: number, adaptive: boolean) {
  return {
    cols: adaptive ? Math.max(30, Math.min(80, Math.floor(Math.max(0, width) / cellWidth))) : 80,
    rows: Math.max(40, Math.min(200, Math.floor(Math.max(0, height) / cellHeight))),
  }
}
