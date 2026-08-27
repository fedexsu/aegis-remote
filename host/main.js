'use strict';

// HatchConnect HOST (technician desktop client).
//
// A thin Electron shell around the web console. Its whole job is to register the
// `hatchconnect://` URL scheme and open device sessions in real desktop windows,
// so the website's Join button can do:
//   click Join -> hatchconnect://join?device=<id> -> this app opens that session
// and closing the session window (the web app calls window.close() on disconnect)
// returns focus to the browser. Login happens once inside the app (cookies persist).

const { app, BrowserWindow, shell, Menu } = require('electron');

const RELAY = process.env.HC_RELAY || 'https://aegis-relay-production.up.railway.app';
const PROTO = 'hatchconnect';
const PARTITION = 'persist:hatchconnect'; // shared, persistent login cookie jar

// Single instance: a protocol activation while we're running is delivered to the
// already-running process via 'second-instance' (Windows passes the URL in argv).
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.setAsDefaultProtocolClient(PROTO);
  const sessionWindows = new Map(); // deviceId -> BrowserWindow

  const relayUrl = (dev) => dev
    ? `${RELAY}/?device=${encodeURIComponent(dev)}&solo=1&app=1`
    : `${RELAY}/?app=1`;

  function openWindow(dev) {
    if (dev && sessionWindows.has(dev)) {
      const w = sessionWindows.get(dev);
      if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.focus(); return w; }
    }
    const win = new BrowserWindow({
      width: dev ? 1360 : 1200,
      height: dev ? 860 : 820,
      minWidth: 720, minHeight: 480,
      backgroundColor: '#0b1017',
      title: 'HatchConnect',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, backgroundThrottling: false },
    });
    win.setMenuBarVisibility(false);
    win.loadURL(relayUrl(dev));

    // A window.open('?device=X&solo=1') from the web app becomes a new app window;
    // external links go to the default browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        const d = u.searchParams.get('device');
        if (u.origin === new URL(RELAY).origin && d) { openWindow(d); return { action: 'deny' }; }
        if (/^https?:$/.test(u.protocol) && u.origin !== new URL(RELAY).origin) { shell.openExternal(url); return { action: 'deny' }; }
      } catch {}
      return { action: 'allow' };
    });

    if (dev) { sessionWindows.set(dev, win); win.on('closed', () => sessionWindows.delete(dev)); }
    return win;
  }

  // Pull hatchconnect://join?device=<id> out of a process argv list.
  function deviceFromArgv(argv) {
    const arg = (argv || []).find((a) => typeof a === 'string' && a.indexOf(PROTO + '://') === 0);
    if (!arg) return { has: false };
    try { return { has: true, device: new URL(arg).searchParams.get('device') || null }; }
    catch { return { has: true, device: null }; }
  }

  app.on('second-instance', (_e, argv) => {
    const r = deviceFromArgv(argv);
    const w = openWindow(r.has ? r.device : null);
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const r = deviceFromArgv(process.argv);
    openWindow(r.has ? r.device : null);
  });

  // When the last window closes (e.g. a session ends on disconnect), quit and hand
  // focus back to the browser - matching "closes the app and returns to browser".
  app.on('window-all-closed', () => app.quit());
}
