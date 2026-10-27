/**
 * @fileoverview 应用启动引导与全局骨架
 *
 * 职责：
 *  1. 启动引导：读取设置 → 应用主题/语言（配合 localStorage 缓存防闪白）；
 *  2. 自绘标题栏：品牌区 + 中部一级导航（启动/下载/设置/更多）+ 窗口控制按钮；
 *  3. hash 路由（#/home 等）：页面切换调用各页面模块的 render/onEnter/onLeave；
 *  4. 全局事件订阅：win-state / settings-changed / task-* / app-log / launch-log /
 *     launch-exit，统一写入 state 并广播给页面；
 *  5. 右下浮动按钮组（任务面板入口 + 徽章、返回顶部）与任务面板弹层。
 */

import { tr, setLang } from './i18n.js';
import { api } from './api.js';
import { state, on, emit, appendLogLine, applySettings, updateTask, appendTaskLog, completeTask, activeTaskCount } from './state.js';
import { el, icon, createLogo, toast, taskMiniRow, taskDetailModal } from './components.js';
import * as home from './pages/home.js';
import * as download from './pages/download.js';
import * as settings from './pages/settings.js';
import * as about from './pages/about.js';

/** 页面注册表：路由名 → 页面模块 */
const PAGES = { home, download, settings, about };
/** 一级导航定义（顺序即展示顺序） */
const NAVS = [
  { id: 'home', label: () => tr('navHome'), ic: 'rocket' },
  { id: 'download', label: () => tr('navDownload'), ic: 'download' },
  { id: 'settings', label: () => tr('navSettings'), ic: 'gear' },
  { id: 'about', label: () => tr('navAbout'), ic: 'dots' },
];
/** 当前页面模块（onLeave 用） */
let currentPage = null;
/** 主题过渡计时器 */
let themeTimer = null;
/** 窗口最大化状态 */
let maximized = false;
/** 任务面板是否展开 */
let panelOpen = false;

// ===================== 启动引导 =====================

boot();

/** 应用启动：设置 → 主题 → 标题栏 → 全局事件 → 路由 */
async function boot() {
  // 主进程桥接缺失（非 Electron 环境）时给出错误态而不是白屏
  if (!window.acl) {
    renderFatal();
    return;
  }
  // 读取设置（失败时使用默认值兜底，错误已由 api 层 toast）
  try {
    const s = await api.settings.get();
    applySettings(s);
  } catch (e) { /* 默认设置兜底 */ }
  setLang(state.settings.language);
  applyTheme(false);

  buildTitlebar();
  buildFabs();
  bindGlobalEvents();
  initRouter();
}

/** 渲染致命错误态（window.acl 缺失） */
function renderFatal() {
  document.getElementById('acl-main').replaceChildren(
    el('div', { class: 'acl-empty', style: 'margin:auto' },
      el('div', { class: 'acl-empty__title' }, '主进程桥接不可用'),
      el('div', { class: 'acl-empty__desc' }, 'window.acl 不存在，请通过 Electron（npm start）启动本应用。'),
    ),
  );
}

// ===================== 主题与语言 =====================

/**
 * 应用主题（body 挂 data-theme / data-accent，CSS 变量驱动）。
 * @param {boolean} animate - 是否带 200ms 全局过渡（用户主动切换时）
 */
function applyTheme(animate = false) {
  const s = state.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme === 'dark' ? 'dark' : 'light';
  root.dataset.accent = ['blue', 'orange', 'green'].includes(s.accent) ? s.accent : 'blue';
  // 写本地缓存：index.html 首屏脚本据此在 JS 加载前应用主题，避免闪白
  try {
    localStorage.setItem('acl.ui.cache', JSON.stringify({ theme: root.dataset.theme, accent: root.dataset.accent }));
  } catch (e) { /* 忽略存储异常 */ }
  if (animate) {
    root.classList.add('theme-fading');
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => root.classList.remove('theme-fading'), 260);
  }
}

// ===================== 标题栏 =====================

