'use strict';

/**
 * @fileoverview 实例（游戏目录）管理模块（instances.js）
 *
 * 管理 dataRoot/instances.json 中的实例清单与每个实例的目录布局：
 * - list()：返回 [{id,name,createdAt,isDefault}]，并保证默认实例恒存在；
 * - create(id)：校验命名规则（1~32 位字母数字._-、拒绝 Windows 保留名）与重名，创建完整目录布局；
 * - remove(id)：默认实例拒绝删除；删除当前实例时先把 settings.instance 回退 'default'；
 * - rename(oldId,newId)：同 create 校验，改清单 + 目录改名，同步更新 settings.instance。
 *
 * 存储格式：{ default:'default', list:[{id,name,createdAt}] }。
 */

const fs = require('fs');
const path = require('path');
const paths = require('./util/paths');
const settingsStore = require('./settings/store');

/** 实例 id 命名规则：1~32 位字母数字 . _ - */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

/** Windows 保留设备名（大小写不敏感，含带扩展名形式） */
const RESERVED_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * 校验实例 id：命名规则 + Windows 保留名。
 * @param {string} id - 候选实例 id
 * @returns {void}
 * @throws {Error} 非法命名时抛出清晰中文错误
 */
function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('实例名只能包含字母、数字、点、下划线、连字符（1~32 位）');
  }
  if (RESERVED_PATTERN.test(id)) {
    throw new Error(`「${id}」是 Windows 保留名称，不能作为实例名`);
  }
}

/**
 * 读取实例清单文件（不存在时初始化默认清单）。内部同步 IO（清单文件很小）。
 * @returns {{default:string, list:Array<{id:string,name:string,createdAt:number}>}} 清单对象
 */
function readStoreSync() {
  const file = paths.instancesFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.list)) {
      return { default: parsed.default || paths.DEFAULT_INSTANCE_ID, list: parsed.list };
    }
  } catch {
    // 文件缺失或损坏 → 重建默认清单
  }
  const fresh = {
    default: paths.DEFAULT_INSTANCE_ID,
    list: [{ id: paths.DEFAULT_INSTANCE_ID, name: paths.DEFAULT_INSTANCE_ID, createdAt: Date.now() }],
  };
  writeStoreSync(fresh);
  return fresh;
}

/**
 * 原子写回实例清单。
 * @param {{default:string, list:Array}} store - 清单对象
 * @returns {void}
 * @throws {Error} 写盘失败
 */
function writeStoreSync(store) {
  const file = paths.instancesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 创建单个实例的完整目录布局（幂等） */
function ensureInstanceDirsSync(id) {
  const base = paths.instanceDir(id);
  fs.mkdirSync(base, { recursive: true });
  for (const sub of paths.INSTANCE_SUB_DIRS) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

/** 确保默认实例存在（清单与目录均幂等） */
function ensureDefaultSync() {
  paths.ensureLayout(); // 含默认实例目录
  const store = readStoreSync();
  if (!store.list.some((i) => i.id === paths.DEFAULT_INSTANCE_ID)) {
    store.list.unshift({
      id: paths.DEFAULT_INSTANCE_ID,
      name: paths.DEFAULT_INSTANCE_ID,
      createdAt: Date.now(),
    });
    writeStoreSync(store);
  }
}

/**
 * 列出全部实例（保证默认实例存在）。
 * @returns {Promise<Array<{id:string,name:string,createdAt:number,isDefault:boolean}>>} 实例数组
 */
async function list() {
  ensureDefaultSync();
  const store = readStoreSync();
  // dir 为实例目录绝对路径（渲染进程「打开文件夹」等操作使用）
  return store.list.map((i) => ({ ...i, isDefault: i.id === store.default, dir: paths.instanceDir(i.id) }));
}

/**
 * 创建新实例并生成完整目录布局。
 * @param {string} id - 实例 id
 * @returns {Promise<{id:string,name:string,createdAt:number,isDefault:boolean}>} 新实例对象
 * @throws {Error} 命名非法或重名
 */
async function create(id) {
  validateId(id);
  ensureDefaultSync();
  const store = readStoreSync();
  if (store.list.some((i) => i.id === id)) {
    throw new Error(`实例「${id}」已存在`);
  }
  ensureInstanceDirsSync(id);
  const item = { id, name: id, createdAt: Date.now() };
  store.list.push(item);
  writeStoreSync(store);
  return { ...item, isDefault: false, dir: paths.instanceDir(id) };
}

/**
 * 删除实例（连同整个实例目录）。默认实例拒绝删除。
 * @param {string} id - 实例 id
 * @returns {Promise<void>}
 * @throws {Error} 默认实例或不存在
 */
async function remove(id) {
  ensureDefaultSync();
  const store = readStoreSync();
  if (id === store.default) throw new Error('默认实例不允许删除');
  const idx = store.list.findIndex((i) => i.id === id);
  if (idx < 0) throw new Error(`实例「${id}」不存在`);

  await fs.promises.rm(paths.instanceDir(id), { recursive: true, force: true });
  store.list.splice(idx, 1);
  writeStoreSync(store);

  // 删除的是当前实例 → 设置回退默认
  const settings = settingsStore.getCachedSync();
  if (settings.instance === id) {
    await settingsStore.set({ instance: paths.DEFAULT_INSTANCE_ID });
  }
}

/**
 * 重命名实例：改清单 + 目录改名；若为当前实例则同步更新 settings.instance。
 * @param {string} oldId - 原实例 id
 * @param {string} newId - 新实例 id
 * @returns {Promise<{id:string,name:string,createdAt:number,isDefault:boolean}>} 更新后的实例对象
 * @throws {Error} 校验失败 / 重名 / 原实例不存在
 */
async function rename(oldId, newId) {
  validateId(newId);
  ensureDefaultSync();
  const store = readStoreSync();
  const item = store.list.find((i) => i.id === oldId);
  if (!item) throw new Error(`实例「${oldId}」不存在`);
  if (store.list.some((i) => i.id === newId)) {
    throw new Error(`实例「${newId}」已存在`);
  }

  const oldDir = paths.instanceDir(oldId);
  const newDir = paths.instanceDir(newId);
  if (fs.existsSync(oldDir)) {
    if (fs.existsSync(newDir)) throw new Error(`目标目录已存在：${newDir}`);
    fs.renameSync(oldDir, newDir);
  }
  item.id = newId;
  item.name = newId; // 当前无自定义别名能力，name 随 id 变化
  writeStoreSync(store);

  const settings = settingsStore.getCachedSync();
  if (settings.instance === oldId) {
    await settingsStore.set({ instance: newId });
  }
  return { ...item, isDefault: newId === store.default, dir: paths.instanceDir(newId) };
}

/**
 * 当前实例 id（settings.instance，兜底默认实例）。
 * @returns {string} 实例 id
 */
function currentInstanceId() {
  const settings = settingsStore.getCachedSync();
  return settings.instance || paths.DEFAULT_INSTANCE_ID;
}

module.exports = { list, create, remove, rename, currentInstanceId, validateId };
