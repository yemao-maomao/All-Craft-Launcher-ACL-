'use strict';

/**
 * @fileoverview SHA1 工具模块（util/sha1.js）
 *
 * 提供字符串/缓冲区哈希与文件流式哈希两个入口：
 * - sha1Hex：内存数据直接计算，供离线登录 UUID（MD5 不走这里）等场景使用；
 * - fileSha1：以流方式分块读取文件计算，避免大文件一次性载入内存，
 *   供下载完成后的完整性校验与「本地已存在且哈希一致则跳过下载」判断使用。
 * 全部使用 Node 内置 crypto，零外部依赖。
 */

const crypto = require('crypto');
const fs = require('fs');

/** 文件哈希计算的单次读取块大小（4 MiB，兼顾内存与系统调用次数） */
const HASH_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * 计算字符串或 Buffer 的 SHA1，返回 40 位小写十六进制。
 * @param {Buffer|string} data - 待哈希数据（字符串按 UTF-8 编码处理）
 * @returns {string} 40 位小写十六进制哈希
 */
function sha1Hex(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/**
 * 流式计算文件的 SHA1（分块读取，内存占用恒定）。
 * @param {string} filePath - 文件绝对路径
 * @returns {Promise<string>} 40 位小写十六进制哈希
 * @throws {Error} 文件不存在或读取失败时抛出
 */
async function fileSha1(filePath) {
  const hash = crypto.createHash('sha1');
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(HASH_CHUNK_SIZE);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break; // 读到文件尾
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

module.exports = { sha1Hex, fileSha1 };
