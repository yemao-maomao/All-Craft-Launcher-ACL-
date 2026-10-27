'use strict';

/**
 * @fileoverview 零依赖 ZIP 读取/解压模块（util/zip.js）
 *
 * 依据 PKZIP APPNOTE 手写解析，仅用于 natives（原生库）解压场景：
 * - 定位 EOCD（末尾 65557 字节内搜索签名 0x06054b50）→ 读中央目录（0x02014b50）
 *   → 逐条按 local header（0x04034b50）读取数据；
 * - 压缩方法仅支持 0=stored（直接读）与 8=deflate（zlib.inflateRawSync）；
 * - 安全：条目名拒绝绝对路径、盘符与 .. 穿越；目录自动创建；覆盖写；
 * - 不支持 zip64 / 加密 / 其他压缩方法（遇到抛清晰中文错误）。
 * 不调用任何外部解压命令，不引入任何依赖。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** EOCD 签名（小端） */
const SIG_EOCD = 0x06054b50;
/** 中央目录条目签名 */
const SIG_CENTRAL = 0x02014b50;
/** local header 签名 */
const SIG_LOCAL = 0x04034b50;

/** EOCD 最小长度 22 字节 + 注释上限 65535 → 末尾最多搜索 65557 字节 */
const EOCD_SCAN_LIMIT = 65557;

/**
 * 在文件缓冲区末尾查找 EOCD 签名位置。
 * @param {Buffer} buf - 整个 ZIP 文件内容
 * @returns {number} EOCD 偏移；找不到返回 -1
 */
function findEocd(buf) {
  const start = Math.max(0, buf.length - EOCD_SCAN_LIMIT);
  // 签名必须 4 字节对齐（从后往前逐字节扫，兼容尾部注释长度任意）
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 校验条目名安全性：拒绝绝对路径、盘符、反斜杠与 .. 穿越段。
 * @param {string} name - 原始条目名（统一把 \ 视作 / 后再检查）
 * @returns {string} 规范化后的相对路径（用 / 分隔）
 * @throws {Error} 路径不安全时抛出
 */
function safeEntryName(name) {
  const normalized = String(name).replace(/\\/g, '/');
  // 拒绝盘符（C:/...）与绝对路径（/...）
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
    throw new Error(`ZIP 条目路径不安全（绝对路径）：${name}`);
  }
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`ZIP 条目路径不安全（含 ${seg}）：${name}`);
    }
  }
  return normalized;
}

/**
 * 读取 ZIP 文件全部条目（含目录项）。整文件载入内存后解析（natives jar 体积可控）。
 * @param {string} filePath - ZIP 文件绝对路径
 * @returns {Array<{name:string, isDirectory:boolean, size:number, compressedSize:number, readData:Function}>} 条目数组
 * @throws {Error} 文件不存在 / 非 ZIP / zip64 / 加密 / 不支持的压缩方法
 */
function readZipEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error(`不是有效的 ZIP 文件：${filePath}`);

  // EOCD 字段（APPNOTE 4.3.16）
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error(`ZIP 中央目录越界：${filePath}`);

  const entries = [];
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let count = 0;
  while (pos + 46 <= cdEnd && count < totalEntries) {
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      // 非预期签名：容错按剩余条目终止（部分生成器目录后有填充）
      if (count === 0) throw new Error(`ZIP 中央目录损坏：${filePath}`);
      break;
    }
    // 中央目录条目字段偏移（APPNOTE 4.3.12）
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);

    // 安全性 / 能力边界检查
    if ((flags & 0x1) !== 0) throw new Error(`ZIP 条目已加密，不支持：${filePath}`);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`ZIP 使用 zip64 格式，暂不支持：${filePath}`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`ZIP 压缩方法 ${method} 暂不支持（仅 stored/deflate）：${filePath}`);
    }

    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const safeName = safeEntryName(name);
    const isDirectory = safeName.endsWith('/');

    // 校验 local header 签名并读取其自身的 nameLen/extraLen：
    // 部分生成器（如旧版 jar 工具）local 与 central 的 extra 字段长度不一致，
    // 数据起点必须按 local header 实际长度计算（以中央目录 compSize 为准读数据）。
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP local header 损坏：${safeName}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    entries.push({
      name: safeName,
      isDirectory,
      size: uncompSize,
      compressedSize: compSize,
      /** 读取并解压该条目的数据（每次调用重新解压，无内部缓存） */
      readData() {
        if (dataStart + compSize > buf.length) {
          throw new Error(`ZIP 条目数据越界：${safeName}`);
        }
        if (isDirectory) return Buffer.alloc(0);
        const raw = buf.subarray(dataStart, dataStart + compSize);
        if (method === 0) return Buffer.from(raw); // stored：直接复制
        return zlib.inflateRawSync(raw);           // deflate：inflateRaw 解压
      },
    });

    pos += 46 + nameLen + extraLen + commentLen;
    count += 1;
  }
  return entries;
}

/**
 * 解压 ZIP 到目标目录（仅文件条目），返回已解压文件的绝对路径列表。
 * @param {string} filePath - ZIP 文件绝对路径
 * @param {string} destDir - 目标目录绝对路径（自动创建）
 * @param {{filter?:Function, excludePrefixes?:string[]}} [opts] - filter(name)→boolean 自定义过滤；excludePrefixes 前缀排除列表
 * @returns {string[]} 已解压文件绝对路径数组
 * @throws {Error} 路径穿越 / 不支持格式 / 磁盘写入失败
 */
function extractZip(filePath, destDir, opts = {}) {
  const { filter, excludePrefixes = [] } = opts;
  const entries = readZipEntries(filePath);
  const extracted = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    // 前缀排除（如 extract.exclude 的 'META-INF/'）
    if (excludePrefixes.some((p) => entry.name.startsWith(p))) continue;
    // 自定义过滤
    if (filter && !filter(entry.name)) continue;

    const dest = path.join(destDir, ...entry.name.split('/'));
    const resolved = path.resolve(dest);
    const baseResolved = path.resolve(destDir);
    // 双保险：即使上面通过了名称检查，也确保最终路径仍在目标目录内
    if (!resolved.startsWith(baseResolved + path.sep)) {
      throw new Error(`ZIP 解压路径穿越被拦截：${entry.name}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.readData());
    extracted.push(dest);
  }
  return extracted;
}

module.exports = { readZipEntries, extractZip };
