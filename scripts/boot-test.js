'use strict';

/**
 * @fileoverview 集成启动冒烟测试（scripts/boot-test.js）
 *
 * 以与真实应用完全一致的配置创建 Electron 窗口：注入真实 preload、注册真实 IPC、
 * 加载真实 renderer/index.html，并监听渲染进程的控制台输出/加载失败/预加载错误，
 * 在窗口加载完成后主动调用若干 IPC 通道做端到端验证，最后打印结果并退出。
 *
 * 用法：
 *   node_modules\electron\dist\electron.exe scripts\boot-test.js
 * 退出码：0 = 全部通过；1 = 存在失败项。
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // 项目根目录

/** 收集到的失败项（任何一条都会导致非零退出码） */
const failures = [];
/** 渲染进程控制台输出（用于诊断） */
const consoleLines = [];

/**
 * 归一化 console-message 事件参数：Electron 不同版本签名不同
 * （旧版 (event, level, message, line, sourceId)；新版 (event, details)）。
 */
function normalizeConsoleArgs(args) {
  if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
    return args[0];
  }
  return {
    level: args[1],
    message: String(args[2] || ''),
    lineNumber: args[3],
    sourceId: args[4],
  };
}

app.whenReady().then(() => {
  // ---- 0. 静态校验：main.js 引用的 preload/renderer 路径必须真实存在（防路径漂移） ----
  const fs = require('fs');
  const mainDir = path.join(ROOT, 'src', 'main');
  const staticChecks = [
    ['src/preload/preload.js（main.js 引用）', path.join(mainDir, '..', 'preload', 'preload.js')],
    ['src/renderer/index.html（main.js 引用）', path.join(mainDir, '..', 'renderer', 'index.html')],
  ];
  for (const [name, p] of staticChecks) {
    if (!fs.existsSync(path.resolve(p))) {
      failures.push(`静态路径校验失败：${name} 不存在（${p}）`);
    } else {
      console.log(`[boot-test] ✓ 静态路径 ${name}`);
    }
  }

  // ---- 1. 初始化路径与 IPC（与 main.js 相同） ----
  try {
    require(path.join(ROOT, 'src/main/core/util/paths')).init({
      appRoot: ROOT,
      userDataRoot: path.join(ROOT, '.smoke-data', 'appdata'),
    });
    require(path.join(ROOT, 'src/main/core/util/paths')).ensureLayout();
  } catch (e) {
    failures.push('paths.init/ensureLayout 失败：' + e.message);
  }
  try {
    const ipc = require(path.join(ROOT, 'src/main/ipc'));
    ipc.registerIpc();
  } catch (e) {
    failures.push('registerIpc 失败：' + e.message);
  }

  // ---- 2. 创建与真实应用一致的窗口 ----
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true, // 显示窗口便于人工观察（同时自动验证渲染流程）
    frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'src/preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // ---- 3. 监听渲染进程健康信号 ----
  win.webContents.on('console-message', (_e, ...args) => {
    const d = normalizeConsoleArgs(args);
    consoleLines.push(`[${d.level}] ${d.message}`);
    // error 级别视为失败（渲染进程运行时错误）
    if (d.level === 3 || d.level === 'error') {
      failures.push('渲染进程错误：' + d.message);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    failures.push(`页面加载失败：${code} ${desc}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    failures.push(`preload 错误：${p} ${err && err.message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    failures.push('渲染进程崩溃：' + JSON.stringify(details));
  });

  // ---- 4. 加载页面 ----
  win.loadFile(path.join(ROOT, 'src/renderer/index.html'));

  // ---- 5. 页面加载完成后做端到端通道验证 ----
  win.webContents.once('did-finish-load', async () => {
    console.log('[boot-test] 页面加载完成，等待渲染进程初始化…');
    await new Promise((r) => setTimeout(r, 8000)); // 给渲染进程初始化时间

    // 逐通道调用验证（等价于 UI 的 boot 流程所调用的通道）
    const checks = [
      ['settings:get', () => require(path.join(ROOT, 'src/main/core/settings/store')).get()],
      ['instances:list', () => require(path.join(ROOT, 'src/main/core/instances')).list()],
      ['game:installed', () => require(path.join(ROOT, 'src/main/core/game/install')).listInstalled()],
      ['java:detect', () => require(path.join(ROOT, 'src/main/core/java')).detect()],
      ['log:get', () => require(path.join(ROOT, 'src/main/core/util/log')).getAll()],
    ];
    for (const [name, fn] of checks) {
      try {
        await fn();
        console.log(`[boot-test] ✓ ${name}`);
      } catch (e) {
        failures.push(`${name} 失败：${e.message}`);
      }
    }

    // ---- 6. 汇总输出 ----
    console.log('========== boot-test 结果 ==========');
    console.log(`渲染进程控制台共 ${consoleLines.length} 条：`);
    for (const line of consoleLines.slice(0, 40)) console.log('  ' + line);
    if (failures.length === 0) {
      console.log('PASS：主进程、preload、renderer 全链路正常');
    } else {
      console.log(`FAIL：${failures.length} 个问题`);
      for (const f of failures) console.log('  ✗ ' + f);
    }
    win.destroy();
    app.exit(failures.length === 0 ? 0 : 1);
  });

  // ---- 7. 兜底超时 ----
  setTimeout(() => {
    failures.push('boot-test 超时（60s 未完成）');
    win.destroy();
    app.exit(1);
  }, 60000);
});
