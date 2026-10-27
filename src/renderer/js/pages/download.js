/**
 * @fileoverview 下载页逻辑（docs/UI-SPEC.md §5.2）
 *
 * 职责：
 *  - 左子导航（220px）：原版游戏 / 模组加载器 / Java 运行时；社区资源、整合包灰态占位；
 *  - 原版游戏：搜索 + 过滤 chips（全部/正式版/快照/远古/已安装）+ 下载源下拉 + 刷新；
 *    版本卡片流（类型色块图标 + 徽章 + 发布时间 + 安装/进度/启动/卸载），滚动分页每页 50；
 *    加载骨架 / 空态 / 错误重试三态齐全；
 *  - 模组加载器：Fabric 卡片（游戏版本 → 查询加载器版本 → 安装 → 进度），其余灰态占位；
 *  - Java 运行时：按 JAVA_MAJORS=[8,17,21,25]（与 src/main/core/constants.js 保持同步）
 *    渲染四张卡片（用途说明 + 本机检测状态 + 自动下载），进入页面自动检测。
 *
 * 页面模块契约：导出 { render(container), onEnter(params), onLeave() }。
 */

import { tr } from '../i18n.js';
import { api } from '../api.js';
import { state, on, emit, saveSettings, setSelectedVersion } from '../state.js';
import {
  el, icon, spinner, createSelect, verBlockIcon, formatDate, toast, confirmDialog,
} from '../components.js';

/** Java 大版本（与 src/main/core/constants.js 的 JAVA_MAJORS 保持一致，UI 无 Node 能力故硬编码） */
const JAVA_MAJORS = [8, 17, 21, 25];

/** Java 卡片用途说明文案键 */
const JAVA_DESC_KEYS = { 8: 'dlJavaDesc8', 17: 'dlJavaDesc17', 21: 'dlJavaDesc21', 25: 'dlJavaDesc25' };

/** Java 检测来源 → 展示名（未收录的直接显示原文） */
const ORIGIN_LABELS = {
  JAVA_HOME: '环境变量 JAVA_HOME',
  PATH: '系统 PATH',
  registry: '注册表',
  managed: '启动器下载',
  common: '常见目录',
};

/** 当前标签：vanilla / loader / java */
let tab = 'vanilla';
/** 版本列表每页条数 */
const PAGE_SIZE = 50;
/** 已渲染条数（分页游标） */
let shownCount = PAGE_SIZE;
/** 搜索关键词（小写） */
let filterQuery = '';
/** 过滤 chip：all / release / snapshot / old / installed */
let filterChip = 'all';
/** 已安装版本 id 集合 */
let installedSet = new Set();
/** 版本安装任务绑定：versionId -> taskId */
const verTasks = new Map();
/** Java 下载任务绑定：major -> taskId */
const javaTasks = new Map();
/** Fabric 标签状态 */
const fabric = { gameVersion: '', loaders: null, loaderVersion: '', querying: false, taskId: null };
/** Java 检测状态 */
let javaDetecting = false;
/** 页面节点引用与订阅集合 */
let scrollEl = null;
let vanillaRoot = null;
let listBox = null;
let footerEl = null;
const unsubs = [];

/**
 * 渲染页面骨架（app.js 路由切换时调用）。
 * @param {HTMLElement} container - 页面容器（#acl-main）
 */
export function render(container) {
  const subnav = el('div', { class: 'acl-subnav' },
    subItem('vanilla', 'cube', 'dlVanilla'),
    subItem('loader', 'puzzle', 'dlLoader'),
    subItem('java', 'mug', 'dlJava'),
    el('div', { class: 'acl-subnav__group' }, tr('dlMoreSection')),
    el('button', { class: 'acl-subitem is-disabled', html: `${icon('globe', 14)}<span>${tr('dlCommunity')}</span>` },
      el('span', { class: 'acl-tag acl-tag--gray acl-subitem__tag' }, tr('comingSoon')),
    ),
    el('button', { class: 'acl-subitem is-disabled', html: `${icon('box', 14)}<span>${tr('dlModpack')}</span>` },
      el('span', { class: 'acl-tag acl-tag--gray acl-subitem__tag' }, tr('comingSoon')),
    ),
  );
  scrollEl = el('div', { class: 'acl-scroll' });
  container.replaceChildren(el('div', { class: 'acl-page' }, subnav, scrollEl));
  syncSubnav();
  renderTabContent();
}

