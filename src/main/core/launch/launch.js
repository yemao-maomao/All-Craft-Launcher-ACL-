'use strict';

/**
 * @fileoverview 游戏启动模块（launch/launch.js）——正确性核心之二
 *
 * 依据 docs/CONTRACTS.md §5.20 与 §12.2~§12.6 组装并启动游戏：
 * - JVM 参数权威顺序（§12.2）：file.encoding → Log4j 安全组 → Windows 专属
 *   （HeapDumpPath/os.name/os.version）→ 内存 + PermSize/MetaspaceSize → G1 模板
 *   （用户指定 -XX:+Use*GC 时跳过模板 GC 项）→ ReservedCodeCacheSize/-Xss →
 *   品牌参数 → json arguments.jvm（规则过滤 + 占位符替换，Java9+ 剔除 -Xincgc）
 *   → -Djava.library.path → -cp → extraJvmArgs（用户自定义靠后覆盖默认）；
 * - 游戏参数（§12.3 占位符表）：旧版 minecraftArguments 与 arguments.game 并存时都追加；
 *   ${auth_uuid} 32 位无连字符、${user_properties} 空传 {}、${clientid}/${auth_xuid}
 *   离线传 '0'、未映射占位符原样保留；
 * - classpath：库（json 声明顺序、非 native、文件存在）在前 + 版本 jar 最后，; 分隔；
 * - natives：目录缺失/为空时现场 extractNatives，目录为 versions/<id>/natives-<platform>；
 * - Windows 必须重设 APPDATA 为游戏目录父目录，并附 INST_NAME/INST_ID/INST_DIR/
 *   INST_MC_DIR/INST_JAVA（§12.5）；
 * - 内存自动分配（FCL 同款）：ram=os.totalmem()/1MB，预留 384，≤8G 取 80%、
 *   超出部分 20%、上限 16G、下限 1024MB，min=min(512,max)；
 * - 进程管理：stdout/stderr 逐行回调（缓存半行）、error → 抛错、close → onExit；
 *   kill(pid) = taskkill /PID <pid> /T /F（进程树）；
 * - 崩溃报告：exit code ≠ 0 且存在 crash-reports 最新文件 → appLog warn。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const constants = require('../constants');
const paths = require('../util/paths');
const appLog = require('../util/log');
const settingsStore = require('../settings/store');
const instances = require('../instances');
const javaApi = require('../java');
const versionApi = require('./../game/version');
const librariesApi = require('./../game/libraries');
const assetsApi = require('./../game/assets');

// ===================== 工具函数 =====================

/**
 * 探测系统 ANSI 编码（Windows 经 chcp 输出判断），默认 UTF-8。
 * @returns {string} 编码名（GBK / UTF-8 / Big5）
 */
