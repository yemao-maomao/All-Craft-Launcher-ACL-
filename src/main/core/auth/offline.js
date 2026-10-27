'use strict';

/**
 * @fileoverview 离线登录模块（auth/offline.js）
 *
 * 按 Minecraft 官方算法生成离线玩家 UUID（与官方启动器一致，保证同一玩家名
 * 在任何启动器下 UUID 相同，存档、服务器白名单不漂移）：
 * - UUID = MD5("OfflinePlayer:" + name) 取 16 字节；
 * - bytes[6] = (bytes[6] & 0x0f) | 0x30（RFC4122 版本位 3）；
 * - bytes[8] = (bytes[8] & 0x3f) | 0x80（变体位 10）；
 * - 格式化为 8-4-4-4-12 UUID 字符串。
 *
 * 离线账户：token='0'、userType='legacy'（docs/CONTRACTS.md §5.9 / §12.10）。
 */

const crypto = require('crypto');

/**
 * 生成离线登录账户。
 * @param {string} name - 玩家名（不允许空或纯空白）
 * @returns {{type:string, name:string, uuid:string, token:string, clientToken:string, userType:string, userProperties:Array}} 账户对象
 * @throws {Error} 玩家名为空时抛出
 */
function offlineLogin(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('玩家名不能为空');
  }
  const trimmed = name.trim();

  // MD5("OfflinePlayer:" + 玩家名) → 16 字节
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${trimmed}`, 'utf8').digest();
  // RFC4122 v3 位修正：版本 3 + 变体 10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  // 格式化为 8-4-4-4-12（带连字符）
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

  return {
    type: 'offline',
    name: trimmed,
    uuid,
    token: '0',         // 离线访问令牌固定 '0'
    clientToken: '',
    userType: 'legacy', // 离线用户类型
    userProperties: [{}],
  };
}

module.exports = { offlineLogin };
