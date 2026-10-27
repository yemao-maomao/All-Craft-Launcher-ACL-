/**
 * @fileoverview 设置页逻辑（docs/UI-SPEC.md §5.3）
 *
 * 职责：
 *  - 左子导航：通用 / 启动 / 账户 / 下载 / 更多（更多 = 跳转关于页）；
 *  - 通用：语言下拉、主题单选卡、主题色三色卡、P1 灰态行；
 *  - 启动：实例管理卡（CRUD 全部走 acl.instances.*）、Java 卡（检测 radio 列表 +
 *    自动选择 + 手动指定 + 下载运行时）、内存卡（自动开关 + 1024~16384 滑块）、
 *    高级卡（JVM 附加参数 + 默认分辨率）；
 *  - 账户：当前账户卡（退出登录）、微软客户端 ID 卡、离线快捷登录卡；
 *  - 下载：下载源单选 + 并发线程滑块 + 缓存清理（P1 占位）。
 *
 * 页面模块契约：导出 { render(container), onEnter(params), onLeave() }。
 */

import { tr } from '../i18n.js';
import { api } from '../api.js';
import { state, on, emit, saveSettings, saveAccount } from '../state.js';
import {
  el, icon, spinner, createSelect, createSwitch, createSlider, buildInstanceRow,
  createInstanceFlow, toast, confirmDialog, btnLoading, formatBytes,
} from '../components.js';

/** 设置分区标识 */
const SECTIONS = ['general', 'launch', 'account', 'download'];
/** 当前分区 */
let section = 'general';
/** 分辨率预设（与启动页一致） */
const RESOLUTIONS = [
  { value: '854x480', label: '854 × 480', width: 854, height: 480 },
  { value: '1280x720', label: '1280 × 720', width: 1280, height: 720 },
  { value: '1600x900', label: '1600 × 900', width: 1600, height: 900 },
  { value: '1920x1080', label: '1920 × 1080', width: 1920, height: 1080 },
];
/** 主题色预设（与 base.css 的 data-accent 对应） */
const ACCENTS = [
  { id: 'blue', labelKey: 'accentBlue', color: '#3D7BFD' },
  { id: 'orange', labelKey: 'accentOrange', color: '#F5822C' },
  { id: 'green', labelKey: 'accentGreen', color: '#2FA66B' },
];
/** 内存滑块防抖计时器 */
let memTimer = null;
/** 线程滑块防抖计时器 */
let threadTimer = null;
/** 页面节点与订阅集合 */
let scrollEl = null;
const unsubs = [];

/**
 * 渲染页面骨架（app.js 路由切换时调用）。
 * @param {HTMLElement} container - 页面容器（#acl-main）
 */
export function render(container) {
  const subnav = el('div', { class: 'acl-subnav' },
    subItem('general', 'gear', 'setGeneral'),
    subItem('launch', 'rocket', 'setLaunch'),
    subItem('account', 'user', 'setAccount'),
    subItem('download', 'download', 'setDownload'),
    // 「更多」= 关于页：直接切换路由
    el('button', {
      class: 'acl-subitem',
      html: `${icon('dots', 14)}<span>${tr('setMore')}</span>`,
      onclick: () => { location.hash = '#/about'; },
    }),
  );
  scrollEl = el('div', { class: 'acl-scroll' });
  container.replaceChildren(el('div', { class: 'acl-page' }, subnav, scrollEl));
  syncSubnav();
  renderSection();
}

/**
 * 页面进入：按路由参数选择分区、刷新实例与 Java、订阅事件总线。
 * @param {object} [params] - 路由参数（tab: general/launch/account/download）
 */
export function onEnter(params) {
  if (params && SECTIONS.includes(params.tab)) setSection(params.tab);
  refreshInstances();
  detectJava();
  unsubs.push(on('instances', () => renderSection()));
  unsubs.push(on('settings', () => renderSection()));
  unsubs.push(on('account', () => renderSection()));
  unsubs.push(on('java', () => { if (section === 'launch') renderSection(); }));
}

