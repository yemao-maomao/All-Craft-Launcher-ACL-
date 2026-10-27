'use strict';

/**
 * @fileoverview 统一网络层模块（util/http.js）
 *
 * 全项目唯一的 HTTP 出口，基于 Node ≥ 20 内置 fetch：
 * - httpJson / httpText：GET + 解析，幂等请求失败自动重试（指数退避 500ms/2s/5s）；
 * - downloadFile：下载到 <dest>.part，支持 HTTP Range 断点续传，
 *   完成后按 expectedSha1 校验（不符则删除重下，重试耗尽抛错）；
 *   本地已存在且哈希一致时直接返回 fromCache=true（先查成品再查 .part）；
 * - probeUrl：HEAD（失败退极小 GET）探测可达性，供镜像候选链选择；
 * - 统一 User-Agent 与超时；取消信号触发时抛出 message 含「已取消」的 AbortError。
 */

const fs = require('fs');
const path = require('path');
const { once } = require('events');
const constants = require('../constants');
const sha1Util = require('./sha1');
const appLog = require('./log');

/** 统一 User-Agent（AllCraftLauncher/<APP_VERSION>） */
const USER_AGENT = `AllCraftLauncher/${constants.APP_VERSION}`;

/** 重试退避间隔（毫秒），依次使用 */
const RETRY_BACKOFF_MS = [500, 2000, 5000];

/** 下载进度上报的最小间隔（毫秒） */
const PROGRESS_INTERVAL_MS = 300;

/**
 * 构造取消异常（message 含「已取消」，name=AbortError，供上层识别）。
 * @param {string} [hint] - 附加说明
 * @returns {Error} AbortError
 */
function abortError(hint) {
  const e = new Error(hint ? `已取消：${hint}` : '已取消');
  e.name = 'AbortError';
  return e;
}

/**
 * 可感知取消信号的延时（取消时立刻 reject 而非等到超时）。
 * @param {number} ms - 延时时长
 * @param {AbortSignal} [signal] - 外部取消信号
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function onAbort() { clearTimeout(timer); reject(abortError()); }
    function done() { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 判断 HTTP 状态是否值得重试（5xx / 408 / 429 视为服务端瞬时故障）。
 * @param {number} status - HTTP 状态码
 * @returns {boolean} 可重试
 */
function isRetriableStatus(status) {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * 单次 GET/HEAD 请求（不重试）。组合超时与外部取消信号。
 * @param {string} url - 请求地址
 * @param {{method?:string, headers?:object, signal?:AbortSignal, timeoutMs?:number}} opts - 请求选项
 * @returns {Promise<Response>} fetch 响应
 * @throws {Error} AbortError（取消）或原始网络错误
 */
async function fetchOnce(url, { method = 'GET', headers = {}, signal, timeoutMs } = {}) {
  const timeout = timeoutMs || constants.HTTP_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);
  try {
    return await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      redirect: 'follow',
      signal: combined,
    });
  } catch (e) {
    if (signal && signal.aborted) throw abortError(url);
    // 超时同样视为可重试的网络错误
    throw e;
  }
}

/**
 * 带重试的文本请求核心（GET，幂等）。404 等 4xx 立即失败不重试。
 * @param {string} url - 请求地址
 * @param {{timeoutMs?:number, headers?:object, signal?:AbortSignal, accept?:string}} opts - 选项
 * @returns {Promise<string>} 响应文本
 * @throws {Error} 重试耗尽或不可重试状态时抛出带 URL 的清晰错误
 */
async function requestText(url, opts = {}) {
  const headers = { Accept: opts.accept || '*/*', ...(opts.headers || {}) };
  let lastError = null;
  const maxAttempts = constants.DOWNLOAD_RETRY_TIMES + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchOnce(url, { headers, signal: opts.signal, timeoutMs: opts.timeoutMs });
      if (res.ok) return await res.text();
      lastError = new Error(`HTTP ${res.status}：${url}`);
      lastError.status = res.status;
      if (!isRetriableStatus(res.status)) lastError.noRetry = true;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
    }
    if (lastError && lastError.noRetry) break;
    if (attempt < maxAttempts - 1) {
      await sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)], opts.signal);
    }
  }
  throw new Error(`请求失败：${url}：${(lastError && lastError.message) || '未知错误'}`);
}

