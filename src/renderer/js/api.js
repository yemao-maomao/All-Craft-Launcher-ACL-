/**
 * @fileoverview window.acl IPC 封装模块
 *
 * 职责：把 preload 暴露的 window.acl.* 全部方法统一包一层信封解包：
 *   { ok:true, data }  → 返回 data
 *   { ok:false, error } → toast 中文错误 + 抛出异常（页面可捕获做局部状态处理）
 * 页面代码只允许 import api.js，不允许直接触碰 window.acl，保证错误处理一致。
 */

import { toast } from './components.js';

/**
 * 主进程桥接对象；当页面在非 Electron 环境打开时用占位桥接兜底，
 * 所有调用都会返回统一错误信封，保证 UI 仍能渲染出错误态而不是白屏崩溃。
 */
const bridge = window.acl || new Proxy({}, {
  get: () => () => Promise.resolve({ ok: false, error: '未检测到主进程桥接（window.acl），请通过 Electron 启动本应用' }),
});

/**
 * 解包统一信封。
 * @param {Promise<{ok:boolean,data?:any,error?:string}>} p - preload 方法返回的信封 Promise
 * @param {string} label - 操作名称（错误提示兜底用）
 * @returns {Promise<any>} 信封中的 data
 * @throws {Error} 信封 ok=false 时抛出（已 toast 提示）
 */
function unwrap(p, label) {
  return p.then((env) => {
    if (env && env.ok) return env.data;
    const msg = (env && env.error) ? String(env.error) : `「${label}」操作失败`;
    toast('error', msg);
    const err = new Error(msg);
    err.aclHandled = true; // 标记错误已 toast，调用方无需再次提示
    throw err;
  });
}

/** 对 preload 单个方法做信封解包包装（保持 this 无关，acl 方法均为箭头函数） */
const w = (fn, label) => (...args) => unwrap(fn(...args), label);

/**
 * 统一 API 出口（与 window.acl 同名同构）。
 * 所有页面调用必须经此对象，错误统一 toast 中文提示。
 */
export const api = {
  /** 应用信息（关于页） */
  getInfo: w(() => bridge.getInfo(), '获取应用信息'),

  /** 窗口控制（自绘标题栏） */
  minimize: w(() => bridge.minimize(), '最小化窗口'),
  maximize: w(() => bridge.maximize(), '切换最大化'),
  close: w(() => bridge.close(), '关闭窗口'),
  isMaximized: w(() => bridge.isMaximized(), '查询窗口状态'),

  settings: {
    get: w(() => bridge.settings.get(), '读取设置'),
    set: w((patch) => bridge.settings.set(patch), '保存设置'),
  },

  instances: {
    list: w(() => bridge.instances.list(), '读取实例列表'),
    create: w((id) => bridge.instances.create(id), '创建实例'),
    remove: w((id) => bridge.instances.remove(id), '删除实例'),
    rename: w((oldId, newId) => bridge.instances.rename(oldId, newId), '重命名实例'),
  },

  auth: {
    offline: w((name) => bridge.auth.offline(name), '离线登录'),
    msStart: w(() => bridge.auth.msStart(), '发起微软登录'),
    msPoll: w((deviceCode) => bridge.auth.msPoll(deviceCode), '轮询微软登录'),
  },

  game: {
    manifest: w((opts) => bridge.game.manifest(opts), '加载版本清单'),
    installed: w(() => bridge.game.installed(), '读取已安装版本'),
    install: w((versionId, opts) => bridge.game.install(versionId, opts), '安装游戏版本'),
    uninstall: w((versionId) => bridge.game.uninstall(versionId), '卸载游戏版本'),
    installFabric: w((opts) => bridge.game.installFabric(opts), '安装 Fabric'),
    fabricLoaders: w((gameVersion, opts) => bridge.game.fabricLoaders(gameVersion, opts), '查询 Fabric 加载器'),
  },

  java: {
    detect: w(() => bridge.java.detect(), '检测 Java'),
    download: w((major) => bridge.java.download(major), '下载 Java 运行时'),
  },

  launch: {
    start: w((opts) => bridge.launch.start(opts), '启动游戏'),
    kill: w((pid) => bridge.launch.kill(pid), '结束游戏'),
  },

  log: {
    get: w(() => bridge.log.get(), '读取日志'),
    clear: w(() => bridge.log.clear(), '清空日志'),
  },

  dialog: {
    selectDir: w(() => bridge.dialog.selectDir(), '选择目录'),
  },

  shell: {
    openExternal: w((url) => bridge.shell.openExternal(url), '打开外部链接'),
    openPath: w((target) => bridge.shell.openPath(target), '打开路径'),
  },

  cache: {
    clear: w(() => bridge.cache.clear(), '清理缓存'),
  },

  tasks: {
    cancel: w((taskId) => bridge.tasks.cancel(taskId), '取消任务'),
  },

  /**
   * 订阅主进程推送事件（透传 preload 的 on，返回取消订阅函数）。
   * @param {string} event - 事件短名，如 'task-progress'
   * @param {Function} cb - 回调
   * @returns {() => void} 取消订阅函数
   */
  on: (event, cb) => bridge.on(event, cb),
};
