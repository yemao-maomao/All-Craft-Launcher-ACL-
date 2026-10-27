/**
 * @fileoverview 全局状态模块
 *
 * 职责：持有渲染进程的全部共享状态（设置、账户、实例、版本清单、已安装版本、
 * Java 检测结果、后台任务注册表、日志缓冲、启动进程状态），并提供简易的
 * 发布订阅（event bus），供各页面模块订阅变化后局部刷新界面。
 *
 * 注意：本模块不直接触碰 window.acl（那由 api.js 负责），也不操作 DOM；
 * 页面通过 on('xxx') 订阅、emit('xxx') 广播，保持单向数据流。
 */

import { api } from './api.js';

/** 设置默认值（与主进程 settings/store.js 的 DEFAULTS 保持一致，供首屏兜底） */
const DEFAULT_SETTINGS = {
  language: 'zh_CN',
  theme: 'light',
  accent: 'blue',
  downloadSource: 'mojang',
  maxDownloadThreads: 4,
  autoMemory: true,
  minMemory: 512,
  maxMemory: 4096,
  extraJvmArgs: '',
  resolution: { width: 854, height: 480 },
  msClientId: '',
  javaPath: null,
  instance: 'default',
  autoScrollLog: true,
  lastAccount: null,
};

/** 日志缓冲上限（与主进程 MAX_LOG_LINES 一致） */
const MAX_LOG_LINES = 2000;

/** 单个任务保留的任务日志上限 */
const MAX_TASK_LOGS = 200;

/**
 * 全局共享状态对象。
 * 所有页面只读这份状态并订阅变化事件，不互相直接传递数据。
 */
export const state = {
  /** 启动器设置（启动后与主进程同步） */
  settings: { ...DEFAULT_SETTINGS },
  /** 当前登录账户（null = 未登录），完整账户对象（含 token 等字段） */
  account: null,
  /** 实例列表 [{id,name,createdAt,isDefault}] */
  instances: [],
  /** 已安装版本列表 [{id,type?}] */
  installed: [],
  /** 首页选中的版本 id（未选择为 null） */
  selectedVersion: null,
  /** 版本清单 {latest:{release,snapshot},versions:[...]}（未加载为 null） */
  manifest: null,
  /** 版本清单加载错误信息（无错误为 null） */
  manifestError: null,
  /** 版本清单是否正在加载（骨架屏用） */
  manifestLoading: false,
  /** Java 检测结果 [{path,exe,major,version,arch,origin}] */
  java: [],
  /** 后台任务注册表 taskId -> task 对象 */
  tasks: new Map(),
  /** 启动日志缓冲（launch 来源的应用日志 + 游戏实时输出，含退出状态行） */
  logLines: [],
  /** 是否已从主进程加载过历史日志（防止重复加载） */
  logHistoryLoaded: false,
  /** 启动进程状态：idle=未启动 starting=正在启动 running=运行中 */
  launch: { status: 'idle', pid: null, versionId: null, account: null, opts: null, java: null },
  /** 最近一次异常退出的崩溃报告绝对路径（launch-exit 附带，无则 null） */
  lastCrashReport: null,
};

// ===================== 简易事件总线 =====================

/** 事件监听器注册表：事件名 -> Set<回调> */
const listeners = new Map();

/**
 * 订阅事件。
 * @param {string} event - 事件名（约定：settings/account/instances/installed/manifest/java/
 *   task-update/task-done/task-remove/log-line/log-cleared/launch/launch-exit/route 等）
 * @param {Function} cb - 回调函数
 * @returns {() => void} 取消订阅函数
 */
export function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => listeners.get(event)?.delete(cb);
}

/**
 * 广播事件。
 * @param {string} event - 事件名
 * @param {*} payload - 事件负载
 */
export function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const cb of [...set]) {
    try { cb(payload); } catch (err) { console.error(`[state] 事件 ${event} 回调异常：`, err); }
  }
}

// ===================== 设置 =====================

/**
 * 应用完整设置对象（来自 settings:get / settings:set / settings-changed）。
 * @param {object} s - 完整设置对象
 */
export function applySettings(s) {
  state.settings = { ...DEFAULT_SETTINGS, ...s };
  emit('settings', state.settings);
}

/**
 * 写设置：调用主进程合并写入，成功后同步本地状态并广播。
 * @param {object} patch - 深合并补丁
 * @returns {Promise<object>} 最新完整设置
 */
