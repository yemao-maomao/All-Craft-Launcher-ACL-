'use strict';

/**
 * @fileoverview 微软 OAuth 设备码登录全链路模块（auth/microsoft.js）
 *
 * 实现 docs/CONTRACTS.md §5.10 / §12.10 的完整设备码流：
 * 1. devicecode：申请设备码（client_id 来自设置，缺失时抛中文提示）；
 * 2. token：轮询换取 access_token（authorization_pending 视为正常等待，
 *    slow_down 提示外部延长间隔，expired_token 抛「登录已过期」）；
 * 3. XBL：user.auth.xboxlive.com 换取 Xbox Live 令牌；
 * 4. XSTS：xsts.auth.xboxlive.com 换取 Minecraft 服务 XSTS 令牌，
 *    401 的 XErr 码映射为中文提示；
 * 5. MC：api.minecraftservices.com 换 Minecraft access_token；
 * 6. 档案：GET /minecraft/profile（404 = 未拥有 Java 版）+
 *    entitlements 检查（200 且无条目 = 未拥有）。
 *
 * 注意：以上域在国内可能不可达，网络错误统一附加「请检查网络」提示。
 */

const settingsStore = require('../settings/store');

/** devicecode 端点 */
const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
/** token 端点 */
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
/** XBL 认证端点 */
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
/** XSTS 授权端点 */
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
/** Minecraft 服务换票端点 */
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
/** Minecraft 档案端点 */
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
/** 游戏权益检查端点 */
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';

/** XSTS XErr 错误码 → 中文提示映射表 */
const XERR_MESSAGES = {
  2148916233: '该账户没有 Xbox 账户（需先创建 Xbox Live 账户）',
  2148916235: '当前地区暂不支持 Xbox Live 登录',
  2148916238: '该账户为未成年账户，无法登录',
};

/**
 * 发送表单编码的 HTTPS POST 并解析 JSON。
 * @param {string} url - 端点
 * @param {object} form - 表单字段
 * @param {object} [extraHeaders] - 额外请求头
 * @returns {Promise<{res:Response, body:object}>} 原始响应与 JSON 体
 */
async function postForm(url, form, extraHeaders = {}) {
  const body = new URLSearchParams(form).toString();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...extraHeaders,
      },
      body,
    });
  } catch (e) {
    throw new Error(`网络请求失败（微软服务在国内可能不可达，请检查网络）：${e.message}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON 响应按空对象处理，由调用方根据状态码判定
  }
  return { res, body: json || {} };
}

/**
 * 发送 JSON POST 请求。
 * @param {string} url - 端点
 * @param {object} payload - JSON 请求体
 * @returns {Promise<{res:Response, body:object}>} 响应与 JSON 体
 */
async function postJson(url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`网络请求失败（微软服务在国内可能不可达，请检查网络）：${e.message}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 同上
  }
  return { res, body: json || {} };
}

/**
 * 获取设置中的微软 OAuth 客户端 ID（缺失时抛中文提示）。
 * @returns {Promise<string>} 客户端 ID
 * @throws {Error} 未配置客户端 ID
 */
async function requireClientId() {
  const settings = await settingsStore.get();
  if (!settings.msClientId || !settings.msClientId.trim()) {
    throw new Error('请在设置中配置微软 OAuth 客户端 ID');
  }
  return settings.msClientId.trim();
}

/**
 * 开始设备码登录：申请 user_code / device_code。
 * @returns {Promise<{userCode:string, deviceCode:string, verificationUri:string, expiresIn:number, interval:number}>} 设备码信息
 * @throws {Error} 客户端 ID 未配置 / 申请失败
 */
async function msStart() {
  const clientId = await requireClientId();
  const { res, body } = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: 'XboxLive.signin offline_access',
  });
  if (!res.ok || !body.device_code) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`获取设备码失败：${detail}`);
  }
  return {
    userCode: body.user_code,
    deviceCode: body.device_code,
    verificationUri: body.verification_uri,
    expiresIn: body.expires_in,
    interval: body.interval || 5,
  };
}

/**
 * 轮询设备码授权结果。authorization_pending 不算错误。
 * @param {string} deviceCode - msStart 返回的 device_code
 * @returns {Promise<{status:'pending'|'ok', account?:object, error?:string}>} 轮询结果
 * @throws {Error} 登录过期 / 被拒绝 / 网络失败
 */