/**
 * 页面进入：按路由参数选择标签、订阅事件总线、绑定滚动分页。
 * @param {object} [params] - 路由参数（tab: vanilla/loader/java）
 */
export function onEnter(params) {
  if (params && (params.tab === 'java' || params.tab === 'loader' || params.tab === 'vanilla')) {
    setTab(params.tab);
  }
  refreshInstalled();
  // 进入 Java 标签时自动刷新本机检测
  if (tab === 'java') detectJava();
  // 任务事件驱动安装行/Java 卡/Fabric 卡局部刷新
  unsubs.push(on('task-update', (task) => handleTaskUpdate(task)));
  unsubs.push(on('task-done', (task) => handleTaskDone(task)));
  unsubs.push(on('installed', () => {
    installedSet = new Set(state.installed.map((v) => v.id));
    if (tab === 'vanilla' && vanillaRoot) renderList();
  }));
  // 滚动到底自动加载下一页（仅原版标签）
  scrollEl.addEventListener('scroll', onScroll);
}

/** 页面离开：取消订阅与滚动监听 */
export function onLeave() {
  for (const off of unsubs.splice(0)) off();
  scrollEl?.removeEventListener('scroll', onScroll);
}

/** 构建左子导航项 */
function subItem(key, ic, labelKey) {
  return el('button', {
    class: `acl-subitem${tab === key ? ' is-active' : ''}`,
    dataset: { tab: key },
    html: `${icon(ic, 14)}<span>${tr(labelKey)}</span>`,
    onclick: () => setTab(key),
  });
}

/** 同步子导航激活态 */
function syncSubnav() {
  scrollEl?.closest('.acl-page')?.querySelectorAll('.acl-subitem[data-tab]')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
}

/**
 * 切换标签。
 * @param {'vanilla'|'loader'|'java'} t - 标签标识
 */
function setTab(t) {
  if (tab === t) return;
  tab = t;
  syncSubnav();
  renderTabContent();
}

/** 渲染当前标签内容 */
function renderTabContent() {
  if (tab === 'vanilla') renderVanilla();
  else if (tab === 'loader') renderLoader();
  else renderJava();
}

/** 滚动处理：原版标签滚动到底自动加载下一页 */
function onScroll() {
  if (tab !== 'vanilla' || !scrollEl || !listBox) return;
  const nearBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 140;
  if (!nearBottom) return;
  const filtered = filteredVersions();
  if (shownCount < filtered.length) {
    shownCount += PAGE_SIZE;
    renderList(true);
  }
}

// ===================== 原版游戏标签 =====================

