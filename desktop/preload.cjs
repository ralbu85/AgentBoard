const {contextBridge, ipcRenderer} = require('electron')

// Only the application view has this preload; web pages have no Node/IPC bridge.
contextBridge.exposeInMainWorld('agentboardDesktop', {
  invoke: (message) => ipcRenderer.invoke('desktop-browser', message),
  subscribe: (callback) => {
    const listener = (_event, message) => callback(message)
    ipcRenderer.on('desktop-browser-event', listener)
    return () => ipcRenderer.removeListener('desktop-browser-event', listener)
  },
})