/** 页面离开：取消订阅、清理防抖 */
export function onLeave() {
  for (const off of unsubs.splice(0)) off();
  if (memTimer) clearTimeout(memTimer);
  if (threadTimer) clearTimeout(threadTimer);
  memTimer = threadTimer = null;
}

/** 构建左子导航项 */
function subItem(key, ic, labelKey) {
  return el('button', {
    class: `acl-subitem${section === key ? ' is-active' : ''}`,
    dataset: { tab: key },
    html: `${icon(ic, 14)}<span>${tr(labelKey)}</span>`,
    onclick: () => setSection(key),
  });
}

/** 同步子导航激活态 */
function syncSubnav() {
  scrollEl?.closest('.acl-page')?.querySelectorAll('.acl-subitem[data-tab]')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.tab === section));
}

/** 切换分区 */
function setSection(s) {
  if (section === s && scrollEl?.childElementCount) return;
  section = s;
  syncSubnav();
  renderSection();
}

/** 渲染当前分区 */
function renderSection() {
  if (!scrollEl) return;
  if (section === 'general') renderGeneral();
  else if (section === 'launch') renderLaunch();
  else if (section === 'account') renderAccount();
  else renderDownload();
}

/**
 * 通用卡片工厂：标题 + 内容。
 * @param {string} title - 标题文案
 * @param {string} ic - 标题图标名
 * @param {...Node} children - 内容节点
 * @returns {HTMLElement}
 */
function setCard(title, ic, ...children) {
  return el('div', { class: 'acl-card acl-set-card' },
    el('div', { class: 'acl-set-card__title', html: `${icon(ic, 15)}<span>${title}</span>` }),
    ...children,
  );
}

// ===================== 通用 =====================

/** 渲染通用分区（语言/主题/主题色/P1 占位行） */
function renderGeneral() {
  const s = state.settings;
  scrollEl.replaceChildren(el('div', { class: 'acl-set-section' },
    setCard(tr('setLanguage'), 'globe',
      el('div', { class: 'acl-form-row' },
        el('span', { class: 'acl-form-row__label' }, tr('setLanguage')),
        el('div', { class: 'acl-form-row__ctrl' },
          createSelect([
            { value: 'zh_CN', label: tr('langZh') },
            { value: 'en_US', label: tr('langEn') },
          ], { value: s.language, onchange: (v) => saveSettings({ language: v }) }),
        ),
      ),
    ),
    setCard(tr('setTheme'), 'sun',
      el('div', { class: 'acl-radio-cards' },
        radioCard({
          active: s.theme === 'light', icon: 'sun', title: tr('themeLight'), desc: tr('themeLightDesc'),
          onclick: () => saveSettings({ theme: 'light' }),
        }),
        radioCard({
          active: s.theme === 'dark', icon: 'moon', title: tr('themeDark'), desc: tr('themeDarkDesc'),
          onclick: () => saveSettings({ theme: 'dark' }),
        }),
      ),
    ),
    setCard(tr('setAccent'), 'cube',
      el('div', { class: 'acl-color-cards' },
        ACCENTS.map((a) => el('button', {
          class: `acl-color-card${s.accent === a.id ? ' is-active' : ''}`,
          onclick: () => saveSettings({ accent: a.id }),
        },
        el('span', { class: 'acl-color-card__swatch', style: `background:${a.color}` }),
        el('span', {}, tr(a.labelKey)),
        s.accent === a.id ? el('span', { class: 'acl-color-card__check', html: icon('check', 14) }) : null,
        )),
      ),
    ),
    setCard(tr('setHideAfter'), 'rocket',
      el('div', { class: 'acl-form-row acl-p1-row' },
        el('span', { class: 'acl-form-row__label' }, tr('setHideAfter')),
        el('div', { class: 'acl-form-row__ctrl' },
          createSwitch(false, { disabled: true }),
          el('span', { class: 'acl-tag acl-tag--gray' }, 'P1'),
        ),
      ),
      el('div', { class: 'acl-set-desc' }, tr('setHideAfterP1')),
    ),
  ));
}

