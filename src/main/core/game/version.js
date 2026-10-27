'use strict';

/**
 * @fileoverview 版本 JSON 模块（game/version.js）——正确性核心之一
 *
 * 负责版本 JSON 的下载、继承合并与规则匹配（docs/CONTRACTS.md §5.14 / §12.1）：
 * - fetchVersionJson：按清单条目 url（经下载源映射 + 候选回退）下载原始 JSON，
 *   缓存到当前实例 versions/<id>/<id>.json；
 * - resolveInheritance：递归处理 inheritsFrom 父链（循环引用检测、深度上限 10）；
 *   合并语义（§12.1 权威）：
 *   * libraries：父在前、子追加，拼接后按 group:artifact 去重（同坐标取高版本）；
 *   * arguments.jvm/game：父在前子在后拼接；子数组中的字符串条目按「占位符前缀」
 *     覆盖父中间前缀条目；对象条目直接追加；
 *   * minecraftArguments：子有则用子，否则用父；
 *   * mainClass / assetIndex / downloads / logging / javaVersion：子优先父补缺；
 *   * minimumLauncherVersion 取最大（它是启动器版本号，不是 Java 版本）；
 *   * id 保持子版本 id；
 * - writeMergedJson：合并结果覆盖落盘 versions/<id>/<id>.json（游戏与启动都读它）；
 * - matchRule：rules 顺序求值、首个匹配条目生效、默认 DISALLOW（仅 allow 规则）；
 * - classifierForLib：natives 描述符按 §12.4 顺序尝试；
 * - 解析宽容：第三方 JSON 字段残缺（无 downloads、拼写错误）给默认值而非抛错。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../util/paths');
const mirror = require('../util/mirror');
const { httpJsonCandidates } = require('../util/http');
const instances = require('../instances');
const { fetchManifest } = require('./manifest');
const appLog = require('../util/log');

/** 继承链最大深度 */
const MAX_INHERIT_DEPTH = 10;

// ===================== 版本号比较 =====================

/**
 * 解析版本号的数字段（忽略 -pre / +build 后缀），'1.20.5-pre1' → [1,20,5]。
 * @param {string} v - 版本字符串
 * @returns {number[]} 数字段数组
 */
function parseVersionSegments(v) {
  if (typeof v !== 'string') return [];
  return v.split('.').map((seg) => {
    const numeric = /^(\d+)/.exec(seg);
    return numeric ? parseInt(numeric[1], 10) : 0;
  });
}

/**
 * 按 . 分段数字比较两个版本（如 1.7.10 > 1.7.9；1.8 = 1.8.0）。
 * @param {string} a - 版本 A
 * @param {string} b - 版本 B
 * @returns {number} a>b 返回 1；a<b 返回 -1；相等返回 0
 */
function compareVersions(a, b) {
  const sa = parseVersionSegments(a);
  const sb = parseVersionSegments(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] || 0;
    const y = sb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ===================== 规则匹配（§5.14 / §8.2） =====================

/**
 * 当前平台信息（供规则匹配与 natives 选择）。
 * @param {{hasCustomResolution?:boolean}} [opts] - hasCustomResolution：启动器是否传了分辨率
 * @returns {{name:string, version:string, arch:string, features:object}} osInfo
 */
function currentOsInfo(opts = {}) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return {
    name: process.platform === 'win32' ? 'windows' : process.platform,
    version: os.release(),
    arch,
    features: {
      has_custom_resolution: !!opts.hasCustomResolution,
      is_demo_user: false,
    },
  };
}

/**
 * 判断单条规则是否匹配当前环境（os 字段齐全且 features 全部满足才算匹配）。
 * @param {object} rule - 规则对象 {action, os?, features?}
 * @param {object} osInfo - 环境信息（含 features 表）
 * @returns {boolean} 该规则是否匹配
 */
function ruleMatches(rule, osInfo) {
  if (!rule || typeof rule !== 'object') return true;
  // os 部分：name 省略 = 任意；version 为正则；arch 严格相等
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osInfo.name) return false;
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(osInfo.version)) return false;
      } catch {
        return false; // 非法正则视为不匹配
      }
    }
    if (rule.os.arch && rule.os.arch !== osInfo.arch) return false;
  }
  // features 部分：声明的特性必须全部为 true
  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if (expected && !osInfo.features[key]) return false;
    }
  }
  return true;
}

