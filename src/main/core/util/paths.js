'use strict';

/**
 * @fileoverview 数据根与实例目录布局解析模块（util/paths.js）
 *
 * 全局唯一的目录信息入口：main.js / scripts/smoke.js 在启动时通过 init() 注入
 * 「应用根目录」与「系统用户数据目录」，此后所有 core 模块统一经本模块获取
 * dataRoot、缓存目录、Java 目录、实例目录等绝对路径。core 层不依赖 electron
 * 的 app.getPath 等 API，因此可脱离 Electron 环境独立运行与测试。
 *
 * 布局规则（docs/CONTRACTS.md §3）：
 * - 便携模式：appRoot 下存在 .portable 文件 → dataRoot = appRoot/.acl-data；
 * - 否则 dataRoot = userDataRoot（%APPDATA%\AllCraftLauncher）；
 * - 每个实例是 dataRoot/instances/<id> 下的一个标准 .minecraft 目录。
 */

const fs = require('fs');
const path = require('path');

/** 默认实例 id（不可删除的基础实例） */
const DEFAULT_INSTANCE_ID = 'default';

/** 实例目录下需要预创建的完整布局（游戏子目录） */
const INSTANCE_SUB_DIRS = [
  'versions',
  'libraries',
  'assets',
  'assets/indexes',
  'assets/objects',
  'assets/virtual',
  'resourcepacks',
  'saves',
  'mods',
  'screenshots',
  'crash-reports',
  'logs',
];

/** 初始化状态（null 表示尚未 init） */
let state = null;

/** 缓存 natives 平台名（本项目仅支持 Windows，含架构） */
let cachedNativesPlatform = null;

/**
 * 计算 natives 目录的平台后缀：windows-x86_64 / windows-arm64。
 * 依据 docs/CONTRACTS.md §12.4，process.arch 映射：x64→x86_64、arm64→arm64。
 * @returns {string} 平台标识，如 'windows-x86_64'
 */
function nativesPlatform() {
  if (cachedNativesPlatform) return cachedNativesPlatform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  cachedNativesPlatform = 'windows-' + arch;
  return cachedNativesPlatform;
}

/**
 * 一次性注入目录信息（main.js / scripts/smoke.js 调用）。
 * @param {{appRoot: string, userDataRoot: string}} opts - appRoot 为可执行文件所在目录，userDataRoot 为系统用户数据目录
 * @returns {void}
 * @throws {Error} 已初始化且参数与上次不同时抛出，防止运行期目录混乱
 */
function init({ appRoot, userDataRoot }) {
  if (!appRoot || !userDataRoot) {
    throw new Error('paths.init 需要 appRoot 与 userDataRoot 两个参数');
  }
  if (state) {
    // 幂等：相同参数重复调用无害
    if (state.appRoot === appRoot && state.userDataRoot === userDataRoot) return;
    throw new Error('paths 已初始化，不允许重复注入不同的目录配置');
  }
  const portable = fs.existsSync(path.join(appRoot, '.portable'));
  state = {
    appRoot,
    userDataRoot,
    dataRoot: portable ? path.join(appRoot, '.acl-data') : userDataRoot,
  };
}

/** 断言已初始化，未初始化时抛错（防止误用相对/空路径） */
function requireInit() {
  if (!state) throw new Error('paths 尚未初始化：请先调用 paths.init()');
}

/**
 * 解析数据根目录（便携模式判定见模块头注释）。
 * @returns {string} dataRoot 绝对路径
 */
function resolveDataRoot() {
  requireInit();
  return state.dataRoot;
}

/**
 * 幂等创建 dataRoot 下的全部基础目录与默认实例目录布局。
 * 重复调用无害；任何一步失败抛出带中文信息的 Error。
 * @returns {void}
 */