/**
 * GET 并解析 JSON。
 * @param {string} url - 请求地址
 * @param {{timeoutMs?:number, headers?:object, signal?:AbortSignal}} [opts] - 选项
 * @returns {Promise<object|array>} 解析后的 JSON
 * @throws {Error} 网络失败或响应不是合法 JSON
 */
async function httpJson(url, opts = {}) {
  const text = await requestText(url, { ...opts, accept: 'application/json' });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON：${url}`);
  }
}

/**
 * 依次尝试多个候选 URL 获取 JSON（镜像链回退），全部失败抛出最后一个错误。
 * @param {string[]} urls - 候选 URL 列表（按优先级）
 * @param {{timeoutMs?:number, headers?:object, signal?:AbortSignal}} [opts] - 选项
 * @returns {Promise<object|array>} 解析后的 JSON
 */
async function httpJsonCandidates(urls, opts = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await httpJson(url, opts);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      appLog.add('warn', 'http', `候选地址失败，尝试下一个：${url}（${e.message}）`);
    }
  }
  throw lastError || new Error('无可用的下载地址');
}

/**
 * GET 并返回纯文本。
 * @param {string} url - 请求地址
 * @param {{timeoutMs?:number, headers?:object, signal?:AbortSignal}} [opts] - 选项
 * @returns {Promise<string>} 响应文本
 */
async function httpText(url, opts = {}) {
  return requestText(url, { ...opts, accept: 'text/plain' });
}

/**
 * 探测 URL 可达性：先 HEAD，服务器不支持时退化为极小 Range GET。
 * @param {string} url - 待探测地址
 * @param {{timeoutMs?:number, headers?:object}} [opts] - 选项
 * @returns {Promise<boolean>} 可达且资源存在返回 true
 */
async function probeUrl(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10000;
  const headers = { ...(opts.headers || {}) };
  try {
    const res = await fetchOnce(url, { method: 'HEAD', headers, timeoutMs });
    if (res.status >= 200 && res.status < 400) return true;
    // 405/403/404 可能是 HEAD 不受支持 → 用极小 GET 复核
    const res2 = await fetchOnce(url, { headers: { ...headers, Range: 'bytes=0-0' }, timeoutMs });
    return res2.status >= 200 && res2.status < 400;
  } catch {
    return false;
  }
}

/**
 * 单次下载到 .part（带断点续传与进度），不负责整体重试。
 * @param {string} url - 下载地址
 * @param {string} partPath - .part 临时文件路径
 * @param {{expectedSha1?:string, onProgress?:Function, signal?:AbortSignal, timeoutMs?:number, headers?:object}} opts - 选项
 * @returns {Promise<void>}
 * @throws {Error} 网络失败 / 4xx（标记 noRetry）/ SHA1 不符 / 取消
 */
async function downloadToPart(url, partPath, opts) {
  const { expectedSha1, onProgress, signal, timeoutMs, headers = {} } = opts;
  // 已存在的 .part 大小 → 续传起点
  const existing = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  const reqHeaders = { Accept: '*/*', ...headers };
  if (existing > 0) reqHeaders.Range = `bytes=${existing}-`;

  const res = await fetchOnce(url, { headers: reqHeaders, signal, timeoutMs });
  if (signal && signal.aborted) throw abortError(url);

  // 416：Range 起点超出资源大小 → .part 可能已完整，进入校验
  if (res.status === 416) {
    if (expectedSha1) {
      const actual = await sha1Util.fileSha1(partPath);
      if (actual === expectedSha1) return; // 已完整且校验通过
      await fs.promises.rm(partPath, { force: true });
      throw new Error(`SHA1 校验失败：期望 ${expectedSha1}，实际 ${actual}`);
    }
    return;
  }
  if (res.status !== 200 && res.status !== 206) {
    const e = new Error(`HTTP ${res.status}：${url}`);
    if (!isRetriableStatus(res.status)) e.noRetry = true;
    throw e;
  }

  // 续传（206）或全新下载（200）
  const resume = res.status === 206;
  const rangeTotal = resume
    ? parseInt((res.headers.get('content-range') || '').split('/')[1], 10) || null
    : null;
  const contentLength = parseInt(res.headers.get('content-length'), 10) || null;
  const total = (resume ? existing : 0) + (rangeTotal || contentLength || 0) || null;

  // 确保 .part 所在目录存在
  await fs.promises.mkdir(path.dirname(partPath), { recursive: true });

  const ws = fs.createWriteStream(partPath, { flags: resume ? 'a' : 'w' });
  let written = resume ? existing : 0;

  // 滑动窗口测速：每 PROGRESS_INTERVAL_MS 上报一次平均速度
  let windowBytes = 0;
  let windowStart = Date.now();
  let lastTick = 0;
  const tick = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < PROGRESS_INTERVAL_MS) return;
    const dt = Math.max(0.001, (now - windowStart) / 1000);
    const speed = Math.round(windowBytes / dt);
    if (onProgress) onProgress({ done: written, total, speedBytesPerSec: speed });
    windowBytes = 0;
    windowStart = now;
    lastTick = now;
  };

  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal && signal.aborted) throw abortError(url);
      windowBytes += value.byteLength;
      written += value.byteLength;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!ws.write(chunk)) await once(ws, 'drain'); // 背压：写满后等待排空
      tick();
    }
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    ws.destroy();
    throw e;
  }
  tick(true);

  // 完成后按期望哈希校验（不符时删除 .part，由上层决定重试）
  if (expectedSha1) {
    const actual = await sha1Util.fileSha1(partPath);
    if (actual !== expectedSha1) {
      await fs.promises.rm(partPath, { force: true });
      throw new Error(`SHA1 校验失败：期望 ${expectedSha1}，实际 ${actual}`);
    }
  }
}

/**
 * 下载文件到 destPath：.part 断点续传、sha1 校验、失败重试、取消支持。
 * 本地已存在且哈希一致时直接返回 fromCache=true。
 * @param {string} url - 下载地址
 * @param {string} destPath - 目标文件绝对路径
 * @param {{expectedSha1?:string, onProgress?:Function, signal?:AbortSignal, timeoutMs?:number, headers?:object}} [opts] - 选项
 * @returns {Promise<{bytes:number, fromCache:boolean}>} 文件字节数与是否命中缓存
 * @throws {Error} 重试耗尽（4xx 立即失败）或取消（AbortError）
 */
async function downloadFile(url, destPath, opts = {}) {
  const { expectedSha1, onProgress, signal, timeoutMs, headers } = opts;
  if (signal && signal.aborted) throw abortError(url);

  // 先查成品文件：存在且（无校验要求或哈希一致）→ 命中缓存
  if (fs.existsSync(destPath)) {
    const size = fs.statSync(destPath).size;
    if (!expectedSha1 || (await sha1Util.fileSha1(destPath)) === expectedSha1) {
      if (onProgress) onProgress({ done: size, total: size, speedBytesPerSec: 0 });
      return { bytes: size, fromCache: true };
    }
    // 哈希不符 → 删除重下
    await fs.promises.rm(destPath, { force: true });
  }

  const partPath = destPath + '.part';
  let lastError = null;
  const maxAttempts = constants.DOWNLOAD_RETRY_TIMES + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await downloadToPart(url, partPath, { expectedSha1, onProgress, signal, timeoutMs, headers });
      // 校验通过 → 原子改名落盘
      await fs.promises.rename(partPath, destPath);
      return { bytes: fs.statSync(destPath).size, fromCache: false };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      if (e.noRetry) break; // 4xx：同地址重试无意义
      if (attempt < maxAttempts - 1) {
        await sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)], signal);
      }
    }
  }
  throw new Error(
    `下载失败：${url}（已重试 ${constants.DOWNLOAD_RETRY_TIMES} 次）：${(lastError && lastError.message) || '未知错误'}`
  );
}

/**
 * 依次尝试多个候选 URL 下载（镜像链回退），返回首个成功结果。
 * @param {string[]} urls - 候选 URL 列表（按优先级）
 * @param {string} destPath - 目标文件绝对路径
 * @param {{expectedSha1?:string, onProgress?:Function, signal?:AbortSignal, timeoutMs?:number, headers?:object}} [opts] - 选项
 * @returns {Promise<{bytes:number, fromCache:boolean, url:string}>} 结果与最终生效的 URL
 */
async function downloadFileCandidates(urls, destPath, opts = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      const r = await downloadFile(url, destPath, opts);
      return { ...r, url };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      appLog.add('warn', 'http', `下载地址失败，切换候选：${url}（${e.message}）`);
    }
  }
  throw lastError || new Error('无可用的下载地址');
}

module.exports = {
  USER_AGENT,
  httpJson,
  httpJsonCandidates,
  httpText,
  downloadFile,
  downloadFileCandidates,
  probeUrl,
  abortError,
};
