'use strict';

/**
 * @fileoverview 版本安装编排模块（game/install.js）
 *
 * 完整安装流程（docs/CONTRACTS.md §5.17，每阶段 task.setProgress + task.log）：
 * 1. 目录布局确保（dataRoot + 当前实例）；
 * 2. 版本清单中查找目标版本（找不到抛「版本不存在」）；
 * 3. 下载原始版本 JSON → 继承合并（父链递归）→ 落盘 versions/<id>/<id>.json；
 * 4. 客户端主 jar：1.13+ 用 downloads.client（§8.5/§12 定论：不下载不合并
 *    client_mappings），旧版同样走 downloads.client，落盘 <id>.jar（sha1 校验）；
 * 5. logging 配置（如有）→ versions/<id>/log_configs/；
 * 6. 运行库解析 + 下载；
 * 7. 资源索引 + 对象下载（无 assetIndex 的版本跳过并 log 提示）；
 * 8. task.finish({versionId, files, bytes, fromCache})；任何一步失败 → task.fail
 *    （保留半成品供断点续传；listInstalled 以「json 与 jar 都存在」为准）。
 */

const fs = require('fs');
const path = require('path');
const paths = require('../util/paths');
const mirror = require('../util/mirror');
const { downloadFileCandidates } = require('../util/http');
const tasks = require('../tasks');
const instances = require('../instances');
const manifestApi = require('./manifest');
const versionApi = require('./version');
const librariesApi = require('./libraries');
const assetsApi = require('./assets');
const appLog = require('../util/log');

/** 安装各阶段权重（合计 100，用于任务进度百分比） */
const STAGE_WEIGHTS = {
  manifest: 5,     // 版本清单
  json: 5,         // 版本 JSON 下载 + 合并
  jar: 10,         // 客户端主 jar
  logging: 2,      // 日志配置
  libraries: 50,   // 运行库
  assets: 28,      // 资源文件
};

/**
 * 执行完整安装流程（内部函数；createInstallTask 与 Fabric 安装复用）。
 * 进度上报到传入的 task；失败抛出错误（由调用方 task.fail 兜底）。
 * @param {string} versionId - 版本 id
 * @param {{source?:string, task:object, signal?:AbortSignal, instanceId?:string}} opts - 选项
 * @returns {Promise<{versionId:string, files:number, bytes:number, fromCache:number}>} 安装统计
 * @throws {Error} 任一步骤失败
 */
