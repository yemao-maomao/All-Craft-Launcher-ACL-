'use strict';

/**
 * @fileoverview core 层冒烟测试 CLI（scripts/smoke.js）
 *
 * 脱离 Electron 环境独立验证 core 各模块（docs/CONTRACTS.md §5.22）：
 *   node scripts/smoke.js help                          # 用法
 *   node scripts/smoke.js manifest [--force]            # 版本清单，打印 latest 与前 5 条
 *   node scripts/smoke.js version <id>                  # 下载+合并版本 JSON，打印摘要
 *   node scripts/smoke.js install <id>                  # 完整安装到 .smoke-data
 *   node scripts/smoke.js java-detect                   # 检测结果表
 *   node scripts/smoke.js java-download <major>         # 自动下载运行时（8/17/21）
 *   node scripts/smoke.js fabric-loaders <gameVersion>  # Fabric loader 列表
 *   node scripts/smoke.js launch-test <versionId> [playerName]  # 离线账号+自动 Java 启动，60s 后 kill
 *
 * 环境：paths.init 指向仓库根 + <仓库>/.smoke-data/appdata（默认实例 default）；
 * SMOKE_SOURCE=bmclapi 覆盖下载源；进度每秒汇总一行输出 stdout。
 */

const path = require('path');

/** 仓库根（scripts/ 的上一级） */
const REPO_ROOT = path.resolve(__dirname, '..');

const { init: initPaths } = require('../src/main/core/util/paths');
const tasks = require('../src/main/core/tasks');

// 初始化路径：appRoot=仓库根、userDataRoot=<仓库>/.smoke-data/appdata
initPaths({
  appRoot: REPO_ROOT,
  userDataRoot: path.join(REPO_ROOT, '.smoke-data', 'appdata'),
});

/** 下载源（SMOKE_SOURCE=bmclapi 覆盖，默认 mojang） */
const SOURCE = process.env.SMOKE_SOURCE === 'bmclapi' ? 'bmclapi' : 'mojang';

// ===================== 输出工具 =====================

/** 简单日志（带时间戳） */
function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

/** 进度汇总器：每秒打印一行汇总（§5.22：每文件级别太吵 → 汇总） */
function makeProgressPrinter(label) {
  let latest = null;
  let lastPrint = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (latest && now - lastPrint >= 1000) {
      const p = latest;
      const pct = p.total > 0 ? ((p.done / p.total) * 100).toFixed(1) : '?.?';
      const speed = p.speedBytesPerSec ? `${(p.speedBytesPerSec / 1024 / 1024).toFixed(1)} MB/s` : '--';
      log(`[${pct}%] ${speed} ${label(p)}`);
      lastPrint = now;
    }
  }, 500);
  return {
    update(p) { latest = p; },
    stop() { clearInterval(timer); },
  };
}

/** 等待一个后台任务结束（监听 tasks 'done' 事件） */
function waitTask(taskId) {
  return new Promise((resolve, reject) => {
    const onDone = (payload) => {
      if (payload.taskId !== taskId) return;
      tasks.removeListener('done', onDone);
      if (payload.ok) resolve(payload.result);
      else reject(new Error(payload.error || '任务失败'));
    };
    tasks.on('done', onDone);
    // 任务可能同步结束（缓存全命中）：兜底轮询一次
    setTimeout(() => {
      const t = tasks.getTask(taskId);
      if (t && t.finished) {
        tasks.removeListener('done', onDone);
        // 已结束但事件错过了：直接按失败/成功处理
        reject(new Error('任务事件丢失（任务已结束）'));
      }
    }, 5000).unref();
  });
}

// ===================== 命令实现 =====================

const HELP_TEXT = `All Craft Launcher 冒烟测试（core 层 CLI）
用法：
  node scripts/smoke.js help                          # 显示本帮助
  node scripts/smoke.js manifest [--force]            # 拉取版本清单，打印 latest 与前 5 条
  node scripts/smoke.js version <id>                  # 下载+继承合并版本 JSON，打印合并摘要
  node scripts/smoke.js install <id>                  # 完整安装到 .smoke-data（进度每秒汇总）
  node scripts/smoke.js java-detect                   # 打印本机 Java 检测结果表
  node scripts/smoke.js java-download <major>         # 自动下载 Java 运行时（8/16/17/21/25）
  node scripts/smoke.js fabric-loaders <gameVersion>  # 打印 Fabric 加载器版本列表
  node scripts/smoke.js launch-test <versionId> [playerName]  # 离线账号+自动 Java 启动，60s 后 kill
环境变量：
  SMOKE_SOURCE=bmclapi   使用 BMCLAPI 镜像作为首选下载源（默认 mojang）
`;

