'use strict';

/**
 * @fileoverview Java 运行时管理模块（java.js）
 *
 * 检测 / 匹配 / 下载 Java（docs/CONTRACTS.md §5.19 / §12.8 / §12.9）：
 * - detect()：扫描 JAVA_HOME、PATH（where java）、注册表（reg query，
 *   JavaSoft/JDK、Eclipse Adoptium、Microsoft、Zulu 及 WOW6432Node）、
 *   常见安装目录（仅一层）、以及已下载的 dataRoot/java/jre-<major>/bin/java.exe，
 *   按 exe 路径去重；版本解析读 `java -version` 的 stderr
 *   （兼容 1.8.0_xxx 与 8u51 等命名），解析失败保留 origin 但 major=null；
 * - bestJavaFor(major)：精确 major 优先，否则最近的更高 major（16 无时自动用 17）；
 * - requiredJavaMajor(versionJson)：javaVersion.majorVersion 优先，
 *   否则按 §12.8 版本区间表（26.1→25、1.20.5→21、1.18→17、1.17→16、其余 8）；
 * - createDownloadTask(major)：后台任务下载 Mojang Java 运行时到
 *   dataRoot/java/jre-<major>/（经 download/javaapi）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./util/paths');
const settingsStore = require('./settings/store');
const tasks = require('./tasks');
const javaApi = require('./download/javaapi');
const appLog = require('./util/log');

/** 注册表探测的厂商键（HKLM/HKCU × 32/64 位视图） */
const REGISTRY_KEYS = [
  ['SOFTWARE\\JavaSoft', ['Java Runtime Environment', 'JDK']],
  ['SOFTWARE\\Eclipse Adoptium', ['JDK']],
  ['SOFTWARE\\Microsoft', ['JDK']],
  ['SOFTWARE\\Azul Systems', ['Zulu']],
];

/** 常见安装目录（仅扫描一层子目录） */
const COMMON_DIRS = [
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files (x86)\\Java',
];

/**
 * 解析版本号数字段（同 game/version.compareVersions 语义，避免循环依赖在此内联）。
 * @param {string} v - 版本字符串
 * @returns {number[]} 数字段
 */
function parseSegments(v) {
  if (typeof v !== 'string') return [];
  return v.split('.').map((seg) => {
    const m = /^(\d+)/.exec(seg);
    return m ? parseInt(m[1], 10) : 0;
  });
}

/**
 * 按 . 分段数字比较版本（忽略 -pre/+build 后缀；1.8 = 1.8.0）。
 * @param {string} a - 版本 A
 * @param {string} b - 版本 B
 * @returns {number} a>b 1 / a<b -1 / 相等 0
 */
function compareVersions(a, b) {
  const sa = parseSegments(a);
  const sb = parseSegments(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] || 0;
    const y = sb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 解析 `java -version` 输出（stderr 首行，兼容 '1.8.0_51' 与 '17.0.15'）。
 * @param {string} text - java -version 的输出文本
 * @returns {{major:number, version:string, arch:string}|null} 解析结果；失败返回 null
 */
function parseJavaVersionOutput(text) {
  if (typeof text !== 'string') return null;
  const m = /version\s+"([^"]+)"/.exec(text);
  if (!m) return null;
  const full = m[1];
  // 主版本：1.x 时代取次段（1.8 → 8），否则取首段（17.0.15 → 17）
  let major = null;
  const mm = /^(\d+)(?:\.(\d+))?/.exec(full);
  if (mm) {
    if (mm[1] === '1' && mm[2] !== undefined) major = parseInt(mm[2], 10);
    else major = parseInt(mm[1], 10);
  }
  const arch = /64-Bit/i.test(text) ? 'x64' : 'x86';
  return { major, version: full, arch };
}

/**
 * 解析某个 java.exe 的版本信息（spawn `java -version`，读 stderr）。
 * @param {string} exe - java.exe 绝对路径
 * @param {string} origin - 来源标签（如 'PATH'、'registry'）
 * @returns {{path:string, exe:string, major:number|null, version:string|null, arch:string|null, origin:string}} 检测条目
 */