function detectSystemEncoding() {
  try {
    const r = spawnSync('cmd', ['/d', '/c', 'chcp'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const m = /(\d+)/.exec(r.stdout || '');
    if (m) {
      const cp = parseInt(m[1], 10);
      if (cp === 936) return 'GBK';
      if (cp === 65001) return 'UTF-8';
      if (cp === 950) return 'Big5';
    }
  } catch {
    // chcp 失败 → 默认 UTF-8
  }
  return 'UTF-8';
}

/**
 * 把额外 JVM 参数字符串按空格分词（支持双引号包裹）。
 * @param {string} text - 参数字符串
 * @returns {string[]} 参数数组
 */
function tokenizeArgs(text) {
  if (!text) return [];
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

/**
 * 判断 JVM 模板参数是否与 GC 相关（用户指定 -XX:+Use*GC 时跳过，避免冲突）。
 * @param {string} arg - 模板参数
 * @returns {boolean} 是否 GC 相关
 */
function isGcRelated(arg) {
  return /^-XX:(G1|MaxGCPauseMillis|[-+]Use)/.test(arg);
}

/**
 * 自动内存分配算法（§5.20-10 / 任务书：FCL 同款）。
 * ram = os.totalmem()/1MB；预留 384MB；≤8G 取 80%、超出部分 20%；
 * 上限 16G、下限 1024MB；min = min(512, max)。
 * @returns {{min:number, max:number}} 内存配置（MB）
 */
function autoMemory() {
  const ram = os.totalmem() / (1024 * 1024); // MB
  const reserved = 384;
  let max = ram <= 8192
    ? ram * 0.8
    : 8192 * 0.8 + (ram - 8192) * 0.2;
  max = Math.max(1024, Math.min(16384, max)); // 下限 1024、上限 16G
  const min = Math.min(512, max);
  return { min: Math.round(min), max: Math.round(max) };
}

/**
 * 逐行输出拆分器：处理 \r?\n 并缓存半行。
 * @param {(line:string)=>void} onLine - 行回调
 * @returns {{feed:Function, flush:Function}} feed 喂入 chunk；flush 输出残余半行
 */
function makeLineSplitter(onLine) {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
    },
  };
}

// ===================== 占位符 =====================

/**
 * 构造 ${user_properties} 值：游戏主类按「属性名 → 值数组」的 JSON 对象解析
 * （1.7.x 的 Main 用 Gson 反序列化为 Map），空属性必须传 '{}'（§12.3）。
 * @param {object} account - 账户对象
 * @returns {string} JSON 字符串
 */
function userPropertiesJson(account) {
  const props = account && Array.isArray(account.userProperties) ? account.userProperties : [];
  const meaningful = props.filter(
    (p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.length > 0
  );
  if (meaningful.length === 0) return '{}'; // 空值传 {}
  const map = {};
  for (const p of meaningful) {
    if (!(p.name in map)) map[p.name] = [];
    map[p.name].push(p.value);
  }
  return JSON.stringify(map);
}

/**
 * 构建占位符替换表（§5.20-8 / §12.3）。
 * @param {object} ctx - 上下文：account/json/versionId/instanceDir/assetsRoot/…
 * @returns {Record<string,string>} 占位符 → 值
 */
function buildPlaceholderMap(ctx) {
  const { account, json, versionId, instanceDir, assetsRoot, assetsIndexName, gameAssets, resolution, nativesDir, classpath, librariesDir, msClientId } = ctx;
  const isMsa = account && account.type === 'msa';
  return {
    '${auth_player_name}': (account && account.name) || '',
    '${auth_uuid}': String((account && account.uuid) || '').replace(/-/g, ''), // 必须 32 位无连字符
    '${auth_access_token}': (account && account.token) || '0',
    '${auth_session}': (account && account.token) || '0',
    '${version_name}': versionId,
    '${game_directory}': instanceDir,
    '${assets_root}': assetsRoot,
    '${assets_index_name}': assetsIndexName,
    '${game_assets}': gameAssets,
    '${user_type}': (account && account.userType) || 'legacy',
    '${version_type}': (json && json.type) || 'release',
    '${user_properties}': userPropertiesJson(account), // 游戏按 Map 解析；空传 {}
    '${profile_name}': 'Minecraft',
    '${clientid}': isMsa && msClientId ? msClientId : '0', // 离线/未配置传 '0'
    '${auth_xuid}': (account && account.xuid) || '0',
    '${resolution_width}': String(resolution && resolution.width ? resolution.width : 854),
    '${resolution_height}': String(resolution && resolution.height ? resolution.height : 480),
    '${natives_directory}': nativesDir,
    '${classpath}': classpath,
    '${launcher_name}': constants.BRAND_NAME,
    '${launcher_version}': constants.APP_VERSION,
    '${library_directory}': librariesDir,
  };
}

/**
 * 替换字符串中的全部占位符；未映射的占位符原样保留（§12.3）。
 * @param {string} text - 原始字符串
 * @param {Record<string,string>} map - 占位符表
 * @returns {string} 替换结果
 */
function replacePlaceholders(text, map) {
  if (typeof text !== 'string') return text;
  return text.replace(/\$\{[^}]+\}/g, (m) => (m in map ? map[m] : m));
}

// ===================== 参数组装 =====================

/**
 * 处理 json arguments 数组（jvm/game 通用）：对象条目按规则过滤、字符串替换占位符。
 * @param {Array} args - arguments 数组
 * @param {object} osInfo - 环境信息
 * @param {Record<string,string>} map - 占位符表
 * @param {{skipXincgc?:boolean}} [opts] - skipXincgc：Java9+ 剔除 -Xincgc（仅 jvm 使用）
 * @returns {string[]} 处理后的参数
 */
function processArgArray(args, osInfo, map, opts = {}) {
  const out = [];
  if (!Array.isArray(args)) return out;
  for (const entry of args) {
    if (typeof entry === 'string') {
      if (opts.skipXincgc && entry === '-Xincgc') continue; // Java9+ 已移除该参数
      out.push(replacePlaceholders(entry, map));
    } else if (entry && typeof entry === 'object') {
      // 对象条目：规则过滤后取 value（字符串或字符串数组）
      if (!versionApi.matchRule(entry.rules || null, osInfo)) continue;
      const value = entry.value;
      if (typeof value === 'string') out.push(replacePlaceholders(value, map));
      else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string') out.push(replacePlaceholders(v, map));
        }
      }
    }
  }
  return out;
}