/** 渲染原版标签（工具条 + 列表容器） */
function renderVanilla() {
  vanillaRoot = el('div', { class: 'acl-dl-toolbar' });
  const chips = [['all', tr('dlAll')], ['release', tr('dlRelease')], ['snapshot', tr('dlSnapshot')], ['old', tr('dlOld')], ['installed', tr('dlInstalled')]];
  const searchInput = el('input', {
    class: 'acl-input', type: 'text', placeholder: tr('dlSearch'), value: filterQuery,
    oninput: () => { filterQuery = searchInput.value.trim().toLowerCase(); shownCount = PAGE_SIZE; renderList(); },
  });
  vanillaRoot.append(
    el('div', { class: 'acl-dl-toolbar__row' },
      el('div', { class: 'acl-search acl-dl-search' }, el('span', { html: icon('search', 14) }), searchInput),
      el('div', { class: 'acl-dl-source' },
        el('span', {}, tr('dlSource')),
        createSelect([
          { value: 'mojang', label: tr('dlSourceMojang') },
          { value: 'bmclapi', label: tr('dlSourceBmclapi') },
        ], {
          value: state.settings.downloadSource,
          onchange: (v) => { saveSettings({ downloadSource: v }); },
        }),
      ),
      el('button', { class: 'acl-icon-btn acl-tooltip', title: tr('refresh'), dataset: { tip: tr('refresh') }, html: icon('refresh', 15), onclick: () => loadManifest(true) }),
    ),
    el('div', { class: 'acl-dl-toolbar__row' },
      el('div', { class: 'acl-chips' },
        chips.map(([key, label]) => el('button', {
          class: `acl-chip${filterChip === key ? ' is-active' : ''}`,
          onclick: () => { filterChip = key; shownCount = PAGE_SIZE; renderList(); },
        }, label)),
      ),
    ),
  );
  listBox = el('div', { class: 'acl-dl-list', style: 'display:flex;flex-direction:column;gap:8px' });
  footerEl = el('div', { class: 'acl-dl-footer' });
  scrollEl.replaceChildren(vanillaRoot, listBox, footerEl);

  if (!state.manifest && !state.manifestError) {
    loadManifest(false);
  } else if (state.manifestError) {
    renderManifestError();
  } else {
    renderList();
  }
}

/**
 * 加载版本清单。
 * @param {boolean} force - 是否忽略缓存强制刷新
 */
async function loadManifest(force) {
  if (state.manifestLoading) return;
  state.manifestLoading = true;
  renderSkeleton();
  try {
    const m = await api.game.manifest({ force, source: state.settings.downloadSource });
    state.manifest = m;
    state.manifestError = null;
    emit('manifest', m);
    renderList();
  } catch (e) {
    state.manifestError = e.message || tr('dlManifestFailed');
    renderManifestError();
  } finally {
    state.manifestLoading = false;
  }
}

/** 渲染加载骨架（3 条闪烁占位） */
function renderSkeleton() {
  if (!listBox) return;
  footerEl.textContent = '';
  listBox.replaceChildren(
    skeletonRow(), skeletonRow(), skeletonRow(),
  );
}

/** 骨架行 */
function skeletonRow() {
  return el('div', { class: 'acl-ver-skeleton' },
    el('div', { class: 'acl-skeleton acl-ver-skeleton__icon' }),
    el('div', { class: 'acl-ver-skeleton__mid' },
      el('div', { class: 'acl-skeleton acl-ver-skeleton__line1' }),
      el('div', { class: 'acl-skeleton acl-ver-skeleton__line2' }),
    ),
    el('div', { class: 'acl-skeleton acl-ver-skeleton__btn' }),
  );
}

/** 渲染错误态（重试按钮） */
function renderManifestError() {
  if (!listBox) return;
  footerEl.textContent = '';
  listBox.replaceChildren(el('div', { class: 'acl-card acl-empty' },
    el('span', { class: 'acl-empty__icon', html: icon('error', 30) }),
    el('div', { class: 'acl-empty__title' }, tr('dlManifestFailed')),
    el('div', { class: 'acl-empty__divider' }),
    el('div', { class: 'acl-empty__desc' }, state.manifestError || ''),
    el('button', { class: 'acl-btn acl-btn--primary', onclick: () => loadManifest(true) }, tr('retry')),
  ));
}

/** 过滤后的版本列表 */
function filteredVersions() {
  let arr = state.manifest?.versions || [];
  if (filterChip === 'release') arr = arr.filter((v) => v.type === 'release');
  else if (filterChip === 'snapshot') arr = arr.filter((v) => v.type === 'snapshot');
  else if (filterChip === 'old') arr = arr.filter((v) => typeof v.type === 'string' && v.type.startsWith('old'));
  else if (filterChip === 'installed') arr = arr.filter((v) => installedSet.has(v.id));
  if (filterQuery) arr = arr.filter((v) => String(v.id).toLowerCase().includes(filterQuery));
  return arr;
}

