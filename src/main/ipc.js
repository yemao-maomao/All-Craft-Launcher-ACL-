'use strict';

/**
 * @fileoverview IPC 通道注册模块
 *
 * 集中定义渲染进程可调用的全部通道（ipcMain.handle）以及主进程向渲染进程
 * 推送的事件转发（任务进度、日志、启动输出、设置变更）。
 *
 * 设计要点：
 * 1. 业务模块（src/main/core/**）一律【惰性 require】：在对应通道第一次被
 *    调用时才加载。这样某个模块尚未实现/出错时不会拖垮整个应用启动，
 *    错误会以统一信封 { ok:false, error } 干净地返回给渲染进程。
 * 2. 事件转发器（任务进度等）在对应模块首次加载成功后挂载，并用标记防止
 *    重复挂载监听。
 * 3. 所有通道统一返回信封 { ok:true, data } 或 { ok:false, error }，
 *    渲染进程 api.js 负责解包与统一错误处理。
 */

const { ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { APP_NAME, APP_VERSION } = require('./core/constants');

/** 当前主窗口引用（由 main.js 通过 attachWindow 注入） */
let mainWindow = null;

/** 事件转发器挂载标记：防止同一事件源被重复挂载监听 */
const forwarders = { tasks: false, settings: false, log: false };

// ===================== 工具函数 =====================

/** 包装业务错误为统一 IPC 返回信封 */
function errResult(error) {
  return { ok: false, error: String((error && error.message) || error) };
}

/** 包装业务结果为统一 IPC 返回信封 */
function okResult(data) {
  return { ok: true, data };
}

/** 向渲染进程推送事件（自动加 acl: 前缀） */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('acl:' + channel, payload);
  }
}

/**
 * 注入主窗口引用，并监听最大化状态变化推送给渲染进程
 * （渲染进程据此切换「最大化/还原」按钮图标）。
 */
function attachWindow(win) {
  mainWindow = win;
  win.on('maximize', () => send('win-state', { maximized: true }));
  win.on('unmaximize', () => send('win-state', { maximized: false }));
}

/** 挂载 tasks 模块的事件转发器（幂等，首次调用时挂载） */
function ensureTaskForwarders() {
  if (forwarders.tasks) return;
  forwarders.tasks = true;
  const tasks = require('./core/tasks');
  tasks.on('progress', (p) => send('task-progress', p));
  tasks.on('done', (p) => send('task-done', p));
  tasks.on('log', (p) => send('task-log', p));
}

/** 挂载 settings 模块变更事件转发器（幂等） */
function ensureSettingsForwarder() {
  if (forwarders.settings) return;
  forwarders.settings = true;
  require('./core/settings/store').on('changed', (settings) => {
    send('settings-changed', { settings });
  });
}

/** 挂载应用日志事件转发器（幂等） */
function ensureLogForwarder() {
  if (forwarders.log) return;
  forwarders.log = true;
  require('./core/util/log').on('line', (entry) => send('app-log', entry));
}

// ===================== 通道注册 =====================

