'use strict';

/**
 * @fileoverview 下载源 URL 构造器模块（util/mirror.js）
 *
 * 按「构造器」方式生成官方源（mojang）与镜像源（bmclapi）的下载 URL，
 * 不做通用字符串替换，避免镜像路径与官方路径差异导致的 404。
 *
 * 实测修正（2026-10-28，scripts/smoke 验证，见 CONTRACTS.md §7「以实测为准」）：
 * 1. 版本 JSON：bmclapi2 /version/<id>/json 可用（200）；
 * 2. 客户端 jar：bmclapi2 /version/<id>/client 可用（200，新旧版本通用）；
 * 3. 资源索引：bmclapi2 /indexes/<id>.json 实测 404，但官方 launchermeta/piston-meta
 *    的 /v1/packages/<sha1>/<id>.json 在 bmclapi2 上以「同路径 host 替换」可用（200），
 *    因此资源索引与 Java 清单统一走 host 替换，/indexes 仅作契约签名保留；
 * 4. 资源对象：bmclapi2 /assets/<h1>/<h2> 可用（200）；
 * 5. 运行库：bmclapi2 /libraries/<path> 可用（200）；
 * 6. Mojang 对象存储（piston-data / launcher.mojang 的 /v1/objects/...）：
 *    bmclapi2 同路径 host 替换可用（200），Java 运行时 raw 文件亦走此路径；
 * 7. Fabric 元数据 /fabric-meta/... 与 Maven /maven/... 均可用（200）；
 * 8. Java 运行时清单（launchermeta 的 /v1/products/java-runtime/...）host 替换可用（200）。
 */

const constants = require('../constants');

const BASE = constants.BMCLAPI_BASE_URL;

/**
 * 版本清单 URL。
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string} 版本清单下载地址
 */
function versionManifestUrl(source) {
  return source === constants.SOURCE_BMCLAPI
    ? `${BASE}/mc/game/version_manifest.json`
    : constants.MOJANG_VERSION_MANIFEST_URL;
}

/**
 * 版本 JSON URL（仅镜像可由 id 直接构造）。
 * 官方源必须使用版本清单条目中的 url 字段（含哈希，无法由 id 推导），故返回 null。
 * @param {string} versionId - 版本 id，如 '1.21.4'
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string|null} 镜像 URL；官方源返回 null（用清单条目 url）
 */
function versionJsonUrl(versionId, source) {
  if (source === constants.SOURCE_BMCLAPI) {
    return `${BASE}/version/${encodeURIComponent(versionId)}/json`;
  }
  return null;
}

/**
 * 客户端主 jar URL（仅镜像可由 id 直接构造，官方需 json.downloads.client.url）。
 * @param {string} versionId - 版本 id
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string|null} 镜像 URL；官方源返回 null
 */
function clientJarUrl(versionId, source) {
  if (source === constants.SOURCE_BMCLAPI) {
    return `${BASE}/version/${encodeURIComponent(versionId)}/client`;
  }
  return null;
}

/**
 * 资源索引 URL（仅镜像可由索引 id 构造）。
 * 注意：实测 bmclapi2 的 /indexes/<id>.json 返回 404，实际下载请使用
 * fallbackCandidates 对官方 launchermeta/piston-meta 包 URL 做 host 替换。
 * 本函数按契约签名保留，供探测与展示使用。
 * @param {string} assetIndexId - 资源索引 id，如 'legacy'、'19'
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string|null} 镜像 URL；官方源返回 null
 */
function assetIndexUrl(assetIndexId, source) {
  if (source === constants.SOURCE_BMCLAPI) {
    return `${BASE}/indexes/${encodeURIComponent(assetIndexId)}.json`;
  }
  return null;
}

/**
 * 资源对象 URL（哈希前两位为第一级目录、完整哈希为文件名，官方与镜像均可用哈希直接构造）。
 * @param {string} sha1 - 资源对象的 40 位 sha1
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string} 资源对象下载地址
 */
function assetObjectUrl(sha1, source) {
  if (source === constants.SOURCE_BMCLAPI) {
    return `${BASE}/assets/${sha1.slice(0, 2)}/${sha1}`;
  }
  return `https://resources.download.minecraft.net/${sha1.slice(0, 2)}/${sha1}`;
}

