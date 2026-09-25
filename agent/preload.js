'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('cfg:save', cfg),
  getDeviceId: () => ipcRenderer.invoke('device:id'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  getMeta: () => ipcRenderer.invoke('meta:get'),
  getScreenSource: () => ipcRenderer.invoke('screen:source'),
  getScreenSize: () => ipcRenderer.invoke('screen:size'),
  getMonitors: () => ipcRenderer.invoke('screen:list'),
  inject: (cmd) => ipcRenderer.send('inject', cmd),
  sessionState: (active) => ipcRenderer.send('session:state', active),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  onSuspend: (cb) => ipcRenderer.on('power:suspend', () => cb()),
  onResume: (cb) => ipcRenderer.on('power:resume', () => cb()),
  sendWol: (mac) => ipcRenderer.invoke('wol:send', mac),
  op: (msg) => ipcRenderer.send('op', msg),
  onOpMessage: (cb) => ipcRenderer.on('op:msg', (_e, m) => cb(m)),
  getPresence: () => ipcRenderer.invoke('presence:get'),
  getInjectorStatus: () => ipcRenderer.invoke('injector:status'),
  onControlStatus: (cb) => ipcRenderer.on('control:status', (_e, available) => cb(available)),
  // Secure-desktop (lock screen) capture: start/stop the SYSTEM helper and receive
  // its JPEG frames to relay to the console when the machine is locked.
  sdStart: () => ipcRenderer.send('sd:start'),
  sdStop: () => ipcRenderer.send('sd:stop'),
  onSdFrame: (cb) => ipcRenderer.on('sd:frame', (_e, buf) => cb(buf)),
  captureScreenshot: () => ipcRenderer.invoke('screen:screenshot'),
});