/** 注册全部 IPC 通道（main.js 在创建窗口后调用一次） */
function registerIpc() {
  // ---- 应用信息：渲染进程「关于页」等使用 ----
  ipcMain.handle('app:info', () => {
    return okResult({
      name: APP_NAME,
      version: APP_VERSION,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    });
  });

  // ---- 窗口控制：无边框窗口自绘标题栏的按钮使用 ----
  ipcMain.handle('win:minimize', () => {
    if (mainWindow) mainWindow.minimize();
    return okResult(true);
  });
  ipcMain.handle('win:maximize', () => {
    // 在最大化/还原之间切换
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    return okResult(true);
  });
  ipcMain.handle('win:close', () => {
    if (mainWindow) mainWindow.close();
    return okResult(true);
  });
  ipcMain.handle('win:is-maximized', () => {
    return okResult(!!(mainWindow && mainWindow.isMaximized()));
  });

  // ---- 设置：读取/合并写入启动器配置 ----
  ipcMain.handle('settings:get', async () => {
    try {
      ensureSettingsForwarder();
      return okResult(await require('./core/settings/store').get());
    } catch (e) { return errResult(e); }
  });
  ipcMain.handle('settings:set', async (_event, patch) => {
    try {
      ensureSettingsForwarder();
      return okResult(await require('./core/settings/store').set(patch || {}));
    } catch (e) { return errResult(e); }
  });

  // ---- 实例（游戏目录）管理 ----
  ipcMain.handle('instances:list', async () => {
    try { return okResult(await require('./core/instances').list()); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('instances:create', async (_event, id) => {
    try { return okResult(await require('./core/instances').create(id)); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('instances:remove', async (_event, id) => {
    try { return okResult(await require('./core/instances').remove(id)); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('instances:rename', async (_event, oldId, newId) => {
    try { return okResult(await require('./core/instances').rename(oldId, newId)); } catch (e) { return errResult(e); }
  });

  // ---- 账户认证 ----
  ipcMain.handle('auth:offline', async (_event, name) => {
    try { return okResult(await require('./core/auth/offline').offlineLogin(name)); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('auth:ms-start', async () => {
    try { return okResult(await require('./core/auth/microsoft').msStart()); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('auth:ms-poll', async (_event, deviceCode) => {
    try { return okResult(await require('./core/auth/microsoft').msPoll(deviceCode)); } catch (e) { return errResult(e); }
  });

  // ---- 游戏版本：清单 / 已安装 / 安装 / 卸载 / Fabric ----
  ipcMain.handle('game:manifest', async (_event, opts) => {
    try { return okResult(await require('./core/game/manifest').fetchManifest(opts || {})); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('game:installed', async () => {
    try { return okResult(await require('./core/game/install').listInstalled()); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('game:install', async (_event, versionId, opts) => {
    try {
      ensureTaskForwarders();
      return okResult(await require('./core/game/install').createInstallTask(versionId, opts || {}));
    } catch (e) { return errResult(e); }
  });
  ipcMain.handle('game:uninstall', async (_event, versionId) => {
    try { return okResult(await require('./core/game/install').uninstall(versionId)); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('game:install-fabric', async (_event, opts) => {
    try {
      ensureTaskForwarders();
      return okResult(await require('./core/game/fabric').createInstallTask(opts || {}));
    } catch (e) { return errResult(e); }
  });
  ipcMain.handle('game:fabric-loaders', async (_event, gameVersion, opts) => {
    // 查询某游戏版本可用的 Fabric 加载器版本列表（下载页「模组加载器」标签用）
    try {
      return okResult(await require('./core/game/fabric').fetchFabricLoaders(gameVersion, opts || {}));
    } catch (e) { return errResult(e); }
  });

  // ---- Java 运行时：检测 / 自动下载 ----
  ipcMain.handle('java:detect', async () => {
    try { return okResult(await require('./core/java').detect()); } catch (e) { return errResult(e); }
  });
  ipcMain.handle('java:download', async (_event, major) => {
    try {
      ensureTaskForwarders();
      return okResult(await require('./core/java').createDownloadTask(major));
    } catch (e) { return errResult(e); }
  });

  // ---- 启动游戏 ----
  ipcMain.handle('launch:start', async (_event, opts) => {
    try {
      ensureLogForwarder();
      const launch = require('./core/launch/launch');
      // 启动后进程输出与退出通过事件实时推送给渲染进程
      const handle = await launch.start(opts || {}, {
        onLine: (entry) => send('launch-log', entry),
        onExit: (info) => send('launch-exit', info),
      });
      return okResult({ pid: handle.pid, java: handle.java });
    } catch (e) { return errResult(e); }
  });
  ipcMain.handle('launch:kill', async (_event, pid) => {
    try { return okResult(require('./core/launch/launch').kill(pid)); } catch (e) { return errResult(e); }
  });

  // ---- 日志 ----
  ipcMain.handle('log:get', () => {
    try {
      ensureLogForwarder();
      return okResult(require('./core/util/log').getAll());
    } catch (e) { return errResult(e); }
  });
  ipcMain.handle('log:clear', () => {
    try {
      ensureLogForwarder();
      require('./core/util/log').clear();
      return okResult(true);
    } catch (e) { return errResult(e); }
  });

  // ---- 系统对话框 / 外部链接 ----
  ipcMain.handle('dialog:select-dir', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择文件夹',
        properties: ['openDirectory'],
      });
      return okResult({ path: result.canceled ? null : result.filePaths[0] });
    } catch (e) { return errResult(e); }
  });
  ipcMain.handle('shell:open-external', async (_event, url) => {
    try {
      // 仅允许 http(s)，防止渲染进程被注入后打开危险协议
      if (!/^https?:\/\//i.test(String(url))) throw new Error('非法链接');
      await shell.openExternal(url);
      return okResult(true);
    } catch (e) { return errResult(e); }
  });
  ipcMain.handle('shell:open-path', async (_event, target) => {
    try {
      // 在资源管理器中打开文件夹/文件（实例目录、日志目录、崩溃报告等）
      const p = String(target || '');
      if (!path.isAbsolute(p)) throw new Error('路径无效');
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
      return okResult(true);
    } catch (e) { return errResult(e); }
  });

  // ---- 缓存维护：清理 dataRoot/cache（版本清单等缓存） ----
  ipcMain.handle('app:clear-cache', () => {
    try {
      const paths = require('./core/util/paths');
      const cacheDir = paths.cacheDir();
      // 递归统计目录大小（用于 UI 反馈释放空间）
      const walk = (dir) => {
        let total = 0;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          total += ent.isDirectory() ? walk(p) : fs.statSync(p).size;
        }
        return total;
      };
      const freed = fs.existsSync(cacheDir) ? walk(cacheDir) : 0;
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      return okResult({ freedBytes: freed });
    } catch (e) { return errResult(e); }
  });

  // ---- 任务取消 ----
  ipcMain.handle('tasks:cancel', (_event, taskId) => {
    try {
      ensureTaskForwarders();
      return okResult(require('./core/tasks').cancel(taskId));
    } catch (e) { return errResult(e); }
  });
}

module.exports = { registerIpc, attachWindow };