export async function saveSettings(patch) {
  const s = await api.settings.set(patch);
  state.settings = { ...DEFAULT_SETTINGS, ...s };
  emit('settings', state.settings);
  return s;
}

// ===================== 账户 =====================

/**
 * 保存账户：更新本地状态、广播，并持久化到设置 lastAccount。
 * @param {object|null} account - 完整账户对象；null 表示退出登录
 */
export async function saveAccount(account) {
  state.account = account;
  emit('account', account);
  try {
    await api.settings.set({ lastAccount: account });
  } catch (e) { /* 设置落盘失败不影响登录态，忽略 */ }
}

// ===================== 版本选择 =====================

/**
 * 设置首页选中的版本。
 * @param {string|null} id - 版本 id
 */
export function setSelectedVersion(id) {
  state.selectedVersion = id;
  emit('selected-version', id);
}

// ===================== 任务注册表 =====================

/**
 * 合并任务进度：新建或更新任务对象，并按 done 增量估算实时速度。
 * @param {{taskId:string,name:string,done:number,total:number,percent?:number,extra?:string}} p - 进度事件
 */
export function updateTask(p) {
  let task = state.tasks.get(p.taskId);
  if (!task) {
    task = {
      taskId: p.taskId, name: p.name || '任务', done: 0, total: 0,
      percent: 0, extra: '', status: 'running', logs: [],
      lastDone: 0, lastTime: Date.now(), speed: 0,
    };
    state.tasks.set(p.taskId, task);
  }
  task.name = p.name || task.name;
  task.extra = p.extra ?? task.extra;
  const now = Date.now();
  if (typeof p.done === 'number') {
    const dt = Math.max(0.4, (now - task.lastTime) / 1000);
    if (p.done >= task.lastDone) {
      task.speed = (p.done - task.lastDone) / dt;   // 字节/秒（若 done 为字节计数）
    }
    task.lastDone = p.done;
    task.lastTime = now;
    task.done = p.done;
  }
  if (typeof p.total === 'number') task.total = p.total;
  task.percent = typeof p.percent === 'number' ? p.percent
    : (task.total > 0 ? Math.min(100, task.done / task.total * 100) : 0);
  emit('task-update', task);
}

/**
 * 记录任务日志（task-log 事件）。
 * @param {{taskId:string,level:string,text:string,time?:any}} p - 任务日志事件
 */
export function appendTaskLog(p) {
  const task = state.tasks.get(p.taskId);
  if (!task) return;
  task.logs.push({ level: p.level || 'info', text: String(p.text ?? ''), time: p.time ?? Date.now() });
  if (task.logs.length > MAX_TASK_LOGS) task.logs.shift();
  emit('task-log', { taskId: p.taskId, entry: task.logs[task.logs.length - 1] });
}

/**
 * 任务结束：更新状态，延迟 3.5s 后从注册表移除（给界面完成态展示时间）。
 * @param {{taskId:string,ok:boolean,error?:string,result?:any}} p - 完成事件
 */
export function completeTask(p) {
  const task = state.tasks.get(p.taskId);
  if (task) {
    task.status = p.ok ? 'done' : 'failed';
    task.error = p.error || '';
    task.result = p.result;
    task.percent = p.ok ? 100 : task.percent;
    emit('task-update', task);
    emit('task-done', task);
    setTimeout(() => {
      state.tasks.delete(p.taskId);
      emit('task-remove', p.taskId);
    }, 3500);
  }
}

/** 当前进行中的任务数量 */
export function activeTaskCount() {
  let n = 0;
  for (const t of state.tasks.values()) if (t.status === 'running') n++;
  return n;
}

// ===================== 日志缓冲 =====================

/**
 * 追加一行启动日志（launch 来源）。
 * @param {{time:number|string,level:string,text:string,kind?:string}} line - 日志行
 *   kind 可选：'exit-ok'（正常退出状态行）/ 'exit-fail'（异常退出状态行）
 */
export function appendLogLine(line) {
  state.logLines.push({
    time: line.time ?? Date.now(),
    level: line.level || 'info',
    text: String(line.text ?? ''),
    kind: line.kind || null,
  });
  if (state.logLines.length > MAX_LOG_LINES) state.logLines.shift();
  emit('log-line', state.logLines[state.logLines.length - 1]);
}

/** 清空本地日志缓冲（主进程存储由调用方负责清） */
export function clearLogLines() {
  state.logLines.length = 0;
  emit('log-cleared');
}