/**
 * 运行库 URL（mavenPath 形如 com/mojang/logging/1.1.1/logging-1.1.1.jar）。
 * @param {string} mavenPath - Maven 仓库相对路径
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string} 运行库下载地址
 */
function libraryUrl(mavenPath, source) {
  if (source === constants.SOURCE_BMCLAPI) {
    return `${BASE}/libraries/${mavenPath}`;
  }
  return `https://libraries.minecraft.net/${mavenPath}`;
}

/**
 * Fabric 元数据 URL（path 以 / 开头，如 /v2/versions/loader/1.21.4）。
 * @param {string} path - 元数据接口路径
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string} Fabric 元数据地址
 */
function fabricMetaUrl(path, source) {
  if (source === constants.SOURCE_BMCLAPI) {
    return `${BASE}/fabric-meta${path}`;
  }
  return `${constants.FABRIC_META_BASE_URL}${path}`;
}

/**
 * 生成某官方 URL 的镜像等价候选（不含官方原地址）。
 * 按已知域名映射表尽力生成；无匹配规则时返回空数组。
 * @param {string} url - 官方（或第三方）URL
 * @returns {string[]} 镜像候选列表（可能为空）
 */
function mirrorCandidates(url) {
  const out = [];
  const add = (u) => { if (u && u !== url && !out.includes(u)) out.push(u); };
  // 统一小写判断域名
  const lower = String(url).toLowerCase();
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    if (host === 'libraries.minecraft.net') {
      add(`${BASE}/libraries${pathname}`);
    } else if (host === 'resources.download.minecraft.net') {
      // resources.download.minecraft.net/<h1>/<h2> → /assets/<h1>/<h2>
      add(`${BASE}/assets${pathname}`);
    } else if (host === 'launchermeta.mojang.com' || host === 'piston-meta.mojang.com') {
      // 官方清单/索引包路径：镜像以同路径 host 替换提供（实测 200）
      add(`${BASE}${pathname}`);
    } else if (host === 'launcher.mojang.com' || host === 'piston-data.mojang.com') {
      // 官方对象存储（client.jar、Java 运行时 raw 文件等）：host 替换可用（实测 200）
      add(`${BASE}${pathname}`);
    } else if (host === 'maven.fabricmc.net') {
      add(`${BASE}/maven${pathname}`);
    } else if (host === 'maven.minecraftforge.net' || host === 'files.minecraftforge.net') {
      // Forge 系 Maven：files.minecraftforge.net/maven/<path> 的 /maven 前缀保留
      add(`${BASE}/maven${pathname}`);
    } else if (host === 'meta.fabricmc.net') {
      add(`${BASE}/fabric-meta${pathname}`);
    } else if (host === 'maven.neoforged.net') {
      add(`${BASE}/maven${pathname}`);
    }
  } catch {
    // URL 非法时忽略，仅返回空候选
  }
  return out;
}

/**
 * 未覆盖构造器的官方 URL：返回 [官方原样, 可能的镜像等价物...]。
 * 官方地址恒在首位；镜像候选按 §7 规则表尽力生成（实测修正见模块头）。
 * @param {string} url - 官方 URL
 * @returns {string[]} 候选列表（至少包含原 URL）
 */
function fallbackCandidates(url) {
  return [url, ...mirrorCandidates(url)];
}

/**
 * 按用户选择的下载源排序候选：镜像模式镜像在前官方兜底；官方模式官方在前镜像兜底。
 * 与 CONTRACTS.md §4.3「镜像失败回官方」一致，同时保证官方模式下网络异常仍有镜像可退。
 * @param {string} url - 官方 URL
 * @param {string} source - 'mojang' | 'bmclapi'
 * @returns {string[]} 按优先级排列的候选列表（去重）
 */
function orderedCandidates(url, source) {
  const official = url;
  const mirrors = mirrorCandidates(url);
  const list = source === constants.SOURCE_BMCLAPI
    ? [...mirrors, official]
    : [official, ...mirrors];
  // 去重保序
  return [...new Set(list.filter(Boolean))];
}

module.exports = {
  versionManifestUrl,
  versionJsonUrl,
  clientJarUrl,
  assetIndexUrl,
  assetObjectUrl,
  libraryUrl,
  fabricMetaUrl,
  fallbackCandidates,
  mirrorCandidates,
  orderedCandidates,
};