/**
 * 规则集整体判定（§5.14 语义，顺序求值、最后匹配生效、默认 DISALLOW）：
 * - 无 rules → true；
 * - 找到首个匹配的 allow → true；首个匹配的 disallow → false；
 * - 都不匹配：存在 disallow 规则 → 默认 true；仅 allow 规则 → 默认 false。
 * @param {Array|null} rules - 规则数组（库/参数的 rules 字段）
 * @param {object} osInfo - 环境信息
 * @returns {boolean} 是否应包含该项
 */
function matchRule(rules, osInfo) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let hasDisallow = false;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (rule.action === 'disallow') hasDisallow = true;
    if (ruleMatches(rule, osInfo)) {
      // 首个匹配的规则生效
      return rule.action === 'allow';
    }
  }
  // 无任何规则匹配：存在 disallow → 默认允许；仅 allow → 默认拒绝
  return hasDisallow;
}

// ===================== natives 分类器（§5.14 / §12.4） =====================

/**
 * 为 native 库选择本平台 classifier 描述符对象。
 * §12.4 描述符尝试顺序（x64）：natives-windows → natives-windows-64 →
 * natives-windows-x86_64 → natives-windows-arm64，取 downloads.classifiers
 * 中第一个存在的；arm64 优先 natives-windows-arm64（§5.14 平台键修正）。
 * @param {object} lib - 库条目
 * @param {object} osInfo - 环境信息
 * @returns {object|null} classifier 对象（{path,url,sha1,size}）；非本平台 native 返回 null
 */
function classifierForLib(lib, osInfo) {
  if (!lib || !lib.natives) return null;
  const hasWin = !!lib.natives.windows;
  const hasWinArm = !!lib.natives['windows-arm64'];
  if (!hasWin && !hasWinArm) return null; // 非 Windows 平台库
  // x64 平台要求 natives.windows 存在（windows-arm64 不适用于 x64 进程）
  if (osInfo.arch === 'x64' && !hasWin) return null;

  const classifiers = (lib.downloads && lib.downloads.classifiers) || {};
  // §12.4 顺序；arm64 平台优先自身描述符（§5.14）
  const order = osInfo.arch === 'arm64'
    ? ['natives-windows-arm64', 'natives-windows', 'natives-windows-64', 'natives-windows-x86_64']
    : ['natives-windows', 'natives-windows-64', 'natives-windows-x86_64', 'natives-windows-arm64'];
  for (const key of order) {
    if (classifiers[key]) return classifiers[key];
  }
  return null;
}

/**
 * 库的解压排除前缀列表：lib.extract.exclude，默认 ['META-INF/']。
 * @param {object} lib - 库条目
 * @returns {string[]} 前缀列表
 */
function extractExcludes(lib) {
  const excludes = lib && lib.extract && Array.isArray(lib.extract.exclude)
    ? lib.extract.exclude.filter((x) => typeof x === 'string')
    : [];
  return excludes.length > 0 ? excludes : ['META-INF/'];
}

// ===================== 继承合并（§12.1 权威） =====================

/**
 * 提取字符串参数条目中第一个 ${...} 占位符之前的「前缀」，
 * 用于父子参数的同前缀覆盖合并（如 '--username ${auth_player_name}' → '--username '）。
 * @param {string} entry - 参数字符串
 * @returns {string|null} 前缀；无占位符返回 null
 */
function argPrefix(entry) {
  const m = /\$\{[^}]+\}/.exec(entry);
  return m ? entry.slice(0, m.index) : null;
}

/**
 * 合并父子参数数组（§5.14/§12.1）：
 * 父在前；子数组的字符串条目若与父中某条同前缀（占位符前文本相同）则覆盖父条目
 * （取子的值），对象条目直接追加。
 * @param {Array} baseArr - 父参数数组
 * @param {Array} childArr - 子参数数组
 * @returns {Array} 合并结果
 */