/**
 * 渲染版本列表（全量或追加）。
 * @param {boolean} [append=false] - true 时只追加新的一页
 */
function renderList(append = false) {
  if (!listBox || !state.manifest) return;
  const filtered = filteredVersions();
  const slice = filtered.slice(0, Math.min(shownCount, filtered.length));

  if (!append) {
    listBox.replaceChildren();
  } else {
    // 移除已渲染的行后追加（按已渲染数量对齐）
    const rendered = listBox.querySelectorAll('.acl-ver-row').length;
    slice.slice(rendered).forEach((v) => listBox.append(buildVersionRow(v)));
  }

  // 空态：没有匹配的版本 + 清空筛选
  if (!slice.length) {
    listBox.replaceChildren(el('div', { class: 'acl-card acl-empty' },
      el('span', { class: 'acl-empty__icon', html: icon('search', 30) }),
      el('div', { class: 'acl-empty__title' }, tr('dlNoMatch')),
      el('div', { class: 'acl-empty__divider' }),
      el('div', { class: 'acl-empty__desc' }, filterQuery ? `“${filterQuery}”` : ''),
      el('button', {
        class: 'acl-btn acl-btn--primary',
        onclick: () => { filterQuery = ''; filterChip = 'all'; shownCount = PAGE_SIZE; renderVanilla(); },
      }, tr('dlClearFilter')),
    ));
    footerEl.textContent = '';
    return;
  }

  if (!append) {
    slice.forEach((v) => listBox.append(buildVersionRow(v)));
  }

  // 底部状态行（含手动加载更多按钮）
  footerEl.replaceChildren(
    el('span', {},
      shownCount < filtered.length
        ? tr('dlShown', { shown: slice.length, total: filtered.length })
        : tr('dlAllShown', { total: filtered.length }),
    ),
    shownCount < filtered.length
      ? el('button', {
        class: 'acl-btn acl-btn--ghost acl-btn--small', style: 'margin-left:10px',
        onclick: () => { shownCount += PAGE_SIZE; renderList(true); },
      }, tr('dlLoadingMore'))
      : null,
  );
}

/**
 * 版本类型 → 图标色块 class 与徽章文案。
 * @param {{id:string,type?:string}} v - 版本条目
 * @returns {{cls:string,label:string}} 类型信息
 */
function typeInfo(v) {
  if (v.type === 'release') return { cls: 'acl-ver-icon--release', label: tr('dlTypeRelease') };
  if (v.type === 'snapshot') return { cls: 'acl-ver-icon--snapshot', label: tr('dlTypeSnapshot') };
  return { cls: 'acl-ver-icon--old', label: tr('dlTypeOld') };
}

/**
 * 构建单个版本行。
 * @param {{id:string,type?:string,releaseTime?:string}} v - 版本条目
 * @returns {HTMLElement}
 */
function buildVersionRow(v) {
  const info = typeInfo(v);
  const installed = installedSet.has(v.id);
  const actions = el('div', { class: 'acl-ver-actions' });
  renderVerActions(actions, v);
  return el('div', { class: 'acl-ver-row', dataset: { ver: v.id } },
    el('div', { class: `acl-ver-icon ${info.cls}`, html: verBlockIcon() },
      installed ? el('span', { class: 'acl-ver-icon__badge', html: icon('check', 10) }) : null,
    ),
    el('div', { class: 'acl-ver-mid' },
      el('div', { class: 'acl-ver-id' }, v.id),
      el('div', { class: 'acl-ver-meta' },
        el('span', { class: `acl-tag ${v.type === 'release' ? 'acl-tag--success' : v.type === 'snapshot' ? 'acl-tag--accent' : 'acl-tag--warning'}` }, info.label),
        v.releaseTime ? el('span', {}, tr('dlReleaseTime', { time: formatDate(v.releaseTime) })) : null,
      ),
    ),
    actions,
  );
}

