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
/** 窗口为底部提醒文字额外增加的区域（与 pet.html 保持一致） */
const SCHEDULE_REMINDER_BAND_PX = 36;
const SCHEDULE_REMINDER_EXTRA_WIDTH_PX = 40;

let petWindow = null;
let panelWindow = null;
let tray = null;
let fullscreenPollTimer = null;
let isOtherAppFullscreen = false;
let userDismissedPet = false;
let hiddenByFullscreen = false;
let wasVisibleBeforeFullscreen = false;
let scheduleWatchTimer = null;
let lastSchedulesConfigKey = '';
const scheduleTriggeredKeys = new Set();

const SCHEDULE_CHECK_MS = 10 * 1000;

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
  const defaultItem = { path: defaultMedia, type: 'image' };
  return {
    mediaItems: [defaultItem],
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
    schedules: [],
  };
}

function inferMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.webm', '.mp4', '.mov'].includes(ext)) return 'video';
  return 'image';
}

/** 归一化媒体列表，兼容旧版单一 mediaPath 字段 */
function normalizeMediaItems(cfg) {
  if (Array.isArray(cfg.mediaItems) && cfg.mediaItems.length > 0) {
    return cfg.mediaItems
      .filter((item) => item && item.path)
      .map((item) => ({
        path: item.path,
        type: item.type || inferMediaType(item.path),
      }));
  }
  if (cfg.mediaPath) {
    return [{ path: cfg.mediaPath, type: cfg.mediaType || inferMediaType(cfg.mediaPath) }];
  }
  const def = getDefaultConfig().mediaItems[0];
  return [def];
}

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((s) => String(s).trim()).filter(Boolean);
}