/** 构建自绘标题栏（44px：品牌区 + 中部导航 + 窗口控制按钮） */
function buildTitlebar() {
  const bar = document.getElementById('acl-titlebar');

  // 品牌区（原创 Logo + 名称）
  const brand = el('div', { class: 'acl-brand' },
    el('span', { html: createLogo(24) }),
    el('span', { class: 'acl-brand__name' }, tr('appName')),
  );

  // 中部一级导航
  const nav = el('nav', { class: 'acl-nav' },
    NAVS.map((n) => el('button', {
      class: 'acl-nav-item',
      dataset: { route: n.id },
      html: `${icon(n.ic, 15)}<span>${n.label()}</span>`,
      onclick: () => { location.hash = `#/${n.id}`; },
    })),
  );

  // 右侧窗口控制按钮
  const maxBtn = el('button', { class: 'acl-win-btn', title: tr('winMax'), html: icon('winMax', 11), onclick: () => { api.maximize().catch(() => {}); } });
  const wins = el('div', { class: 'acl-win-btns' },
    el('button', { class: 'acl-win-btn', title: tr('winMin'), html: icon('winMin', 11), onclick: () => { api.minimize().catch(() => {}); } }),
    maxBtn,
    el('button', { class: 'acl-win-btn acl-win-btn--close', title: tr('winClose'), html: icon('winClose', 11), onclick: () => { api.close().catch(() => {}); } }),
  );
  bar.append(brand, nav, wins);

  /** 按最大化状态切换「最大化/还原」图标与提示 */
  window.__setWinMax = (isMax) => {
    maximized = !!isMax;
    maxBtn.innerHTML = icon(maximized ? 'winRestore' : 'winMax', 11);
    maxBtn.title = tr(maximized ? 'winRestore' : 'winMax');
  };

  // 双击标题栏空白（拖动区）切换最大化（Windows 惯例）
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, .acl-nav, .acl-brand')) return;
    api.maximize().catch(() => {});
  });

  // 初始最大化状态
  api.isMaximized().then((v) => window.__setWinMax(v)).catch(() => {});
}

// ===================== 浮动按钮组与任务面板 =====================

/** 构建右下浮动按钮组（任务面板入口 + 返回顶部） */
function buildFabs() {
  const box = document.getElementById('acl-fabs');
  const badge = el('span', { class: 'acl-fab__badge is-hidden' });
  const fabTasks = el('button', { class: 'acl-fab', title: tr('taskFabsTip'), html: icon('list', 17), onclick: () => toggleTaskPanel() },
    badge,
  );
  const fabTop = el('button', { class: 'acl-fab acl-fab--top', title: tr('fabsTop'), html: icon('up', 17), onclick: () => {
    const sc = currentScrollEl();
    if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
  } });
  box.append(fabTasks, fabTop);
  window.__taskBadge = badge;

  // 滚动联动：返回顶部按钮显隐（捕获阶段监听，适配各页面滚动容器）
  document.getElementById('acl-main').addEventListener('scroll', (e) => {
    const sc = e.target.closest?.('.acl-scroll');
    if (sc && sc === currentScrollEl()) {
      fabTop.classList.toggle('is-show', sc.scrollTop > 400);
    }
  }, true);

  // 任务变化 → 徽章与面板刷新
  on('task-update', () => { refreshBadge(); if (panelOpen) renderTaskPanel(); });
  on('task-remove', () => { refreshBadge(); if (panelOpen) renderTaskPanel(); });
}

/** 当前页面的滚动容器 */
function currentScrollEl() {
  return document.querySelector('#acl-main .acl-scroll');
}

/** 刷新任务徽章数量 */
function refreshBadge() {
  const badge = window.__taskBadge;
  if (!badge) return;
  const n = activeTaskCount();
  badge.textContent = String(n);
  badge.classList.toggle('is-hidden', n === 0);
}

/** 展开/收起任务面板 */
function toggleTaskPanel() {
  panelOpen = !panelOpen;
  const panel = document.getElementById('acl-task-panel');
  panel.classList.toggle('is-hidden', !panelOpen);
  if (panelOpen) renderTaskPanel();
}

/** 渲染任务面板内容（任务列表 + 总进度） */
function renderTaskPanel() {
  const panel = document.getElementById('acl-task-panel');
  const tasks = [...state.tasks.values()].filter((t) => t.status === 'running');
  // 总进度：有字节计数用合计，否则取平均百分比
  let totalPct = 0;
  if (tasks.length) {
    const sumDone = tasks.reduce((a, t) => a + (t.done || 0), 0);
    const sumTotal = tasks.reduce((a, t) => a + (t.total || 0), 0);
    totalPct = sumTotal > 0 ? sumDone / sumTotal * 100 : tasks.reduce((a, t) => a + (t.percent || 0), 0) / tasks.length;
  }
  panel.replaceChildren(
    el('div', { class: 'acl-task-panel__head', html: `${icon('list', 15)}<span>${tr('taskPanelTitle')}</span>` },
      el('button', { class: 'acl-icon-btn', style: 'margin-left:auto', title: tr('close'), html: icon('winClose', 11), onclick: () => toggleTaskPanel() }),
    ),
    tasks.length
      ? el('div', { class: 'acl-task-panel__list' },
        tasks.map((t) => taskMiniRow(t, taskDetailModal)),
      )
      : el('div', { class: 'acl-task-panel__empty' }, tr('taskNoActive')),
    tasks.length
      ? el('div', { class: 'acl-task-panel__foot' },
        el('span', {}, tr('taskTotal')),
        el('div', { class: 'acl-progress' }, el('div', { class: 'acl-progress__bar', style: `width:${Math.min(100, totalPct)}%` })),
        el('span', {}, `${Math.floor(totalPct)}%`),
      )
      : null,
  );
}

// ===================== 全局事件订阅 =====================

