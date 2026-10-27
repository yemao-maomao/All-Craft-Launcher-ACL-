'use strict';

/**
 * @fileoverview 运行库模块（game/libraries.js）
 *
 * 解析、下载与解压版本运行库（docs/CONTRACTS.md §5.15 / §12.4）：
 * - listLibraries：按规则过滤（matchRule），native 库取本平台 classifier 条目，
 *   普通库取 downloads.artifact（缺省时按 name 的 Maven 坐标推导路径），
 *   生成 { name, url, dest(绝对路径), sha1, size, isNative, classifier, extractExclude, urls } 列表；
 * - downloadLibraries：批量并发下载（镜像候选 + 官方兜底）；
 * - extractNatives：仅解压 native jar 到 versions/<id>/natives-<platform>，
 *   排除 extract.exclude 前缀 + 固定排除 .sha1 / .git（防路径穿越由 util/zip 保证）。
 */

const fs = require('fs');
const path = require('path');
const paths = require('../util/paths');
const mirror = require('../util/mirror');
const { downloadBatch } = require('../download/downloader');
const { extractZip } = require('../util/zip');
const versionUtil = require('./version');
const instances = require('../instances');
const appLog = require('../util/log');

/** 官方运行库基地址（库条目无 url 字段时的默认值） */
const DEFAULT_LIB_BASE = 'https://libraries.minecraft.net';

/**
 * 由 Maven 坐标 name（group:artifact:version[:classifier]）推导仓库相对路径。
 * 例：com.mojang:logging:1.1.1 → com/mojang/logging/1.1.1/logging-1.1.1.jar
 * @param {string} name - Maven 坐标
 * @returns {string|null} 仓库相对路径；解析失败返回 null
 */
function mavenPathFromName(name) {
  if (typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  const dir = group.replace(/\./g, '/');
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return `${dir}/${artifact}/${version}/${fileName}`;
}

/**
 * 解析版本 JSON 的运行库列表（过滤不适用项、确定 native/artifact 与下载地址）。
 * @param {object} mergedJson - 合并后的版本 JSON
 * @param {{osInfo?:object, source?:string, instanceId?:string}} [opts] - osInfo 环境信息（缺省按本机）；source 下载源
 * @returns {Array<{name:string, url:string, dest:string, sha1?:string, size?:number, isNative:boolean, classifier?:string, extractExclude:string[], urls:string[]}>} 库列表
 */
function listLibraries(mergedJson, opts = {}) {
  const { source = 'mojang', instanceId } = opts;
  const osInfo = opts.osInfo || versionUtil.currentOsInfo({ hasCustomResolution: true });
  const instId = instanceId || instances.currentInstanceId();
  const libDir = paths.instanceLibrariesDir(instId);
  const libs = [];

  const arr = Array.isArray(mergedJson.libraries) ? mergedJson.libraries : [];
  for (const lib of arr) {
    // 宽容解析：字符串/空条目跳过（第三方 JSON 可能残缺）
    if (!lib || typeof lib !== 'object') continue;
    // 规则过滤：不匹配的库不参与本平台安装
    if (Array.isArray(lib.rules) && !versionUtil.matchRule(lib.rules, osInfo)) continue;

    const downloads = lib.downloads || {};
    let artifact = downloads.artifact || null;
    let classifier = null;
    let isNative = false;

    if (lib.natives && typeof lib.natives === 'object') {
      // native 库：取本平台 classifier 条目
      classifier = versionUtil.classifierForLib(lib, osInfo);
      if (!classifier) continue; // 本平台无可用 natives → 跳过
      isNative = true;
    }

    const item = isNative ? classifier : artifact;
    // 相对路径：优先条目自带的 path，缺省按 Maven 坐标推导
    let relPath = item && item.path ? item.path : mavenPathFromName(lib.name);
    if (!relPath) continue;

    const base = (typeof lib.url === 'string' && lib.url) || DEFAULT_LIB_BASE;
    const officialUrl = (item && item.url) || `${base.replace(/\/+$/, '')}/${relPath}`;

    libs.push({
      name: lib.name || relPath,
      url: officialUrl,
      dest: path.join(libDir, ...relPath.split('/')),
      sha1: (item && item.sha1) || undefined,
      size: (item && item.size) || undefined,
      isNative,
      classifier: isNative ? classifier.path : undefined,
      extractExclude: versionUtil.extractExcludes(lib),
      // 候选链：按下载源排序（镜像优先/官方兜底 或 官方优先/镜像兜底）
      urls: mirror.orderedCandidates(officialUrl, source),
    });
  }
  return libs;
}

/**
 * 批量下载运行库（断点续传 + sha1 校验 + 候选回退）。
 * @param {string} instanceId - 实例 id
 * @param {Array} libs - listLibraries 的结果
 * @param {{onProgress?:Function, signal?:AbortSignal, threads?:number}} [opts] - 选项
 * @returns {Promise<{files:number, bytes:number, fromCache:number}>} 下载统计
 * @throws {Error} 下载失败 / 取消
 */
async function downloadLibraries(instanceId, libs, opts = {}) {
  const { onProgress, signal, threads } = opts;
  const files = libs.map((lib) => ({
    urls: lib.urls,
    dest: lib.dest,
    sha1: lib.sha1,
    size: lib.size,
  }));
  return downloadBatch(files, {
    threads,
    signal,
    onOverall: (p) => onProgress && onProgress({ done: p.done, total: p.total, extra: '下载运行库' }),
  });
}

/**
 * 解压全部 native 库到 natives 目录（§12.4：versions/<id>/natives-<platform>）。
 * 排除 extract.exclude 前缀 + 固定排除 .sha1 文件与 .git 目录。
 * @param {string} instanceId - 实例 id
 * @param {string} versionId - 版本 id
 * @param {Array} libs - listLibraries 的结果（仅 isNative 条目参与）
 * @returns {string} natives 目录绝对路径
 * @throws {Error} native jar 缺失或解压失败
 */
function extractNatives(instanceId, versionId, libs) {
  const nativesDir = paths.instanceNativesDir(instanceId, versionId);
  fs.mkdirSync(nativesDir, { recursive: true });

  let extractedCount = 0;
  for (const lib of libs) {
    if (!lib.isNative) continue;
    if (!fs.existsSync(lib.dest)) {
      throw new Error(`原生库文件缺失：${lib.dest}（请重新安装该版本）`);
    }
    // 固定排除 .sha1 与 .git（§12.4），前缀排除 extract.exclude
    const extracted = extractZip(lib.dest, nativesDir, {
      excludePrefixes: lib.extractExclude || ['META-INF/'],
      filter: (name) => !name.endsWith('.sha1') && !name.startsWith('.git/'),
    });
    extractedCount += extracted.length;
  }
  appLog.add('info', 'libraries', `原生库解压完成：${extractedCount} 个文件 → ${nativesDir}`);
  return nativesDir;
}

module.exports = { listLibraries, downloadLibraries, extractNatives, mavenPathFromName };
