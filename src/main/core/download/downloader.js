'use strict';

/**
 * @fileoverview 批量并发下载器模块（download/downloader.js）
 *
 * 在 util/http.downloadFile 之上封装「多文件并发下载」：
 * - 并发队列（上限 threads，默认 4）；
 * - 单文件走 http.downloadFile（含 .part 断点续传、sha1 校验、自动重试）；
 * - 支持 files[].urls（候选链）：首个成功即止，全部失败抛最后一个错误，
 *   由此实现「镜像失败回官方」的下载源回退；
 * - onFile / onOverall 回调逐文件、逐批上报；信号取消 → AbortError。
 */

const constants = require('../constants');
const { downloadFile, abortError } = require('../util/http');

/**
 * 批量下载文件。
 * @param {Array<{url?:string, urls?:string[], dest:string, sha1?:string, size?:number}>} files - 待下载文件列表
 * @param {{threads?:number, onFile?:Function, onOverall?:Function, signal?:AbortSignal, timeoutMs?:number}} [opts] - 选项
 * @returns {Promise<{files:number, bytes:number, fromCache:number}>} 汇总统计
 * @throws {Error} AbortError（取消）或首个失败文件的重试耗尽错误
 */
async function downloadBatch(files, opts = {}) {
  const { onFile, onOverall, signal, timeoutMs } = opts;
  const threads = Math.max(1, Math.min(16, opts.threads || constants.DOWNLOAD_THREADS));
  if (signal && signal.aborted) throw abortError('批量下载');

  if (!Array.isArray(files) || files.length === 0) {
    return { files: 0, bytes: 0, fromCache: 0 };
  }

  const stats = { files: 0, bytes: 0, fromCache: 0 };
  let doneCount = 0;
  const queue = files.slice(); // 本地队列副本，worker 从队头取

  /**
   * 单个 worker：循环取文件直到队列空。任一文件最终失败 → 抛错中断整批。
   */
  async function worker() {
    for (;;) {
      const file = queue.shift();
      if (!file) return; // 队列空
      // 入口取消检查
      if (signal && signal.aborted) throw abortError('批量下载');

      const candidates = (Array.isArray(file.urls) && file.urls.length > 0)
        ? file.urls
        : [file.url];
      let lastError = null;
      let result = null;
      for (const url of candidates) {
        try {
          result = await downloadFile(url, file.dest, {
            expectedSha1: file.sha1,
            signal,
            timeoutMs,
          });
          break;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          lastError = e;
        }
      }
      if (!result) {
        // 所有候选均失败 → 抛出最后一个错误（含重试耗尽信息）
        throw lastError || new Error(`下载失败：${file.url || file.urls}`);
      }

      stats.files += 1;
      stats.bytes += result.bytes;
      if (result.fromCache) stats.fromCache += 1;
      doneCount += 1;
      if (onFile) onFile({ url: candidates[candidates.length - 1], dest: file.dest, done: result.bytes, total: result.bytes });
      if (onOverall) onOverall({ done: doneCount, total: files.length });
    }
  }

  // 并发 worker：全部完成（或任一失败）后返回
  await Promise.all(Array.from({ length: threads }, () => worker()));
  return stats;
}

module.exports = { downloadBatch };
