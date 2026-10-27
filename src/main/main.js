'use strict';

/**
 * @fileoverview Electron 主进程入口（“壳”）
 *
 * 职责：
 * 1. 应用生命周期管理（单实例锁、就绪、退出）；
 * 2. 创建无边框主窗口（标题栏由渲染进程自绘，PCL 风格）；
 * 3. 注册 IPC 通道（见 ipc.js）与窗口控制；
 * 4. 拦截新窗口请求，把 http(s) 链接交给系统浏览器。
 *
 * 业务逻辑一律放在 src/main/core/ 下，本文件只做薄薄的壳，
 * 方便测试与替换（core 模块不依赖 electron，可用纯 Node 测试）。
 */

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const {
  APP_NAME,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
} = require('./core/constants');

const { registerIpc, attachWindow } = require('./ipc');

/** 主窗口引用（null 表示尚未创建或已关闭） */
let mainWindow = null;

// Windows 任务栏图标/分组标识（与 electron-builder.yml 的 appId 对应）
app.setAppUserModelId('com.acl.allcraftlauncher');

// 固定用户数据目录：开发态（app 名为 all-craft-launcher）与打包态（productName 为
// "All Craft Launcher"）的默认 userData 路径不一致，这里统一为 %APPDATA%\AllCraftLauncher，
// 保证两种形态共享同一份数据。
app.setPath('userData', path.join(app.getPath('appData'), 'AllCraftLauncher'));

// ===================== 单实例锁 =====================
// 启动器是单例应用：重复启动时聚焦已有窗口而不是再开一个。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 第二次启动实例时：唤起已有窗口
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 去掉默认菜单栏（无边框应用不需要）
    Menu.setApplicationMenu(null);

    // 路径初始化：把「exe 所在目录」与「系统用户数据目录」注入 core 层。
    // 注意：用 process.execPath 而非 app.execPath——后者在某些启动方式下为 undefined
    // （例如被宿主进程拉起时），process.execPath 在开发态与打包态都可靠。
    try {
      require('./core/util/paths').init({
        appRoot: path.dirname(process.execPath),
        userDataRoot: app.getPath('userData'),
      });
    } catch (err) {
      console.warn('[main] core/util/paths 初始化失败（跳过，core 通道将不可用）：');
      console.warn('[main]', err.stack || err);
    }

    // 按用户主题读取窗口底色（避免浅色主题下首帧出现深色闪烁）
    let bgColor = '#1b212b';
    try {
      const saved = JSON.parse(fs.readFileSync(require('./core/util/paths').settingsFile(), 'utf8'));
      bgColor = saved.theme === 'dark' ? '#141a24' : '#e9edf4';
    } catch { /* 首次启动或读取失败时使用默认深色 */ }

    // 创建主窗口
    mainWindow = new BrowserWindow({
      title: APP_NAME,
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      minWidth: 1024,
      minHeight: 640,
      frame: false,                    // 无边框：自绘标题栏（窗口控制按钮在渲染进程实现）
      backgroundColor: bgColor,          // 按用户主题取底色，避免首帧闪烁
      show: false,                     // 等 ready-to-show 再显示，避免白屏闪烁
      webPreferences: {
        // 注意：preload 位于 src/preload（本文件在 src/main，需回退一级目录）
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,        // 渲染进程与 Node 环境隔离（安全基线）
        nodeIntegration: false,        // 渲染进程禁用 Node 能力，只能走 window.acl
        sandbox: true,
      },
    });

    // 注入窗口引用并注册全部 IPC 通道
    attachWindow(mainWindow);
    registerIpc();

    // 加载渲染进程界面（renderer 位于 src/renderer，同样回退一级目录）
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // 页面准备完成后再显示窗口
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });

    // 渲染进程内的新窗口请求：http(s) 链接一律交给系统浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  // 所有窗口关闭时退出应用（Windows 桌面应用惯例）
  app.on('window-all-closed', () => app.quit());
}
