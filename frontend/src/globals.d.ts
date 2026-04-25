interface WsDebug {
  screenCount: number
  lastScreenId: string
  lastScreenLen: number
  snapshotCount: number
  notifyActiveCount?: number
  lastNotifyActive?: string | null
  wsState?: number
}

interface Window {
  __wsDebug: WsDebug
}

// Vite ?raw imports — content as string
declare module '*?raw' {
  const content: string
  export default content
}