/**
 * 渲染版本行右侧操作区（安装/进度/启动/卸载）。
 * @param {HTMLElement} box - 操作容器
 * @param {{id:string}} v - 版本条目
 */
function renderVerActions(box, v) {
  box.replaceChildren();
  const taskId = verTasks.get(v.id);
  const task = taskId ? state.tasks.get(taskId) : null;
  const installed = installedSet.has(v.id);

  if (task && task.status === 'running') {
    // 安装中：进度条 + 百分比 + 取消
    const pct = Math.max(0, Math.min(100, task.percent || 0));
    box.append(el('div', { class: 'acl-ver-progress' },
      el('div', { class: 'acl-progress' }, el('div', { class: 'acl-progress__bar', style: `width:${pct}%` })),
      el('span', { class: 'acl-ver-progress__pct' }, `${Math.floor(pct)}%`),
      el('button', { class: 'acl-icon-btn acl-icon-btn--danger', title: tr('taskCancel'), html: icon('winClose', 12), onclick: async () => { await api.tasks.cancel(taskId); } }),
    ));
  } else if (installed) {
    box.append(
      el('button', { class: 'acl-btn acl-btn--primary acl-btn--small', html: `${icon('play', 11)}<span>${tr('dlLaunch')}</span>`, onclick: () => launchVersion(v.id) }),
      el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', title: tr('dlUninstall'), html: `${icon('trash', 11)}<span>${tr('dlUninstall')}</span>`, onclick: () => uninstallVersion(v) }),
    );
  } else {
    box.append(el('button', { class: 'acl-btn acl-btn--primary acl-btn--small', html: `${icon('download', 11)}<span>${tr('dlInstall')}</span>`, onclick: () => installVersion(v.id) }));
  }
}

/** 安装版本（触发后台任务并绑定进度） */
async function installVersion(id) {
  try {
    const { taskId } = await api.game.install(id, { source: state.settings.downloadSource });
    verTasks.set(id, taskId);
    const row = listBox?.querySelector(`[data-ver="${CSS.escape(id)}"]`);
    if (row) renderVerActions(row.querySelector('.acl-ver-actions'), { id });
  } catch (e) { /* 已 toast */ }
}

