'use strict';

/**
 * @fileoverview Fabric 加载器安装模块（game/fabric.js）
 *
 * 依据 docs/CONTRACTS.md §5.18 / §12.11 实现：
 * - fetchFabricLoaders：GET meta /v2/versions/loader/<game>（bmclapi 走 /fabric-meta/
 *   同路径；官方 meta.fabricmc.net 不可达时候选链回退镜像）；
 * - createInstallTask：下载 profile JSON（/v2/versions/loader/<game>/<loader>/profile/json，
 *   其本身即完整版本 json：id=fabric-loader-<loader>-<game>、inheritsFrom、mainClass 等）
 *   → 原版未安装则先安装原版（复用 install 流程）→ 继承合并落盘 →
 *   下载 profile 新增 libraries（maven.fabricmc.net → bmclapi /maven/<path> 映射）。
 */

const path = require('path');
const paths = require('../util/paths');
const mirror = require('../util/mirror');
const { httpJsonCandidates } = require('../util/http');
const tasks = require('../tasks');
const instances = require('../instances');
const installApi = require('./install');
const versionApi = require('./version');
const librariesApi = require('./libraries');
const appLog = require('../util/log');

/**
 * 查询某游戏版本可用的 Fabric 加载器列表。
 * @param {string} gameVersion - 游戏版本 id，如 '1.21.4'
 * @param {{source?:string}} [opts] - 下载源（默认 'mojang'；镜像不可达时官方兜底，反之亦然）
 * @returns {Promise<Array<{loader:object, intermediary:object, launcherMeta:object}>>} 加载器条目列表
 * @throws {Error} 网络失败 / 响应非法
 */
async function fetchFabricLoaders(gameVersion, opts = {}) {
  const { source = 'mojang' } = opts;
  if (!gameVersion) throw new Error('缺少游戏版本参数');
  const metaPath = `/v2/versions/loader/${encodeURIComponent(gameVersion)}`;
  // 候选链：按下载源排序（§5.18：source='mojang' 也允许回退 bmclapi）
  const official = mirror.fabricMetaUrl(metaPath, 'mojang');
  const bmcl = mirror.fabricMetaUrl(metaPath, 'bmclapi');
  const candidates = source === 'bmclapi' ? [bmcl, official] : [official, bmcl];
  const data = await httpJsonCandidates(candidates, { timeoutMs: 30000 });
  if (!Array.isArray(data)) throw new Error('Fabric 加载器列表格式异常');
  return data;
}

/**
 * 创建 Fabric 安装任务（异步执行，立即返回 taskId）。
 * @param {{gameVersion:string, loaderVersion:string, source?:string}} opts - 游戏版本 / 加载器版本 / 下载源
 * @returns {{taskId:string}} 任务 id
 * @throws {Error} 参数缺失
 */
function createInstallTask(opts = {}) {
  const { gameVersion, loaderVersion, source = 'mojang' } = opts;
  if (!gameVersion || !loaderVersion) {
    throw new Error('安装 Fabric 需要 gameVersion 与 loaderVersion');
  }
  const task = tasks.createTask({ name: `安装 Fabric ${loaderVersion}（MC ${gameVersion}）` });
  runFabricInstall({ gameVersion, loaderVersion, source, task }).catch((e) => {
    task.fail(e);
    appLog.add('error', 'fabric', `Fabric 安装失败：${e.message}`);
  });
  return { taskId: task.id };
}

/**
 * Fabric 安装内部流程（供 createInstallTask 调用）。
 * @param {{gameVersion:string, loaderVersion:string, source?:string, task:object}} opts - 选项
 * @returns {Promise<{versionId:string, files:number, bytes:number, fromCache:number}>} 安装统计
 */
async function runFabricInstall(opts) {
  const { gameVersion, loaderVersion, source = 'mojang', task } = opts;
  const signal = task.getSignal();
  const instId = instances.currentInstanceId();

  task.setProgress({ done: 0, total: 100, extra: '检查原版安装状态' });

  // 1. 原版未安装 → 先安装原版（复用 install 流程，进度归入本任务）
  const installed = await installApi.listInstalled();
  if (!installed.some((i) => i.id === gameVersion)) {
    task.log('info', `原版 ${gameVersion} 未安装，先安装原版`);
    await installApi.runInstall(gameVersion, { source, task, instanceId: instId });
  }

  // 2. 下载 Fabric profile JSON（即完整版本 json）
  task.setProgress({ done: 5, total: 100, extra: '下载 Fabric profile' });
  const profilePath = `/v2/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  const official = mirror.fabricMetaUrl(profilePath, 'mojang');
  const bmcl = mirror.fabricMetaUrl(profilePath, 'bmclapi');
  const candidates = source === 'bmclapi' ? [bmcl, official] : [official, bmcl];
  const profile = await httpJsonCandidates(candidates, { signal, timeoutMs: 30000 });
  if (!profile || typeof profile !== 'object') throw new Error('Fabric profile 格式异常');

  const profileId = profile.id || `fabric-loader-${loaderVersion}-${gameVersion}`;
  task.log('info', `Fabric profile 版本 id：${profileId}`);

  // 3. 继承合并（原版 json 已在本地）并落盘
  task.setProgress({ done: 10, total: 100, extra: '合并版本 JSON' });
  const merged = await versionApi.resolveInheritance(profileId, profile, { source, instanceId: instId });
  versionApi.writeMergedJson(instId, profileId, merged);

  // 4. 下载 profile 新增 libraries（fabric maven 坐标经 mirror 映射）
  task.setProgress({ done: 15, total: 100, extra: '解析 Fabric 运行库' });
  const osInfo = versionApi.currentOsInfo({ hasCustomResolution: true });
  const libs = librariesApi.listLibraries(merged, { osInfo, source, instanceId: instId });
  task.log('info', `Fabric 运行库：${libs.length} 个`);
  const libStats = await librariesApi.downloadLibraries(instId, libs, {
    signal,
    threads: 4,
    onProgress: (p) => {
      const frac = p.total > 0 ? p.done / p.total : 0;
      task.setProgress({ done: Math.round(15 + 80 * frac), total: 100, extra: '下载 Fabric 运行库' });
    },
  });

  const stats = { versionId: profileId, files: libStats.files, bytes: libStats.bytes, fromCache: libStats.fromCache };
  task.setProgress({ done: 100, total: 100, extra: 'Fabric 安装完成' });
  task.finish(stats);
  appLog.add('info', 'fabric', `Fabric ${loaderVersion}（MC ${gameVersion}）安装完成`);
  return stats;
}

module.exports = { fetchFabricLoaders, createInstallTask };
