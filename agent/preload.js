'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('cfg:save', cfg),
  getScreenSource: () => ipcRenderer.invoke('screen:source'),
  getScreenSize: () => ipcRenderer.invoke('screen:size'),
  inject: (cmd) => ipcRenderer.send('inject', cmd),
  sessionState: (active) => ipcRenderer.send('session:state', active),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
});
