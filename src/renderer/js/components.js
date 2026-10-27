/**
 * @fileoverview UI 组件与助手函数库
 *
 * 职责：渲染进程的通用积木——
 *  1. DOM 构建助手 el()（文本一律走 textContent，杜绝 XSS）；
 *  2. 手写原创内联 SVG 图标库 + 方块拼字 ACL Logo；
 *  3. toast 通知 / 模态框（openModal/confirmDialog/promptDialog）/ 任务详情弹窗；
 *  4. 登录弹窗（微软设备码流 + 离线）、实例管理弹窗与实例 CRUD 流程；
 *  5. 通用格式化（字节/速度/时间）与小型控件（开关/滑块/下拉）工厂。
 *
 * 注意：本模块不直接触碰 window.acl（统一经 api.js），不修改主进程任何文件。
 */

import { tr } from './i18n.js';
import { api } from './api.js';
import { state, emit, saveSettings, saveAccount } from './state.js';

// ===================== 手写原创图标库 =====================

/**
 * 全部图标为手绘线性 SVG（24 视窗、描边风格），原创图形，
 * 不使用任何外部资源或现存启动器的矢量数据。
 */
const ICONS = {
  rocket: { markup: '<path d="M12 3c2.4 1.8 3.9 4.2 3.9 7.1l-1.9 1.1v4.6l-2 1.7-2-1.7v-4.6L8.1 10.1C8.1 7.2 9.6 4.8 12 3z"/><circle cx="12" cy="9.7" r="1.5" fill="currentColor" stroke="none"/><path d="M12 20.5v1.2"/><path d="M8.4 4.6l1.3 1.2M15.6 4.6l-1.3 1.2"/>' },
  download: { markup: '<path d="M12 3.5v10.5"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 17.5v1.6a2 2 0 002 2h12a2 2 0 002-2v-1.6"/>' },
  gear: { markup: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>' },
  dots: { markup: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>' },
  winMin: { markup: '<path d="M5 12h14"/>', stroke: 1.6 },
  winMax: { markup: '<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="1"/>', stroke: 1.5 },
  winRestore: { markup: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9.2 7V5.4A1.4 1.4 0 0110.6 4h8A1.4 1.4 0 0120 5.4v8a1.4 1.4 0 01-1.4 1.4H17"/>', stroke: 1.5 },
  winClose: { markup: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', stroke: 1.6 },
  chevron: { markup: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>' },
  up: { markup: '<path d="M12 19V5"/><path d="M6.5 10.5L12 5l5.5 5.5"/>' },
  list: { markup: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>' },
  folder: { markup: '<path d="M3 7.5A2 2 0 015 5.5h4.2l1.8 2H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8z"/>' },
  trash: { markup: '<path d="M4 7h16"/><path d="M9.5 7V5.2A1.2 1.2 0 0110.7 4h2.6a1.2 1.2 0 011.2 1.2V7"/><path d="M6 7l.9 12.1A2 2 0 008.9 21h6.2a2 2 0 002-1.9L18 7"/><path d="M10 11.5v5.5M14 11.5v5.5"/>' },
  edit: { markup: '<path d="M4 20h4.5L19.6 8.9a2.12 2.12 0 000-3l-.5-.5a2.12 2.12 0 00-3 0L5 16.5V20z"/><path d="M13.8 6.2l3 3"/>' },
  check: { markup: '<path d="M5 12.5l4.5 4.5L19 7"/>' },
  copy: { markup: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5.5A2 2 0 017 3h9.5"/>' },
  play: { markup: '<path d="M8 5.5l10 6.5-10 6.5z"/>' },
  stop: { markup: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>' },
  plus: { markup: '<path d="M12 5v14M5 12h14"/>' },
  search: { markup: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>' },
  refresh: { markup: '<path d="M20 12a8 8 0 11-2.34-5.66"/><path d="M20 4v4.5h-4.5"/>' },
  external: { markup: '<path d="M14 5h5v5"/><path d="M19 5l-8.5 8.5"/><path d="M19 13.5v4a2 2 0 01-2 2H6.5a2 2 0 01-2-2V7a2 2 0 012-2h4"/>' },
  info: { markup: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>' },
  success: { markup: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5.5-6.5"/>' },
  warn: { markup: '<path d="M12 3.8l8.7 15H3.3z"/><path d="M12 10v4"/><circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none"/>' },
  error: { markup: '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>' },
  user: { markup: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20c.8-4 3.6-6 7.5-6s6.7 2 7.5 6"/>' },
  idCard: { markup: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="2"/><path d="M5.5 15.5c.7-2 2-3 3-3s2.3 1 3 3"/><path d="M14 9.5h5M14 13h5"/>' },
  mug: { markup: '<path d="M5.5 8h10.5v5.5a5 5 0 01-5 5h-.5a5 5 0 01-5-5V8z"/><path d="M16 9h1.2a2.3 2.3 0 010 4.6H16"/><path d="M7.5 5.5v1M10.5 5.5v1M13.5 5.5v1"/>' },
  ram: { markup: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 7V4M16 7V4M8 20v-3M16 20v-3"/><path d="M8 11.5h8M8 14.5h5"/>' },
  cube: { markup: '<path d="M12 3l8 4.6v8.8L12 21l-8-4.6V7.6z"/><path d="M12 12.2L20 7.6M12 12.2L4 7.6M12 12.2V21"/>' },
  puzzle: { markup: '<path d="M9.5 4.5a2.5 2.5 0 015 0V6h3a2 2 0 012 2v3h1.5a2.5 2.5 0 010 5H19.5v3a2 2 0 01-2 2h-3v-1.5a2.5 2.5 0 00-5 0V21h-3a2 2 0 01-2-2v-3H3a2.5 2.5 0 010-5h1.5V8a2 2 0 012-2h3z"/>' },
  globe: { markup: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z"/>' },
  box: { markup: '<path d="M12 3l8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>' },
  sun: { markup: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19"/>' },
  moon: { markup: '<path d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z"/>' },
  bulb: { markup: '<path d="M12 3a6 6 0 00-3.6 10.8c.9.7 1.4 1.4 1.6 2.2h4c.2-.8.7-1.5 1.6-2.2A6 6 0 0012 3z"/><path d="M9.5 18.5h5M10.5 21h3"/>' },
};

/** toast 类型与图标名映射 */
const TOAST_ICONS = { success: 'success', error: 'error', warning: 'warn', info: 'info' };

/**
 * 生成内联 SVG 图标。
 * @param {string} name - 图标名（ICONS 键）
 * @param {number} [size=15] - 像素尺寸
 * @param {string} [cls=''] - 附加 class
 * @returns {string} SVG 字符串（作者可控的静态内容，可安全 innerHTML）
 */
export function icon(name, size = 15, cls = '') {
  const def = ICONS[name];
  if (!def) return '';
  return `<svg class="acl-ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${def.stroke || 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.markup}</svg>`;
}

// ===================== 原创 Logo：方块拼字 ACL =====================

/** 像素字形表：A / C / L 三字母（4 列 x 5 行点阵） */
const LOGO_GLYPHS = {
  A: ['1111', '1001', '1111', '1001', '1001'],
  C: ['1111', '1000', '1000', '1000', '1111'],
  L: ['1000', '1000', '1000', '1000', '1111'],
};

/**
 * 生成应用 Logo（方块拼字 ACL，原创像素风）。
 * @param {number} [size=22] - 宽度像素
 * @returns {string} SVG 字符串
 */
export function createLogo(size = 22) {
  const cell = 2;        // 单元格边长
  const step = 3;        // 单元格步距（2 + 1 间隙）
  const letterW = 11;    // 单字母宽（4 格）
  const gap = 3;         // 字母间距
  const W = letterW * 3 + gap * 2;
  const H = 14;          // 5 格高
  const rects = [];
  Object.keys(LOGO_GLYPHS).forEach((ch, li) => {
    const baseX = li * (letterW + gap);
    LOGO_GLYPHS[ch].forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] === '1') {
          rects.push(`<rect x="${baseX + c * step}" y="${r * step}" width="${cell}" height="${cell}" rx="0.6"/>`);
        }
      }
    });
  });
  return `<svg class="acl-logo" width="${size}" height="${Math.round(size * H / W)}" viewBox="0 0 ${W} ${H}" fill="currentColor" aria-hidden="true">${rects.join('')}</svg>`;
}

/**
 * 版本方块图标（按类型着色的原创「方块脸」色块）。
 * @returns {string} SVG 字符串
 */
export function verBlockIcon() {
  return '<svg class="acl-ver-icon__svg" viewBox="0 0 24 24" aria-hidden="true">'
    + '<rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="currentColor"/>'
    + '<rect x="6" y="6" width="4.8" height="4.8" rx="1.2" fill="rgba(0,0,0,.2)"/>'
    + '<rect x="13.2" y="6" width="4.8" height="4.8" rx="1.2" fill="rgba(0,0,0,.2)"/>'
    + '<rect x="6" y="13.8" width="12" height="3.2" rx="1.6" fill="rgba(0,0,0,.2)"/>'
    + '</svg>';
}

// ===================== DOM 构建助手 =====================

/**
 * 创建 DOM 节点。字符串子节点一律按文本处理（安全防注入）；
 * 需要插入作者可控静态 SVG 时使用 attrs.html。
 * @param {string} tag - 标签名
 * @param {object} [attrs] - 属性：class / html / dataset / onXxx 事件 / 其他 setAttribute
 * @param {...(Node|string|number|null|false)} children - 子节点
 * @returns {HTMLElement} 节点
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');   // 布尔属性（如 disabled）
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 旋转加载圈 */
export function spinner(size = 22, cls = '') {
  return el('span', { class: `acl-spinner ${cls}`, style: `width:${size}px;height:${size}px` });
}

/**
 * 按钮 loading/禁用切换（配合 CSS .is-loading 显示内嵌旋转圈）。
 * @param {HTMLButtonElement} btn - 按钮
 * @param {boolean} busy - 是否忙碌
 */
export function btnLoading(btn, busy) {
  btn.classList.toggle('is-loading', !!busy);
  btn.disabled = !!busy;
}

/** 挂起指定毫秒 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===================== 格式化助手 =====================

/**
 * 字节数人性化（B/KB/MB/GB）。
 * @param {number} n - 字节数
 * @returns {string} 如 '34.5 MB'
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * 速度人性化。
 * @param {number} bps - 字节/秒
 * @returns {string} 如 '1.2 MB/s'
 */
export function formatSpeed(bps) {
  return `${formatBytes(bps)}/s`;
}

/**
 * 时间格式化为 HH:mm:ss。
 * @param {number|string|Date} t - 时间戳/ISO 字符串/Date
 * @returns {string} HH:mm:ss
 */
export function formatTime(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return String(t ?? '');
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * ISO 时间格式化为 YYYY-MM-DD（本地时区）。
 * @param {string} iso - ISO 日期字符串
 * @returns {string} 如 '2024-12-03'
 */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 日志级别 → 中文级别名。
 * @param {string} level - info/warn/error/…
 * @returns {string} 中文级别名
 */
export function levelName(level) {
  if (level === 'error') return tr('levelError');
  if (level === 'warn') return tr('levelWarn');
  return tr('levelInfo');
}

/**
 * 复制文本到剪贴板（优先现代 API，失败回退 textarea）。
 * @param {string} text - 待复制文本
 * @returns {Promise<boolean>} 是否成功
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/** 随机建议昵称（原创词库） */
export function randomName() {
  const heads = ['风', '夜', '星', '光', '雾', '霜', '云', '月', '晨曦', '流星'];
  const tails = ['行者', '旅人', '守望者', '探险家', '矿工', '建筑师', '骑士', '少年', '梦想家', '拾荒者'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(heads)}${pick(tails)}`;
}

// ===================== 小控件工厂 =====================

/**
 * 开关控件。
 * @param {boolean} checked - 初始状态
 * @param {{disabled?:boolean,title?:string,onchange?:Function}} [opts]
 * @returns {HTMLElement} label.acl-switch
 */
export function createSwitch(checked, opts = {}) {
  const input = el('input', { type: 'checkbox', class: 'acl-switch__input', checked: !!checked });
  const node = el('label', { class: 'acl-switch' + (opts.disabled ? ' is-disabled' : ''), title: opts.title ?? '' },
    input,
    el('span', { class: 'acl-switch__track' }, el('span', { class: 'acl-switch__thumb' })),
  );
  input.disabled = !!opts.disabled;
  if (opts.onchange) input.addEventListener('change', () => opts.onchange(input.checked));
  return node;
}

/**
 * 滑块控件（input[type=range]）。
 * @param {{min:number,max:number,value:number,step?:number,disabled?:boolean,oninput?:Function}} opts
 * @returns {HTMLInputElement}
 */
export function createSlider({ min, max, value, step = 1, disabled = false, oninput }) {
  const input = el('input', {
    type: 'range', class: 'acl-slider',
    min, max, step, value,
  });
  input.disabled = disabled;
  if (oninput) input.addEventListener('input', () => oninput(Number(input.value)));
  return input;
}

/**
 * 下拉选择控件（原生 select + 手绘 chevron，统一外观）。
 * @param {Array<{value:string,label:string,disabled?:boolean}>} options - 选项
 * @param {{value?:string,onchange?:Function,className?:string,title?:string}} [opts]
 * @returns {HTMLElement} div.acl-select-wrap
 */
export function createSelect(options, opts = {}) {
  const select = el('select', { class: `acl-select ${opts.className || ''}`, title: opts.title ?? '' });
  for (const o of options) {
    select.append(el('option', { value: o.value, disabled: !!o.disabled }, o.label));
  }
  if (opts.value !== undefined) select.value = opts.value;
  if (opts.onchange) select.addEventListener('change', () => opts.onchange(select.value));
  return el('div', { class: 'acl-select-wrap' },
    select,
    el('span', { class: 'acl-select-arrow', html: icon('chevron', 12) }),
  );
}

// ===================== toast 通知 =====================

/**
 * 右上角 toast 通知（3s 自动消失）。
 * @param {'success'|'error'|'warning'|'info'} type - 类型
 * @param {string} text - 文案
 * @param {number} [duration=3000] - 展示毫秒
 */
export function toast(type, text, duration = 3000) {
  let layer = document.getElementById('acl-toast-layer');
  if (!layer) {
    layer = el('div', { class: 'acl-toast-layer', id: 'acl-toast-layer' });
    document.body.append(layer);
  }
  const node = el('div', { class: `acl-toast acl-toast--${type}` },
    el('span', { class: 'acl-toast__icon', html: icon(TOAST_ICONS[type] || 'info', 16) }),
    el('span', { class: 'acl-toast__text' }, text),
  );
  layer.append(node);
  setTimeout(() => node.classList.add('acl-toast--out'), Math.max(0, duration - 240));
  setTimeout(() => node.remove(), duration);
}

// ===================== 模态框体系 =====================

/** 打开中的模态框栈（后进先出关闭） */
const modalStack = [];

// 全局 Esc：优先关闭最上层模态框；没有模态框时广播给应用层（如任务面板）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = modalStack[modalStack.length - 1];
  if (top) {
    if (top.closable) top.close();
  } else {
    document.dispatchEvent(new CustomEvent('acl-esc'));
  }
});

/**
 * 打开模态框。
 * @param {{title?:string,body:Node,footer?:Node,width?:number,closable?:boolean,onClose?:Function}} opts
 * @returns {{close:Function, el:HTMLElement, mask:HTMLElement}}
 */
export function openModal({ title, body, footer, width = 420, closable = true, onClose }) {
  const layer = document.getElementById('acl-modal-layer');
  if (!layer) throw new Error('缺少模态框容器 #acl-modal-layer');

  const entry = { closable, close: null, mask: null };
  const box = el('div', { class: 'acl-modal', style: width ? `--w:${width}px` : null });
  const head = el('div', { class: 'acl-modal__head' },
    el('span', { class: 'acl-modal__title' }, title ?? ''),
  );
  if (closable) {
    head.append(el('button', {
      class: 'acl-icon-btn', title: tr('close'), html: icon('winClose', 12),
      onclick: () => entry.close?.(),
    }));
  }
  box.append(head, el('div', { class: 'acl-modal__body' }, body));
  if (footer) box.append(el('div', { class: 'acl-modal__foot' }, footer));

  const mask = el('div', { class: 'acl-modal-mask' }, box);
  entry.mask = mask;

  /** 关闭当前模态框（幂等） */
  function close() {
    if (!mask.parentNode) return;
    mask.remove();
    const i = modalStack.indexOf(entry);
    if (i >= 0) modalStack.splice(i, 1);
    onClose?.();
  }
  entry.close = close;

  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask && closable) close();   // 点击遮罩关闭
  });
  layer.append(mask);
  modalStack.push(entry);

  // 聚焦第一个输入控件，便于键盘操作
  requestAnimationFrame(() => {
    const inp = box.querySelector('input, select, textarea');
    if (inp && typeof inp.focus === 'function') inp.focus();
  });
  return { close, el: box, mask };
}

/**
 * 确认对话框。
 * @param {{title?:string,message:string,confirmText?:string,cancelText?:string,danger?:boolean}} opts
 * @returns {Promise<boolean>} true=确认
 */
export function confirmDialog({ title, message, confirmText = tr('confirm'), cancelText = tr('cancel'), danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; m.close(); resolve(v); } };
    const m = openModal({
      title,
      body: el('div', { class: 'acl-confirm' }, el('div', { class: 'acl-confirm__msg' }, message)),
      footer: el('div', { class: 'acl-modal-actions' },
        el('button', { class: 'acl-btn', onclick: () => done(false) }, cancelText),
        el('button', { class: `acl-btn ${danger ? 'acl-btn--danger' : 'acl-btn--primary'}`, onclick: () => done(true) }, confirmText),
      ),
      onClose: () => done(false),
    });
  });
}

/**
 * 输入对话框（带实时校验；返回 null 表示取消）。
 * @param {{title?:string,label?:string,placeholder?:string,value?:string,hint?:string,
 *   validate?:Function,confirmText?:string,danger?:boolean}} opts
 * @returns {Promise<string|null>} 输入值或 null
 */
export function promptDialog({ title, label, placeholder = '', value = '', hint = '', validate, confirmText = tr('confirm'), danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    let current = value;
    const done = (v) => { if (!settled) { settled = true; m.close(); resolve(v); } };

    const input = el('input', {
      class: 'acl-input', type: 'text', placeholder, value,
      oninput: () => { current = input.value.trim(); refresh(); },
    });
    const errEl = el('div', { class: 'acl-field-error is-hidden' });
    const okBtn = el('button', {
      class: `acl-btn ${danger ? 'acl-btn--danger' : 'acl-btn--primary'}`,
      onclick: () => { if (!okBtn.disabled) done(current); },
    }, confirmText);

    /** 实时校验并刷新确认按钮可用态 */
    function refresh() {
      const err = validate ? validate(current) : '';
      errEl.textContent = err || '';
      errEl.classList.toggle('is-hidden', !err);
      okBtn.disabled = !current || !!err;
    }
    refresh();

    const m = openModal({
      title,
      body: el('div', { class: 'acl-form-col' },
        label ? el('label', { class: 'acl-form-label' }, label) : null,
        input,
        hint ? el('div', { class: 'acl-field-hint' }, hint) : null,
        errEl,
      ),
      footer: el('div', { class: 'acl-modal-actions' },
        el('button', { class: 'acl-btn', onclick: () => done(null) }, tr('cancel')),
        okBtn,
      ),
      onClose: () => done(null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !okBtn.disabled) done(current);
    });
  });
}

// ===================== 实例管理（共享流程） =====================

/**
 * 刷新实例列表并广播。
 * @returns {Promise<Array>} 实例列表
 */
export async function refreshInstances() {
  state.instances = await api.instances.list();
  emit('instances', state.instances);
  return state.instances;
}

/**
 * 校验实例名称（与主进程规则一致，前端先行拦截）。
 * @param {string} v - 名称
 * @param {string} [oldId] - 重命名时的旧 id（跳过自身重名检查）
 * @returns {string} 错误文案（'' 表示合法）
 */
function instanceNameError(v, oldId) {
  if (!v) return tr('setInstanceRule');
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(v)) return tr('setInstanceRule');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(v)) return '该名称为 Windows 保留名';
  if (state.instances.some((i) => i.id === v && i.id !== oldId)) return '已存在同名实例';
  return '';
}

/** 新建实例流程（输入 → 校验 → 创建 → 刷新） */
export async function createInstanceFlow() {
  const name = await promptDialog({
    title: tr('setNewInstance'),
    label: tr('setInstanceName'),
    placeholder: 'myworld',
    hint: tr('setInstanceRule'),
    confirmText: tr('create'),
    validate: (v) => instanceNameError(v),
  });
  if (!name) return;
  await api.instances.create(name);
  toast('success', tr('setInstanceCreated', { name }));
  await refreshInstances();
}

/**
 * 重命名实例流程。
 * @param {{id:string,name?:string}} item - 实例对象
 */
export async function renameInstanceFlow(item) {
  const oldId = item.id;
  const name = await promptDialog({
    title: tr('setRenameInstance'),
    label: tr('setInstanceName'),
    value: item.name || item.id,
    hint: tr('setInstanceRule'),
    confirmText: tr('rename'),
    validate: (v) => instanceNameError(v, oldId),
  });
  if (!name) return;
  await api.instances.rename(oldId, name);
  toast('success', tr('setInstanceRenamed'));
  await refreshInstances();
}

/**
 * 删除实例流程（危险操作：输入实例名确认）。
 * @param {{id:string,name?:string}} item - 实例对象
 */
export async function deleteInstanceFlow(item) {
  const display = item.name || item.id;
  const name = await promptDialog({
    title: tr('setDeleteInstanceTitle'),
    label: tr('setDeleteInstanceMsg', { name: display }),
    placeholder: item.id,
    danger: true,
    confirmText: tr('delete'),
    validate: (v) => (v === item.id ? '' : '输入的名称不匹配'),
  });
  if (!name) return;
  await api.instances.remove(item.id);
  if (state.settings.instance === item.id) await saveSettings({ instance: 'default' });
  toast('success', tr('setInstanceRemoved', { name: display }));
  await refreshInstances();
}

/**
 * 设为当前实例。
 * @param {{id:string,name?:string}} item - 实例对象
 */
export async function setCurrentInstance(item) {
  await saveSettings({ instance: item.id });
  toast('success', tr('setInstanceCurrent', { name: item.name || item.id }));
  emit('instances', state.instances);
}

/**
 * 构建单个实例行（实例管理弹窗与设置页共用）。
 * @param {{id:string,name?:string,createdAt?:string,isDefault?:boolean,dir?:string}} item - 实例对象
 *   dir：实例目录绝对路径（instances:list/create/rename 返回项附带，Lead 追加）
 * @param {{compact?:boolean}} [opts]
 * @returns {HTMLElement} 行节点
 */
export function buildInstanceRow(item, opts = {}) {
  const isCurrent = item.id === state.settings.instance;
  const actions = [];
  if (!isCurrent) {
    actions.push(el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', onclick: () => setCurrentInstance(item) }, tr('setCurrent')));
  }
  actions.push(el('button', { class: 'acl-icon-btn', title: tr('rename'), html: icon('edit', 14), onclick: () => renameInstanceFlow(item) }));
  if (!item.isDefault) {
    actions.push(el('button', { class: 'acl-icon-btn acl-icon-btn--danger', title: tr('delete'), html: icon('trash', 14), onclick: () => deleteInstanceFlow(item) }));
  }
  // 打开文件夹：经 shell.openPath 在资源管理器中打开实例目录（dir 缺失时禁用兜底）
  actions.push(el('button', {
    class: 'acl-icon-btn', title: item.dir || tr('setOpenFolder'),
    disabled: !item.dir,
    html: icon('folder', 14),
    onclick: () => { api.shell.openPath(item.dir).catch(() => { /* 打开失败已由 api 层 toast */ }); },
  }));

  return el('div', { class: 'acl-inst-row' + (isCurrent ? ' is-current' : '') },
    el('span', { class: 'acl-inst-row__icon', html: icon('folder', 15) }),
    el('div', { class: 'acl-inst-row__mid' },
      el('div', { class: 'acl-inst-row__name' }, item.name || item.id),
      el('div', { class: 'acl-inst-row__meta' },
        item.isDefault ? el('span', { class: 'acl-tag acl-tag--accent' }, tr('setDefaultBadge')) : null,
        isCurrent ? el('span', { class: 'acl-tag acl-tag--success' }, tr('setCurrentBadge')) : null,
      ),
    ),
    el('div', { class: 'acl-inst-row__actions' }, actions),
  );
}

/**
 * 打开实例管理弹窗（首页「管理」按钮）。
 */
export function openInstanceManagerModal() {
  const listBox = el('div', { class: 'acl-inst-list' });
  const m = openModal({
    title: tr('setInstanceTitle'),
    width: 520,
    body: listBox,
    footer: el('div', { class: 'acl-modal-actions' },
      el('button', { class: 'acl-btn acl-btn--ghost', onclick: () => m.close() }, tr('close')),
      el('button', { class: 'acl-btn acl-btn--primary', html: `${icon('plus', 13)}<span>${tr('setNewInstance')}</span>`, onclick: async () => { await createInstanceFlow(); render(); } }),
    ),
  });

  /** 重新拉取并渲染实例列表 */
  async function render() {
    listBox.replaceChildren(el('div', { class: 'acl-loading-wrap' }, spinner(), tr('loading')));
    try {
      const list = await refreshInstances();
      listBox.replaceChildren();
      for (const item of list) listBox.append(buildInstanceRow(item));
    } catch (e) {
      listBox.replaceChildren(el('div', { class: 'acl-loading-wrap' }, tr('dlManifestFailed'),
        el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', onclick: render }, tr('retry'))));
    }
  }
  render();
}

// ===================== 任务相关 =====================

/**
 * 取消任务（先确认）。
 * @param {{taskId:string,name:string}} task - 任务对象
 */
export async function cancelTask(task) {
  const ok = await confirmDialog({
    title: tr('taskCancel'),
    message: tr('taskCancelConfirm', { name: task.name }),
    confirmText: tr('taskCancel'),
    danger: true,
  });
  if (!ok) return;
  await api.tasks.cancel(task.taskId);
  toast('info', tr('taskCancelled'));
}

/**
 * 任务迷你行（首页任务卡片 / 右下任务面板共用）。
 * @param {object} task - 任务注册表对象
 * @param {Function} [onRowClick] - 点击行回调（打开详情）
 * @returns {HTMLElement}
 */
export function taskMiniRow(task, onRowClick) {
  const pct = Math.max(0, Math.min(100, task.percent || 0));
  const row = el('div', { class: 'acl-task-mini', dataset: { taskId: task.taskId } },
    el('div', { class: 'acl-task-mini__top' },
      el('span', { class: 'acl-task-mini__name', title: task.name }, task.name),
      el('span', { class: 'acl-task-mini__pct' }, `${Math.floor(pct)}%`),
      task.status === 'running'
        ? el('button', { class: 'acl-icon-btn acl-icon-btn--danger', title: tr('taskCancel'), html: icon('winClose', 11), onclick: (e) => { e.stopPropagation(); cancelTask(task); } })
        : null,
    ),
    el('div', { class: 'acl-progress' }, el('div', { class: 'acl-progress__bar', style: `width:${pct}%` })),
    task.extra ? el('div', { class: 'acl-task-mini__extra' }, task.extra) : null,
  );
  if (onRowClick) row.addEventListener('click', () => onRowClick(task));
  return row;
}

/**
 * 任务详情弹窗（进度 + 速度 + 最近 10 行日志）。
 * @param {object} task - 任务注册表对象
 */
export function taskDetailModal(task) {
  const pct = Math.max(0, Math.min(100, task.percent || 0));
  const logs = (task.logs || []).slice(-10);
  const body = el('div', { class: 'acl-task-detail' },
    el('div', { class: 'acl-task-detail__status' },
      task.status === 'done' ? el('span', { class: 'acl-tag acl-tag--success' }, tr('taskStatusDone'))
        : task.status === 'failed' ? el('span', { class: 'acl-tag acl-tag--danger' }, tr('taskStatusFailed'))
          : el('span', { class: 'acl-tag acl-tag--accent' }, tr('taskStatusRunning')),
      task.error ? el('span', { class: 'acl-task-detail__error' }, String(task.error)) : null,
    ),
    el('div', { class: 'acl-progress acl-progress--lg' }, el('div', { class: 'acl-progress__bar', style: `width:${pct}%` })),
    el('div', { class: 'acl-task-detail__stats' },
      el('div', { class: 'acl-task-detail__stat' },
        el('span', { class: 'acl-task-detail__label' }, tr('taskSpeed')),
        el('span', {}, task.status === 'running' && task.speed > 0 ? formatSpeed(task.speed) : '—'),
      ),
      el('div', { class: 'acl-task-detail__stat' },
        el('span', { class: 'acl-task-detail__label' }, '进度'),
        el('span', {}, task.total > 0 ? `${formatBytes(task.done)} / ${formatBytes(task.total)}` : `${Math.floor(pct)}%`),
      ),
    ),
    el('div', { class: 'acl-task-detail__log-title' }, tr('taskRecentLogs')),
    el('div', { class: 'acl-task-detail__logs' },
      logs.length
        ? logs.map((l) => el('div', { class: `acl-log-line acl-log-line--${l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : ''}` },
          el('span', { class: 'acl-log-time' }, `[${formatTime(l.time)}]`),
          ' ',
          el('span', { class: 'acl-log-level' }, `[${levelName(l.level)}]`),
          ' ',
          el('span', { class: 'acl-log-text' }, l.text),
        ))
        : el('div', { class: 'acl-text-3' }, '（暂无日志）'),
    ),
  );
  const m = openModal({
    title: tr('taskDetailTitle'),
    width: 480,
    body,
    footer: el('div', { class: 'acl-modal-actions' },
      el('button', { class: 'acl-btn acl-btn--ghost', onclick: () => m.close() }, tr('close')),
      task.status === 'running'
        ? el('button', { class: 'acl-btn acl-btn--danger', onclick: () => { m.close(); cancelTask(task); } }, tr('taskCancel'))
        : null,
    ),
  });
}

// ===================== 登录弹窗 =====================

/**
 * 打开登录弹窗。
 * @param {'ms'|'offline'} [initialTab='ms'] - 初始标签（默认微软账户）
 */
export function openLoginModal(initialTab = 'ms') {
  /** 设备码信息（msStart 结果） */
  let deviceInfo = null;
  /** 微软轮询状态：idle | waiting | ok | fail */
  let pollStatus = 'idle';
  /** 失败错误文案 */
  let failMsg = '';
  /** 已等待秒数 */
  let elapsed = 0;
  /** 轮询代次（关闭后递增，防止旧定时器回调） */
  let pollSeq = 0;
  /** 各定时器句柄 */
  let pollTimer = null;
  let tickTimer = null;
  let closeTimer = null;
  let closed = false;

  const codeBox = el('div', { class: 'acl-login-code' });
  const msStatus = el('div', { class: 'acl-login-status' });
  const msFoot = el('div', { class: 'acl-modal-actions' });

  // 三步说明（静态，渲染一次）
  const stepsBox = el('div', { class: 'acl-login-steps' },
    el('div', { class: 'acl-login-step' }, el('span', { class: 'acl-login-step__no' }, '1'), el('span', {}, tr('msStep1'))),
    el('div', { class: 'acl-login-step' }, el('span', { class: 'acl-login-step__no' }, '2'), el('span', {}, tr('msStep2'))),
    el('div', { class: 'acl-login-step' }, el('span', { class: 'acl-login-step__no' }, '3'), el('span', {}, tr('msStep3'))),
  );

  /** 停掉所有轮询与定时器 */
  function stopTimers() {
    pollSeq++;
    if (pollTimer) clearTimeout(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (closeTimer) clearTimeout(closeTimer);
    pollTimer = tickTimer = closeTimer = null;
  }

  /** 渲染微软标签动态区（按 pollStatus 状态机：说明在上、代码居中、状态在下） */
  function renderMs() {
    codeBox.replaceChildren();
    msStatus.replaceChildren();
    msFoot.replaceChildren();
    // 未配置客户端 ID 时隐藏三步说明，只展示引导
    stepsBox.classList.toggle('is-hidden', !state.settings.msClientId);

    if (!state.settings.msClientId) {
      // 未配置客户端 ID：引导到设置-账户
      msStatus.append(
        el('div', { class: 'acl-hint acl-hint--warning' },
          el('span', { html: icon('warn', 15) }),
          el('span', {}, tr('msNoClientId')),
        ),
      );
      msFoot.append(el('button', {
        class: 'acl-btn acl-btn--primary', html: `${icon('gear', 13)}<span>${tr('msGoSettings')}</span>`,
        onclick: () => { m.close(); location.hash = '#/settings?tab=account'; },
      }));
      return;
    }

    if (pollStatus === 'idle') {
      msFoot.append(el('button', {
        class: 'acl-btn acl-btn--primary acl-btn--large',
        html: `${icon('external', 13)}<span>${tr('msOpenBrowser')}</span>`,
        onclick: startMs,
      }));
      return;
    }

    // 展示代码大字（可点击复制）
    if (deviceInfo) {
      codeBox.append(
        el('div', { class: 'acl-login-code__label' }, tr('msCopyCode')),
        el('div', {
          class: 'acl-login-code__text acl-tooltip', title: tr('msCopyCode'),
          dataset: { tip: tr('msCopyCode') },
          onclick: async () => {
            if (await copyText(deviceInfo.userCode)) toast('success', tr('copied'));
          },
        }, deviceInfo.userCode),
      );
    }

    if (pollStatus === 'waiting') {
      msStatus.append(
        el('div', { class: 'acl-login-waiting' },
          spinner(20),
          el('span', {}, tr('msWaiting')),
          el('span', { class: 'acl-login-elapsed', dataset: { elapsed: '' } }, tr('msElapsed', { sec: elapsed })),
        ),
      );
      msFoot.append(
        el('button', { class: 'acl-btn acl-btn--ghost', onclick: startMs }, tr('msRetry')),
        el('button', { class: 'acl-btn acl-btn--ghost', onclick: () => m.close() }, tr('close')),
      );
    } else if (pollStatus === 'ok') {
      msStatus.append(
        el('div', { class: 'acl-login-waiting acl-login-waiting--ok' },
          el('span', { class: 'acl-login-ok', html: icon('success', 22) }),
          el('span', {}, tr('msSuccess')),
        ),
      );
    } else if (pollStatus === 'fail') {
      msStatus.append(
        el('div', { class: 'acl-hint acl-hint--danger' },
          el('span', { html: icon('error', 15) }),
          el('span', {}, tr('msLoginError', { msg: failMsg })),
        ),
      );
      msFoot.append(el('button', { class: 'acl-btn acl-btn--primary', onclick: startMs }, tr('msRetry')));
    }
  }

  /** 发起微软设备码登录并开始轮询 */
  async function startMs() {
    stopTimers();
    elapsed = 0;
    const btn = msFoot.querySelector('.acl-btn--primary');
    if (btn) btnLoading(btn, true);
    try {
      deviceInfo = await api.auth.msStart();
      pollStatus = 'waiting';
      renderMs();
      // 每秒刷新「已等待 N 秒」
      tickTimer = setInterval(() => {
        elapsed++;
        const t = msStatus.querySelector('.acl-login-elapsed');
        if (t) t.textContent = tr('msElapsed', { sec: elapsed });
      }, 1000);
      pollOnce();
    } catch (e) {
      pollStatus = 'fail';
      failMsg = e.message || '';
      renderMs();
    } finally {
      if (btn) btnLoading(btn, false);
    }
  }

  /** 单次轮询（按 interval 间隔循环直到成功/失败/关闭） */
  async function pollOnce() {
    if (closed || pollStatus !== 'waiting') return;
    const seq = pollSeq;
    try {
      const res = await api.auth.msPoll(deviceInfo.deviceCode);
      if (closed || seq !== pollSeq || pollStatus !== 'waiting') return;
      if (res && res.status === 'ok' && res.account) {
        pollStatus = 'ok';
        stopTimers();
        renderMs();
        await saveAccount(res.account);
        toast('success', tr('loginWelcome', { name: res.account.name || '' }));
        closeTimer = setTimeout(() => m.close(), 900);
        return;
      }
      // pending（authorization_pending / slow_down）继续轮询
      pollTimer = setTimeout(pollOnce, Math.max(2, (deviceInfo.interval || 5)) * 1000);
    } catch (e) {
      if (closed || seq !== pollSeq) return;
      pollStatus = 'fail';
      failMsg = e.message || '';
      stopTimers();
      renderMs();
    }
  }

  /** 离线昵称输入（默认随机建议昵称） */
  const offName = el('input', {
    class: 'acl-input', type: 'text', value: randomName(), maxlength: 16,
    placeholder: tr('setOfflineName'),
  });
  const offBody = el('div', { class: 'acl-form-col' },
    el('div', { class: 'acl-field-hint' }, tr('offHint')),
    el('label', { class: 'acl-form-label' }, tr('setOfflineName')),
    offName,
    el('div', { class: 'acl-modal-actions', style: 'margin-top:14px' },
      el('button', {
        class: 'acl-btn acl-btn--ghost', html: `${icon('refresh', 13)}<span>${tr('randomName')}</span>`,
        onclick: () => { offName.value = randomName(); offName.focus(); },
      }),
      el('button', { class: 'acl-btn acl-btn--primary', html: `${icon('rocket', 13)}<span>${tr('offStart')}</span>`, onclick: offlineLogin }),
    ),
  );

  /** 离线登录提交 */
  async function offlineLogin() {
    const name = offName.value.trim();
    if (!name) {
      toast('warning', tr('offNameEmpty'));
      offName.focus();
      return;
    }
    const btn = offBody.querySelector('.acl-btn--primary');
    btnLoading(btn, true);
    try {
      const account = await api.auth.offline(name);
      await saveAccount(account);
      toast('success', tr('loginWelcome', { name }));
      m.close();
    } catch (e) {
      /* 错误已由 api 层 toast */
    } finally {
      btnLoading(btn, false);
    }
  }

  // 标签页切换结构（两个分段按钮 + 面板容器）
  const msBody = el('div', { class: 'acl-login-ms' }, stepsBox, codeBox, msStatus);
  const tabPanels = { ms: msBody, offline: offBody };
  const bodyBox = el('div', { class: 'acl-login-body' });
  bodyBox.append(tabPanels[initialTab]);

  /** 切换登录标签（切走微软标签时停止轮询并恢复空闲态） */
  function switchTab(key) {
    stopTimers();
    pollStatus = 'idle';
    btnMs.classList.toggle('is-active', key === 'ms');
    btnOff.classList.toggle('is-active', key === 'offline');
    bodyBox.replaceChildren(tabPanels[key]);
    renderMs();
  }

  const btnMs = el('button', {
    class: 'acl-seg-btn' + (initialTab === 'ms' ? ' is-active' : ''),
    html: `${icon('idCard', 13)}<span>${tr('homeMsLogin')}</span>`,
    onclick: () => switchTab('ms'),
  });
  const btnOff = el('button', {
    class: 'acl-seg-btn' + (initialTab === 'offline' ? ' is-active' : ''),
    html: `${icon('user', 13)}<span>${tr('homeOfflineLogin')}</span>`,
    onclick: () => switchTab('offline'),
  });

  const m = openModal({
    title: tr('loginTitle'),
    width: 440,
    body: el('div', { class: 'acl-login' },
      el('div', { class: 'acl-seg' }, btnMs, btnOff),
      bodyBox,
    ),
    footer: msFoot,
    onClose: () => { closed = true; stopTimers(); },
  });

  renderMs();
}