async function msPoll(deviceCode) {
  if (!deviceCode) throw new Error('缺少设备码（deviceCode）');
  const clientId = await requireClientId();
  const { res, body } = await postForm(TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
  });

  if (!res.ok) {
    const err = body.error || 'unknown_error';
    if (err === 'authorization_pending') return { status: 'pending' }; // 用户尚未完成授权：正常等待
    if (err === 'slow_down') return { status: 'pending', error: 'slow_down' }; // 提示外部延长间隔（interval+5s）
    if (err === 'expired_token') throw new Error('登录已过期');
    if (err === 'access_denied') throw new Error('登录被拒绝');
    throw new Error(`登录失败：${body.error_description || err}`);
  }
  if (!body.access_token) throw new Error('登录响应缺少 access_token');

  const account = await completeChain(body.access_token);
  return { status: 'ok', account };
}

/**
 * 拿到微软 access_token 后完成 XBL → XSTS → MC → 档案的换票链路。
 * @param {string} msToken - 微软 access_token
 * @returns {Promise<{type:string,name:string,uuid:string,token:string,userType:string,xuid:string,clientToken:string}>} 完整账户
 * @throws {Error} 各环节失败的中文提示
 */
async function completeChain(msToken) {
  // 1. XBL：微软令牌 → Xbox Live 用户令牌
  const xbl = await postJson(XBL_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!xbl.res.ok || !xbl.body.Token || !xbl.body.DisplayClaims) {
    throw new Error(`Xbox Live 认证失败：${xbl.body.XErr ? `错误码 ${xbl.body.XErr}` : `HTTP ${xbl.res.status}`}`);
  }
  const uhs = xbl.body.DisplayClaims.xui && xbl.body.DisplayClaims.xui[0] && xbl.body.DisplayClaims.xui[0].uhs;

  // 2. XSTS：XBL 令牌 → Minecraft 服务 XSTS 令牌
  const xsts = await postJson(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.body.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  if (!xsts.res.ok) {
    const xerr = xsts.body.XErr;
    if (xerr && XERR_MESSAGES[xerr]) throw new Error(XERR_MESSAGES[xerr]);
    throw new Error(`XSTS 认证失败：${xerr ? `错误码 ${xerr}` : `HTTP ${xsts.res.status}`}`);
  }
  if (!xsts.body.Token) throw new Error('XSTS 认证响应缺少令牌');

  // 3. MC 换票：XSTS → Minecraft access_token
  const mc = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${uhs};${xsts.body.Token}` });
  if (!mc.res.ok || !mc.body.access_token) {
    throw new Error(`Minecraft 登录失败：HTTP ${mc.res.status}`);
  }

  // 4. 档案：获取玩家名与 UUID（404 = 未拥有 Java 版）
  let profileRes;
  try {
    profileRes = await fetch(MC_PROFILE_URL, {
      headers: { Authorization: `Bearer ${mc.body.access_token}` },
    });
  } catch (e) {
    throw new Error(`获取 Minecraft 档案失败（请检查网络）：${e.message}`);
  }
  if (profileRes.status === 404) {
    throw new Error('该账户未拥有 Minecraft Java 版');
  }
  if (!profileRes.ok) {
    throw new Error(`获取 Minecraft 档案失败：HTTP ${profileRes.status}`);
  }
  const profile = await profileRes.json();
  if (!profile || !profile.id || !profile.name) {
    throw new Error('Minecraft 档案响应格式异常');
  }

  // 5. 权益检查：200 且无 game_minecraft 条目 = 未拥有（请求失败仅告警不阻断）
  try {
    const entRes = await fetch(MC_ENTITLEMENTS_URL, {
      headers: { Authorization: `Bearer ${mc.body.access_token}` },
    });
    if (entRes.ok) {
      const ent = await entRes.json();
      const items = (ent && ent.items) || [];
      if (!items.some((i) => i && i.name === 'game_minecraft')) {
        throw new Error('该账户未拥有 Minecraft Java 版');
      }
    } else {
      console.warn('[microsoft] 权益检查失败（不阻断登录）：HTTP', entRes.status);
    }
  } catch (e) {
    if (e.message && e.message.includes('未拥有')) throw e;
    console.warn('[microsoft] 权益检查异常（不阻断登录）：', e.message);
  }

  return {
    type: 'msa',
    name: profile.name,
    uuid: String(profile.id).replace(/-/g, ''), // 档案 id 无连字符，双保险去横线
    token: mc.body.access_token,
    userType: 'msa',
    xuid: uhs || '',
    clientToken: '',
  };
}

module.exports = { msStart, msPoll };
