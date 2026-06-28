const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  dialog,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ALLOWED_EXT = ['.webp', '.webm', '.mp4', '.mov', '.gif'];
const CONFIG_NAME = 'config.json';
const MEDIA_DIR_NAME = 'media';
const FULLSCREEN_POLL_MS = 1500;

let petWindow = null;
let panelWindow = null;
let tray = null;
let fullscreenPollTimer = null;
let isOtherAppFullscreen = false;
let userDismissedPet = false;
let hiddenByFullscreen = false;
let wasVisibleBeforeFullscreen = false;

/** 可选依赖：npm install active-win（需 VS 构建工具；未安装时 Windows 走 PowerShell 回退） */
let activeWinModule = null;
try {
  activeWinModule = require('active-win');
} catch (_) {
  /* 使用 PowerShell Win32 回退方案 */
}

/** Windows 前台窗口 PowerShell 脚本路径（无 native 依赖回退方案） */
const FOREGROUND_PS1 = path.join(__dirname, 'scripts', 'foreground-window.ps1');

function getConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_NAME);
}

function getMediaDir() {
  return path.join(app.getPath('userData'), MEDIA_DIR_NAME);
}

function getDefaultConfig() {
  const defaultMedia = path.join(__dirname, 'assets', 'default.svg');
  return {
    mediaPath: defaultMedia,
    mediaType: 'image',
    buttonText: '互动',
    responses: [
      '你好呀！今天也要加油哦~',
      '摸摸头，心情变好了吗？',
      '我在这里陪着你呢！',
      '休息一下，喝口水吧~',
      '你是最棒的！',
    ],
    idleMessages: ['右键点击打开设置面板', '悬停显示互动按钮哦~'],
    width: 200,
    height: 200,
    showIdleHint: true,
  };
}

function readConfig() {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...getDefaultConfig(), ...parsed };
    }
  } catch (err) {
    console.error('[Deskpet] readConfig failed:', err.message);
  }
  const defaults = getDefaultConfig();
  writeConfig(defaults);
  return defaults;
}

function writeConfig(config) {
  const configPath = getConfigPath();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Deskpet] writeConfig failed:', err.message);
    return false;
  }
}

function ensureMediaDir() {
  try {
    fs.mkdirSync(getMediaDir(), { recursive: true });
  } catch (err) {
    console.error('[Deskpet] ensureMediaDir failed:', err.message);
  }
}

function broadcastConfigToPet(config) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('config-updated', config);
  }
}

/** 将配置中的宽高应用到桌宠窗口，并广播给渲染进程 */
function applyPetWindowSize(config) {
  if (!petWindow || petWindow.isDestroyed()) return config;

  const width = clampSize(config.width);
  const height = clampSize(config.height);
  const bounds = petWindow.getBounds();
  const nextBounds = { x: bounds.x, y: bounds.y, width, height };

  // 使用 setBounds 而非 setSize，避免 frameless + resizable:false 在 Windows 上尺寸不更新
  petWindow.setBounds(nextBounds, false);

  const workArea = getWorkAreaForWindow(petWindow);
  const snapped = clampToWorkArea(nextBounds.x, nextBounds.y, width, height, workArea);
  if (snapped.x !== nextBounds.x || snapped.y !== nextBounds.y) {
    petWindow.setPosition(snapped.x, snapped.y);
  }

  const normalized = { ...config, width, height };
  broadcastConfigToPet(normalized);
  return normalized;
}

function clampSize(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 200;
  return Math.min(600, Math.max(80, n));
}

function setPetVisibility(visible, { byUser = false } = {}) {
  if (!petWindow || petWindow.isDestroyed()) return;

  if (visible) {
    userDismissedPet = false;
    hiddenByFullscreen = false;
    if (!isOtherAppFullscreen) {
      petWindow.show();
    }
  } else {
    if (byUser) userDismissedPet = true;
    petWindow.hide();
  }

  if (tray && tray.rebuildMenu) tray.rebuildMenu();
}

function createTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  try {
    if (fs.existsSync(iconPath)) {
      return nativeImage.createFromPath(iconPath);
    }
  } catch (_) {
    /* fall through */
  }
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 8;
      const dy = y - 8;
      const inside = dx * dx + dy * dy <= 36;
      const i = (y * size + x) * 4;
      if (inside) {
        canvas[i] = 110;
        canvas[i + 1] = 231;
        canvas[i + 2] = 255;
        canvas[i + 3] = 255;
      } else {
        canvas[i + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function createPetWindow() {
  const config = readConfig();

  petWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    frame: false,
    transparent: true,
    // Windows 透明窗口需显式 alpha 背景，否则鼠标命中/拖拽易失效
    backgroundColor: '#00000000',
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  petWindow.loadFile('pet.html');

  petWindow.once('ready-to-show', () => {
    petWindow.show();
    applyPetWindowSize(readConfig());
  });

  petWindow.on('closed', () => {
    petWindow = null;
  });
}

function createPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.focus();
    return;
  }

  panelWindow = new BrowserWindow({
    width: 480,
    height: 640,
    title: 'Deskpet 设置',
    resizable: true,
    minimizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  panelWindow.loadFile('panel.html');

  panelWindow.on('closed', () => {
    panelWindow = null;
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Deskpet');

  const rebuildMenu = () => {
    const visible =
      petWindow &&
      !petWindow.isDestroyed() &&
      petWindow.isVisible() &&
      !hiddenByFullscreen;
    const menu = Menu.buildFromTemplate([
      {
        label: '设置面板',
        click: () => createPanelWindow(),
      },
      {
        label: visible ? '隐藏桌宠' : '显示桌宠',
        click: () => {
          if (!petWindow || petWindow.isDestroyed()) return;
          if (petWindow.isVisible() && !hiddenByFullscreen) {
            setPetVisibility(false, { byUser: true });
          } else {
            setPetVisibility(true);
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出应用',
        click: () => app.quit(),
      },
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();
  tray.on('click', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (petWindow.isVisible() && !hiddenByFullscreen) {
      setPetVisibility(false, { byUser: true });
    } else {
      setPetVisibility(true);
    }
  });

  tray.rebuildMenu = rebuildMenu;
}

function getWorkAreaForWindow(win) {
  if (!win || win.isDestroyed()) {
    return screen.getPrimaryDisplay().workArea;
  }
  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2),
  });
  return display.workArea;
}

function clampToWorkArea(x, y, width, height, workArea) {
  let clampedX = x;
  let clampedY = y;

  if (width >= workArea.width) {
    clampedX = workArea.x;
  } else {
    const maxX = workArea.x + workArea.width - width;
    clampedX = Math.min(Math.max(x, workArea.x), maxX);
  }

  if (height >= workArea.height) {
    clampedY = workArea.y;
  } else {
    const maxY = workArea.y + workArea.height - height;
    clampedY = Math.min(Math.max(y, workArea.y), maxY);
  }

  return { x: clampedX, y: clampedY };
}

/** 检测当前前台窗口是否为「其他应用」的全屏窗口 */
async function getForegroundWindowInfo() {
  if (activeWinModule) {
    try {
      const activeWin = activeWinModule.default || activeWinModule;
      const aw = typeof activeWin === 'function' ? await activeWin() : await activeWin;
      if (aw && aw.bounds) {
        return {
          x: aw.bounds.x,
          y: aw.bounds.y,
          width: aw.bounds.width,
          height: aw.bounds.height,
          pid: aw.owner && aw.owner.processId,
        };
      }
    } catch (err) {
      console.error('[Deskpet] active-win failed:', err.message);
    }
  }

  if (process.platform !== 'win32') return null;

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', FOREGROUND_PS1],
      { windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024 }
    );
    const parsed = JSON.parse(stdout.trim());
    if (parsed && parsed.width > 0) return parsed;
  } catch (err) {
    console.error('[Deskpet] PowerShell foreground detect failed:', err.message);
  }

  return null;
}

async function detectOtherAppFullscreen() {
  const info = await getForegroundWindowInfo();
  if (!info || !info.width || !info.height) return false;

  // 忽略本应用前台窗口（设置面板等）
  if (info.pid === process.pid) return false;

  const { x, y, width, height } = info;
  const display = screen.getDisplayMatching({ x, y, width, height });
  const db = display.bounds;
  const tolerance = 8;

  const coversDisplay =
    width >= db.width - tolerance &&
    height >= db.height - tolerance &&
    x <= db.x + tolerance &&
    y <= db.y + tolerance;

  return coversDisplay;
}

function handleFullscreenState(fullscreen) {
  if (!petWindow || petWindow.isDestroyed()) return;

  if (fullscreen && !isOtherAppFullscreen) {
    isOtherAppFullscreen = true;
    wasVisibleBeforeFullscreen = petWindow.isVisible() && !userDismissedPet;
    if (wasVisibleBeforeFullscreen) {
      hiddenByFullscreen = true;
      petWindow.hide();
      if (tray && tray.rebuildMenu) tray.rebuildMenu();
    }
    return;
  }

  if (!fullscreen && isOtherAppFullscreen) {
    isOtherAppFullscreen = false;
    if (hiddenByFullscreen && wasVisibleBeforeFullscreen && !userDismissedPet) {
      hiddenByFullscreen = false;
      petWindow.show();
      if (tray && tray.rebuildMenu) tray.rebuildMenu();
    } else {
      hiddenByFullscreen = false;
    }
    wasVisibleBeforeFullscreen = false;
  }
}

function startFullscreenWatcher() {
  if (fullscreenPollTimer) return;
  if (process.platform !== 'win32' && !activeWinModule) return;

  fullscreenPollTimer = setInterval(async () => {
    const fullscreen = await detectOtherAppFullscreen();
    handleFullscreenState(fullscreen);
  }, FULLSCREEN_POLL_MS);
}

function stopFullscreenWatcher() {
  if (fullscreenPollTimer) {
    clearInterval(fullscreenPollTimer);
    fullscreenPollTimer = null;
  }
}

function registerIpc() {
  ipcMain.handle('get-config', () => readConfig());

  ipcMain.handle('save-config', (_event, partial) => {
    try {
      const current = readConfig();
      const next = {
        ...current,
        ...partial,
        width: clampSize(partial.width ?? current.width),
        height: clampSize(partial.height ?? current.height),
      };
      const ok = writeConfig(next);
      if (ok) {
        const applied = applyPetWindowSize(next);
        if (tray && tray.rebuildMenu) tray.rebuildMenu();
        return { ok, config: applied };
      }
      return { ok: false, error: '写入配置失败' };
    } catch (err) {
      console.error('[Deskpet] save-config failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('pick-media-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择桌宠素材',
      filters: [
        {
          name: '媒体文件',
          extensions: ['webp', 'webm', 'mp4', 'mov', 'gif'],
        },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    return copyMediaFile(result.filePaths[0]);
  });

  ipcMain.handle('copy-media-file', (_event, sourcePath) => {
    if (!sourcePath) return { ok: false, error: '无效路径' };
    return copyMediaFile(sourcePath);
  });

  ipcMain.handle('get-screen-info', () => {
    if (!petWindow || petWindow.isDestroyed()) {
      const wa = screen.getPrimaryDisplay().workArea;
      return { workArea: wa };
    }
    const bounds = petWindow.getBounds();
    const workArea = getWorkAreaForWindow(petWindow);
    return { workArea, windowBounds: bounds };
  });

  /** 同步计算拖拽偏移（Windows 透明窗不能用 webkit drag，改 IPC 拖动） */
  ipcMain.handle('begin-window-drag', (_event, { screenX, screenY }) => {
    if (!petWindow || petWindow.isDestroyed()) return null;
    const bounds = petWindow.getBounds();
    return {
      offsetX: screenX - bounds.x,
      offsetY: screenY - bounds.y,
    };
  });

  ipcMain.handle('set-window-position', (_event, x, y) => {
    if (!petWindow || petWindow.isDestroyed()) return null;
    petWindow.setPosition(Math.round(x), Math.round(y));
    return petWindow.getBounds();
  });

  ipcMain.handle('snap-window-to-screen', () => {
    if (!petWindow || petWindow.isDestroyed()) return null;
    const bounds = petWindow.getBounds();
    const workArea = getWorkAreaForWindow(petWindow);
    const snapped = clampToWorkArea(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      workArea
    );
    return {
      from: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      to: snapped,
      workArea,
    };
  });

  ipcMain.handle('open-panel', () => {
    createPanelWindow();
    return true;
  });

  /** 桌宠悬停关闭按钮：隐藏窗口（可通过托盘恢复） */
  ipcMain.handle('hide-pet-window', () => {
    setPetVisibility(false, { byUser: true });
    return true;
  });

  ipcMain.handle('get-media-dir', () => getMediaDir());
}

function copyMediaFile(sourcePath) {
  try {
    const ext = path.extname(sourcePath).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return { ok: false, error: `不支持的格式: ${ext}` };
    }
    ensureMediaDir();
    const fileName = `pet_${Date.now()}${ext}`;
    const destPath = path.join(getMediaDir(), fileName);
    fs.copyFileSync(sourcePath, destPath);

    let mediaType = 'image';
    if (['.webm', '.mp4', '.mov'].includes(ext)) {
      mediaType = 'video';
    }

    const config = readConfig();
    config.mediaPath = destPath;
    config.mediaType = mediaType;
    writeConfig(config);
    const applied = applyPetWindowSize(config);

    return { ok: true, mediaPath: destPath, mediaType, config: applied };
  } catch (err) {
    console.error('[Deskpet] copyMediaFile failed:', err.message);
    return { ok: false, error: err.message };
  }
}

app.whenReady().then(() => {
  ensureMediaDir();
  registerIpc();
  createPetWindow();
  createTray();
  startFullscreenWatcher();
});

app.on('before-quit', () => {
  stopFullscreenWatcher();
});

app.on('window-all-closed', () => {
  // 保留托盘常驻，不因关闭设置面板而退出
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createPetWindow();
  }
});

process.on('uncaughtException', (err) => {
  console.error('[Deskpet] uncaughtException:', err);
});