function ensureLayout() {
  requireInit();
  const dirs = [
    cacheDir(),
    logsDir(),
    javaDir(),
    instancesDir(),
    path.join(instanceDir(DEFAULT_INSTANCE_ID)),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
  // 默认实例的完整游戏子目录布局
  for (const sub of INSTANCE_SUB_DIRS) {
    fs.mkdirSync(path.join(instanceDir(DEFAULT_INSTANCE_ID), sub), { recursive: true });
  }
}

// ===================== 基础目录访问器 =====================

/** @returns {string} 数据根目录绝对路径 */
function dataRoot() { requireInit(); return state.dataRoot; }
/** @returns {string} 缓存目录（version_manifest.json、java-runtime.json 等）
 *  命名为 .acl-cache 而非 cache：避免与 Chromium 在 userData 根目录自建的
 *  "Cache" 目录在 Windows（大小写不敏感文件系统）上撞名，被浏览器缓存清理误删。 */
function cacheDir() { return path.join(dataRoot(), '.acl-cache'); }
/** @returns {string} 启动器日志落盘目录 */
function logsDir() { return path.join(dataRoot(), 'logs'); }
/** @returns {string} 自动下载的 Java 运行时根目录 */
function javaDir() { return path.join(dataRoot(), 'java'); }
/** @returns {string} 实例清单目录 */
function instancesDir() { return path.join(dataRoot(), 'instances'); }
/** @returns {string} 设置文件绝对路径 */
function settingsFile() { return path.join(dataRoot(), 'settings.json'); }
/** @returns {string} 实例清单文件绝对路径 */
function instancesFile() { return path.join(dataRoot(), 'instances.json'); }

// ===================== 实例相关目录 =====================

/**
 * 单个实例（.minecraft 目录）的绝对路径。
 * @param {string} id - 实例 id
 * @returns {string} instances/<id>
 */
function instanceDir(id) { return path.join(instancesDir(), id); }

/** @param {string} id - 实例 id @returns {string} 版本目录 */
function instanceVersionsDir(id) { return path.join(instanceDir(id), 'versions'); }
/** @param {string} id - 实例 id @returns {string} 运行库目录 */
function instanceLibrariesDir(id) { return path.join(instanceDir(id), 'libraries'); }
/** @param {string} id - 实例 id @returns {string} 资源根目录 */
function instanceAssetsDir(id) { return path.join(instanceDir(id), 'assets'); }

/**
 * 原生库解压目录：versions/<versionId>/natives-<platform>（§12.4 修正后的命名）。
 * @param {string} id - 实例 id
 * @param {string} versionId - 版本 id
 * @returns {string} natives 目录绝对路径
 */
function instanceNativesDir(id, versionId) {
  return path.join(instanceVersionsDir(id), versionId, 'natives-' + nativesPlatform());
}

/**
 * 版本 JSON 路径：versions/<versionId>/<versionId>.json（合并结果也落盘于此）。
 * @param {string} id - 实例 id
 * @param {string} versionId - 版本 id
 * @returns {string} 版本 JSON 绝对路径
 */
function instanceVersionJsonPath(id, versionId) {
  return path.join(instanceVersionsDir(id), versionId, versionId + '.json');
}

/**
 * 客户端主 jar 路径：versions/<versionId>/<versionId>.jar。
 * @param {string} id - 实例 id
 * @param {string} versionId - 版本 id
 * @returns {string} 主 jar 绝对路径
 */
function instanceVersionJarPath(id, versionId) {
  return path.join(instanceVersionsDir(id), versionId, versionId + '.jar');
}

module.exports = {
  DEFAULT_INSTANCE_ID,
  INSTANCE_SUB_DIRS,
  init,
  resolveDataRoot,
  ensureLayout,
  dataRoot,
  cacheDir,
  logsDir,
  javaDir,
  instancesDir,
  settingsFile,
  instancesFile,
  instanceDir,
  instanceVersionsDir,
  instanceLibrariesDir,
  instanceAssetsDir,
  instanceNativesDir,
  instanceVersionJsonPath,
  instanceVersionJarPath,
  nativesPlatform,
};
