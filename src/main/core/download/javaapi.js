'use strict';

/**
 * @fileoverview Mojang Java 运行时下载模块（download/javaapi.js）
 *
 * 依据 docs/CONTRACTS.md §5.12 / §12.9 实现 Java 运行时清单解析与安装：
 * - all.json：{平台: {组件名: [条目...]}}，条目含 version.name 与 manifest.url；
 *   取「主版本 ≥ 所需 major 的最近条目」（jre-legacy=8、alpha=16、beta/gamma=17、
 *   delta=21、epsilon=25）；
 * - 平台 manifest：files 的键为相对路径，条目 {type, downloads:{raw,lzma}}；
 *   **零依赖策略：只用 raw 逐文件下载**（并发、断点续传、sha1 校验），
 *   type='directory' 建目录、type='link' 忽略（Windows 平台无符号链接）；
 * - 目标目录 dataRoot/java/jre-<major>/，完成校验 bin/java.exe 存在；
 * - 镜像候选：官方 raw.url 的 piston-data host 替换（实测可用），失败回官方。
 *
 * all.json 缓存 dataRoot/cache/java-runtime.json，TTL 12 小时。
 */

const fs = require('fs');
const path = require('path');
const constants = require('../constants');
const paths = require('../util/paths');
const mirror = require('../util/mirror');
const { httpJsonCandidates } = require('../util/http');
const { downloadBatch } = require('./downloader');
const appLog = require('../util/log');

/** Java 运行时清单缓存文件名 */
const JAVA_MANIFEST_CACHE = 'java-runtime.json';

/** 缓存有效期（12 小时） */
const JAVA_MANIFEST_TTL_MS = 12 * 60 * 60 * 1000;

/** raw 文件下载并发数（§5.12：并发 4-8 线程） */
const JAVA_DOWNLOAD_THREADS = 6;

/**
 * 从 version.name 解析 Java 主版本：
 * '8u51-cacert462b08' → 8；'16.0.1.9.1' → 16；'17.0.15' → 17；'1.8.0_51' → 8。
 * @param {string} name - 组件 version.name
 * @returns {number|null} 主版本号；无法解析返回 null
 */
function parseJavaMajor(name) {
  if (typeof name !== 'string') return null;
  // 老式命名：8u51-... / 8u201
  let m = /^(\d+)u(\d+)/.exec(name);
  if (m) return parseInt(m[1], 10);
  // 常规命名：1.8.0_51 / 17.0.15 / 25.0.1 / 14
  m = /^(\d+)\.(\d+)/.exec(name);
  if (m) {
    const first = parseInt(m[1], 10);
    if (first === 1) return parseInt(m[2], 10); // 1.8 → 8
    return first;
  }
  m = /^(\d+)$/.exec(name);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * 获取 Java 运行时总清单（all.json），12h 缓存。
 * @param {{force?:boolean, source?:string}} [opts] - force 忽略缓存；source 下载源
 * @returns {Promise<object>} all.json 对象
 * @throws {Error} 下载/解析失败
 */
async function fetchJavaManifest(opts = {}) {
  const { force = false, source = 'mojang' } = opts;
  const cachePath = path.join(paths.cacheDir(), JAVA_MANIFEST_CACHE);

  // 命中缓存（未过期且未强制刷新）
  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < JAVA_MANIFEST_TTL_MS && cached.data) {
        return cached.data;
      }
    } catch {
      // 缓存缺失/损坏 → 重新下载
    }
  }

  const candidates = mirror.orderedCandidates(constants.MOJANG_JAVA_MANIFEST_URL, source);
  const data = await httpJsonCandidates(candidates, { timeoutMs: 60000 });
  if (!data || typeof data !== 'object') throw new Error('Java 运行时清单格式异常');

  // 原子写缓存
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
  await fs.promises.rename(tmp, cachePath);
  return data;
}

/**
 * 从 all.json 中为指定平台解析满足 major 要求的运行时组件。
 * 遍历该平台全部组件条目，取「主版本 ≥ major 且最近」的一条。
 * @param {number} major - 需要的 Java 主版本（8/16/17/21/25）
 * @param {{os?:string, arch?:string}} [opts] - os 仅 'windows'（本项目）；arch 'x64'|'arm64'
 * @returns {Promise<{version:string, major:number, manifestUrl:string, manifestSha1?:string, componentName:string}>} 组件信息
 * @throws {Error} 平台无该版本运行时
 */
