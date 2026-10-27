'use strict';

/**
 * @fileoverview 资源文件模块（game/assets.js）
 *
 * 资源索引与资源对象下载 + legacy 虚拟资源树重建（docs/CONTRACTS.md §5.16 / §12.6）：
 * - fetchAssetIndex：下载 merged.assetIndex.url（经下载源映射）到
 *   assets/indexes/<id>.json；assetIndex 缺失时按 assets 键名查硬编码兜底表；
 *   仅当 URL 本身含 sha1 才做 SHA-1 校验（官方索引字段 sha1 可能过期）；
 * - downloadAssets：objects 逐条下载到 assets/objects/<h1>/<h2>（sha1 校验/跳过）；
 * - ensureVirtualAssets（§12.6）：
 *   * virtual:true 或 map_to_resources:true 的索引为 legacy，需要 assets/virtual/<id> 树；
 *   * 重建前完整性检查：已存在对象数 ×10 < 总数 → 回退直接用 assets/ 根（放弃虚拟树）；
 *   * 否则增量复制缺失对象到 virtual/<assetId>/<name>；map_to_resources 再复制到 <gameDir>/resources/；
 *   * 返回虚拟资源目录路径（非 legacy 返回 null，调用方直接用 assets 根）。
 */

const fs = require('fs');
const path = require('path');
const paths = require('../util/paths');
const mirror = require('../util/mirror');
const { downloadFileCandidates, abortError } = require('../util/http');
const { downloadBatch } = require('../download/downloader');
const instances = require('../instances');
const appLog = require('../util/log');

/**
 * assetIndex 缺省兜底表（§12.1）：老版本/第三方 JSON 无 assetIndex 时按 assets 键名
 * 映射到官方索引地址（sha1 由实测获取，2026-10-28）。
 */
const ASSET_INDEX_FALLBACK = {
  'pre-1.6': 'https://launchermeta.mojang.com/v1/packages/3d8e55480977e32acd9844e545177e69a52f594b/pre-1.6.json',
  'legacy': 'https://launchermeta.mojang.com/v1/packages/770572e819335b6c0a053f8378ad88eda189fc14/legacy.json',
  '1.7.3': 'https://launchermeta.mojang.com/v1/packages/f6cf726f4747128d13887010c2cbc44ba83504d9/1.7.3.json',
  '1.7.4': 'https://launchermeta.mojang.com/v1/packages/545510a60f526b9aa8a38f9c0bc7a74235d21675/1.7.4.json',
  '1.7.10': 'https://launchermeta.mojang.com/v1/packages/1863782e33ce7b584fc45b037325a1964e095d3e/1.7.10.json',
  '1.8': 'https://launchermeta.mojang.com/v1/packages/f6ad102bcaa53b1a58358f16e376d548d44933ec/1.8.json',
};

/**
 * 判断索引是否为 legacy（需要虚拟资源树）。
 * @param {object} index - 资源索引对象
 * @returns {boolean} virtual 或 map_to_resources 为真
 */
function isLegacyIndex(index) {
  return !!(index && (index.virtual === true || index.map_to_resources === true));
}

/**
 * 从官方索引 URL 提取 sha1（/v1/packages/<sha1>/<id>.json 路径内含哈希）。
 * @param {string} url - 官方资源索引 URL
 * @returns {string|null} 40 位 sha1；URL 不含返回 null
 */