async function runInstall(versionId, opts) {
  const { source = 'mojang', task, instanceId } = opts;
  const signal = task ? task.getSignal() : opts.signal;
  const instId = instanceId || instances.currentInstanceId();
  const stats = { versionId, files: 0, bytes: 0, fromCache: 0 };
  // 各阶段累计起点（百分比）
  let basePercent = 0;

  /** 阶段进度助手：把阶段内 0..1 映射到全局百分比 */
  function stageProgress(weight, extra) {
    return (p) => {
      const frac = p.total > 0 ? p.done / p.total : 0;
      const done = Math.round(basePercent + weight * frac);
      if (task) task.setProgress({ done, total: 100, extra });
    };
  }

  const checkAbort = () => { if (signal && signal.aborted) throw new Error('已取消：安装任务'); };

  // ---- 1. 目录布局 ----
  paths.ensureLayout();
  for (const d of [paths.instanceVersionsDir(instId), paths.instanceLibrariesDir(instId), paths.instanceAssetsDir(instId)]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (task) task.log('info', `开始安装 ${versionId}（实例：${instId}，下载源：${source}）`);

  // ---- 2. 版本清单查找 ----
  if (task) task.setProgress({ done: basePercent, total: 100, extra: '获取版本清单' });
  const manifest = await manifestApi.fetchManifest({ source });
  const entry = (manifest.versions || []).find(
    (v) => String(v.id).toLowerCase() === String(versionId).toLowerCase()
  );
  if (!entry) throw new Error(`版本不存在：${versionId}`);
  basePercent += STAGE_WEIGHTS.manifest;
  checkAbort();

  // ---- 3. 版本 JSON：下载 → 继承合并 → 落盘 ----
  if (task) task.setProgress({ done: basePercent, total: 100, extra: '下载并合并版本 JSON' });
  const raw = await versionApi.fetchVersionJson(versionId, { source, instanceId: instId });
  const merged = await versionApi.resolveInheritance(versionId, raw, { source, instanceId: instId });
  versionApi.writeMergedJson(instId, versionId, merged);
  basePercent += STAGE_WEIGHTS.json;
  checkAbort();

  // ---- 4. 客户端主 jar（§8.5/§12：仅 downloads.client 落为 <id>.jar，不下载 client_mappings） ----
  if (task) task.setProgress({ done: basePercent, total: 100, extra: '下载客户端主文件' });
  const jarPath = paths.instanceVersionJarPath(instId, versionId);
  const clientInfo = merged.downloads && merged.downloads.client;
  const officialJarUrl = clientInfo && clientInfo.url;
  const jarCandidates = new Set();
  if (source === 'bmclapi') {
    const mj = mirror.clientJarUrl(versionId, 'bmclapi');
    if (mj) jarCandidates.add(mj);
  }
  if (officialJarUrl) jarCandidates.add(officialJarUrl);
  else {
    // 无 downloads.client：仅剩镜像候选（官方 URL 缺失，第三方残缺 JSON 的兜底）
    const mj = mirror.clientJarUrl(versionId, 'bmclapi');
    if (mj) jarCandidates.add(mj);
  }
  if (source === 'mojang') {
    const mj = mirror.clientJarUrl(versionId, 'bmclapi');
    if (mj) jarCandidates.add(mj);
  }
  if (jarCandidates.size === 0) throw new Error(`版本 ${versionId} 缺少客户端下载地址`);
  await downloadFileCandidates([...jarCandidates], jarPath, {
    expectedSha1: clientInfo && clientInfo.sha1 ? clientInfo.sha1 : undefined,
    signal,
    onProgress: (p) => {
      if (task) task.setProgress({
        done: Math.round(basePercent + STAGE_WEIGHTS.jar * (p.total > 0 ? p.done / p.total : 0)),
        total: 100,
        extra: `下载客户端主文件（${(p.speedBytesPerSec / 1024 / 1024).toFixed(1)} MB/s）`,
      });
    },
    timeoutMs: 120000,
  });
  basePercent += STAGE_WEIGHTS.jar;
  checkAbort();

  // ---- 5. logging 配置（如有）----
  const loggingFile = merged.logging && merged.logging.client && merged.logging.client.file;
  if (loggingFile && loggingFile.url) {
    const logConfigDir = path.join(paths.instanceVersionsDir(instId), versionId, 'log_configs');
    fs.mkdirSync(logConfigDir, { recursive: true });
    const fileName = loggingFile.id || path.basename(loggingFile.url) || 'client.xml';
    const dest = path.join(logConfigDir, fileName);
    await downloadFileCandidates(mirror.orderedCandidates(loggingFile.url, source), dest, {
      // URL 含 sha1 才校验（§12.6 同款原则）
      expectedSha1: /\/[0-9a-f]{40}\//i.test(loggingFile.url) ? loggingFile.sha1 : undefined,
      signal,
    });
    if (task) task.log('info', `日志配置已下载：${fileName}`);
  }
  basePercent += STAGE_WEIGHTS.logging;
  checkAbort();

  // ---- 6. 运行库 ----
  if (task) task.setProgress({ done: basePercent, total: 100, extra: '解析运行库' });
  const osInfo = versionApi.currentOsInfo({ hasCustomResolution: true });
  const libs = librariesApi.listLibraries(merged, { osInfo, source, instanceId: instId });
  if (task) task.log('info', `运行库解析完成：${libs.length} 个（native ${libs.filter((l) => l.isNative).length} 个）`);
  const libStats = await librariesApi.downloadLibraries(instId, libs, {
    signal,
    threads: 4,
    onProgress: stageProgress(STAGE_WEIGHTS.libraries, '下载运行库'),
  });
  stats.files += libStats.files;
  stats.bytes += libStats.bytes;
  stats.fromCache += libStats.fromCache;
  basePercent += STAGE_WEIGHTS.libraries;
  checkAbort();

  // ---- 7. 资源索引与对象（无 assetIndex 且无兜底映射 → 跳过） ----
  const hasAssetIndex = !!(merged.assetIndex && merged.assetIndex.url)
    || (typeof merged.assets === 'string' && assetsApi.ASSET_INDEX_FALLBACK[merged.assets]);
  if (hasAssetIndex) {
    if (task) task.setProgress({ done: basePercent, total: 100, extra: '下载资源索引' });
    const index = await assetsApi.fetchAssetIndex(merged, { source, instanceId: instId, signal });
    const assetStats = await assetsApi.downloadAssets(instId, index, {
      source,
      signal,
      onProgress: stageProgress(STAGE_WEIGHTS.assets, '下载资源文件'),
    });
    stats.files += assetStats.files;
    stats.bytes += assetStats.bytes;
    stats.fromCache += assetStats.fromCache;
  } else {
    if (task) task.log('warn', '该版本没有资源索引（assetIndex），跳过资源下载');
  }
  basePercent += STAGE_WEIGHTS.assets;

  // ---- 8. 完成 ----
  appLog.add('info', 'install', `版本 ${versionId} 安装完成（${stats.files} 个文件，${(stats.bytes / 1024 / 1024).toFixed(1)} MB，缓存命中 ${stats.fromCache}）`);
  if (task) {
    task.setProgress({ done: 100, total: 100, extra: '安装完成' });
    task.finish(stats);
  }
  return stats;
}

/**
 * 创建安装任务（异步执行，立即返回 taskId）。
 * @param {string} versionId - 版本 id
 * @param {{source?:string}} [opts] - 下载源
 * @returns {{taskId:string}} 任务 id
 */
function createInstallTask(versionId, opts = {}) {
  const { source = 'mojang' } = opts;
  const task = tasks.createTask({ name: `安装 ${versionId}` });
  // 异步执行：任何错误（含取消）→ task.fail；正常路径由 runInstall 内 task.finish
  runInstall(versionId, { source, task }).catch((e) => {
    task.fail(e);
    appLog.add('error', 'install', `安装 ${versionId} 失败：${e.message}`);
  });
  return { taskId: task.id };
}

/**
 * 扫描当前实例已安装的版本（json 与 jar 都存在才算安装完成）。
 * @returns {Promise<Array<{id:string, type?:string}>>} 已安装版本列表（按安装时间倒序）
 */
async function listInstalled() {
  const instId = instances.currentInstanceId();
  const versionsDir = paths.instanceVersionsDir(instId);
  let dirs = [];
  try {
    dirs = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of dirs) {
    const jsonPath = paths.instanceVersionJsonPath(instId, id);
    const jarPath = paths.instanceVersionJarPath(instId, id);
    if (!fs.existsSync(jsonPath) || !fs.existsSync(jarPath)) continue;
    let type;
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      type = parsed.type || undefined;
    } catch {
      // 损坏 JSON 不算已安装
      continue;
    }
    let mtime = 0;
    try { mtime = fs.statSync(jarPath).mtimeMs; } catch { /* 忽略 */ }
    out.push({ id, type, _mtime: mtime });
  }
  // 最近安装的在前
  out.sort((a, b) => b._mtime - a._mtime);
  return out.map(({ id, type }) => ({ id, type }));
}

/**
 * 卸载版本：删除 versions/<versionId>/ 整个目录（assets/libraries 保留共享）。
 * @param {string} versionId - 版本 id
 * @returns {Promise<void>}
 * @throws {Error} 非法版本名（防路径穿越）
 */
async function uninstall(versionId) {
  if (typeof versionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(versionId)) {
    throw new Error('非法的版本名');
  }
  const instId = instances.currentInstanceId();
  const dir = path.join(paths.instanceVersionsDir(instId), versionId);
  await fs.promises.rm(dir, { recursive: true, force: true });
  appLog.add('info', 'install', `版本 ${versionId} 已卸载（${dir}）`);
}

module.exports = { createInstallTask, runInstall, listInstalled, uninstall };