async function resolveJavaVersion(major, opts = {}) {
  const all = await fetchJavaManifest({ source: opts.source });
  const arch = opts.arch === 'arm64' ? 'arm64' : opts.arch === 'x86' ? 'x86' : 'x64';
  const platformKey = `windows-${arch}`;
  const platform = all[platformKey];
  if (!platform || typeof platform !== 'object') {
    throw new Error(`Mojang 未提供 ${platformKey} 平台的 Java 运行时`);
  }

  // 遍历全部组件（每组件可能是数组：同组件多条目取首个满足者）
  let best = null;
  for (const [componentName, entries] of Object.entries(platform)) {
    const arr = Array.isArray(entries) ? entries : [entries];
    for (const entry of arr) {
      if (!entry || !entry.version || !entry.manifest || !entry.manifest.url) continue;
      const m = parseJavaMajor(entry.version.name);
      if (m == null) continue;
      // 要求主版本 ≥ 所需；同满足时取更近的（主版本更小者优先）
      if (m >= major && (!best || m < best.major)) {
        best = { major: m, entry, componentName };
      }
    }
  }
  if (!best) throw new Error(`Mojang 未提供 Java ${major} 的 ${platformKey} 运行时`);

  return {
    version: best.entry.version.name,
    major: best.major,
    manifestUrl: best.entry.manifest.url,
    manifestSha1: best.entry.manifest.sha1,
    componentName: best.componentName,
  };
}

/**
 * 下载并安装指定 major 的 Java 运行时到 dataRoot/java/jre-<major>/。
 * @param {number} major - Java 主版本
 * @param {{onProgress?:Function, signal?:AbortSignal, source?:string}} [opts] - onProgress({done,total,extra})；source 下载源
 * @returns {Promise<{javaDir:string, javaExe:string, major:number}>} 安装结果
 * @throws {Error} 组件解析/清单异常/下载失败/缺少 bin/java.exe
 */
async function downloadJava(major, opts = {}) {
  const source = opts.source || 'mojang';
  const { onProgress, signal } = opts;
  const info = await resolveJavaVersion(major, { arch: process.arch === 'arm64' ? 'arm64' : 'x64', source });

  // 下载平台 manifest（候选链：镜像优先/官方兜底）
  const manifestCandidates = mirror.orderedCandidates(info.manifestUrl, source);
  const manifest = await httpJsonCandidates(manifestCandidates, { signal, timeoutMs: 60000 });
  if (!manifest || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Java 运行时平台清单格式异常');
  }

  const javaDir = path.join(paths.javaDir(), `jre-${info.major}`);
  await fs.promises.mkdir(javaDir, { recursive: true });
  appLog.add('info', 'java', `开始下载 Java ${info.major} 运行时（${info.version}）到 ${javaDir}`);

  // 预扫描：目录条目建目录、link 忽略、file 条目收集下载
  const fileTasks = [];
  for (const [relPath, meta] of Object.entries(manifest.files)) {
    if (!meta || typeof meta !== 'object') continue;
    // 安全：拒绝路径穿越（清单来自 Mojang，双保险）
    if (relPath.includes('..') || path.isAbsolute(relPath)) {
      appLog.add('warn', 'java', `忽略可疑路径条目：${relPath}`);
      continue;
    }
    if (meta.type === 'directory') {
      await fs.promises.mkdir(path.join(javaDir, relPath), { recursive: true });
      continue;
    }
    if (meta.type === 'link') continue; // Windows 平台无符号链接，忽略
    if (meta.type !== 'file' || !meta.downloads || !meta.downloads.raw) continue;

    const raw = meta.downloads.raw;
    if (!raw.url) continue;
    fileTasks.push({
      urls: mirror.orderedCandidates(raw.url, source),
      dest: path.join(javaDir, relPath),
      sha1: raw.sha1,
      size: raw.size,
    });
  }

  // 并发 raw 逐文件下载（断点续传 + sha1 校验，行为等价于 lzma 解包）
  const stats = await downloadBatch(fileTasks, {
    threads: JAVA_DOWNLOAD_THREADS,
    signal,
    onOverall: (p) => onProgress && onProgress({ done: p.done, total: p.total, extra: `下载 Java ${info.major} 运行时文件` }),
  });
  appLog.add('info', 'java', `Java ${info.major} 运行时下载完成：${stats.files} 个文件（缓存命中 ${stats.fromCache}）`);

  // 完整性兜底：bin/java.exe 必须存在
  const javaExe = path.join(javaDir, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) {
    throw new Error(`Java 运行时损坏：缺少 bin/java.exe（${javaDir}）`);
  }
  return { javaDir, javaExe, major: info.major };
}

module.exports = { fetchJavaManifest, resolveJavaVersion, downloadJava, parseJavaMajor };
