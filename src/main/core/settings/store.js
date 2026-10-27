'use strict';

/**
 * @fileoverview 设置持久化模块（settings/store.js）
 *
 * 启动器设置的单一事实来源：
 * - 存储 dataRoot/settings.json（JSON + 临时文件原子写 + rename）；
 * - 内存缓存加速读取；文件损坏时备份为 .broken 并回退默认值；
 * - set(patch) 深合并后原子写盘，并向所有订阅者广播 'changed'（携带完整新设置）；
 * - 除契约的异步 get/set 外，提供 getCachedSync() 供启动等同步路径读取
 *   （未加载时返回默认值，不触发磁盘 IO）。
 *
 * ipc.js 已把 'changed' 事件转发为渲染进程的 acl:settings-changed。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const paths = require('../util/paths');

/** 默认设置（docs/CONTRACTS.md §5.6） */
const DEFAULTS = {
  language: 'zh_CN',        // 界面语言
  theme: 'light',           // light | dark
  accent: 'blue',           // 主题色预设：blue | orange | green
  downloadSource: 'mojang', // mojang | bmclapi（文件与清单共用）
  maxDownloadThreads: 4,    // 1..16
  autoMemory: true,         // 自动分配内存
  minMemory: 512, maxMemory: 4096, // MB（自定义时生效）
  extraJvmArgs: '',         // 追加 JVM 参数（按空格分词）
  resolution: { width: 854, height: 480 },
  msClientId: '',           // 微软 OAuth 客户端 ID（空 = 未配置，登录时提示）
  javaPath: null,           // 手动指定 java.exe；null = 自动检测
  instance: 'default',      // 当前实例 id
  autoScrollLog: true,
  lastAccount: null,        // {type,name,uuid} 记忆上次账户
};

/**
 * 深合并：普通对象递归合并，数组与标量整体替换。
 * @param {object} base - 基础对象
 * @param {object} patch - 补丁对象（其字段覆盖 base）
 * @returns {object} 合并结果（新对象）
 */
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 深度克隆（structuredClone 不可用时回退 JSON） */
function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 设置存储单例。
 */
class SettingsStore extends EventEmitter {
  constructor() {
    super();
    /** 内存缓存（null 表示尚未从磁盘加载） */
    this._cache = null;
  }

  /**
   * 从磁盘加载设置（首次 get 时调用）。文件损坏 → 备份 .broken 并回退默认。
   * @returns {Promise<object>} 设置对象
   */
  async _load() {
    const file = paths.settingsFile();
    try {
      const text = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('设置文件内容不是对象');
      }
      return deepMerge(DEFAULTS, parsed); // 新字段补默认值
    } catch (e) {
      if (e.code === 'ENOENT') return deepClone(DEFAULTS); // 首次运行
      // 损坏文件：备份后回退默认，不阻断启动
      try {
        await fs.promises.rename(file, file + '.broken');
      } catch {
        // 备份失败不影响回退
      }
      console.warn('[settings] 设置文件损坏，已备份为 .broken 并回退默认值：', e.message);
      return deepClone(DEFAULTS);
    }
  }

  /**
   * 读取完整设置（返回副本，外部修改不影响内部状态）。
   * @returns {Promise<object>} 设置对象
   */
  async get() {
    if (!this._cache) this._cache = await this._load();
    return deepClone(this._cache);
  }

  /**
   * 同步读取内存缓存（未加载时返回默认值，不触发磁盘 IO）。
   * 仅供启动参数组装等同步路径使用。
   * @returns {object} 设置对象副本
   */
  getCachedSync() {
    return this._cache ? deepClone(this._cache) : deepClone(DEFAULTS);
  }

  /**
   * 合并写入设置：深合并 → 原子写（tmp + rename）→ 广播 'changed'。
   * @param {object} patch - 需要修改的字段（深合并语义）
   * @returns {Promise<object>} 写入后的完整设置
   * @throws {Error} 写盘失败（磁盘满/权限等）
   */
  async set(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return this.get();
    const current = this._cache || (await this._load());
    this._cache = deepMerge(current, patch);

    // 原子写：先写临时文件再 rename，避免写入中断留下半个 JSON
    const file = paths.settingsFile();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, JSON.stringify(this._cache, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);

    const snapshot = deepClone(this._cache);
    this.emit('changed', snapshot);
    return snapshot;
  }
}

module.exports = new SettingsStore();
