// Preload bridge: exposes a minimal, safe API to the renderer.
// No Node.js access leaks into the web page (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  resizeWindow: (height) => ipcRenderer.invoke('resize-window', height),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  pickAvatarPhoto: () => ipcRenderer.invoke('pick-avatar-photo'),
  getCustomAvatar: () => ipcRenderer.invoke('get-custom-avatar'),
  snooze: (type) => ipcRenderer.send('snooze', type),
  bubbleDismissed: () => ipcRenderer.send('bubble-dismissed'),
  runAway: () => ipcRenderer.send('run-away'),
  onWalkStart: (callback) => ipcRenderer.on('walk-start', () => callback()),
  hideWindow: () => ipcRenderer.send('hide-window'),
  quitApp: () => ipcRenderer.send('quit-app'),
  previewReminder: (type) => ipcRenderer.send('preview-reminder', type),
  onReminder: (callback) => ipcRenderer.on('reminder', (_event, data) => callback(data)),
  onSettingsUpdated: (callback) =>
    ipcRenderer.on('settings-updated', (_event, data) => callback(data)),
  // End-to-end test override for the bubble auto-hide delay (milliseconds).
  // Null in normal runs, which means the 90-second default in renderer.js.
  autohideMs: (() => {
    const raw = parseInt(process.env.PCC_E2E_AUTOHIDE_MS || '', 10);
    return Number.isFinite(raw) ? Math.min(120000, Math.max(1000, raw)) : null;
  })(),
});
