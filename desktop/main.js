/**
 * UVoz para Windows: uma janela que carrega o UVoz publicado (as atualizações do site chegam
 * sem reinstalar) e acrescenta o que só um app de verdade tem — ícone na bandeja, iniciar com
 * o Windows, atalho global para o microfone, selo de não lidas e seletor de tela/janela.
 */
const { app, BrowserWindow, Tray, Menu, shell, session, globalShortcut, desktopCapturer, ipcMain, nativeImage } = require('electron');
const path = require('path');

const APP_URL = (process.env.UVOZ_URL || 'https://uvoz.on-forge.com').replace(/\/+$/, '');
const APP_ORIGIN = new URL(APP_URL).origin;
const MIC_SHORTCUT = 'Control+Shift+M';
const startHidden = process.argv.includes('--hidden');
const asset = (name) => path.join(__dirname, 'assets', name);

let win = null;
let tray = null;
let quitting = false;
let unread = 0;

// Uma única instância: abrir de novo só traz a janela para a frente.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showWindow);
app.setAppUserModelId('com.unicopag.uvoz'); // notificações do Windows com nome e ícone do app

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 420,
    minHeight: 560,
    show: false,
    backgroundColor: '#313338',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // a chamada continua fluida com a janela minimizada ou na bandeja
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Fechar a janela mantém o app na bandeja (como o Discord); "Sair" no menu da bandeja encerra.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('focus', () => win.flashFrame(false));

  // Links externos abrem no navegador padrão; o app só navega dentro do próprio UVoz.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== APP_ORIGIN) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });

  // O título do site é "(N) UVoz · Unicopag" quando há N não lidas.
  win.webContents.on('page-title-updated', (_e, title) => setUnread(Number((title.match(/^\((\d+)\)/) || [])[1]) || 0));

  // Sem internet ao abrir: mostra um aviso e tenta de novo sozinho.
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navegação cancelada
    win.loadFile(path.join(__dirname, 'offline.html')).catch(() => {});
    setTimeout(() => { if (win && !quitting) win.loadURL(APP_URL).catch(() => {}); }, 5000);
  });

  win.loadURL(APP_URL).catch(() => {});
}

function setUnread(n) {
  if (n > unread && win && !win.isFocused()) win.flashFrame(true); // pisca na barra de tarefas
  unread = n;
  if (win && process.platform === 'win32') {
    win.setOverlayIcon(n ? nativeImage.createFromPath(asset('badge.png')) : null, n ? `${n} não lidas` : '');
  }
  if (tray) tray.setToolTip(n ? `UVoz — ${n} não lida${n > 1 ? 's' : ''}` : 'UVoz');
}

function toggleMic() {
  // Mesmo botão do painel de voz do site; não faz nada fora de uma chamada.
  win?.webContents.executeJavaScript("document.querySelector('#panel-mic:not(:disabled)')?.click()", true).catch(() => {});
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.setToolTip('UVoz');
  tray.on('click', showWindow);
  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir o UVoz', click: showWindow },
    { label: `Ligar/desligar microfone (${MIC_SHORTCUT.replace('Control', 'Ctrl')})`, click: toggleMic },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); refresh(); },
    },
    { label: 'Recarregar', click: () => win?.loadURL(APP_URL).catch(() => {}) },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  refresh();
}

// ----- Permissões: só o próprio UVoz pode usar microfone, câmera, tela e notificações ---------
function setupPermissions() {
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);
  const fromApp = (url) => { try { return new URL(url).origin === APP_ORIGIN; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(fromApp(wc.getURL()) && allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => fromApp(origin) && allowed.has(permission));

  // Compartilhar tela: o Electron não tem seletor próprio no Windows, então o app mostra o seu.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // Recusar = chamar sem argumentos (o site recebe o mesmo erro de "permissão negada" do navegador).
    let answered = false;
    const deny = () => { if (answered) return; answered = true; try { callback(); } catch { /* já respondido */ } };
    try {
      if (!fromApp(request.securityOrigin || request.frame?.url || '')) return deny();
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
      const choice = await pickSource(sources);
      const source = choice && sources.find((s) => s.id === choice.id);
      if (!source) return deny(); // cancelado
      answered = true;
      callback(choice.audio && request.audioRequested && process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
    } catch (err) {
      console.error('[uvoz] compartilhamento de tela:', err);
      deny();
    }
  });
}

function pickSource(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, resizable: false, minimizable: false, maximizable: false,
      title: 'Compartilhar tela', backgroundColor: '#2b2d31', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    picker.removeMenu();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('picker:choose', onChoose);
      ipcMain.removeHandler('picker:sources');
      if (!picker.isDestroyed()) picker.close();
      resolve(value);
    };
    const onChoose = (e, value) => { if (e.sender === picker.webContents) finish(value && typeof value.id === 'string' ? { id: value.id, audio: !!value.audio } : null); };
    ipcMain.on('picker:choose', onChoose);
    ipcMain.handle('picker:sources', (e) => (e.sender === picker.webContents
      ? sources.map((s) => ({ id: s.id, name: s.name, isScreen: s.id.startsWith('screen:'), thumbnail: s.thumbnail.toDataURL() }))
      : []));
    picker.on('closed', () => finish(null));
    picker.once('ready-to-show', () => picker.show());
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

app.whenReady().then(() => {
  setupPermissions();
  createWindow();
  buildTray();
  globalShortcut.register(MIC_SHORTCUT, toggleMic); // funciona com a janela minimizada ou em outro programa
  app.on('activate', showWindow);
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* continua na bandeja */ });