/** 订阅主进程推送事件，统一写入 state 并广播 */
function bindGlobalEvents() {
  // 窗口最大化状态
  api.on('win-state', ({ maximized: isMax }) => window.__setWinMax?.(isMax));

  // 设置变更（其他入口改设置后同步主题/语言；主题相关变化带 200ms 过渡）
  api.on('settings-changed', ({ settings: s }) => {
    if (!s) return;
    const themeChanged = (s.theme !== state.settings.theme) || (s.accent !== state.settings.accent);
    applySettings(s);
    setLang(s.language);
    applyTheme(themeChanged);
  });

  // 任务事件
  api.on('task-progress', (p) => updateTask(p));
  api.on('task-done', (p) => onTaskDone(p));
  api.on('task-log', (p) => appendTaskLog(p));

  // 应用日志（仅 launch 来源进入启动日志卡）
  api.on('app-log', (line) => {
    if (line && line.source === 'launch') {
      appendLogLine({ time: line.time, level: line.level || 'info', text: line.text || '' });
    }
  });

  // 游戏实时输出
  api.on('launch-log', ({ level, text }) => {
    appendLogLine({ time: Date.now(), level: level || 'info', text: text || '' });
    // 收到首行输出即视为「运行中」
    if (state.launch.status === 'starting') {
      state.launch.status = 'running';
      emit('launch', state.launch);
    }
  });

  // 游戏退出：恢复空闲态 + 输出绿色/红色状态行（附带崩溃报告路径时记录）
  api.on('launch-exit', (info) => {
    const code = info && typeof info.code === 'number' ? info.code : null;
    const ok = code === 0 || code === null;
    state.launch.status = 'idle';
    state.launch.pid = null;
    state.launch.java = null;
    // 崩溃报告路径需在退出状态行渲染前就位（行内按钮点击时读取）
    state.lastCrashReport = (info && info.crashReportPath) ? info.crashReportPath : null;
    appendLogLine({
      time: Date.now(),
      level: ok ? 'info' : 'error',
      text: ok
        ? tr('homeExitNormal', { code: code ?? 0 })
        : `${tr('homeExitAbnormal', { code })} —— ${tr('homeCrashHint')}`,
      kind: ok ? 'exit-ok' : 'exit-fail',
    });
    emit('launch-exit', info);
    emit('launch', state.launch);
  });

  // Esc 关闭任务面板（components 的 Esc 处理完模态框后广播 acl-esc）
  document.addEventListener('acl-esc', () => {
    if (panelOpen) toggleTaskPanel();
  });
}

/**
 * 任务完成：状态落库 + 统一 toast（成功/取消/失败三种口径）。
 * @param {{taskId:string,ok:boolean,error?:string,name?:string}} p - 完成事件
 */
function onTaskDone(p) {
  completeTask(p);
  const task = state.tasks.get(p.taskId);
  const name = (p.name || task?.name || tr('taskPanelTitle'));
  if (p.ok) {
    toast('success', `${name}：${tr('taskSucceed')}`);
  } else if (String(p.error || '').includes('已取消')) {
    toast('info', `${name}：${tr('taskCancelled')}`);
  } else {
    toast('error', `${name}：${tr('taskFailed')}：${p.error || ''}`);
  }
}

// ===================== hash 路由 =====================

/** 初始化路由（监听 hashchange + 首屏导航） */
function initRouter() {
  window.addEventListener('hashchange', () => route());
  route();
}

/** 解析 hash：#/download?tab=java → { page:'download', params:{tab:'java'} } */
function parseHash() {
  const h = location.hash || '#/home';
  const m = h.match(/^#\/?([a-z]+)?(?:\?(.*))?$/i);
  const page = m && m[1] && PAGES[m[1]] ? m[1] : 'home';
  const params = {};
  if (m && m[2]) {
    for (const [k, v] of new URLSearchParams(m[2])) params[k] = v;
  }
  return { page, params };
}

/** 执行路由：切换页面模块（render → onEnter） */
async function route() {
  const { page, params } = parseHash();
  const mod = PAGES[page];
  const mainEl = document.getElementById('acl-main');

  if (currentPage && currentPage !== mod) {
    try { currentPage.onLeave?.(); } catch (e) { console.error('[app] 页面 onLeave 异常：', e); }
  }
  currentPage = mod;
  try {
    mod.render(mainEl);
  } catch (e) {
    console.error('[app] 页面渲染异常：', e);
    mainEl.replaceChildren(el('div', { class: 'acl-empty', style: 'margin:auto' },
      el('div', { class: 'acl-empty__title' }, '页面渲染失败'),
      el('div', { class: 'acl-empty__desc' }, String(e?.message || e)),
    ));
  }
  try { await mod.onEnter?.(params); } catch (e) { console.error('[app] 页面 onEnter 异常：', e); }

  syncNav(page);
  refreshBadge();
}

/** 同步一级导航激活态 */
function syncNav(page) {
  document.querySelectorAll('.acl-nav-item[data-route]')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.route === page));
}
