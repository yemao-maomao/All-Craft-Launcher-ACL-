'use strict';

/**
 * @fileoverview 预加载脚本（contextIsolation 沙箱环境）
 *
 * 通过 contextBridge 把主进程能力以 window.acl 的形式安全暴露给渲染进程。
 * 渲染进程拿不到任何 Node/Electron 原生对象，只能调用这里白名单化的 API，
 * 这是 Electron 应用的标准安全基线。
 *
 * 所有 invoke 的返回值都是主进程的统一信封 { ok, data } / { ok, error }，
 * 渲染进程侧由 js/api.js 负责解包与统一错误提示。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 通用 invoke 封装：把渲染进程调用转发到主进程对应 ipcMain.handle 通道。
 * @param {string} channel - 通道名（主进程注册的完整名称，如 'settings:get'）
 * @param {...any} args - 透传给主进程处理器的参数
 * @returns {Promise<any>} 主进程返回的统一信封
 */
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * 订阅主进程推送事件。
 * @param {string} channel - 事件短名（主进程发送的是 'acl:<channel>'）
 * @param {(payload: any) => void} callback - 事件回调
 * @returns {() => void} 取消订阅函数
 */
function subscribe(channel, callback) {
  const full = 'acl:' + channel;
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(full, listener);
  return () => ipcRenderer.removeListener(full, listener);
}

// 暴露给渲染进程的白名单 API（window.acl）
contextBridge.exposeInMainWorld('acl', {
  /** 应用元信息（名称/版本/运行时版本等） */
  getInfo: () => invoke('app:info'),

  /** 窗口控制（自绘标题栏按钮使用） */
  minimize: () => invoke('win:minimize'),
  maximize: () => invoke('win:maximize'),
  close: () => invoke('win:close'),
  isMaximized: () => invoke('win:is-maximized'),

  /** 设置读写 */
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },

  /** 实例（游戏目录）管理 */
  instances: {
    list: () => invoke('instances:list'),
    create: (id) => invoke('instances:create', id),
    remove: (id) => invoke('instances:remove', id),
    rename: (oldId, newId) => invoke('instances:rename', oldId, newId),
  },

  /** 账户认证：离线 / 微软 */
  auth: {
    offline: (name) => invoke('auth:offline', name),
    msStart: () => invoke('auth:ms-start'),
    msPoll: (deviceCode) => invoke('auth:ms-poll', deviceCode),
  },

  /** 游戏版本：清单 / 安装 / 卸载 / Fabric 加载器 */
  game: {
    manifest: (opts) => invoke('game:manifest', opts),
    installed: () => invoke('game:installed'),
    install: (versionId, opts) => invoke('game:install', versionId, opts),
    uninstall: (versionId) => invoke('game:uninstall', versionId),
    installFabric: (opts) => invoke('game:install-fabric', opts),
    fabricLoaders: (gameVersion, opts) => invoke('game:fabric-loaders', gameVersion, opts),
  },

  /** Java 运行时：检测 / 自动下载 */
  java: {
    detect: () => invoke('java:detect'),
    download: (major) => invoke('java:download', major),
  },

  /** 启动游戏 */
  launch: {
    start: (opts) => invoke('launch:start', opts),
    kill: (pid) => invoke('launch:kill', pid),
  },

  /** 应用日志 */
  log: {
    get: () => invoke('log:get'),
    clear: () => invoke('log:clear'),
  },

  /** 系统对话框 / 外部链接 */
  dialog: {
    selectDir: () => invoke('dialog:select-dir'),
  },
  shell: {
    openExternal: (url) => invoke('shell:open-external', url),
    openPath: (target) => invoke('shell:open-path', target),
  },

  /** 缓存维护 */
  cache: {
    clear: () => invoke('app:clear-cache'),
  },

  /** 后台任务取消 */
  tasks: {
    cancel: (taskId) => invoke('tasks:cancel', taskId),
  },

  /**
   * 订阅主进程推送事件（返回取消订阅函数）。
   * 可用事件：task-progress / task-done / task-log / app-log /
   *          launch-log / launch-exit / settings-changed / win-state
   */
  on: subscribe,
});