/** 单选卡片工厂（主题/下载源共用） */
function radioCard({ active, icon: ic, title, desc, onclick }) {
  return el('button', { class: `acl-radio-card${active ? ' is-active' : ''}`, onclick },
    el('span', { class: 'acl-radio-card__icon', html: icon(ic, 17) }),
    el('span', { style: 'flex:1' },
      el('div', { class: 'acl-radio-card__title' }, title),
      el('div', { class: 'acl-radio-card__desc' }, desc),
    ),
    active ? el('span', { class: 'acl-radio-card__check', html: icon('check', 14) }) : null,
  );
}

// ===================== 启动 =====================

/** 渲染启动分区（实例/Java/内存/高级） */
function renderLaunch() {
  const s = state.settings;
  scrollEl.replaceChildren(el('div', { class: 'acl-set-section' },
    // —— 实例管理卡 ——
    setCard(tr('setInstanceTitle'), 'folder',
      el('div', { class: 'acl-set-instance-head' },
        el('div', { class: 'acl-set-desc' }, `${state.instances.length} 个实例`),
        el('button', { class: 'acl-btn acl-btn--primary acl-btn--small', html: `${icon('plus', 12)}<span>${tr('setNewInstance')}</span>`, onclick: createInstance }),
      ),
      el('div', { class: 'acl-set-instance-list' },
        state.instances.map((item) => buildInstanceRow(item)),
      ),
    ),
    // —— Java 卡 ——
    renderJavaCard(s),
    // —— 内存卡 ——
    renderMemoryCard(s),
    // —— 高级卡 ——
    setCard(tr('setAdvancedTitle'), 'gear',
      el('div', { class: 'acl-form-row' },
        el('span', { class: 'acl-form-row__label' }, tr('setJvmArgs')),
        el('div', { class: 'acl-form-row__ctrl acl-set-jvm' },
          el('textarea', {
            class: 'acl-input', rows: 3, placeholder: tr('setJvmArgsPlaceholder'),
            onchange: () => { saveSettings({ extraJvmArgs: ta.value.trim() }); },
          }),
        ),
      ),
      el('div', { class: 'acl-form-row' },
        el('span', { class: 'acl-form-row__label' }, tr('setResolution')),
        el('div', { class: 'acl-form-row__ctrl' },
          createSelect(RESOLUTIONS.map((r) => ({ value: r.value, label: r.label })), {
            value: `${s.resolution.width}x${s.resolution.height}`,
            onchange: (v) => {
              const r = RESOLUTIONS.find((x) => x.value === v);
              if (r) saveSettings({ resolution: { width: r.width, height: r.height } });
            },
          }),
        ),
      ),
    ),
  ));
  // 初始化 JVM 参数文本框内容
  const ta = scrollEl.querySelector('textarea.acl-input');
  if (ta) ta.value = s.extraJvmArgs || '';
}

/** 新建实例（弹输入对话框，复用 components 流程） */
async function createInstance() {
  await createInstanceFlow();
}

/**
 * 渲染 Java 卡（检测 radio 列表 + 自动选择 + 手动指定 + 下载运行时）。
 * @param {object} s - 设置对象
 * @returns {HTMLElement}
 */