function sha1FromIndexUrl(url) {
  const m = /\/packages\/([0-9a-f]{40})\//i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * 下载资源索引到 assets/indexes/<id>.json 并返回索引对象。
 * @param {object} mergedJson - 合并后的版本 JSON
 * @param {{source?:string, instanceId?:string, signal?:AbortSignal}} [opts] - 选项
 * @returns {Promise<{id:string, objects:object, virtual?:boolean, map_to_resources?:boolean}>} 索引对象
 * @throws {Error} 无索引可下载 / 下载失败 / JSON 非法
 */
async function fetchAssetIndex(mergedJson, opts = {}) {
  const { source = 'mojang', instanceId, signal } = opts;
  const instId = instanceId || instances.currentInstanceId();

  // 索引元信息：json.assetIndex 优先；缺失按 assets 键名查兜底表
  let indexId = null;
  let officialUrl = null;
  if (mergedJson.assetIndex && typeof mergedJson.assetIndex === 'object') {
    indexId = mergedJson.assetIndex.id || null;
    officialUrl = mergedJson.assetIndex.url || null;
  }
  if (!officialUrl && typeof mergedJson.assets === 'string' && ASSET_INDEX_FALLBACK[mergedJson.assets]) {
    indexId = mergedJson.assets;
    officialUrl = ASSET_INDEX_FALLBACK[mergedJson.assets];
  }
  if (!officialUrl) {
    throw new Error('该版本缺少资源索引（assetIndex），无法下载资源');
  }
  if (!indexId) {
    const m = /\/([^/]+)\.json$/i.exec(officialUrl);
    indexId = m ? m[1] : 'legacy';
  }

  const dest = path.join(paths.instanceAssetsDir(instId), 'indexes', `${indexId}.json`);

  // 本地已有可解析索引且无强制校验要求 → 直接复用
  if (fs.existsSync(dest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      if (parsed && typeof parsed.objects === 'object') return parsed;
    } catch {
      // 损坏 → 重新下载
    }
  }

  // §12.6：仅当 URL 本身含 sha1 才做 SHA-1 校验
  const expectedSha1 = sha1FromIndexUrl(officialUrl);
  const candidates = mirror.orderedCandidates(officialUrl, source);
  await downloadFileCandidates(candidates, dest, { expectedSha1, signal, timeoutMs: 60000 });

  let index = null;
  try {
    index = JSON.parse(fs.readFileSync(dest, 'utf8'));
  } catch {
    throw new Error(`资源索引不是合法 JSON：${dest}`);
  }
  if (!index || typeof index.objects !== 'object') {
    throw new Error(`资源索引格式异常（缺少 objects）：${indexId}`);
  }
  return index;
}

/**
 * 从本地 assets/indexes/<id>.json 读取索引（启动阶段用，缺失返回 null）。
 * @param {string} instanceId - 实例 id
 * @param {string} indexId - 索引 id
 * @returns {object|null} 索引对象
 */
function readLocalIndex(instanceId, indexId) {
  try {
    const file = path.join(paths.instanceAssetsDir(instanceId), 'indexes', `${indexId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.objects === 'object') return parsed;
  } catch {
    // 缺失/损坏
  }
  return null;
}

/**
 * 下载资源对象：objects 逐条 → assets/objects/<h1>/<h2>（sha1 校验/跳过），
 * legacy 索引额外重建虚拟资源树（§5.16）。
 * @param {string} instanceId - 实例 id
 * @param {object} index - 资源索引对象
 * @param {{onProgress?:Function, signal?:AbortSignal, threads?:number, source?:string}} [opts] - 选项
 * @returns {Promise<{files:number, bytes:number, fromCache:number}>} 下载统计
 * @throws {Error} 下载失败 / 取消
 */
async function downloadAssets(instanceId, index, opts = {}) {
  const { onProgress, signal, threads, source = 'mojang' } = opts;
  const objectsDir = path.join(paths.instanceAssetsDir(instanceId), 'objects');

  const files = [];
  for (const [name, obj] of Object.entries(index.objects || {})) {
    if (!obj || typeof obj.hash !== 'string' || obj.hash.length < 40) continue; // 宽容解析
    const hash = obj.hash;
    const officialUrl = mirror.assetObjectUrl(hash, 'mojang');
    files.push({
      urls: mirror.orderedCandidates(officialUrl, source),
      dest: path.join(objectsDir, hash.slice(0, 2), hash),
      sha1: hash,
      size: obj.size,
    });
  }

  const stats = await downloadBatch(files, {
    threads,
    signal,
    onOverall: (p) => onProgress && onProgress({ done: p.done, total: p.total, extra: '下载资源文件' }),
  });

  // legacy 索引：安装阶段一并重建虚拟资源树（启动阶段还会再校验重建，§12.6）
  if (isLegacyIndex(index)) {
    await ensureVirtualAssets(instanceId, index, { signal });
  }
  return stats;
}

/**
 * 重建/校验 legacy 虚拟资源树（§12.6）。
 * - 重建前完整性检查：assets/objects 中已存在对象数 ×10 < 总数 →
 *   回退直接用 assets/ 根（返回 assets 根路径），不重建虚拟树；
 * - 否则增量复制缺失对象到 assets/virtual/<assetId>/<name>；
 * - map_to_resources:true 时再复制到 <gameDir>/resources/。
 * @param {string} instanceId - 实例 id
 * @param {object} index - 资源索引对象
 * @param {{signal?:AbortSignal, onProgress?:Function}} [opts] - 选项
 * @returns {Promise<string|null>} 虚拟资源目录绝对路径；非 legacy 返回 null；完整性不足返回 assets 根
 */
async function ensureVirtualAssets(instanceId, index, opts = {}) {
  const { signal, onProgress } = opts;
  if (!isLegacyIndex(index)) return null;

  const assetsDir = paths.instanceAssetsDir(instanceId);
  const objectsDir = path.join(assetsDir, 'objects');
  const virtualDir = path.join(assetsDir, 'virtual', index.id || 'legacy');
  const names = Object.keys(index.objects || {});
  const total = names.length;
  if (total === 0) return virtualDir;

  // 完整性检查：统计 objects 中已存在的对象数
  let existingObjects = 0;
  for (const name of names) {
    const obj = index.objects[name];
    if (!obj || typeof obj.hash !== 'string') continue;
    if (fs.existsSync(path.join(objectsDir, obj.hash.slice(0, 2), obj.hash))) existingObjects += 1;
  }
  // 已有对象不足总数 10% → 虚拟树无法完整重建，回退直接用 assets 根（游戏可运行、资源缺失）
  if (existingObjects * 10 < total) {
    appLog.add('warn', 'assets', `资源对象严重缺失（${existingObjects}/${total}），虚拟资源树回退为 assets 根`);
    return assetsDir;
  }

  // 增量复制：缺失或大小不符的对象 → virtual/<id>/<name>
  await fs.promises.mkdir(virtualDir, { recursive: true });
  const resourcesDir = index.map_to_resources === true ? path.join(paths.instanceDir(instanceId), 'resources') : null;
  if (resourcesDir) await fs.promises.mkdir(resourcesDir, { recursive: true });

  let copied = 0;
  let processed = 0;
  for (const name of names) {
    if (signal && signal.aborted) throw abortError('重建虚拟资源树');
    const obj = index.objects[name];
    if (!obj || typeof obj.hash !== 'string') continue;
    const src = path.join(objectsDir, obj.hash.slice(0, 2), obj.hash);
    if (!fs.existsSync(src)) continue; // 对象缺失：跳过（完整性检查已兜底）

    const destVirtual = path.join(virtualDir, ...name.split('/'));
    const needCopy = !fs.existsSync(destVirtual)
      || (typeof obj.size === 'number' && fs.statSync(destVirtual).size !== obj.size);
    if (needCopy) {
      await fs.promises.mkdir(path.dirname(destVirtual), { recursive: true });
      await fs.promises.copyFile(src, destVirtual);
      copied += 1;
    }
    // map_to_resources：同步到 <gameDir>/resources/（§12.6）
    if (resourcesDir) {
      const destRes = path.join(resourcesDir, ...name.split('/'));
      if (!fs.existsSync(destRes) || (typeof obj.size === 'number' && fs.statSync(destRes).size !== obj.size)) {
        await fs.promises.mkdir(path.dirname(destRes), { recursive: true });
        await fs.promises.copyFile(src, destRes);
      }
    }
    processed += 1;
    if (onProgress && processed % 500 === 0) {
      onProgress({ done: processed, total, extra: '重建虚拟资源树' });
    }
  }
  appLog.add('info', 'assets', `虚拟资源树就绪：${virtualDir}（新复制 ${copied}/${total}）`);
  return virtualDir;
}

module.exports = {
  ASSET_INDEX_FALLBACK,
  isLegacyIndex,
  fetchAssetIndex,
  readLocalIndex,
  downloadAssets,
  ensureVirtualAssets,
};