/**
 * 启动游戏。
 * @param {object} opts - { instanceId, versionId, account, javaPath?, memory:{auto,min,max}, resolution:{width,height}, extraJvmArgs?, source? }
 * @param {{onLine:Function, onExit:Function}} callbacks - onLine({level,text})；onExit({code,pid})
 * @returns {Promise<{pid:number, kill:Function}>} 进程句柄
 * @throws {Error} 版本未安装 / 未找到 Java / 启动失败
 */
async function start(opts, callbacks = {}) {
  const { onLine = () => {}, onExit = () => {} } = callbacks;
  const { instanceId, versionId, account } = opts;
  const source = opts.source || 'mojang';
  if (!instanceId || !versionId || !account) {
    throw new Error('启动参数不完整：需要 instanceId、versionId、account');
  }
  const instId = instanceId;
  const instanceDir = paths.instanceDir(instId);

  // ---- 1. 读取合并后的版本 JSON ----
  const jsonPath = paths.instanceVersionJsonPath(instId, versionId);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`请先安装该版本：${versionId}`);
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    throw new Error(`版本 JSON 损坏：${jsonPath}`);
  }
  appLog.add('info', 'launch', `读取版本 JSON：${versionId}`);

  // ---- 2. Java 选择 ----
  const neededMajor = javaApi.requiredJavaMajor(json);
  let javaObj = null;
  if (opts.javaPath) {
    javaObj = javaApi.inspect(opts.javaPath);
    if (!fs.existsSync(opts.javaPath)) throw new Error(`指定的 Java 不存在：${opts.javaPath}`);
    appLog.add('info', 'launch', `使用手动指定 Java：${opts.javaPath}`);
  } else {
    javaObj = await javaApi.bestJavaFor(neededMajor);
  }
  if (!javaObj || !javaObj.exe) {
    throw new Error(`未找到 Java ${neededMajor}，请在设置中选择或下载`);
  }
  const javaMajor = javaObj.major || neededMajor; // 解析失败时按所需版本兜底
  const javaExe = javaObj.exe;
  appLog.add('info', 'launch', `使用 Java：${javaExe}（${javaObj.version || '未知版本'}，需求 major ${neededMajor}）`);

  // ---- 3. classpath：库在前（json 顺序、非 native、存在）+ 版本 jar 最后 ----
  const osInfo = versionApi.currentOsInfo({ hasCustomResolution: !!opts.resolution });
  const libs = librariesApi.listLibraries(json, { osInfo, source, instanceId: instId });
  const librariesDir = paths.instanceLibrariesDir(instId);
  const jarPath = paths.instanceVersionJarPath(instId, versionId);
  if (!fs.existsSync(jarPath)) throw new Error(`版本主文件缺失：${jarPath}（请重新安装）`);
  const cpParts = [];
  for (const lib of libs) {
    if (lib.isNative) continue;
    if (fs.existsSync(lib.dest)) cpParts.push(lib.dest);
  }
  cpParts.push(jarPath); // 版本 jar 恒在最后
  const classpath = cpParts.join(';'); // Windows 分隔符

  // ---- 4. natives：缺失/为空 → 现场解压 ----
  const nativesDir = paths.instanceNativesDir(instId, versionId);
  let nativesMissing = false;
  try {
    nativesMissing = !fs.existsSync(nativesDir) || fs.readdirSync(nativesDir).length === 0;
  } catch {
    nativesMissing = true;
  }
  if (nativesMissing) {
    appLog.add('info', 'launch', `natives 目录缺失，现场解压：${nativesDir}`);
    librariesApi.extractNatives(instId, versionId, libs);
  }

  // ---- 5. 资源（assets）与 ${game_assets} ----
  const assetsRoot = paths.instanceAssetsDir(instId);
  const assetsIndexName = (json.assetIndex && json.assetIndex.id)
    || (typeof json.assets === 'string' ? json.assets : 'legacy');
  let gameAssets = assetsRoot;
  const localIndex = assetsApi.readLocalIndex(instId, assetsIndexName);
  if (localIndex && assetsApi.isLegacyIndex(localIndex)) {
    // legacy：启动前重建 assets/virtual/<id> 树（§12.6；完整性不足时函数内回退 assets 根）
    gameAssets = await assetsApi.ensureVirtualAssets(instId, localIndex, {});
    appLog.add('info', 'launch', `legacy 资源目录：${gameAssets}`);
  }

  // ---- 6. 内存 ----
  const memory = (!opts.memory || opts.memory.auto !== false)
    ? autoMemory()
    : {
        min: Math.max(64, parseInt(opts.memory.min, 10) || constants.DEFAULT_MIN_MEMORY),
        max: Math.max(256, parseInt(opts.memory.max, 10) || constants.DEFAULT_MAX_MEMORY),
      };
  appLog.add('info', 'launch', `内存分配：-Xms${memory.min}M -Xmx${memory.max}M`);

  // ---- 7. 占位符表 ----
  const settings = settingsStore.getCachedSync();
  const map = buildPlaceholderMap({
    account, json, versionId, instanceDir, assetsRoot, assetsIndexName, gameAssets,
    resolution: opts.resolution || settings.resolution,
    nativesDir, classpath, librariesDir,
    msClientId: settings.msClientId,
  });

  // ---- 8. JVM 参数（§12.2 权威顺序） ----
  const extraTokens = tokenizeArgs(opts.extraJvmArgs || settings.extraJvmArgs || '');
  const userSpecifiedGc = extraTokens.some((a) => /^-XX:\+Use.*GC/.test(a));
  const is64Bit = (javaObj.arch || 'x64') === 'x64';

  const jvmArgs = [];
  // 1) 文件编码
  jvmArgs.push(`-Dfile.encoding=${detectSystemEncoding()}`);
  // 2) Log4j 安全组（防 RCE）
  jvmArgs.push(
    '-Djava.rmi.server.useCodebaseOnly=true',
    '-Dcom.sun.jndi.rmi.object.trustURLCodebase=false',
    '-Dcom.sun.jndi.cosnaming.object.trustURLCodebase=false',
    '-Dlog4j2.formatMsgNoLookups=true'
  );
  // 3) Windows 专属
  if (process.platform === 'win32') {
    jvmArgs.push(
      '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
      '-Dos.name=Windows 10',
      '-Dos.version=10.0'
    );
  }
  // 4) 内存 + PermSize/MetaspaceSize
  jvmArgs.push(`-Xms${memory.min}M`, `-Xmx${memory.max}M`);
  if (javaMajor < 8) jvmArgs.push('-XX:PermSize=128M');
  else jvmArgs.push('-XX:MetaspaceSize=256M');
  // 5) G1 模板（用户指定 -XX:+Use*GC 时跳过模板 GC 项；
  //    Java<9 的 G1NewSizePercent/G1ReservePercent 属实验参数，需先解锁）
  if (javaMajor < 9) jvmArgs.push('-XX:+UnlockExperimentalVMOptions');
  for (const arg of constants.jvmArgsForJavaMajor(javaMajor)) {
    if (userSpecifiedGc && isGcRelated(arg)) continue;
    jvmArgs.push(arg);
  }
  // 6) 代码缓存 / 栈大小
  if (is64Bit && memory.max > 4096) jvmArgs.push('-XX:ReservedCodeCacheSize=400M');
  if (!is64Bit) jvmArgs.push('-Xss1M');
  // 7) 品牌参数
  jvmArgs.push(
    `-Dminecraft.launcher.brand=${constants.BRAND_NAME}`,
    `-Dminecraft.launcher.version=${constants.APP_VERSION}`,
    `-Dminecraft.client.jar=${jarPath}`,
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    '-Dfml.ignorePatchDiscrepancies=true',
    '-Djava.net.useSystemProxies=true'
  );
  // 8) json arguments.jvm（规则过滤 + 占位符替换；Java9+ 剔除 -Xincgc）
  if (json.arguments && Array.isArray(json.arguments.jvm)) {
    jvmArgs.push(...processArgArray(json.arguments.jvm, osInfo, map, { skipXincgc: javaMajor >= 9 }));
  }
  // 9) natives / classpath / 用户自定义（靠后覆盖默认）
  jvmArgs.push(`-Djava.library.path=${nativesDir}`);
  jvmArgs.push('-cp', classpath);
  jvmArgs.push(...extraTokens);

  // ---- 9. 主类与游戏参数（§12.3） ----
  const mainClass = json.mainClass || 'net.minecraft.client.main.Main';
  const gameArgs = [];
  // 旧版 minecraftArguments 与 arguments.game 并存时都追加（§12.3）
  if (typeof json.minecraftArguments === 'string') {
    gameArgs.push(...tokenizeArgs(replacePlaceholders(json.minecraftArguments, map)));
  }
  if (json.arguments && Array.isArray(json.arguments.game)) {
    gameArgs.push(...processArgArray(json.arguments.game, osInfo, map));
  }

  const fullArgs = [...jvmArgs, mainClass, ...gameArgs];
  appLog.add('info', 'launch', `JVM 参数 ${jvmArgs.length} 项，游戏参数 ${gameArgs.length} 项`);

  // ---- 10. 环境变量（§12.5） ----
  const instanceName = await (async () => {
    try {
      const list = await instances.list();
      const item = list.find((i) => i.id === instId);
      return item ? item.name : instId;
    } catch {
      return instId;
    }
  })();
  const env = {
    ...process.env,
    APPDATA: path.dirname(instanceDir), // 重设为游戏目录父目录（§12.5 必须）
    INST_NAME: instanceName,
    INST_ID: instId,
    INST_DIR: instanceDir,
    INST_MC_DIR: instanceDir,
    INST_JAVA: javaExe,
  };

  // ---- 11. spawn ----
  appLog.add('info', 'launch', `启动命令：${javaExe} ${fullArgs.slice(0, 6).join(' ')} …`);
  const child = spawn(javaExe, fullArgs, {
    cwd: instanceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    env,
  });

  // 等待 spawn 事件（ENOENT 等 spawn 错误在此拒绝，而非静默失败）
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  const splitOut = makeLineSplitter((text) => onLine({ level: 'info', text }));
  const splitErr = makeLineSplitter((text) => onLine({ level: 'error', text }));
  child.stdout.on('data', (chunk) => splitOut.feed(chunk));
  child.stderr.on('data', (chunk) => splitErr.feed(chunk));

  child.on('error', (err) => {
    splitOut.flush();
    splitErr.flush();
    appLog.add('error', 'launch', `Java 启动失败：${err.message}`);
  });

  child.on('close', (code) => {
    splitOut.flush();
    splitErr.flush();
    appLog.add('info', 'launch', `游戏进程退出：code=${code} pid=${child.pid}`);

    // 崩溃报告：exit code ≠ 0 时取 crash-reports 最新文件（§5.20-11；
    // 按修改时间取最新且距现在 ≤2 分钟，附带绝对路径供渲染进程展示）
    let crashReportPath = null;
    if (code !== 0 && code !== null) {
      try {
        const crashDir = path.join(instanceDir, 'crash-reports');
        const now = Date.now();
        const reports = fs.readdirSync(crashDir)
          .filter((f) => f.startsWith('crash-') && f.endsWith('.txt'))
          .map((f) => ({ f, mtime: fs.statSync(path.join(crashDir, f)).mtimeMs }))
          .filter((x) => now - x.mtime <= 2 * 60 * 1000) // ≤2 分钟
          .sort((a, b) => b.mtime - a.mtime);
        if (reports.length > 0) {
          crashReportPath = path.join(crashDir, reports[0].f);
          appLog.add('warn', 'launch', `游戏崩溃，报告：${crashReportPath}`);
        }
      } catch {
        // crash-reports 不存在/不可读：忽略
      }
    }
    const exitPayload = { code, pid: child.pid };
    if (crashReportPath) exitPayload.crashReportPath = crashReportPath;
    onExit(exitPayload);
  });

  return {
    pid: child.pid,
    // 渲染进程启动态信息表需要实际 Java 信息（Lead 追加需求）
    java: {
      major: javaObj.major != null ? javaObj.major : javaMajor,
      version: javaObj.version,
      exe: javaExe,
    },
    kill: () => kill(child.pid),
  };
}

/**
 * 结束游戏进程（Windows：taskkill /PID <pid> /T /F 杀整个进程树）。
 * @param {number} pid - 进程 id
 * @returns {boolean} 是否成功
 */
function kill(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, timeout: 15000,
      });
      return r.status === 0;
    }
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

module.exports = { start, kill, autoMemory, detectSystemEncoding, tokenizeArgs };