/** 卸载版本（二次确认） */
async function uninstallVersion(v) {
  const ok = await confirmDialog({
    title: tr('dlUninstallTitle'),
    message: tr('dlUninstallConfirm', { id: v.id }),
    confirmText: tr('dlUninstall'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.game.uninstall(v.id);
    toast('success', tr('dlUninstalled', { id: v.id }));
    await refreshInstalled();
  } catch (e) { /* 已 toast */ }
}

/** 从下载页启动版本：选中并跳转启动页 */
function launchVersion(id) {
  setSelectedVersion(id);
  location.hash = '#/home';
}

/** 刷新已安装版本列表 */
async function refreshInstalled() {
  try {
    state.installed = await api.game.installed();
    installedSet = new Set(state.installed.map((v) => v.id));
    emit('installed', state.installed);
  } catch (e) { /* 已 toast */ }
}

// ===================== 任务事件 → 局部刷新 =====================

/**
 * 任务进度事件：刷新对应的版本行 / Fabric 卡 / Java 卡。
 * @param {object} task - 任务对象
 */
function handleTaskUpdate(task) {
  for (const [verId, taskId] of verTasks) {
    if (taskId === task.taskId) {
      const row = listBox?.querySelector(`[data-ver="${CSS.escape(verId)}"]`);
      if (row) renderVerActions(row.querySelector('.acl-ver-actions'), { id: verId });
      break;
    }
  }
  if (fabric.taskId === task.taskId && tab === 'loader') renderLoader();
  for (const [major, taskId] of javaTasks) {
    if (taskId === task.taskId) { if (tab === 'java') renderJava(); break; }
  }
}

/**
 * 任务完成事件：清理绑定并刷新依赖数据。
 * @param {object} task - 任务对象
 */
function handleTaskDone(task) {
  for (const [verId, taskId] of verTasks) {
    if (taskId === task.taskId) {
      verTasks.delete(verId);
      if (task.status === 'done') refreshInstalled();
      const row = listBox?.querySelector(`[data-ver="${CSS.escape(verId)}"]`);
      if (row) renderVerActions(row.querySelector('.acl-ver-actions'), { id: verId });
      break;
    }
  }
  if (fabric.taskId === task.taskId) {
    fabric.taskId = null;
    if (task.status === 'done') refreshInstalled();
    if (tab === 'loader') renderLoader();
  }
  for (const [major, taskId] of javaTasks) {
    if (taskId === task.taskId) {
      javaTasks.delete(major);
      if (task.status === 'done') {
        toast('success', tr('dlJavaDownloaded', { major }));
        detectJava();
      }
      if (tab === 'java') renderJava();
      break;
    }
  }
}

// ===================== 模组加载器标签 =====================

/** 渲染模组加载器标签（Fabric 卡 + 灰态占位卡） */
function renderLoader() {
  // Fabric 卡片
  const gameSel = createSelect(
    (state.manifest?.versions || []).map((v) => ({ value: v.id, label: v.id })),
    {
      value: fabric.gameVersion || (state.manifest?.latest?.release || ''),
      onchange: (v) => { fabric.gameVersion = v; fabric.loaders = null; fabric.loaderVersion = ''; renderLoader(); },
    },
  );
  fabric.gameVersion = fabric.gameVersion || (state.manifest?.latest?.release || '');

  const loaderSel = createSelect(
    fabric.loaders ? fabric.loaders.map((l) => ({ value: l.loader.version, label: l.loader.version })) : [{ value: '', label: tr('dlQueryLoaders'), disabled: true }],
    {
      value: fabric.loaderVersion,
      onchange: (v) => { fabric.loaderVersion = v; },
    },
  );

  const queryBtn = el('button', {
    class: 'acl-btn acl-btn--ghost acl-btn--small',
    html: `${icon('search', 11)}<span>${fabric.querying ? tr('dlQuerying') : tr('dlQueryLoaders')}</span>`,
    onclick: queryLoaders,
  });
  if (fabric.querying) queryBtn.disabled = true;

  const installArea = el('div', { class: 'acl-loader-card__actions' });
  const fabricTask = fabric.taskId ? state.tasks.get(fabric.taskId) : null;
  if (fabricTask && fabricTask.status === 'running') {
    const pct = Math.max(0, Math.min(100, fabricTask.percent || 0));
    installArea.append(el('div', { class: 'acl-fab-progress', style: 'flex:1' },
      el('div', { class: 'acl-progress' }, el('div', { class: 'acl-progress__bar', style: `width:${pct}%` })),
      el('span', { class: 'acl-ver-progress__pct' }, `${Math.floor(pct)}%`),
      el('button', { class: 'acl-icon-btn acl-icon-btn--danger', title: tr('taskCancel'), html: icon('winClose', 12), onclick: () => api.tasks.cancel(fabric.taskId) }),
    ));
  } else {
    installArea.append(el('button', {
      class: 'acl-btn acl-btn--primary',
      html: `${icon('download', 12)}<span>${tr('dlFabricInstall')}</span>`,
      onclick: installFabric,
    }));
  }

  const fabricCard = el('div', { class: 'acl-card acl-loader-card' },
    el('div', { class: 'acl-loader-card__head' },
      el('span', { class: 'acl-loader-card__icon', html: icon('puzzle', 17) }),
      el('div', {},
        el('div', { class: 'acl-loader-card__title' }, tr('dlFabricTitle')),
        el('div', { class: 'acl-loader-card__desc' }, tr('dlFabricDesc')),
      ),
    ),
    el('div', { class: 'acl-loader-card__row' },
      el('span', { class: 'acl-loader-card__row-label' }, tr('dlGameVersion')),
      gameSel,
    ),
    el('div', { class: 'acl-loader-card__row' },
      el('span', { class: 'acl-loader-card__row-label' }, tr('dlLoaderVersion')),
      el('div', { style: 'display:flex;gap:6px;align-items:center' }, loaderSel, queryBtn),
    ),
    installArea,
  );

  // 灰态占位卡：Forge / NeoForge / Quilt
  const placeholder = (title, desc) => el('div', { class: 'acl-card acl-loader-card is-disabled' },
    el('div', { class: 'acl-loader-card__head' },
      el('span', { class: 'acl-loader-card__icon', html: icon('puzzle', 17) }),
      el('div', { style: 'flex:1' },
        el('div', { class: 'acl-loader-card__title' }, tr(title)),
        el('div', { class: 'acl-loader-card__desc' }, tr(desc)),
      ),
      el('span', { class: 'acl-tag acl-tag--gray' }, tr('comingSoon')),
    ),
  );

  const box = el('div', { class: 'acl-loader-grid' },
    fabricCard,
    placeholder('dlForgeTitle', 'dlForgeDesc'),
    placeholder('dlNeoForgeTitle', 'dlNeoForgeDesc'),
    placeholder('dlQuiltTitle', 'dlQuiltDesc'),
  );

  // 版本清单未加载/加载失败时的提示条
  const content = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  if (!state.manifest && !state.manifestError && !state.manifestLoading) {
    loadManifest(false).then(() => { if (tab === 'loader') renderLoader(); });
  }
  if (state.manifestLoading) {
    content.append(el('div', { class: 'acl-hint acl-hint--info' }, el('span', { html: icon('info', 15) }), el('span', {}, tr('loading'))));
  } else if (state.manifestError) {
    content.append(el('div', { class: 'acl-hint acl-hint--danger' },
      el('span', { html: icon('error', 15) }),
      el('span', { style: 'flex:1' }, tr('dlManifestFailed')),
      el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', onclick: () => loadManifest(true).then(() => renderLoader()) }, tr('retry')),
    ));
  }
  content.append(box);
  scrollEl.replaceChildren(content);
}

/** 查询 Fabric 加载器版本列表 */
async function queryLoaders() {
  if (!fabric.gameVersion) {
    toast('warning', tr('dlPickGameFirst'));
    return;
  }
  fabric.querying = true;
  renderLoader();
  try {
    const res = await api.game.fabricLoaders(fabric.gameVersion, { source: state.settings.downloadSource });
    fabric.loaders = Array.isArray(res) ? res : [];
    fabric.loaderVersion = fabric.loaders.length ? fabric.loaders[0].loader.version : '';
    if (!fabric.loaders.length) toast('warning', tr('dlNoMatch'));
  } catch (e) {
    toast('error', tr('dlQueryFailed'));
  } finally {
    fabric.querying = false;
    renderLoader();
  }
}

/** 安装 Fabric */
async function installFabric() {
  if (!fabric.gameVersion) return toast('warning', tr('dlPickGameFirst'));
  if (!fabric.loaderVersion) return toast('warning', tr('dlPickLoaderFirst'));
  try {
    const { taskId } = await api.game.installFabric({
      gameVersion: fabric.gameVersion,
      loaderVersion: fabric.loaderVersion,
      source: state.settings.downloadSource,
    });
    fabric.taskId = taskId;
    renderLoader();
  } catch (e) { /* 已 toast */ }
}

// ===================== Java 运行时标签 =====================

/** 渲染 Java 标签（四张卡片） */
function renderJava() {
  const box = el('div', { class: 'acl-java-grid' });
  for (const major of JAVA_MAJORS) box.append(buildJavaCard(major));
  scrollEl.replaceChildren(box);
}

/**
 * 构建单张 Java 卡片（用途说明 + 检测状态 + 自动下载）。
 * @param {number} major - Java 大版本
 * @returns {HTMLElement}
 */
function buildJavaCard(major) {
  const matched = javaDetecting ? null : state.java.filter((j) => j.major === major);
  const taskId = javaTasks.get(major);
  const task = taskId ? state.tasks.get(taskId) : null;

  // 状态区
  let statusEl;
  if (javaDetecting) {
    statusEl = el('div', { class: 'acl-loading-wrap', style: 'padding:10px' }, spinner(16), tr('dlJavaDetecting'));
  } else if (matched && matched.length) {
    statusEl = el('div', { class: 'acl-java-status' },
      el('div', { style: 'font-size:12px;color:var(--text-2)' }, tr('dlJavaDetected', { count: matched.length })),
      matched.map((j) => el('div', { class: 'acl-java-item', title: j.exe || j.path },
        el('span', { class: 'acl-java-item__ver' }, j.version || `Java ${j.major}`),
        j.arch ? el('span', { class: 'acl-java-item__arch' }, j.arch) : null,
        el('span', { class: 'acl-java-item__path' }, j.path || j.exe || ''),
        el('span', { class: 'acl-tag acl-tag--gray' }, ORIGIN_LABELS[j.origin] || j.origin || ''),
      )),
    );
  } else {
    statusEl = el('div', { class: 'acl-java-none', html: `${icon('warn', 13)}<span>${tr('dlJavaNotDetected')}</span>` });
  }

  // 底部操作区
  let footEl;
  if (task && task.status === 'running') {
    const pct = Math.max(0, Math.min(100, task.percent || 0));
    footEl = el('div', { class: 'acl-java-progress' },
      el('div', { class: 'acl-progress' }, el('div', { class: 'acl-progress__bar', style: `width:${pct}%` })),
      el('span', { class: 'acl-java-progress__pct' }, `${Math.floor(pct)}%`),
      el('button', { class: 'acl-icon-btn acl-icon-btn--danger', title: tr('taskCancel'), html: icon('winClose', 12), onclick: () => api.tasks.cancel(taskId) }),
    );
  } else {
    footEl = el('button', {
      class: 'acl-btn acl-btn--primary', disabled: javaDetecting,
      html: `${icon('download', 12)}<span>${tr('dlJavaDownload')}</span>`,
      onclick: () => downloadJava(major),
    });
  }

  return el('div', { class: 'acl-card acl-java-card', dataset: { java: major } },
    el('div', { class: 'acl-java-card__head' },
      el('span', { class: 'acl-java-card__icon', html: icon('mug', 18) }),
      el('div', {},
        el('div', { class: 'acl-java-card__title' }, tr('dlJavaTitle', { major })),
        el('div', { class: 'acl-java-card__desc' }, tr(JAVA_DESC_KEYS[major] || 'dlJavaDesc21')),
      ),
    ),
    statusEl,
    footEl,
  );
}

/** 自动下载 Java 运行时（触发任务并绑定） */
async function downloadJava(major) {
  try {
    const { taskId } = await api.java.download(major);
    javaTasks.set(major, taskId);
    renderJava();
  } catch (e) { /* 已 toast */ }
}

/** 检测本机 Java（进入标签与下载完成后调用） */
async function detectJava() {
  if (javaDetecting) return;
  javaDetecting = true;
  if (tab === 'java') renderJava();
  try {
    state.java = await api.java.detect();
    emit('java', state.java);
  } catch (e) {
    toast('error', tr('dlJavaDetectFailed'));
  } finally {
    javaDetecting = false;
    if (tab === 'java') renderJava();
  }
}