async function cmdHelp() {
  console.log(HELP_TEXT);
}

async function cmdManifest(args = []) {
  const force = args.includes('--force');
  const { fetchManifest } = require('../src/main/core/game/manifest');
  log(`抓取版本清单（source=${SOURCE} force=${force}）…`);
  const data = await fetchManifest({ force, source: SOURCE });
  log('latest:', JSON.stringify(data.latest));
  log(`共 ${data.versions.length} 个版本，前 5 条：`);
  for (const v of data.versions.slice(0, 5)) {
    console.log(`  ${v.id}\t${v.type}\t${v.releaseTime}`);
  }
}

async function cmdVersion(versionId) {
  if (!versionId) throw new Error('用法：node scripts/smoke.js version <id>');
  const versionApi = require('../src/main/core/game/version');
  log(`下载版本 JSON：${versionId}（source=${SOURCE}）…`);
  const raw = await versionApi.fetchVersionJson(versionId, { source: SOURCE });
  const merged = await versionApi.resolveInheritance(versionId, raw, { source: SOURCE });
  console.log('--- 合并摘要 ---');
  console.log('id:', merged.id);
  console.log('mainClass:', merged.mainClass);
  console.log('type:', merged.type, '| javaVersion:', JSON.stringify(merged.javaVersion || null));
  console.log('libraries 数量:', Array.isArray(merged.libraries) ? merged.libraries.length : 0);
  console.log('assetIndex:', merged.assetIndex ? JSON.stringify({ id: merged.assetIndex.id, url: merged.assetIndex.url }) : '(无)');
  console.log('downloads.client:', merged.downloads && merged.downloads.client ? merged.downloads.client.url : '(无)');
  console.log('arguments:', merged.arguments ? `jvm=${(merged.arguments.jvm || []).length} 项 game=${(merged.arguments.game || []).length} 项` : '(无)');
  console.log('minecraftArguments:', merged.minecraftArguments ? '存在' : '(无)');
  console.log('inheritsFrom:', merged.inheritsFrom || '(无)');
  console.log('minimumLauncherVersion:', merged.minimumLauncherVersion);
}

async function cmdInstall(versionId) {
  if (!versionId) throw new Error('用法：node scripts/smoke.js install <id>');
  const { createInstallTask } = require('../src/main/core/game/install');
  log(`开始安装 ${versionId}（source=${SOURCE}）…`);
  const { taskId } = createInstallTask(versionId, { source: SOURCE });
  const printer = makeProgressPrinter((p) => p.extra || '');
  const onProgress = (p) => {
    if (p.taskId !== taskId) return;
    printer.update({ done: p.done, total: p.total, speedBytesPerSec: 0, extra: p.extra });
  };
  tasks.on('progress', onProgress);
  try {
    const result = await waitTask(taskId);
    log('安装完成：', JSON.stringify(result));
  } finally {
    tasks.removeListener('progress', onProgress);
    printer.stop();
  }
}

async function cmdJavaDetect() {
  const javaApi = require('../src/main/core/java');
  log('检测 Java…');
  const list = await javaApi.detect();
  if (list.length === 0) {
    console.log('（未检测到任何 Java 运行时）');
    return;
  }
  console.log('序号\tmajor\t版本\t架构\t来源\t路径');
  list.forEach((j, i) => {
    console.log(`${i + 1}\t${j.major ?? '?'}\t${j.version ?? '?'}\t${j.arch ?? '?'}\t${j.origin}\t${j.exe}`);
  });
}

async function cmdJavaDownload(major) {
  const n = parseInt(major, 10);
  if (!Number.isFinite(n)) throw new Error('用法：node scripts/smoke.js java-download <major>');
  const javaApi = require('../src/main/core/java');
  log(`下载 Java ${n} 运行时（source=${SOURCE}）…`);
  const { taskId } = javaApi.createDownloadTask(n);
  const printer = makeProgressPrinter((p) => p.extra || '');
  const onProgress = (p) => {
    if (p.taskId !== taskId) return;
    printer.update({ done: p.done, total: p.total, speedBytesPerSec: 0, extra: p.extra });
  };
  tasks.on('progress', onProgress);
  try {
    const result = await waitTask(taskId);
    log('Java 下载完成：', JSON.stringify(result));
  } finally {
    tasks.removeListener('progress', onProgress);
    printer.stop();
  }
}