function mergeArgArray(baseArr, childArr) {
  if (!Array.isArray(baseArr)) return Array.isArray(childArr) ? childArr.slice() : [];
  if (!Array.isArray(childArr)) return baseArr.slice();

  // 收集子字符串条目的前缀集合（同前缀 → 子覆盖父）
  const childPrefixes = new Set();
  for (const entry of childArr) {
    if (typeof entry === 'string') {
      const p = argPrefix(entry);
      if (p !== null) childPrefixes.add(p);
    }
  }
  const result = [];
  // 父在前：剔除被同前缀覆盖的父字符串条目（对象条目恒保留）
  for (const entry of baseArr) {
    if (typeof entry === 'string') {
      const p = argPrefix(entry);
      if (p !== null && childPrefixes.has(p)) continue;
    }
    result.push(entry);
  }
  // 子条目追加
  result.push(...childArr);
  return result;
}

/**
 * 库坐标（group:artifact，不含版本），用于 libraries 去重键。
 * @param {object} lib - 库条目
 * @returns {string|null} 'group:artifact'；无法解析返回 null
 */
function libKey(lib) {
  if (!lib || typeof lib.name !== 'string') return null;
  const parts = lib.name.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

/**
 * 合并父子 libraries：父在前子追加；按 group:artifact 去重，同坐标取高版本
 * （版本段按数字比较，同版本保留后出现的子条目）。
 * @param {Array} baseLibs - 父 libraries
 * @param {Array} childLibs - 子 libraries
 * @returns {Array} 合并后的 libraries
 */
function mergeLibraries(baseLibs, childLibs) {
  const combined = [];
  if (Array.isArray(baseLibs)) combined.push(...baseLibs);
  if (Array.isArray(childLibs)) combined.push(...childLibs);

  const seen = new Map(); // key → 数组下标
  const result = [];
  for (const lib of combined) {
    const key = libKey(lib);
    if (key === null) {
      result.push(lib); // 无 name 的异常条目原样保留
      continue;
    }
    if (seen.has(key)) {
      const existing = result[seen.get(key)];
      const existingVersion = existing.name.split(':')[2] || '';
      const newVersion = lib.name.split(':')[2] || '';
      // 同坐标取高版本：替换位置保持首次出现顺序
      if (compareVersions(newVersion, existingVersion) > 0) {
        result[seen.get(key)] = lib;
      }
    } else {
      seen.set(key, result.length);
      result.push(lib);
    }
  }
  return result;
}

/**
 * 合并父（base）与子（child）版本 JSON（§12.1 语义）。
 * @param {object|null} base - 父版本 JSON（无父为 null）
 * @param {object} child - 子版本 JSON
 * @returns {object} 合并结果（id 保持子 id）
 */
function mergeVersions(base, child) {
  if (!base) return child;
  // 子优先父补缺的浅合并基底
  const merged = { ...base, ...child };

  // libraries：拼接 + group:artifact 去重（父在前）
  merged.libraries = mergeLibraries(base.libraries, child.libraries);

  // arguments.jvm / game：父在前子在后拼接（字符串同前缀覆盖）
  if (base.arguments || child.arguments) {
    merged.arguments = { ...(base.arguments || {}) };
    if (child.arguments) merged.arguments = { ...merged.arguments, ...child.arguments };
    if (Array.isArray(base.arguments && base.arguments.jvm) || Array.isArray(child.arguments && child.arguments.jvm)) {
      merged.arguments.jvm = mergeArgArray(
        (base.arguments && base.arguments.jvm) || [],
        (child.arguments && child.arguments.jvm) || []
      );
    }
    if (Array.isArray(base.arguments && base.arguments.game) || Array.isArray(child.arguments && child.arguments.game)) {
      merged.arguments.game = mergeArgArray(
        (base.arguments && base.arguments.game) || [],
        (child.arguments && child.arguments.game) || []
      );
    }
  }

  // minecraftArguments：子有则用子
  if (typeof child.minecraftArguments !== 'string' && typeof base.minecraftArguments === 'string') {
    merged.minecraftArguments = base.minecraftArguments;
  }

  // minimumLauncherVersion 取最大（启动器版本号，非 Java 版本）
  if (typeof base.minimumLauncherVersion === 'number' || typeof child.minimumLauncherVersion === 'number') {
    merged.minimumLauncherVersion = Math.max(base.minimumLauncherVersion || 0, child.minimumLauncherVersion || 0);
  }

  // id 恒为子 id（merged 由 {...base, ...child} 保证；child 无 id 时保留 base.id 兜底）
  if (child.id) merged.id = child.id;
  return merged;
}

// ===================== 下载与解析 =====================

/**
 * 下载指定版本的原始版本 JSON（经下载源映射 + 候选回退），
 * 缓存到当前实例 versions/<id>/<id>.json（后续合并会覆盖它）。
 * @param {string} id - 版本 id
 * @param {{source?:string, force?:boolean, instanceId?:string}} [opts] - 选项
 * @returns {Promise<object>} 原始版本 JSON 对象
 * @throws {Error} 版本不存在 / 下载失败 / JSON 非法
 */
async function fetchVersionJson(id, opts = {}) {
  const { source = 'mojang', force = false, instanceId } = opts;
  const instId = instanceId || instances.currentInstanceId();
  const cachePath = paths.instanceVersionJsonPath(instId, id);

  // 非强制时优先复用本地缓存（可能是原始或已合并的 JSON，语义等价）
  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached && typeof cached === 'object' && cached.id) return cached;
    } catch {
      // 缓存缺失/损坏 → 重新下载
    }
  }

  const manifest = await fetchManifest({ source });
  const entry = (manifest.versions || []).find(
    (v) => String(v.id).toLowerCase() === String(id).toLowerCase()
  );
  if (!entry || !entry.url) throw new Error(`版本不存在：${id}`);

  // 候选链：镜像 /version/<id>/json 优先（实测 200），官方清单条目 url 兜底
  const candidates = new Set();
  const mirrorUrl = mirror.versionJsonUrl(id, source);
  if (mirrorUrl) candidates.add(mirrorUrl);
  for (const c of mirror.orderedCandidates(entry.url, source)) candidates.add(c);
  const list = [...candidates];

  const raw = await httpJsonCandidates(list, { timeoutMs: 60000 });
  if (!raw || typeof raw !== 'object') throw new Error(`版本 ${id} 的 JSON 格式异常`);

  // 缓存原始 JSON 到 versions/<id>/<id>.json
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.promises.writeFile(cachePath, JSON.stringify(raw, null, 2), 'utf8');
  return raw;
}

