'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer gets. Context isolation is on and node
 * integration is off, so everything the UI can do is enumerated here.
 */
contextBridge.exposeInMainWorld('api', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  parseProxies: (text, defaultScheme) =>
    ipcRenderer.invoke('proxies:parse', { text, defaultScheme }),

  startCheck: (text, defaultScheme) => ipcRenderer.invoke('check:start', { text, defaultScheme }),
  cancelCheck: () => ipcRenderer.invoke('check:cancel'),
  checkOwnIp: () => ipcRenderer.invoke('check:own-ip'),

  importFile: () => ipcRenderer.invoke('file:import'),
  exportFile: (content, defaultName, kind) =>
    ipcRenderer.invoke('file:export', { content, defaultName, kind }),

  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // Embedded iphub.info viewer (user-driven; read by a person, not the app).
  lookupInViewer: (ip, bounds) => ipcRenderer.invoke('viewer:lookup', { ip, bounds }),
  setViewerBounds: (bounds) => ipcRenderer.invoke('viewer:bounds', bounds),
  reloadViewer: () => ipcRenderer.invoke('viewer:reload'),
  viewerBack: () => ipcRenderer.invoke('viewer:back'),
  viewerExternal: () => ipcRenderer.invoke('viewer:external'),
  closeViewer: () => ipcRenderer.invoke('viewer:close'),
  onViewerState: (fn) => subscribe('viewer:state', fn),

  // Streaming run events. Each returns an unsubscribe function.
  onStarted: (fn) => subscribe('check:started', fn),
  onResult: (fn) => subscribe('check:result', fn),
  onDone: (fn) => subscribe('check:done', fn),
});

function subscribe(channel, fn) {
  const listener = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
