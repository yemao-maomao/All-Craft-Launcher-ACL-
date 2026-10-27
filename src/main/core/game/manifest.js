'use strict';

/**
 * @fileoverview 版本清单模块（game/manifest.js）
 *
 * 抓取并缓存 Mojang/BMCLAPI 的版本清单（version_manifest.json）：
 * - URL 由 mirror.versionManifestUrl(source) 构造，镜像候选失败自动回官方；
 * - 缓存 dataRoot/cache/version_manifest.json，TTL = MANIFEST_CACHE_TTL_MS，
 *   force=true 忽略缓存强制刷新；
 * - versions 保持官方顺序（新在前），返回前不裁剪；
 * - 注意（§12.7）：BMCLAPI 清单存在缓存滞后（快照可能滞后官方数日），
 *   UI 不应据此宣称「最新」。
 */

const fs = require('fs');
const path = require('path');
const constants = require('../constants');
const paths = require('../util/paths');
const mirror = require('../util/mirror');
const { httpJsonCandidates } = require('../util/http');
const appLog = require('../util/log');

/** 版本清单缓存文件名 */
const MANIFEST_CACHE_FILE = 'version_manifest.json';

/**
 * 抓取版本清单（带 30 分钟缓存）。
 * @param {{force?:boolean, source?:string}} [opts] - force 忽略缓存；source 'mojang'|'bmclapi'
 * @returns {Promise<{latest:{release:string,snapshot:string}, versions:Array<{id:string,type:string,url:string,releaseTime:string,sha1?:string}>}>} 清单对象
 * @throws {Error} 下载失败 / 格式异常
 */
async function fetchManifest(opts = {}) {
  const { force = false, source = 'mojang' } = opts;
  const cachePath = path.join(paths.cacheDir(), MANIFEST_CACHE_FILE);

  // 命中缓存（未过期且未强制刷新）
  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (
        cached && typeof cached.fetchedAt === 'number' &&
        Date.now() - cached.fetchedAt < constants.MANIFEST_CACHE_TTL_MS &&
        cached.data && Array.isArray(cached.data.versions)
      ) {
        return cached.data;
      }
    } catch {
      // 缓存缺失/损坏 → 重新下载
    }
  }

  appLog.add('info', 'manifest', `抓取版本清单（下载源：${source}）`);
  const candidates = mirror.orderedCandidates(mirror.versionManifestUrl(source), source);
  const data = await httpJsonCandidates(candidates, { timeoutMs: constants.HTTP_TIMEOUT_MS });
  if (!data || typeof data !== 'object' || !Array.isArray(data.versions)) {
    throw new Error('版本清单格式异常');
  }

  // 原子写缓存
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
  await fs.promises.rename(tmp, cachePath);
  return data;
}

module.exports = { fetchManifest };