function renderJavaCard(s) {
  const javaList = state.java;
  const isCustomPath = s.javaPath && !javaList.some((j) => j.exe === s.javaPath);

  const rows = [];
  // 「自动选择」项
  rows.push(el('label', { class: `acl-radio-row${!s.javaPath ? ' is-active' : ''}` },
    el('input', { type: 'radio', name: 'javaPath', checked: !s.javaPath, onchange: () => saveSettings({ javaPath: null }) }),
    el('div', { class: 'acl-radio-row__main' },
      el('div', { class: 'acl-radio-row__title' }, tr('setJavaAuto')),
      el('div', { class: 'acl-radio-row__sub' }, tr('homeJavaAuto')),
    ),
  ));
  // 检测结果项
  for (const j of javaList) {
    rows.push(el('label', { class: `acl-radio-row${s.javaPath === j.exe ? ' is-active' : ''}` },
      el('input', { type: 'radio', name: 'javaPath', checked: s.javaPath === j.exe, onchange: () => saveSettings({ javaPath: j.exe }) }),
      el('div', { class: 'acl-radio-row__main' },
        el('div', { class: 'acl-radio-row__title' }, `Java ${j.major} · ${j.version || '?'}${j.arch ? ` · ${j.arch}` : ''}`),
        el('div', { class: 'acl-radio-row__sub', title: j.exe || j.path }, j.exe || j.path),
      ),
      el('span', { class: 'acl-tag acl-tag--gray' }, j.origin || ''),
    ));
  }
  // 手动指定路径项（不在检测列表里时显示）
  if (isCustomPath) {
    rows.push(el('label', { class: 'acl-radio-row is-active' },
      el('input', { type: 'radio', name: 'javaPath', checked: true }),
      el('div', { class: 'acl-radio-row__main' },
        el('div', { class: 'acl-radio-row__title' }, tr('setJavaManual')),
        el('div', { class: 'acl-radio-row__sub', title: s.javaPath }, tr('setJavaManualCurrent', { path: s.javaPath })),
      ),
    ));
  }

  const body = el('div', { class: 'acl-set-java-list' });
  if (!javaList.length && !isCustomPath) {
    body.append(el('div', { class: 'acl-loading-wrap', style: 'padding:12px' },
      spinner(16), tr('setJavaNone')));
  } else {
    body.append(...rows);
  }

  return setCard(tr('setJavaTitle'), 'mug',
    body,
    el('div', { class: 'acl-set-java-actions' },
      el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', html: `${icon('folder', 12)}<span>${tr('setJavaManual')}</span>`, onclick: manualSelectJava }),
      el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', html: `${icon('download', 12)}<span>${tr('setJavaDownload')}</span>`, onclick: () => { location.hash = '#/download?tab=java'; } }),
    ),
  );
}

/** 手动指定 Java：选目录后拼接 bin\java.exe 保存 */
async function manualSelectJava() {
  toast('info', tr('setJavaPickHint'));
  try {
    const { path } = await api.dialog.selectDir();
    if (!path) return; // 用户取消
    const exe = `${path.replace(/[\\/]+$/, '')}\\bin\\java.exe`;
    await saveSettings({ javaPath: exe });
    toast('success', `${tr('setJavaSaved')}：${exe}`);
  } catch (e) { /* 已 toast */ }
}

/**
 * 渲染内存卡（自动开关 + 1024~16384 双滑块）。
 * @param {object} s - 设置对象
 * @returns {HTMLElement}
 */
function renderMemoryCard(s) {
  const clamp = (v) => Math.max(1024, Math.min(16384, v || 1024));
  const min = clamp(s.minMemory);
  const max = clamp(s.maxMemory);

  /** 构建滑块行 */
  const sliderRow = (labelKey, key, val, otherVal, isMin) => {
    const valEl = el('span', { class: 'acl-set-mem-row__val' }, `${val} MB`);
    const slider = createSlider({
      min: 1024, max: 16384, step: 64, value: val, disabled: s.autoMemory,
      oninput: (v) => {
        valEl.textContent = `${v} MB`;
        const patch = {};
        if (isMin) {
          patch.minMemory = v;
          if (v > otherVal) patch.maxMemory = v;
        } else {
          patch.maxMemory = v;
          if (v < otherVal) patch.minMemory = v;
        }
        if (memTimer) clearTimeout(memTimer);
        memTimer = setTimeout(() => saveSettings(patch), 350);
      },
    });
    return el('div', { class: 'acl-set-mem-row' },
      el('div', { class: 'acl-set-mem-row__top' }, el('span', {}, tr(labelKey)), valEl),
      slider,
    );
  };

  return setCard(tr('setMemoryTitle'), 'ram',
    el('div', { class: 'acl-set-mem-head' },
      el('span', { class: 'acl-form-row__label', style: 'width:auto' }, tr('setMemoryAuto')),
      createSwitch(s.autoMemory, { onchange: (v) => saveSettings({ autoMemory: v }) }),
    ),
    el('div', { class: 'acl-set-desc' }, tr('setMemoryHint')),
    el('div', { class: 'acl-set-mem-sliders' },
      sliderRow('homeMinMemory', 'minMemory', min, max, true),
      sliderRow('homeMaxMemory', 'maxMemory', max, min, false),
    ),
  );
}

