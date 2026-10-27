/**
 * @fileoverview CDP 诊断脚本（scripts/cdp-check.mjs）
 * 连接打包应用的 --remote-debugging-port，读取渲染进程真实状态：
 * 页面是否加载、window.acl 是否存在、模块脚本是否执行、资源加载清单。
 * 用法：node scripts/cdp-check.mjs <debugPort>（配合 exe 的 --remote-debugging-port 参数）
 */

const port = process.argv[2] || '9222';

// 获取调试目标列表（页面 / 渲染进程）
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.log('FAIL：未找到 page 目标，目标列表：', list.map((t) => `${t.type}: ${t.url}`));
  process.exit(1);
}
console.log('page 目标 URL：', page.url);

// 建立 WebSocket 连接（Node ≥ 21 内置 WebSocket）
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

/** 发送 CDP 命令并等待响应 */
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};

/** 在页面上下文执行表达式并取回结果 */
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result ? r.result.value : undefined;
}

await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');

// 等 3 秒让页面稳定
await new Promise((r) => setTimeout(r, 3000));

console.log('===== 渲染进程诊断 =====');
console.log('readyState      :', await evalJs('document.readyState'));
console.log('document.title  :', await evalJs('document.title'));
console.log('window.acl 存在 :', await evalJs('typeof window.acl'));
console.log('app 容器存在    :', await evalJs('!!document.querySelector(".acl-app")'));
console.log('导航项数量      :', await evalJs('document.querySelectorAll(".acl-titlebar *").length'));
console.log('标题栏内容前120字:', await evalJs('(document.querySelector(".acl-titlebar")||{textContent:""}).textContent.slice(0,120)'));
console.log('模块脚本加载清单:', JSON.stringify(await evalJs('performance.getEntriesByType("resource").map(e => e.name.split("/").slice(-2).join("/"))'), null, 0));
console.log('js/app.js 已执行 :', await evalJs('!!(window.__aclBooted || document.querySelector(".acl-main") && document.querySelector(".acl-main").children.length > 0)'));
console.log('main 容器子节点数:', await evalJs('document.querySelector(".acl-main") ? document.querySelector(".acl-main").children.length : -1'));

ws.close();
console.log('===== 诊断结束 =====');
process.exit(0);
