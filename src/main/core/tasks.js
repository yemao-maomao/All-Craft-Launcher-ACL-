'use strict';

/**
 * @fileoverview 后台任务注册表模块（tasks.js）
 *
 * 长任务（安装、Java 下载等）的统一生命周期管理：
 * - createTask({name}) → 任务句柄 { id, name, setProgress, log, getSignal, finish, fail }；
 * - 进度事件按 200ms 节流广播（避免渲染进程被高频事件淹没）；
 * - cancel(taskId) 触发该任务的 AbortController，各执行体响应信号并以
 *   「已取消」终止（幂等；任务不存在或已结束返回 false）；
 * - 事件：progress {taskId,name,done,total,percent,extra}、
 *   done {taskId,name,ok,error,result}、log {taskId,name,level,text,time}。
 *
 * 模块导出即 EventEmitter 单例（ipc.js 直接 require('./core/tasks').on(...)）。
 */

const { EventEmitter } = require('events');

/** 同一任务两次 progress 广播的最小间隔（毫秒） */
const PROGRESS_THROTTLE_MS = 200;

/** 注册表中最多保留的已结束任务数（超出移除最旧，防内存无限增长） */
const MAX_FINISHED_TASKS = 200;

/**
 * 任务注册表单例。
 */
class TaskRegistry extends EventEmitter {
  constructor() {
    super();
    /** 全部任务（含已结束，受 MAX_FINISHED_TASKS 限制） */
    this._tasks = new Map();
    /** 已结束任务顺序表（用于淘汰最旧） */
    this._finishedOrder = [];
    /** 自增序号（与时间戳共同组成任务 id） */
    this._seq = 0;
  }

  /**
   * 创建后台任务并返回任务句柄。任务实际执行由调用方异步启动。
   * @param {{name: string}} opts - 任务显示名（中文，如「安装 1.21.4」）
   * @returns {{id:string, name:string, setProgress:Function, log:Function, getSignal:Function, finish:Function, fail:Function}} 任务句柄
   */
  createTask({ name }) {
    const id = `${Date.now().toString(36)}-${(++this._seq).toString(36)}`;
    // 取消信号：挂在任务内部对象上，cancel() 直接 abort
    const controller = new AbortController();

    const task = {
      id,
      name: String(name || '任务'),
      /** 进度状态 */
      done: 0,
      total: 0,
      /** 是否已结束（finish/fail 幂等依据） */
      finished: false,
      /** 最近一次 progress 广播时间（节流用） */
      _lastProgressEmit: 0,
      /** 是否已请求取消 */
      _cancelRequested: false,
      /** 取消控制器（registry.cancel 使用） */
      _controller: controller,

      /**
       * 更新并广播任务进度（内部节流；done>=total 时强制广播）。
       * @param {{done:number, total:number, extra?:string}} p - 进度数据
       * @returns {void}
       */
      setProgress({ done = 0, total = 0, extra = '' }) {
        if (this.finished) return;
        this.done = Math.max(0, done);
        this.total = Math.max(0, total);
        const now = Date.now();
        const force = total > 0 && done >= total;
        if (!force && now - this._lastProgressEmit < PROGRESS_THROTTLE_MS) return;
        this._lastProgressEmit = now;
        const percent = total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 0;
        registry.emit('progress', {
          taskId: this.id, name: this.name, done: this.done, total: this.total, percent, extra,
        });
      },

      /**
       * 追加一条任务日志。
       * @param {string} level - 级别：info | warn | error
       * @param {string} text - 日志内容
       * @returns {void}
       */
      log(level, text) {
        if (this.finished) return;
        registry.emit('log', { taskId: this.id, name: this.name, level, text: String(text), time: Date.now() });
      },

      /** @returns {AbortSignal} 取消信号（传给 http/downloader） */
      getSignal() {
        return this._controller.signal;
      },

      /**
       * 标记任务成功结束（幂等；广播 done 后保留在注册表供查询）。
       * @param {object} [result] - 结果数据（如 {versionId, files, bytes}）
       * @returns {void}
       */
      finish(result = {}) {
        if (this.finished) return;
        // 先发最终进度再标记结束（setProgress 对已结束任务静默）
        this.setProgress({ done: this.total || 1, total: this.total || 1, extra: '完成' });
        this.finished = true;
        registry.emit('done', { taskId: this.id, name: this.name, ok: true, result });
        registry._markFinished(this.id);
      },

      /**
       * 标记任务失败结束（幂等；取消产生的 AbortError 消息含「已取消」）。
       * @param {Error|string} error - 错误对象或消息
       * @returns {void}
       */
      fail(error) {
        if (this.finished) return;
        this.finished = true;
        const message = (error && (error.message || String(error))) || '未知错误';
        registry.emit('done', { taskId: this.id, name: this.name, ok: false, error: message });
        registry._markFinished(this.id);
      },
    };

    this._tasks.set(id, task);
    // 初始进度（total=0 表示不确定阶段）
    task.setProgress({ done: 0, total: 0, extra: '准备中' });
    return task;
  }

  /**
   * 记录任务结束并淘汰超量的已结束任务（内部方法）。
   * @param {string} id - 任务 id
   * @returns {void}
   */
  _markFinished(id) {
    this._finishedOrder.push(id);
    while (this._finishedOrder.length > MAX_FINISHED_TASKS) {
      const old = this._finishedOrder.shift();
      this._tasks.delete(old);
    }
  }

  /**
   * 请求取消任务：触发其 AbortController（执行体须响应信号）。
   * @param {string} taskId - 任务 id
   * @returns {boolean} 是否成功发出取消请求（任务不存在/已结束返回 false）
   */
  cancel(taskId) {
    const task = this._tasks.get(taskId);
    if (!task || task.finished) return false;
    task._cancelRequested = true;
    task.log('warn', '用户请求取消，正在中止…');
    if (task._controller && !task._controller.signal.aborted) {
      task._controller.abort();
    }
    return true;
  }

  /**
   * 按 id 获取任务句柄（测试/内部使用）。
   * @param {string} taskId - 任务 id
   * @returns {object|undefined} 任务句柄
   */
  getTask(taskId) {
    return this._tasks.get(taskId);
  }
}

/** 模块级注册表单例（类方法内统一引用 registry） */
const registry = new TaskRegistry();

module.exports = registry;