/**
 * 递归解析继承链并合并：父链同样下载 + 合并（循环引用检测，深度上限 10）。
 * @param {string} id - 顶层版本 id
 * @param {object} rawJson - 顶层版本的原始 JSON
 * @param {{source?:string, instanceId?:string}} [opts] - 选项
 * @returns {Promise<object>} 合并后的版本 JSON
 * @throws {Error} 循环引用 / 深度超限 / 父版本下载失败
 */
async function resolveInheritance(id, rawJson, opts = {}) {
  const { source = 'mojang', instanceId } = opts;
  const visited = new Set([id]);

  async function resolve(curId, curRaw, depth) {
    if (depth > MAX_INHERIT_DEPTH) {
      throw new Error(`版本继承链过深（>${MAX_INHERIT_DEPTH}）：${curId}`);
    }
    const parentId = curRaw && curRaw.inheritsFrom;
    if (!parentId) return curRaw; // 无父 → 自身即合并结果
    if (visited.has(parentId)) {
      throw new Error(`版本继承循环引用：${parentId}`);
    }
    visited.add(parentId);

    const parentRaw = await fetchVersionJson(parentId, { source, instanceId });
    const parentMerged = await resolve(parentId, parentRaw, depth + 1);
    return mergeVersions(parentMerged, curRaw);
  }

  return resolve(id, rawJson, 0);
}

/**
 * 把合并结果覆盖写入 versions/<id>/<id>.json（游戏启动与后续安装都以此为准）。
 * @param {string} instanceId - 实例 id
 * @param {string} id - 版本 id
 * @param {object} mergedJson - 合并后的版本 JSON
 * @returns {void}
 */
function writeMergedJson(instanceId, id, mergedJson) {
  const file = paths.instanceVersionJsonPath(instanceId, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(mergedJson, null, 2), 'utf8');
  appLog.add('info', 'version', `版本 ${id} 合并结果已写入 ${file}`);
}

module.exports = {
  compareVersions,
  parseVersionSegments,
  currentOsInfo,
  matchRule,
  ruleMatches,
  classifierForLib,
  extractExcludes,
  mergeVersions,
  mergeLibraries,
  mergeArgArray,
  fetchVersionJson,
  resolveInheritance,
  writeMergedJson,
};
