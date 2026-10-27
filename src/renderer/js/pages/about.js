/**
 * @fileoverview 关于页逻辑（docs/UI-SPEC.md §5.3「更多」）
 *
 * 职责：展示 Logo + 名称/版本 + 简介 + 运行时信息（acl.getInfo()）+
 * 开源协议（GPL-3.0）链接 + 灵感致谢（HMCL / PCL2 / FCL）+ 项目仓库链接 + 免责声明。
 * 所有外链统一经 api.shell.openExternal 打开系统浏览器。
 *
 * 页面模块契约：导出 { render(container), onEnter(params), onLeave() }。
 */

import { tr } from '../i18n.js';
import { api } from '../api.js';
import { el, icon, createLogo } from '../components.js';

/** 页面节点引用 */
let rootEl = null;
/** 运行时信息加载状态（防止重复拉取） */
let infoLoaded = false;
/** 运行时信息缓存（onEnter 异步填充后刷新表格） */
let info = null;

/**
 * 渲染页面骨架（app.js 路由切换时调用）。
 * @param {HTMLElement} container - 页面容器（#acl-main）
 */
export function render(container) {
  rootEl = el('div', { class: 'acl-scroll' },
    el('div', { class: 'acl-about' },
      el('div', { class: 'acl-card acl-about__hero' },
        el('span', { class: 'acl-about__logo', html: createLogo(64) }),
        el('div', { class: 'acl-about__name' }, tr('appName')),
        el('div', { class: 'acl-about__version' }, `v${info?.version || '0.0.1'}`),
        el('div', { class: 'acl-about__intro' }, tr('aboutIntro')),
      ),
      el('div', { class: 'acl-card' },
        el('div', { class: 'acl-set-card__title', html: `${icon('info', 15)}<span>${tr('aboutRuntime')}</span>` }),
        el('div', { class: 'acl-about-table', id: 'acl-about-table' },
          el('div', { class: 'acl-about-table__row' },
            el('span', { class: 'acl-about-table__k' }, 'Electron'),
            el('span', { class: 'acl-about-table__v' }, info?.electron || '—'),
          ),
          el('div', { class: 'acl-about-table__row' },
            el('span', { class: 'acl-about-table__k' }, 'Node.js'),
            el('span', { class: 'acl-about-table__v' }, info?.node || '—'),
          ),
          el('div', { class: 'acl-about-table__row' },
            el('span', { class: 'acl-about-table__k' }, 'Chromium'),
            el('span', { class: 'acl-about-table__v' }, info?.chrome || '—'),
          ),
          el('div', { class: 'acl-about-table__row' },
            el('span', { class: 'acl-about-table__k' }, tr('aboutPlatform')),
            el('span', { class: 'acl-about-table__v' }, info?.platform || '—'),
          ),
          el('div', { class: 'acl-about-table__row' },
            el('span', { class: 'acl-about-table__k' }, tr('aboutArch')),
            el('span', { class: 'acl-about-table__v' }, info?.arch || '—'),
          ),
        ),
      ),
      el('div', { class: 'acl-card' },
        el('div', { class: 'acl-set-card__title', html: `${icon('box', 15)}<span>${tr('aboutLicense')}</span>` }),
        el('div', { class: 'acl-about-links' },
          linkRow({
            name: tr('aboutLicenseName'),
            desc: 'https://www.gnu.org/licenses/gpl-3.0.html',
            url: 'https://www.gnu.org/licenses/gpl-3.0.html',
          }),
        ),
      ),
      el('div', { class: 'acl-card' },
        el('div', { class: 'acl-set-card__title', html: `${icon('bulb', 15)}<span>${tr('aboutAck')}</span>` }),
        el('div', { class: 'acl-set-desc', style: 'margin-bottom:10px' }, tr('aboutAckDesc')),
        el('div', { class: 'acl-about-links' },
          linkRow({ name: 'HMCL', desc: 'Hello Minecraft! Launcher', url: 'https://github.com/HMCL-dev/HMCL' }),
          linkRow({ name: 'Plain Craft Launcher 2', desc: 'PCL2', url: 'https://github.com/Hex-Dragon/PCL2' }),
          linkRow({ name: 'Fold Craft Launcher', desc: 'FCL', url: 'https://github.com/FCL-Team/FoldCraftLauncher' }),
        ),
      ),
      el('div', { class: 'acl-card' },
        el('div', { class: 'acl-set-card__title', html: `${icon('external', 15)}<span>${tr('aboutRepo')}</span>` }),
        el('div', { class: 'acl-about-links' },
          linkRow({
            name: 'AllCraftLauncher / AllCraftLauncher',
            desc: 'https://github.com/AllCraftLauncher/AllCraftLauncher',
            url: 'https://github.com/AllCraftLauncher/AllCraftLauncher',
          }),
        ),
      ),
      el('div', { class: 'acl-card' },
        el('div', { class: 'acl-set-card__title', html: `${icon('warn', 15)}<span>${tr('aboutDisclaimerTitle')}</span>` }),
        el('div', { class: 'acl-about__disclaimer' }, tr('aboutDisclaimer')),
      ),
    ),
  );
  container.replaceChildren(el('div', { class: 'acl-page' }, rootEl));
}

/**
 * 页面进入：拉取应用信息（acl.getInfo()）填充运行时表格。
 * @param {object} [params] - 路由参数
 */
export async function onEnter(params) {
  if (infoLoaded) return;
  infoLoaded = true;
  try {
    info = await api.getInfo();
    applyInfo();
  } catch (e) { /* 已 toast；表格保持占位 */ }
}

/** 页面离开（无持久订阅，无需清理） */
export function onLeave() {}

/** 把运行时信息写入表格 */
function applyInfo() {
  const table = rootEl?.querySelector('#acl-about-table');
  if (!table || !info) return;
  const rows = table.querySelectorAll('.acl-about-table__v');
  const values = [info.electron, info.node, info.chrome, info.platform, info.arch];
  rows.forEach((node, i) => { node.textContent = values[i] || '—'; });
  const ver = rootEl.querySelector('.acl-about__version');
  if (ver) ver.textContent = `v${info.version || '0.0.1'}`;
}

/**
 * 链接行（点击经 shell.openExternal 打开系统浏览器）。
 * @param {{name:string,desc?:string,url:string}} opts - 链接信息
 * @returns {HTMLElement}
 */
function linkRow({ name, desc, url }) {
  return el('button', {
    class: 'acl-about-link',
    onclick: () => { api.shell.openExternal(url).catch(() => {}); },
  },
    el('span', { class: 'acl-about-link__icon', html: icon('external', 15) }),
    el('div', { class: 'acl-about-link__mid' },
      el('div', { class: 'acl-about-link__name' }, name),
      desc ? el('div', { class: 'acl-about-link__desc' }, desc) : null,
    ),
    el('span', { class: 'acl-about-link__arrow', style: 'transform:rotate(-90deg)', html: icon('chevron', 13) }),
  );
}
