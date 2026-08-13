'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu } = require('electron');

const store = require('./store');
const { parseList } = require('./proxy-parser');
const { runBatch, checkOwnIp } = require('./checker');

let mainWindow = null;
/** Live run controller, so the Stop button can abort in-flight sockets. */
let activeRun = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0f1218',
    show: false,
    title: 'IPChecker — proxy quality via iphub.info',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Keep external links in the user's browser rather than in an app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [{ role: 'quit' }],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Get a free iphub.info API key',
            click: () => shell.openExternal('https://iphub.info/pricing'),
          },
          {
            label: 'Open settings folder',
            // openPath on the directory: the settings file may not exist yet
            // on a first run, and showItemInFolder would silently do nothing.
            click: () => shell.openPath(path.dirname(store.settingsPath())),
          },
        ],
      },
    ])
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (activeRun) activeRun.abort();
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------------------------------------------- settings */

ipcMain.handle('settings:load', () => store.load());
ipcMain.handle('settings:save', (_event, patch) => store.save(patch || {}));

/* ------------------------------------------------------------------- parse */

ipcMain.handle('proxies:parse', (_event, { text, defaultScheme }) =>
  parseList(text, defaultScheme)
);

/* ------------------------------------------------------------------ checks */

ipcMain.handle('check:start', async (_event, { text, defaultScheme }) => {
  if (activeRun) return { ok: false, error: 'A check is already running' };

  const settings = store.load();
  const { proxies, errors, duplicates } = parseList(text, defaultScheme || settings.defaultScheme);

  if (proxies.length === 0) {
    return { ok: false, error: 'No valid proxies found in the list', errors };
  }

  const controller = new AbortController();
  activeRun = controller;

  send('check:started', { total: proxies.length, parseErrors: errors, duplicates });

  let completed = 0;
  try {
    await runBatch(proxies, {
      apiKey: (settings.apiKey || '').trim(),
      timeout: settings.timeoutMs,
      concurrency: settings.concurrency,
      signal: controller.signal,
      onResult: (result) => {
        completed += 1;
        send('check:result', { result, completed, total: proxies.length });
      },
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      activeRun = null;
      send('check:done', { cancelled: false, error: error.message });
      return { ok: false, error: error.message };
    }
  }

  const cancelled = controller.signal.aborted;
  activeRun = null;
  send('check:done', { cancelled, completed, total: proxies.length });

  return { ok: true, total: proxies.length, completed, cancelled, parseErrors: errors, duplicates };
});

ipcMain.handle('check:cancel', () => {
  if (!activeRun) return { ok: false };
  activeRun.abort();
  return { ok: true };
});

ipcMain.handle('check:own-ip', async () => {
  const settings = store.load();
  try {
    const result = await checkOwnIp({
      apiKey: (settings.apiKey || '').trim(),
      timeout: settings.timeoutMs,
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/* ------------------------------------------------------------ import/export */

ipcMain.handle('file:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import proxy list',
    properties: ['openFile'],
    filters: [
      { name: 'Text lists', extensions: ['txt', 'csv', 'list'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) return { ok: false };

  try {
    const text = await fs.readFile(filePaths[0], 'utf8');
    return { ok: true, text, path: filePaths[0] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('file:export', async (_event, { content, defaultName, kind }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export results',
    defaultPath: defaultName || 'ipcheck-results.csv',
    filters:
      kind === 'txt'
        ? [{ name: 'Text file', extensions: ['txt'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false };

  try {
    await fs.writeFile(filePath, content, 'utf8');
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('shell:open', (_event, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

/* ------------------------------------------------------------ embedded view */

/**
 * A manually-driven browser panel for looking up a single exit IP on
 * iphub.info without leaving the app. It is a viewer, not a scraper: nothing
 * is read back out of the page or into the results table. The one thing we do
 * touch is the site's own lookup form -- filling the IP and pressing Lookup,
 * exactly what a person would do by hand -- so that clicking a second IP
 * reuses the loaded page instead of reloading the whole site. Navigation is
 * pinned to iphub.info; any other host is handed to the system browser.
 */
let viewer = null;
let viewerBounds = null;

const VIEWER_HOST = 'iphub.info';
const VIEWER_HOME = 'https://iphub.info/';
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIphubUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === VIEWER_HOST || hostname.endsWith(`.${VIEWER_HOST}`));
  } catch {
    return false;
  }
}

function sendViewerState(patch) {
  send('viewer:state', patch);
}

function ensureViewer() {
  if (viewer && !viewer.webContents.isDestroyed()) return viewer;

  viewer = new WebContentsView({
    webPreferences: {
      // Remote content: no preload, no node, sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const wc = viewer.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the panel on iphub.info; send stray links to the real browser.
  wc.on('will-navigate', (event, url) => {
    if (!isIphubUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  wc.on('did-start-loading', () => sendViewerState({ loading: true }));
  wc.on('did-stop-loading', () =>
    sendViewerState({ loading: false, url: wc.getURL(), canGoBack: wc.navigationHistory.canGoBack() })
  );
  wc.on('did-navigate', (_event, url) => sendViewerState({ url }));

  // The site pushes ?ip=<addr> into history itself after each lookup, so
  // in-page navigation is how the URL changes once the page is warm.
  wc.on('did-navigate-in-page', (_event, url) =>
    sendViewerState({ url, canGoBack: wc.navigationHistory.canGoBack() })
  );

  mainWindow.contentView.addChildView(viewer);
  if (viewerBounds) viewer.setBounds(viewerBounds);
  return viewer;
}

/** Bounds arrive from the renderer as the CSS rect of the reserved column. */
function applyBounds(bounds) {
  if (!bounds) return;
  viewerBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
  if (viewer && !viewer.webContents.isDestroyed()) viewer.setBounds(viewerBounds);
}

function destroyViewer() {
  if (!viewer) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.contentView.removeChildView(viewer);
    } catch {
      // Window already tearing down; nothing to detach from.
    }
  }
  if (!viewer.webContents.isDestroyed()) viewer.webContents.close();
  viewer = null;
}

/**
 * Drive the site's own lookup form: put the IP in the field and press Lookup.
 * The field is disabled while a lookup is in flight and Alpine may not have
 * wired the form up yet on a cold page, so this polls briefly before giving
 * up and letting the caller fall back to a full navigation.
 */
function lookupFormScript(ip) {
  return `(() => {
    const ip = ${JSON.stringify(ip)};
    const deadline = Date.now() + 4000;
    return new Promise((resolve) => {
      const attempt = () => {
        const input = document.querySelector('#lookupInput');
        const form = document.querySelector('#lookupForm') || (input && input.form);
        const retry = (reason) =>
          Date.now() < deadline ? setTimeout(attempt, 100) : resolve({ ok: false, reason });
        if (!input || !form) return void retry('no-form');
        if (input.disabled) return void retry('busy');

        // Assign through the prototype setter so frameworks see a real change.
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setValue.call(input, ip);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        const button = form.querySelector('button[type="submit"], input[type="submit"]');
        if (button && !button.disabled) button.click();
        else if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        resolve({ ok: true });
      };
      attempt();
    });
  })()`;
}

function whenIdle(wc) {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => wc.once('did-stop-loading', resolve));
}

/**
 * One entry point for every IP click. The first click loads the site with
 * ?ip=<addr>, which iphub reads on init and looks up on its own. Later clicks
 * reuse that page via the form, so the panel no longer reloads each time.
 */
ipcMain.handle('viewer:lookup', async (_event, { ip, bounds }) => {
  if (typeof ip !== 'string' || !IPV4.test(ip)) {
    return { ok: false, error: 'Not a valid IPv4 address' };
  }
  applyBounds(bounds);

  const warm = viewer && !viewer.webContents.isDestroyed();
  const wc = ensureViewer().webContents;

  if (warm) {
    await whenIdle(wc);
    if (isIphubUrl(wc.getURL())) {
      try {
        const result = await wc.executeJavaScript(lookupFormScript(ip), true);
        if (result && result.ok) return { ok: true };
      } catch {
        // Page torn down or navigated mid-script; fall through to a reload.
      }
    }
  }

  try {
    await wc.loadURL(`${VIEWER_HOME}?ip=${encodeURIComponent(ip)}`);
  } catch {
    return { ok: false, error: 'Could not reach iphub.info' };
  }
  return { ok: true };
});

ipcMain.handle('viewer:bounds', (_event, bounds) => applyBounds(bounds));

ipcMain.handle('viewer:reload', () => {
  if (viewer && !viewer.webContents.isDestroyed()) viewer.webContents.reload();
});

ipcMain.handle('viewer:back', () => {
  const wc = viewer && !viewer.webContents.isDestroyed() ? viewer.webContents : null;
  if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
});

ipcMain.handle('viewer:external', () => {
  if (viewer && !viewer.webContents.isDestroyed()) shell.openExternal(viewer.webContents.getURL());
});

ipcMain.handle('viewer:close', () => {
  destroyViewer();
  return { ok: true };
});
