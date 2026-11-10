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
      adaptiveColumns: (typeof saved?.adaptiveColumns === 'boolean' ? saved.adaptiveColumns : true),
    }
  } catch { return { ...fallback } }
}
// Viewport scaling never changes the terminal's source columns or rows.
export function viewportScale(width:number,gridWidth:number,fit:boolean){
  return fit&&gridWidth>0?Math.min(1,Math.max(0.1,width/gridWidth)):1
}

// Extra display rows show scrollback above the source screen.
export function viewportRows(height:number,cellHeight:number,scale:number,sourceRows:number,expand:boolean) {
  if(!expand||cellHeight<=0||scale<=0)return sourceRows
  return Math.max(sourceRows,Math.min(200,Math.floor(height/(cellHeight*scale))))
}


export function desktopColumns(width:number,cellWidth:number) {
  return cellWidth>0?Math.max(80,Math.min(240,Math.floor(width/cellWidth))):80
}

// Every width change makes the app redraw: Claude Code prints its last answer
// again below the old copy, and tmux re-wraps the tables above it. A pane within
// 10% of the current width keeps it; the display scales or leaves a margin.
export function settledColumns(fit:number,current?:number) {
  return current!==undefined&&fit>=current*0.9&&fit<=current*1.1?current:fit
}