// ===================== 账户 =====================

/** 渲染账户分区（当前账户/微软客户端 ID/离线登录） */
function renderAccount() {
  const s = state.settings;
  const acc = state.account;

  // 当前账户卡
  const accCard = setCard(tr('setAccountTitle'), 'user',
    acc
      ? el('div', { class: 'acl-set-account' },
        el('span', { class: 'acl-avatar acl-avatar--small' }, (acc.name || '?').slice(0, 1).toUpperCase()),
        el('div', { class: 'acl-set-account__mid' },
          el('div', { class: 'acl-set-account__name' }, acc.name || '?'),
          el('div', { class: 'acl-set-account__meta' },
            el('span', { class: `acl-tag ${acc.type === 'msa' ? 'acl-tag--accent' : 'acl-tag--gray'}` }, acc.type === 'msa' ? tr('homeAccTypeMs') : tr('homeAccTypeOffline')),
            acc.uuid ? el('span', { style: 'margin-left:8px' }, acc.uuid) : null,
          ),
        ),
        el('div', { class: 'acl-set-account__actions' },
          el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', onclick: logout }, tr('setLogout')),
        ),
      )
      : el('div', { class: 'acl-loading-wrap', style: 'padding:16px' }, tr('homeNotLogin')),
  );

  // 微软客户端 ID 卡
  const msInput = el('input', { class: 'acl-input', type: 'text', value: s.msClientId || '', placeholder: tr('setMsIdPlaceholder') });
  const msBtn = el('button', {
    class: 'acl-btn acl-btn--primary acl-btn--small',
    onclick: async () => {
      const v = msInput.value.trim();
      btnLoading(msBtn, true);
      try {
        await saveSettings({ msClientId: v });
        toast('success', tr('setMsSaved'));
      } catch (e) { /* 已 toast */ } finally { btnLoading(msBtn, false); }
    },
  }, tr('setMsSave'));
  const msCard = setCard(tr('setMsTitle'), 'idCard',
    el('div', { class: 'acl-form-row' },
      el('span', { class: 'acl-form-row__label' }, tr('setMsId')),
      el('div', { class: 'acl-form-row__ctrl' }, msInput),
    ),
    el('div', { class: 'acl-form-row' },
      el('span', { class: 'acl-form-row__label' }, ''),
      el('div', { class: 'acl-form-row__ctrl' },
        msBtn,
        el('a', {
          href: 'https://learn.microsoft.com/zh-cn/entra/identity-platform/quickstart-register-app',
          class: 'acl-set-desc',
          onclick: (e) => { e.preventDefault(); api.shell.openExternal(e.currentTarget.href); },
        }, tr('setMsHelp')),
      ),
    ),
  );

  // 离线快捷登录卡
  const offInput = el('input', { class: 'acl-input', type: 'text', placeholder: tr('setOfflineName'), maxlength: 16 });
  const offCard = setCard(tr('setOfflineTitle'), 'user',
    el('div', { class: 'acl-form-row' },
      el('span', { class: 'acl-form-row__label' }, tr('setOfflineName')),
      el('div', { class: 'acl-form-row__ctrl' }, offInput),
    ),
    el('div', { class: 'acl-form-row' },
      el('span', { class: 'acl-form-row__label' }, ''),
      el('div', { class: 'acl-form-row__ctrl' },
        el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', html: `${icon('rocket', 12)}<span>${tr('setOfflineLogin')}</span>`, onclick: offlineLogin }),
      ),
    ),
  );
  /** 离线快捷登录提交 */
  async function offlineLogin() {
    const name = offInput.value.trim();
    if (!name) return toast('warning', tr('offNameEmpty'));
    btnLoading(offCard.querySelector('.acl-btn'), true);
    try {
      const account = await api.auth.offline(name);
      await saveAccount(account);
      toast('success', tr('loginWelcome', { name }));
    } catch (e) { /* 已 toast */ } finally {
      btnLoading(offCard.querySelector('.acl-btn'), false);
    }
  }

  scrollEl.replaceChildren(el('div', { class: 'acl-set-section' }, accCard, msCard, offCard));
}