function inspectJavaExe(exe, origin) {
  const entry = {
    path: path.dirname(exe),
    exe,
    major: null,
    version: null,
    arch: null,
    origin,
  };
  try {
    const r = spawnSync(exe, ['-version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const output = `${r.stderr || ''}\n${r.stdout || ''}`;
    const parsed = parseJavaVersionOutput(output);
    if (parsed && parsed.major != null) {
      entry.major = parsed.major;
      entry.version = parsed.version;
      entry.arch = parsed.arch;
    }
  } catch {
    // 进程无法启动：保留 origin 但 major 未知
  }
  return entry;
}

/**
 * 执行 `reg query` 并收集 REG_SZ 值（两级：基键下的子键值）。
 * 注册表不存在/无权限时静默返回空。
 * @param {string} baseKey - 注册表基键
 * @param {string[]} subKeys - 一级子键名（如 JavaSoft 下的 JRE/JDK）
 * @returns {string[]} 收集到的值（JavaHome/Path 等）
 */
function queryRegistry(baseKey, subKeys) {
  const values = [];
  const run = (args) => {
    const r = spawnSync('reg', args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return (r.stdout || '');
  };
  for (const sub of subKeys) {
    const key = `${baseKey}\\${sub}`;
    // 先列出子键（JavaSoft 下是版本号，Adoptium 下是 版本-hotspot）
    const listOut = run(['query', key]);
    const subKeyNames = [];
    for (const line of listOut.split(/\r?\n/)) {
      const mm = new RegExp(`^\\s*${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\\\(\\S+)`).exec(line);
      if (mm) subKeyNames.push(mm[1]);
    }
    const targets = subKeyNames.length > 0 ? subKeyNames.map((s) => `${key}\\${s}`) : [key];
    for (const t of targets) {
      const out = run(['query', t]);
      for (const line of out.split(/\r?\n/)) {
        // 形如 "    JavaHome    REG_SZ    C:\Program Files\Java\jre1.8.0_51"
        const m = /^\s*[A-Za-z][A-Za-z0-9_ -]*\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i.exec(line);
        if (m && m[1]) values.push(m[1].trim());
      }
    }
  }
  return values;
}

/**
 * 检测本机全部可用 Java。
 * @returns {Promise<Array<{path:string, exe:string, major:number|null, version:string|null, arch:string|null, origin:string}>>} 检测结果
 */
async function detect() {
  const candidates = []; // {exe, origin}
  const push = (exe, origin) => {
    if (exe && typeof exe === 'string') candidates.push({ exe, origin });
  };

  // 1. 设置中手动指定的 javaPath（校验可执行，放列表最前；无效则忽略并告警）
  const settings = settingsStore.getCachedSync();
  let manualEntry = null;
  if (settings.javaPath) {
    if (fs.existsSync(settings.javaPath)) {
      const inspected = inspectJavaExe(settings.javaPath, 'manual');
      // spawn `-version` 成功且能解析出主版本才算有效
      if (inspected.major != null) manualEntry = inspected;
    }
    if (!manualEntry) {
      appLog.add('warn', 'java', `设置中的 Java 路径无效，已忽略：${settings.javaPath}`);
    }
  }

  // 2. JAVA_HOME
  if (process.env.JAVA_HOME) {
    push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'), 'JAVA_HOME');
  }

  // 3. PATH（where java）
  try {
    const r = spawnSync('where', ['java'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const exe = line.trim();
      if (exe) push(exe, 'PATH');
    }
  } catch {
    // where 不可用（非 Windows）：忽略
  }

  // 4. 注册表（仅 Windows；HKLM/HKCU × 32/64 位视图）
  if (process.platform === 'win32') {
    const hives = ['HKLM', 'HKCU'];
    for (const hive of hives) {
      for (const view of ['', '\\WOW6432Node']) {
        for (const [base, subs] of REGISTRY_KEYS) {
          const key = `${hive}\\${base}${view}`;
          for (const v of queryRegistry(key, subs)) {
            push(path.join(v, 'bin', 'java.exe'), 'registry');
          }
        }
      }
    }
  }

  // 5. 常见安装目录（仅列一层）
  for (const dir of COMMON_DIRS) {
    let subs = [];
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // 目录不存在
    }
    for (const sub of subs) {
      push(path.join(dir, sub, 'bin', 'java.exe'), 'common');
    }
  }

  // 6. 已下载的 Mojang 运行时 dataRoot/java/jre-*/bin/java.exe
  try {
    const jres = fs.readdirSync(paths.javaDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^jre-\d+$/.test(d.name))
      .map((d) => d.name);
    for (const jre of jres) {
      push(path.join(paths.javaDir(), jre, 'bin', 'java.exe'), 'downloaded');
    }
  } catch {
    // java 目录尚未创建
  }

  // 按 exe 路径去重（大小写不敏感，Windows 文件系统）
  const seen = new Set();
  const result = [];
  for (const { exe, origin } of candidates) {
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(exe)) continue; // 无效路径直接剔除
    result.push(inspectJavaExe(exe, origin));
  }
  // 手动指定的 Java 放最前（若与其他来源同路径，优先保留 manual 条目）
  if (manualEntry) {
    const key = manualEntry.exe.toLowerCase();
    const idx = result.findIndex((r) => r.exe.toLowerCase() === key);
    if (idx >= 0) result.splice(idx, 1); // 去除同路径的其他来源条目
    result.unshift(manualEntry);
  }
  return result;
}

/**
 * 为指定主版本选择最佳 Java：精确 major 优先；否则最近的更高 major
 * （如需要 16 而只有 17 → 用 17，§12.8）。解析失败的条目不参与选择。
 * @param {number} major - 需要的 Java 主版本
 * @returns {Promise<object|null>} detect() 条目；无可用返回 null
 */
async function bestJavaFor(major) {
  const list = await detect();
  const usable = list.filter((j) => j.major != null && typeof j.major === 'number');
  if (usable.length === 0) return null;
  const exact = usable.find((j) => j.major === major);
  if (exact) return exact;
  const higher = usable.filter((j) => j.major > major).sort((a, b) => a.major - b.major);
  if (higher.length > 0) return higher[0];
  return null;
}

/**
 * 解析指定 exe 路径的 Java 信息（手动指定 javaPath 时使用）。
 * @param {string} exePath - java.exe 路径
 * @returns {{path:string, exe:string, major:number|null, version:string|null, arch:string|null, origin:string}} 检测条目
 */
function inspect(exePath) {
  return inspectJavaExe(exePath, 'manual');
}

/**
 * 版本区间表（§12.8，json 无 javaVersion 字段时按 versionId 数字段判断）。
 * @param {string} versionId - 版本 id（如 '1.21.4'、'26.1'）
 * @returns {number} Java 主版本
 */
function majorByVersionInterval(versionId) {
  // ≥ 26.1 → 25（未来版本下限）
  if (compareVersions(versionId, '26.1') >= 0) return 25;
  if (compareVersions(versionId, '1.20.5') >= 0) return 21;
  if (compareVersions(versionId, '1.18') >= 0) return 17;
  if (compareVersions(versionId, '1.17') >= 0) return 16; // 无 16 时 bestJavaFor 自动用 17
  return 8; // ≤ 1.16.5 / 远古 / 快照：Java 8
}

/**
 * 确定某版本 JSON 需要的 Java 主版本：javaVersion.majorVersion 优先，
 * 否则按 §12.8 区间表（1.7.10+ 的 javaVersion 字段可信）。
 * @param {object} versionJson - 版本 JSON（合并后）
 * @returns {number} Java 主版本
 */
function requiredJavaMajor(versionJson) {
  const jv = versionJson && versionJson.javaVersion;
  if (jv && typeof jv.majorVersion === 'number') return jv.majorVersion;
  const id = (versionJson && versionJson.id) || '';
  return majorByVersionInterval(id);
}

/**
 * 创建 Java 下载任务（后台执行，立即返回 taskId）。
 * @param {number} major - Java 主版本（8/16/17/21/25）
 * @returns {{taskId:string}} 任务 id
 */
function createDownloadTask(major) {
  const task = tasks.createTask({ name: `下载 Java ${major} 运行时` });
  const source = settingsStore.getCachedSync().downloadSource || 'mojang';
  javaApi.downloadJava(major, {
    source,
    signal: task.getSignal(),
    onProgress: (p) => {
      task.setProgress({
        done: p.done,
        total: p.total,
        extra: p.extra || `下载 Java ${major} 运行时`,
      });
    },
  }).then((result) => {
    task.finish(result);
    appLog.add('info', 'java', `Java ${major} 运行时就绪：${result.javaExe}`);
  }).catch((e) => {
    task.fail(e);
    appLog.add('error', 'java', `Java ${major} 下载失败：${e.message}`);
  });
  return { taskId: task.id };
}

module.exports = {
  detect,
  bestJavaFor,
  inspect,
  requiredJavaMajor,
  majorByVersionInterval,
  compareVersions,
  parseJavaVersionOutput,
  createDownloadTask,
};