function normalizeTimeString(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const hours = Math.min(23, Math.max(0, parseInt(match[1], 10)));
  const minutes = Math.min(59, Math.max(0, parseInt(match[2], 10)));
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** 归一化日程提醒列表（以毫秒时间戳存储，兼容旧版 time 字符串） */
function legacyTimeToNextTimestamp(timeStr) {
  const [hours, minutes] = timeStr.split(':').map((v) => parseInt(v, 10));
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function normalizeSchedules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && item.title)
    .map((item) => {
      let timestamp = Number(item.timestamp);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        const timeStr = normalizeTimeString(item.time);
        timestamp = timeStr ? legacyTimeToNextTimestamp(timeStr) : 0;
      }
      return {
        id: String(item.id || `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        title: String(item.title).trim(),
        timestamp: Math.round(timestamp),
        repeatDaily: Boolean(item.repeatDaily),
      };
    })
    .filter((item) => item.title && item.timestamp > 0);
}

/** 统一配置结构，确保数组字段为全新副本（修复语料热重载残留） */
function normalizeConfig(raw) {
  const base = getDefaultConfig();
  const merged = { ...base, ...raw };

  merged.responses = normalizeStringArray(
    raw.responses !== undefined ? raw.responses : merged.responses,
    base.responses
  );
  merged.idleMessages = normalizeStringArray(
    raw.idleMessages !== undefined ? raw.idleMessages : merged.idleMessages,
    base.idleMessages
  );
  merged.schedules = normalizeSchedules(
    raw.schedules !== undefined ? raw.schedules : merged.schedules
  );
  merged.mediaItems = normalizeMediaItems(merged);
  merged.mediaPath = merged.mediaItems[0].path;
  merged.mediaType = merged.mediaItems[0].type;
  merged.width = clampSize(merged.width);
  merged.height = clampSize(merged.height);
  merged.buttonText = String(merged.buttonText || base.buttonText).trim() || base.buttonText;

  return merged;
}

function readConfig() {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return normalizeConfig(parsed);
    }
  } catch (err) {
    console.error('[Deskpet] readConfig failed:', err.message);
  }
  const defaults = normalizeConfig(getDefaultConfig());
  writeConfig(defaults);
  return defaults;
}

function writeConfig(config) {
  const configPath = getConfigPath();
  try {
    const normalized = normalizeConfig(config);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2), 'utf-8');
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
  if (!petWindow || petWindow.isDestroyed()) return;

  const payload = normalizeConfig(config || readConfig());
  syncScheduleTriggerCache(payload);
  petWindow.webContents.send('config-updated', payload);
  checkSchedulesInMain();
}

/** 日程配置变更时重置已触发缓存，避免旧状态阻止新提醒 */
function syncScheduleTriggerCache(config) {
  const key = JSON.stringify(
    (config.schedules || []).map((item) => `${item.id}:${item.timestamp}`)
  );
  if (key !== lastSchedulesConfigKey) {
    scheduleTriggeredKeys.clear();
    lastSchedulesConfigKey = key;
  }
}

/** 主进程定时检测日程（避免渲染进程被 Electron 节流导致漏触发） */
function checkSchedulesInMain() {
  const config = readConfig();
  const schedules = Array.isArray(config.schedules) ? config.schedules : [];
  if (!schedules.length) return;

  const now = Date.now();

  for (const item of schedules) {
    const triggerKey = `${item.id}:${item.timestamp}`;
    if (scheduleTriggeredKeys.has(triggerKey)) continue;

    const timestamp = Number(item.timestamp);
    if (!Number.isFinite(timestamp)) continue;

    const diffMinutes = (timestamp - now) / 60000;

    // 核心判断：距离指定时间还剩不到 10 分钟，且尚未过期
    if (diffMinutes > 0 && diffMinutes <= 10) {
      scheduleTriggeredKeys.add(triggerKey);
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('schedule-reminder', item);
      }
      break;
    }
  }
}

function startScheduleWatcher() {
  clearInterval(scheduleWatchTimer);
  scheduleWatchTimer = setInterval(checkSchedulesInMain, SCHEDULE_CHECK_MS);
  checkSchedulesInMain();
}

function stopScheduleWatcher() {
  if (scheduleWatchTimer) {
    clearInterval(scheduleWatchTimer);
    scheduleWatchTimer = null;
  }
}

function getPetWindowSize(config) {
  const mediaWidth = clampSize(config.width);
  const mediaHeight = clampSize(config.height);
  return {
    width: mediaWidth + SCHEDULE_REMINDER_EXTRA_WIDTH_PX,
    mediaWidth,
    mediaHeight,
    height: mediaHeight + SCHEDULE_REMINDER_BAND_PX,
  };
}

/** 将配置中的宽高应用到桌宠窗口，并广播给渲染进程 */
function applyPetWindowSize(config) {
  if (!petWindow || petWindow.isDestroyed()) return config;

  const { width, mediaWidth, mediaHeight, height: windowHeight } = getPetWindowSize(config);
  const bounds = petWindow.getBounds();
  const nextBounds = { x: bounds.x, y: bounds.y, width, height: windowHeight };

  // 使用 setBounds 而非 setSize，避免 frameless + resizable:false 在 Windows 上尺寸不更新
  petWindow.setBounds(nextBounds, false);

  const workArea = getWorkAreaForWindow(petWindow);
  const snapped = clampToWorkArea(nextBounds.x, nextBounds.y, width, windowHeight, workArea);
  if (snapped.x !== nextBounds.x || snapped.y !== nextBounds.y) {
    petWindow.setPosition(snapped.x, snapped.y);
  }

  const normalized = normalizeConfig({ ...config, width: mediaWidth, height: mediaHeight });
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
  const { width, height } = getPetWindowSize(config);

  petWindow = new BrowserWindow({
    width,
    height,
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
      backgroundThrottling: false,
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

function getDisplayForWindow(win) {
  if (!win || win.isDestroyed()) {
    return screen.getPrimaryDisplay();
  }
  return screen.getDisplayNearestPoint(win.getBounds());
}

function getWorkAreaForWindow(win) {
  return getDisplayForWindow(win).workArea;
}

/**
 * 将窗口位置钳制在当前显示器工作区内（屏幕绝对坐标，兼容 DPI 与多屏 workArea 偏移）
 */
function clampToWorkArea(x, y, winWidth, winHeight, workArea) {
  const screenWidth = workArea.width;
  const screenHeight = workArea.height;
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = minX + screenWidth - winWidth;
  const maxY = minY + screenHeight - winHeight;

  let targetX = x;
  let targetY = y;

  if (winWidth >= screenWidth) {
    targetX = minX;
  } else if (x < minX) {
    targetX = minX;
  } else if (x > maxX) {
    targetX = maxX;
  }

  if (winHeight >= screenHeight) {
    targetY = minY;
  } else if (y < minY) {
    targetY = minY;
  } else if (y > maxY) {
    targetY = maxY;
  }

  return {
    x: Math.round(targetX),
    y: Math.round(targetY),
  };
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
      const next = normalizeConfig({ ...current, ...partial });
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
      title: '选择桌宠素材（可多选）',
      filters: [
        {
          name: '媒体文件',
          extensions: ['webp', 'webm', 'mp4', 'mov', 'gif'],
        },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    return addMediaFiles(result.filePaths);
  });

  ipcMain.handle('copy-media-file', (_event, sourcePath) => {
    if (!sourcePath) return { ok: false, error: '无效路径' };
    return addMediaFiles([sourcePath], { replace: true });
  });

  /** 从列表中移除指定索引的状态素材 */
  ipcMain.handle('remove-media-item', (_event, index) => {
    try {
      const config = readConfig();
      const items = [...config.mediaItems];
      if (index < 0 || index >= items.length) {
        return { ok: false, error: '索引无效' };
      }
      items.splice(index, 1);
      if (items.length === 0) {
        const def = getDefaultConfig().mediaItems[0];
        items.push(def);
      }
      const next = normalizeConfig({ ...config, mediaItems: items });
      writeConfig(next);
      const applied = applyPetWindowSize(next);
      return { ok: true, config: applied };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** 仅一次日程提醒结束后，从 config.json 移除对应项 */
  ipcMain.handle('remove-schedule-item', (_event, scheduleId) => {
    try {
      const config = readConfig();
      const id = String(scheduleId || '').trim();
      if (!id) return { ok: false, error: '无效日程 ID' };

      const schedules = config.schedules.filter((item) => item.id !== id);
      if (schedules.length === config.schedules.length) {
        return { ok: false, error: '日程不存在' };
      }

      const next = normalizeConfig({ ...config, schedules });
      writeConfig(next);
      syncScheduleTriggerCache(next);
      broadcastConfigToPet(next);
      return { ok: true, config: next };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
    const display = getDisplayForWindow(petWindow);
    const workArea = display.workArea;
    const winWidth = bounds.width;
    const winHeight = bounds.height;

    const snapped = clampToWorkArea(
      bounds.x,
      bounds.y,
      winWidth,
      winHeight,
      workArea
    );

    const needsSnap = snapped.x !== bounds.x || snapped.y !== bounds.y;

    return {
      from: {
        x: bounds.x,
        y: bounds.y,
        width: winWidth,
        height: winHeight,
      },
      to: snapped,
      workArea,
      workAreaSize: display.workAreaSize,
      needsSnap,
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

function copyOneMediaFile(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    throw new Error(`不支持的格式: ${ext}`);
  }
  ensureMediaDir();
  const fileName = `pet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const destPath = path.join(getMediaDir(), fileName);
  fs.copyFileSync(sourcePath, destPath);
  return { path: destPath, type: inferMediaType(destPath) };
}

/** 复制多个素材到 userData/media 并追加到 mediaItems */
function addMediaFiles(sourcePaths, { replace = false } = {}) {
  try {
    const config = readConfig();
    const added = [];
    for (const sourcePath of sourcePaths) {
      try {
        added.push(copyOneMediaFile(sourcePath));
      } catch (err) {
        console.error('[Deskpet] skip file:', sourcePath, err.message);
      }
    }
    if (!added.length) {
      return { ok: false, error: '没有成功导入的文件' };
    }

    const isDefaultOnly = (items) =>
      items.length === 1 && items[0].path.includes('default.svg');

    let mediaItems;
    if (replace) {
      mediaItems = added;
    } else if (isDefaultOnly(config.mediaItems)) {
      mediaItems = added;
    } else {
      mediaItems = [...config.mediaItems, ...added];
    }

    const next = normalizeConfig({ ...config, mediaItems });
    writeConfig(next);
    const applied = applyPetWindowSize(next);
    return { ok: true, added, config: applied };
  } catch (err) {
    console.error('[Deskpet] addMediaFiles failed:', err.message);
    return { ok: false, error: err.message };
  }
}

app.whenReady().then(() => {
  ensureMediaDir();
  registerIpc();
  createPetWindow();
  createTray();
  startFullscreenWatcher();
  startScheduleWatcher();
});

app.on('before-quit', () => {
  stopFullscreenWatcher();
  stopScheduleWatcher();
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