async function cmdFabricLoaders(gameVersion) {
  if (!gameVersion) throw new Error('用法：node scripts/smoke.js fabric-loaders <gameVersion>');
  const { fetchFabricLoaders } = require('../src/main/core/game/fabric');
  log(`查询 Fabric 加载器（MC ${gameVersion}，source=${SOURCE}）…`);
  const loaders = await fetchFabricLoaders(gameVersion, { source: SOURCE });
  console.log(`共 ${loaders.length} 个加载器版本，前 8 条：`);
  for (const l of loaders.slice(0, 8)) {
    const mainClass = l.launcherMeta && l.launcherMeta.mainClass && l.launcherMeta.mainClass.client;
    console.log(`  loader=${l.loader && l.loader.version}  stable=${l.loader && l.loader.stable}  mainClass=${mainClass || '?'}`);
  }
}

async function cmdLaunchTest(versionId, playerName) {
  if (!versionId) throw new Error('用法：node scripts/smoke.js launch-test <versionId> [playerName]');
  const name = playerName || 'SmokePlayer';
  const { offlineLogin } = require('../src/main/core/auth/offline');
  const javaApi = require('../src/main/core/java');
  const installApi = require('../src/main/core/game/install');
  const launch = require('../src/main/core/launch/launch');
  const paths = require('../src/main/core/util/paths');

  // 1. 检查已安装
  const installed = await installApi.listInstalled();
  if (!installed.some((i) => i.id === versionId)) {
    throw new Error(`版本 ${versionId} 未安装，请先运行 install ${versionId}`);
  }
  // 2. 离线账号
  const account = offlineLogin(name);
  log(`离线账号：${account.name}（uuid=${account.uuid}）`);
  // 3. Java：自动检测 → 无匹配则自动下载所需 major
  const json = JSON.parse(require('fs').readFileSync(paths.instanceVersionJsonPath('default', versionId), 'utf8'));
  const neededMajor = javaApi.requiredJavaMajor(json);
  let javaObj = await javaApi.bestJavaFor(neededMajor);
  if (!javaObj) {
    log(`未找到 Java ${neededMajor}，自动下载运行时…`);
    const { taskId } = javaApi.createDownloadTask(neededMajor);
    await waitTask(taskId);
    javaObj = await javaApi.bestJavaFor(neededMajor);
  }
  if (!javaObj) throw new Error('Java 运行时仍然不可用');
  log(`使用 Java：${javaObj.exe}（major=${javaObj.major}）`);

  // 4. 启动（流式日志）
  log('启动游戏…');
  const handle = await launch.start(
    {
      instanceId: 'default',
      versionId,
      account,
      memory: { auto: true },
      resolution: { width: 854, height: 480 },
      source: SOURCE,
    },
    {
      onLine: ({ level, text }) => {
        console.log(`[${level === 'error' ? 'ERR' : 'OUT'}] ${text}`);
      },
      onExit: ({ code, pid, crashReportPath }) => {
        log(`游戏进程退出：code=${code} pid=${pid}${crashReportPath ? ` crashReport=${crashReportPath}` : ''}`);
        process.exit(code === 0 ? 0 : 1);
      },
    }
  );
  log(`游戏已启动：pid=${handle.pid} Java=${handle.java.major}（${handle.java.version || '?'}）${handle.java.exe}，60 秒后自动结束`);
  setTimeout(() => {
    log('60 秒到，结束游戏进程…');
    handle.kill();
  }, 60000).unref();
}

// ===================== 主入口 =====================

const COMMANDS = {
  help: cmdHelp,
  manifest: cmdManifest,
  version: cmdVersion,
  install: cmdInstall,
  'java-detect': cmdJavaDetect,
  'java-download': cmdJavaDownload,
  'fabric-loaders': cmdFabricLoaders,
  'launch-test': cmdLaunchTest,
};

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const handler = COMMANDS[cmd || 'help'];
  if (!handler) {
    console.error(`未知命令：${cmd}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }
  try {
    await handler(...args);
  } catch (e) {
    console.error(`[失败] ${e.message}`);
    process.exitCode = 1;
  }
  // launch-test 保持进程存活（游戏日志流式输出），其余命令自然退出
  if (cmd !== 'launch-test') {
    // 给未 flush 的 stdout 一点时间
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
