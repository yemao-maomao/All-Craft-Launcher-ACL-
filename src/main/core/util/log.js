'use strict';

/**
 * @fileoverview 应用日志模块（util/log.js）
 *
 * 内存环形缓冲区 + EventEmitter 的应用级日志：
 * - add(level, source, text)：追加一行并触发 'line' 事件；
 * - getAll()：返回当前全部行（按时间序）；
 * - clear()：清空缓冲；
 * - 缓冲上限 constants.MAX_LOG_LINES，超出丢弃最旧行。
 *
 * ipc.js 已把 'line' 事件转发为渲染进程的 acl:app-log。
 * 安装、启动、认证等模块的关键节点统一经本模块记录。
 */

const { EventEmitter } = require('events');
const constants = require('../constants');

/**
 * 日志实例（模块导出即单例）。
 * 环形缓冲实现：数组 + 头指针，避免频繁 shift 的 O(n) 开销。
 */
class AppLog extends EventEmitter {
  constructor() {
    super();
    /** 环形缓冲存储 */
    this._buffer = new Array(constants.MAX_LOG_LINES);
    /** 已写入总数（用于计算行号与环形位置） */
    this._count = 0;
  }

  /**
   * 追加一条日志并广播 'line' 事件。
   * @param {string} level - 级别：info | warn | error
   * @param {string} source - 来源模块名，如 'launch'、'install'
   * @param {string} text - 日志正文
   * @returns {{time:number, level:string, source:string, text:string}} 本次追加的条目
   */
  add(level, source, text) {
    const entry = { time: Date.now(), level, source, text: String(text) };
    this._buffer[this._count % constants.MAX_LOG_LINES] = entry;
    this._count += 1;
    this.emit('line', entry);
    return entry;
  }

  /**
   * 获取全部日志行（时间序，返回副本，外部修改不影响内部状态）。
   * @returns {Array<{time:number, level:string, source:string, text:string}>} 日志行数组
   */
  getAll() {
    const size = Math.min(this._count, constants.MAX_LOG_LINES);
    const out = [];
    // 从最旧的条目开始组装，保证时间序
    const start = this._count > constants.MAX_LOG_LINES ? this._count % constants.MAX_LOG_LINES : 0;
    for (let i = 0; i < size; i++) {
      out.push(this._buffer[(start + i) % constants.MAX_LOG_LINES]);
    }
    return out;
  }

  /** 清空日志缓冲（触发清空后 UI 自行刷新） */
  clear() {
    this._buffer = new Array(constants.MAX_LOG_LINES);
    this._count = 0;
  }
}

module.exports = new AppLog();