/** 退出登录（二次确认） */
async function logout() {
  const ok = await confirmDialog({ title: tr('setLogout'), message: tr('setLogoutConfirm'), confirmText: tr('setLogout'), danger: true });
  if (!ok) return;
  await saveAccount(null);
  toast('info', tr('setLogout'));
}

// ===================== 下载 =====================

/** 渲染下载分区（下载源/并发线程/缓存） */
function renderDownload() {
  const s = state.settings;
  const threadVal = el('span', { class: 'acl-set-thread-row__val' }, `${s.maxDownloadThreads}`);
  scrollEl.replaceChildren(el('div', { class: 'acl-set-section' },
    setCard(tr('setDlSource'), 'download',
      el('div', { class: 'acl-radio-cards' },
        radioCard({
          active: s.downloadSource === 'mojang', icon: 'globe', title: tr('dlSourceMojang'), desc: tr('setDlSourceMojangDesc'),
          onclick: () => saveSettings({ downloadSource: 'mojang' }),
        }),
        radioCard({
          active: s.downloadSource === 'bmclapi', icon: 'refresh', title: tr('dlSourceBmclapi'), desc: tr('setDlSourceBmDesc'),
          onclick: () => saveSettings({ downloadSource: 'bmclapi' }),
        }),
      ),
    ),
    setCard(tr('setThreads'), 'list',
      el('div', { class: 'acl-form-row' },
        el('span', { class: 'acl-form-row__label' }, tr('setThreads')),
        el('div', { class: 'acl-form-row__ctrl acl-set-thread-row' },
          createSlider({
            min: 1, max: 16, step: 1, value: s.maxDownloadThreads,
            oninput: (v) => {
              threadVal.textContent = String(v);
              if (threadTimer) clearTimeout(threadTimer);
              threadTimer = setTimeout(() => saveSettings({ maxDownloadThreads: v }), 350);
            },
          }),
          threadVal,
        ),
      ),
    ),
    setCard(tr('setCache'), 'folder',
      el('div', { class: 'acl-form-row' },
        el('span', { class: 'acl-form-row__label' }, tr('setCache')),
        el('div', { class: 'acl-form-row__ctrl' },
          el('button', {
            class: 'acl-btn acl-btn--ghost acl-btn--small',
            html: `${icon('trash', 12)}<span>${tr('setClearCache')}</span>`,
            onclick: clearCache,
          }),
        ),
      ),
      el('div', { class: 'acl-set-desc' }, tr('setCacheDesc')),
    ),
  ));

  /**
   * 清理缓存：确认 → acl.cache.clear() → 按 freedBytes 反馈释放空间。
   */
  async function clearCache() {
    const ok = await confirmDialog({
      title: tr('setClearCache'),
      message: tr('setClearCacheConfirm'),
      confirmText: tr('setClearCache'),
      danger: true,
    });
    if (!ok) return;
    const btn = scrollEl.querySelector('.acl-btn--ghost.acl-btn--small');
    btnLoading(btn, true);
    try {
      const { freedBytes } = await api.cache.clear();
      toast('success', tr('cacheCleared', { size: formatBytes(freedBytes || 0) }));
    } catch (e) { /* 已 toast */ } finally {
      btnLoading(btn, false);
    }
  }
}

// ===================== 数据刷新 =====================

/** 刷新实例列表 */
async function refreshInstances() {
  try {
    state.instances = await api.instances.list();
    emit('instances', state.instances);
  } catch (e) { /* 已 toast */ }
}

/** 检测本机 Java（进入设置页自动执行） */
async function detectJava() {
  try {
    state.java = await api.java.detect();
    emit('java', state.java);
  } catch (e) { /* 已 toast */ }
}
