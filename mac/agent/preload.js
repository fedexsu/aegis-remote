'use strict';

// Small IPC bridge for the onboarding window. Kept intentionally tiny — Phase 1
// only needs "open the right System Settings pane" and "quit". Phase 2 adds
// permission-check functions.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  openSettings: (kind) => ipcRenderer.invoke('open-settings', kind),   // kind: 'screen' | 'accessibility'
  quit: () => ipcRenderer.invoke('quit'),
});
