/**
 * @fileoverview 启动页逻辑（docs/UI-SPEC.md §5.1）
 *
 * 职责：
 *  - 左栏 280px：账号卡片、实例/版本选择、内存折叠块、分辨率、大启动按钮；
 *    启动后左栏原位切换为进程态（旋转加载/绿点 + 不定长进度 + 信息表 + 取消）。
 *  - 右栏卡片流：可关闭欢迎提示条、主页卡片、小贴士、启动日志卡片（实时流）、
 *    后台任务卡片。
 *  - 日志卡片：订阅 launch-log / app-log(launch 来源) 实时追加；
 *    自动滚动支持「用户上滚暂停、回底恢复」（settings.autoScrollLog）；
 *    launch-exit 时输出绿色/红色退出状态行。
 *
 * 页面模块契约：导出 { render(container), onEnter(params), onLeave() }。
 */

import { tr } from '../i18n.js';
import { api } from '../api.js';
import { state, on, emit, saveSettings, setSelectedVersion } from '../state.js';
import {
  el, icon, createLogo, createSwitch, createSelect, createSlider,
  openLoginModal, openInstanceManagerModal, taskMiniRow, taskDetailModal,
  formatTime, levelName, copyText, toast, confirmDialog, btnLoading,
} from '../components.js';

/** 内存折叠块是否收起（页面生命周期内保持用户选择） */
let memCollapsed = false;
/** 内存滑块保存防抖计时器 */
let memTimer = null;
/** 当前展示的小贴士（每次进入页面随机一条） */
let currentTip = null;
/** 日志框「用户上滚暂停」内部标志（滚动位置 >40px 距底即暂停） */
let logPaused = false;
/** 页面订阅的取消函数集合（onLeave 时全部取消） */
const unsubs = [];
/** 页面主要节点引用 */
let panelEl = null;
let rightEl = null;
let logBox = null;

/** 原创小贴士库（本地数组，每次随机一条） */
const TIPS = [
  '星空蓝、熔岩橙、草叶绿 —— 在「设置 → 通用」里可以随时更换主题色。',
  '深色主题是我们的特色，晚上游玩时去「设置 → 通用 → 界面主题」切换试试。',
  '下载速度慢？在「设置 → 下载」把下载源切换为 BMCLAPI 镜像试试。',
  '「自动分配内存」会根据物理内存自动计算最优值，多数情况下比手动设置更省心。',
  '游戏异常退出时，崩溃报告会保存在实例目录的 crash-reports 文件夹里。',
  '在下载页安装好版本后，回到启动页选中它，点击「启动游戏」即可开始游玩。',
  '日志区的文字可以选中复制，工具栏也提供一键复制整段日志。',
  '实例就是独立的游戏目录，多开存档或不同模组组合可以用不同实例隔离开。',
];

/** 分辨率预设（与设置页共用） */
const RESOLUTIONS = [
  { value: '854x480', label: '854 × 480', width: 854, height: 480 },
  { value: '1280x720', label: '1280 × 720', width: 1280, height: 720 },
  { value: '1600x900', label: '1600 × 900', width: 1600, height: 900 },
  { value: '1920x1080', label: '1920 × 1080', width: 1920, height: 1080 },
];

/**
 * 渲染页面骨架（app.js 路由切换时调用）。
 * @param {HTMLElement} container - 页面容器（#acl-main）
 */
export function render(container) {
  panelEl = el('aside', { class: 'acl-panel' });
  rightEl = el('div', { class: 'acl-scroll' });
  container.replaceChildren(el('div', { class: 'acl-page' }, panelEl, rightEl));
  if (!currentTip) currentTip = TIPS[Math.floor(Math.random() * TIPS.length)];
  renderPanel();
  renderRight();
}

/**
 * 页面进入：刷新实例/已安装版本、加载历史日志、订阅事件总线。
 * @param {object} [params] - 路由参数
 */
export function onEnter(params) {
  refreshInstances();
  refreshInstalled();
  loadLogHistory();
  // 订阅事件总线，页面局部响应
  unsubs.push(on('instances', () => renderPanel()));
  unsubs.push(on('installed', () => {
    // 已安装列表变化后，若选中版本被卸载则回退选择
    if (state.selectedVersion && !state.installed.some((v) => v.id === state.selectedVersion)) {
      setSelectedVersion(pickDefaultVersion());
    }
    renderPanel();
  }));
  unsubs.push(on('account', () => renderPanel()));
  unsubs.push(on('settings', () => renderPanel()));
  unsubs.push(on('selected-version', () => renderPanel()));
  unsubs.push(on('launch', () => {
    renderPanel();
    updateLogHead();   // 启动状态变化（启动中 ↔ 运行中）同步日志卡头部
  }));
  unsubs.push(on('launch-exit', () => {
    renderPanel();
    updateLogHead();
  }));
  unsubs.push(on('log-line', (line) => appendLogLineEl(line)));
  unsubs.push(on('log-cleared', () => renderLogBox()));
  unsubs.push(on('task-update', () => renderTaskCard()));
  unsubs.push(on('task-remove', () => renderTaskCard()));
}

/**
 * 页面离开：取消全部事件订阅，清理防抖计时器。
 */
export function onLeave() {
  for (const off of unsubs.splice(0)) off();
  if (memTimer) clearTimeout(memTimer);
  memTimer = null;
  logBox = null;
}

// ===================== 左栏渲染 =====================

/** 渲染左栏（进程态 / 启动态二选一） */
function renderPanel() {
  if (!panelEl) return;
  if (state.launch.status !== 'idle') {
    renderProcPanel();
  } else {
    renderLaunchPanel();
  }
}

/** 渲染启动态左栏 */
function renderLaunchPanel() {
  const acc = state.account;
  panelEl.replaceChildren(
    renderAccountCard(acc),
    renderSelectCard('homeInstance', 'folder',
      createSelect(state.instances.map((i) => ({ value: i.id, label: i.name || i.id })), {
        value: state.settings.instance,
        onchange: (v) => { saveSettings({ instance: v }); },
      }),
      el('button', { class: 'acl-icon-btn', title: tr('homeManage'), html: icon('gear', 14), onclick: () => openInstanceManagerModal() }),
    ),
    renderSelectCard('homeVersion', 'cube',
      createSelect(
        state.installed.length
          ? state.installed.map((v) => ({ value: v.id, label: v.id }))
          : [{ value: '', label: tr('homeNoVersion'), disabled: true }],
        { value: state.selectedVersion || '', onchange: (v) => setSelectedVersion(v) },
      ),
      el('button', { class: 'acl-icon-btn', title: tr('homeGoDownload'), html: icon('download', 14), onclick: () => { location.hash = '#/download'; } }),
    ),
    renderMemoryCard(),
    renderSelectCard('homeResolution', 'gear',
      createSelect(RESOLUTIONS.map((r) => ({ value: r.value, label: r.label })), {
        value: `${state.settings.resolution.width}x${state.settings.resolution.height}`,
        onchange: (v) => {
          const r = RESOLUTIONS.find((x) => x.value === v);
          if (r) saveSettings({ resolution: { width: r.width, height: r.height } });
        },
      }),
    ),
    el('button', { class: 'acl-launch', html: `${icon('rocket', 17)}<span>${tr('homeLaunch')}</span>`, onclick: doLaunch }),
    acc && state.selectedVersion
      ? el('div', { class: 'acl-launch-hint' }, tr('homeLaunchAs', { name: acc.name || '?', version: state.selectedVersion }))
      : null,
  );
}

/**
 * 渲染账号卡片。
 * @param {object|null} acc - 账户对象
 * @returns {HTMLElement} 卡片节点
 */
function renderAccountCard(acc) {
  if (acc) {
    const typeLabel = acc.type === 'msa' ? tr('homeAccTypeMs') : tr('homeAccTypeOffline');
    const tagCls = acc.type === 'msa' ? 'acl-tag--accent' : 'acl-tag--gray';
    return el('div', { class: 'acl-card acl-acc' },
      el('span', { class: 'acl-avatar' }, (acc.name || '?').slice(0, 1).toUpperCase()),
      el('div', { class: 'acl-acc__mid' },
        el('div', { class: 'acl-acc__name' }, acc.name || '?'),
        el('div', { class: 'acl-acc__meta' }, el('span', { class: `acl-tag ${tagCls}` }, typeLabel)),
      ),
      el('button', { class: 'acl-btn acl-btn--text acl-btn--small', title: tr('homeSwitchAccount'), onclick: () => openLoginModal(acc.type === 'msa' ? 'ms' : 'offline') },
        tr('homeSwitchAccount')),
    );
  }
  return el('div', { class: 'acl-card acl-acc acl-acc--empty' },
    el('div', { class: 'acl-acc__top' },
      el('span', { class: 'acl-avatar', html: icon('user', 20) }),
      el('div', { class: 'acl-acc__mid' },
        el('div', { class: 'acl-acc__name' }, tr('homeNotLogin')),
        el('div', { class: 'acl-acc__meta' },
          el('span', { class: 'acl-text-3', style: 'font-size:12px' }, tr('homeNeedLogin'))),
      ),
    ),
    el('button', { class: 'acl-btn acl-btn--primary', html: `${icon('user', 13)}<span>${tr('homeLogin')}</span>`, onclick: () => openLoginModal('ms') }),
    el('div', { class: 'acl-acc__entries' },
      el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', html: `${icon('idCard', 12)}<span>${tr('homeMsLogin')}</span>`, onclick: () => openLoginModal('ms') }),
      el('button', { class: 'acl-btn acl-btn--ghost acl-btn--small', html: `${icon('user', 12)}<span>${tr('homeOfflineLogin')}</span>`, onclick: () => openLoginModal('offline') }),
    ),
  );
}

/**
 * 渲染「标签 + 下拉 + 附加按钮」的选择卡片。
 * @param {string} labelKey - 标签文案键
 * @param {string} ic - 标签图标名
 * @param {HTMLElement} selectWrap - 下拉控件
 * @param {HTMLElement} [extraBtn] - 右侧附加按钮
 * @returns {HTMLElement} 卡片节点
 */
function renderSelectCard(labelKey, ic, selectWrap, extraBtn) {
  const line = el('div', { class: 'acl-home-row__line' }, selectWrap);
  if (extraBtn) line.append(extraBtn);
  return el('div', { class: `acl-card acl-home-row${labelKey === 'homeVersion' ? ' acl-home-row--ver' : ''}` },
    el('div', { class: 'acl-home-row__label', html: `${icon(ic, 14)}<span>${tr(labelKey)}</span>` }),
    line,
  );
}

/** 渲染内存折叠卡 */
function renderMemoryCard() {
  const s = state.settings;
  const body = el('div', { class: 'acl-card__body acl-mem-body' });
  if (!s.autoMemory) {
    const clamp = (v) => Math.max(1024, Math.min(16384, v || 1024));
    const min = clamp(s.minMemory);
    const max = clamp(s.maxMemory);
    body.append(
      memSliderRow('homeMinMemory', 'minMemory', min, max),
      memSliderRow('homeMaxMemory', 'maxMemory', min, max),
    );
  }
  const card = el('div', { class: `acl-card acl-card--collapsible${memCollapsed ? ' acl-card--collapsed' : ''}` },
    el('div', { class: 'acl-card__head', onclick: () => { memCollapsed = !memCollapsed; renderPanel(); } },
      el('span', { html: icon('ram', 15) }),
      tr('homeMemory'),
      createSwitch(s.autoMemory, {
        onchange: (v) => { saveSettings({ autoMemory: v }); },
      }),
      el('span', { class: 'acl-card__chevron', html: icon('chevron', 12) }),
    ),
    body,
  );
  // 开关点击冒泡到头部会触发展开/收起，阻止
  card.querySelector('.acl-switch').addEventListener('click', (e) => e.stopPropagation());
  return card;
}

/**
 * 渲染内存滑块行（含数值显示与防抖保存）。
 * @param {string} labelKey - 文案键
 * @param {'minMemory'|'maxMemory'} key - 设置字段
 * @param {number} min - 当前最小内存
 * @param {number} max - 当前最大内存
 * @returns {HTMLElement}
 */
function memSliderRow(labelKey, key, min, max) {
  const val = key === 'minMemory' ? min : max;
  const valEl = el('span', { class: 'acl-mem-slider-row__val' }, `${val} MB`);
  const slider = createSlider({
    min: 1024, max: 16384, step: 64, value: val,
    oninput: (v) => {
      valEl.textContent = `${v} MB`;
      // 最小/最大互相钳制，避免出现 min > max
      const patch = {};
      if (key === 'minMemory') {
        patch.minMemory = v;
        if (v > max) patch.maxMemory = v;
      } else {
        patch.maxMemory = v;
        if (v < min) patch.minMemory = v;
      }
      if (memTimer) clearTimeout(memTimer);
      memTimer = setTimeout(() => saveSettings(patch), 350);
    },
  });
  return el('div', { class: 'acl-mem-slider-row' },
    el('div', { class: 'acl-mem-slider-row__top' }, el('span', {}, tr(labelKey)), valEl),
    slider,
  );
}

/** 渲染启动进程态左栏（原位替换） */
function renderProcPanel() {
  const l = state.launch;
  const running = l.status === 'running';
  const acc = l.account || state.account;
  const s = state.settings;
  const inst = state.instances.find((i) => i.id === s.instance);
  const rows = [
    [tr('homeInfoLogin'), acc ? `${acc.type === 'msa' ? tr('homeAccTypeMs') : tr('homeAccTypeOffline')}（${acc.name || '?'}）` : '—'],
    [tr('homeInfoMemory'), s.autoMemory ? tr('homeAutoMemoryVal') : tr('homeManualMemoryVal', { min: s.minMemory, max: s.maxMemory })],
    // Java 行：launch:start 返回实际 java 信息（{major,version,exe}）时显示实际版本
    [tr('homeInfoJava'), l.java && l.java.version ? `Java ${l.java.version}` : (s.javaPath ? tr('homeJavaManual') : tr('homeJavaAuto'))],
    [tr('homeInfoDir'), inst ? (inst.name || inst.id) : s.instance],
  ];
  panelEl.replaceChildren(el('div', { class: 'acl-card acl-proc' },
    running
      ? el('span', { class: 'acl-proc__dot' })
      : el('span', { class: 'acl-proc__spinner' }),
    el('div', { class: 'acl-proc__title' },
      running ? el('span', { class: 'acl-proc__dot-inline' }) : null,
      tr(running ? 'homeRunning' : 'homeLaunching'),
    ),
    el('div', { class: 'acl-proc__version' }, l.versionId || ''),
    el('div', { class: 'acl-progress acl-progress--indeterminate' }, el('div', { class: 'acl-progress__bar' })),
    el('div', { class: 'acl-proc-table' },
      rows.map(([k, v]) => el('div', { class: 'acl-proc-table__row' },
        el('span', { class: 'acl-proc-table__k' }, k),
        el('span', { class: 'acl-proc-table__v', title: v }, v))),
    ),
    el('button', { class: 'acl-btn acl-btn--ghost acl-btn--danger', style: 'width:100%', html: `${icon('stop', 13)}<span>${tr('homeCancelLaunch')}</span>`, onclick: killLaunch }),
  ));
}

// ===================== 启动 / 结束游戏 =====================

/** 校验并启动游戏 */
async function doLaunch() {
  const s = state.settings;
  // 未登录 → toast 引导 + 账号卡片抖动高亮
  if (!state.account) {
    toast('warning', tr('homeNeedLogin'));
    shake('.acl-acc');
    return;
  }
  // 未选版本 → toast 引导 + 版本行抖动高亮
  if (!state.selectedVersion) {
    toast('warning', tr('homeNeedVersion'));
    shake('.acl-home-row--ver');
    return;
  }
  const btn = panelEl.querySelector('.acl-launch');
  btnLoading(btn, true);
  try {
    const opts = {
      instanceId: s.instance,
      versionId: state.selectedVersion,
      account: state.account,
      memory: { auto: s.autoMemory, min: s.minMemory, max: s.maxMemory },
      resolution: s.resolution,
      extraJvmArgs: s.extraJvmArgs || undefined,
      javaPath: s.javaPath || undefined,
      source: s.downloadSource,
    };
    // launch:start 现返回 {pid, java:{major,version,exe}}，java 供进程态信息表展示
    const res = await api.launch.start(opts);
    state.launch = {
      status: 'starting', pid: res.pid, java: res.java || null,
      versionId: state.selectedVersion, account: state.account, opts,
    };
    emit('launch', state.launch);
    renderPanel();
    updateLogHead();
  } catch (e) {
    /* 错误已由 api 层 toast */
  } finally {
    btnLoading(btn, false);
  }
}

/** 给选择器元素加抖动高亮（校验失败提示） */
function shake(selector) {
  const node = panelEl.querySelector(selector);
  if (!node) return;
  node.classList.remove('is-invalid');
  void node.offsetWidth; // 强制回流以重启动画
  node.classList.add('is-invalid');
  setTimeout(() => node.classList.remove('is-invalid'), 900);
}

/** 结束游戏（取消启动） */
async function killLaunch() {
  const pid = state.launch.pid;
  if (pid == null) return;
  try {
    await api.launch.kill(pid);
    toast('info', tr('homeKillSent'));
  } catch (e) { /* 已 toast */ }
}

// ===================== 右栏渲染 =====================

/** 渲染右栏卡片流 */
function renderRight() {
  rightEl.replaceChildren();
  // 1. 可关闭欢迎提示条（localStorage 记忆关闭）
  if (!localStorage.getItem('acl.ui.hideWelcome')) {
    rightEl.append(el('div', { class: 'acl-hint acl-hint--info' },
      el('span', { html: icon('info', 15) }),
      el('span', { style: 'flex:1' }, tr('homeWelcome')),
      el('button', { class: 'acl-hint__close', html: icon('winClose', 11), onclick: (e) => { localStorage.setItem('acl.ui.hideWelcome', '1'); e.target.closest('.acl-hint').remove(); } }),
    ));
  }
  // 2. 主页卡片（logo + 简介 + 快捷入口）
  rightEl.append(el('div', { class: 'acl-card acl-home-hero' },
    el('span', { class: 'acl-home-hero__logo', html: createLogo(52) }),
    el('div', { class: 'acl-home-hero__title' }, tr('homeCardTitle')),
    el('div', { class: 'acl-home-hero__desc' }, tr('homeCardDesc')),
    el('div', { class: 'acl-home-hero__actions' },
      el('button', { class: 'acl-btn acl-btn--primary', html: `${icon('download', 13)}<span>${tr('homeQuickDownload')}</span>`, onclick: () => { location.hash = '#/download'; } }),
      el('button', { class: 'acl-btn acl-btn--ghost', html: `${icon('gear', 13)}<span>${tr('homeQuickSettings')}</span>`, onclick: () => { location.hash = '#/settings'; } }),
      el('button', { class: 'acl-btn acl-btn--ghost', html: `${icon('bulb', 13)}<span>${tr('homeQuickAbout')}</span>`, onclick: () => { location.hash = '#/about'; } }),
    ),
  ));
  // 3. 小贴士卡
  rightEl.append(el('div', { class: 'acl-card acl-tip' },
    el('span', { class: 'acl-tip__icon', html: icon('bulb', 15) }),
    el('div', {},
      el('div', { style: 'font-weight:600;margin-bottom:4px' }, tr('homeTipTitle')),
      el('div', { class: 'acl-tip__text' }, currentTip || TIPS[0]),
    ),
  ));
  // 4. 启动日志卡片
  rightEl.append(buildLogCard());
  // 5. 任务卡片（有活动任务时才渲染）
  const tasksBox = el('div', { class: 'acl-home-tasks-slot' });
  rightEl.append(tasksBox);
  renderTaskCard(tasksBox);
}

/** 构建启动日志卡片（含工具栏与日志区） */
function buildLogCard() {
  const box = el('div', { class: 'acl-log__box acl-selectable' });
  logBox = box;

  // 自动滚动开关
  const autoSwitch = createSwitch(state.settings.autoScrollLog, {
    onchange: async (v) => {
      await saveSettings({ autoScrollLog: v });
      if (v) scrollLogToBottom();
    },
  });

  const head = el('div', { class: 'acl-log__head' });
  const card = el('div', { class: 'acl-card acl-log' },
    head,
    el('div', { class: 'acl-log__tools' },
      el('label', { class: 'acl-log__tool-label' }, autoSwitch, tr('homeAutoScroll')),
      el('div', { class: 'acl-log__tool-btns' },
        el('button', { class: 'acl-icon-btn', title: tr('homeCopyLog'), html: icon('copy', 14), onclick: copyLog }),
        el('button', { class: 'acl-icon-btn', title: tr('homeClearLog'), html: icon('trash', 14), onclick: clearLog }),
        el('button', { class: 'acl-icon-btn acl-tooltip', title: tr('homeOpenLogDir'), disabled: true, dataset: { tip: tr('p1Note') }, html: icon('folder', 14) }),
      ),
    ),
    box,
  );

  // 用户上滚暂停自动滚动、回底恢复
  box.addEventListener('scroll', () => {
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
    logPaused = dist > 40;
  });

  renderLogBox();
  updateLogHead();
  return card;
}

/** 更新日志卡头部（运行状态绿点 + 结束游戏按钮） */
function updateLogHead() {
  if (!logBox) return;
  const card = logBox.closest('.acl-log');
  if (!card) return;
  const head = card.querySelector('.acl-log__head');
  head.replaceChildren(
    el('div', { class: 'acl-log__title', html: `${icon('list', 15)}<span>${tr('homeLogTitle')}</span>` }),
    state.launch.status !== 'idle'
      ? el('span', { class: 'acl-log__running' },
        el('span', { class: 'acl-log__running-dot' }),
        tr(state.launch.status === 'running' ? 'homeRunning' : 'homeLaunching'),
      )
      : null,
    el('div', { style: 'margin-left:auto' },
      state.launch.status !== 'idle'
        ? el('button', { class: 'acl-btn acl-btn--danger acl-btn--small', html: `${icon('stop', 12)}<span>${tr('homeEndGame')}</span>`, onclick: killLaunch })
        : null,
    ),
  );
}

/** 全量渲染日志区（初始/清空后） */
function renderLogBox() {
  if (!logBox) return;
  logBox.replaceChildren();
  for (const line of state.logLines) logBox.append(buildLogLineEl(line));
  if (state.settings.autoScrollLog && !logPaused) scrollLogToBottom();
}

/**
 * 构建单个日志行节点。
 * @param {{time:any,level:string,text:string,kind?:string}} line - 日志行
 * @returns {HTMLElement}
 */
function buildLogLineEl(line) {
  const cls = [
    'acl-log-line',
    line.kind === 'exit-ok' ? 'acl-log-line--sys acl-log-line--ok'
      : line.kind === 'exit-fail' ? 'acl-log-line--sys acl-log-line--fail'
        : line.level === 'error' ? 'acl-log-line--error'
          : line.level === 'warn' ? 'acl-log-line--warn' : '',
  ].filter(Boolean).join(' ');
  const node = el('div', { class: cls },
    el('span', { class: 'acl-log-time' }, `[${formatTime(line.time)}]`),
    ' ',
    el('span', { class: 'acl-log-level' }, `[${levelName(line.level)}]`),
    ' ',
    el('span', { class: 'acl-log-text' }, line.text),
  );
  // 异常退出行：附加「查看崩溃报告」按钮（launch-exit 附带 crashReportPath 时就地打开，否则 P1 提示）
  if (line.kind === 'exit-fail') {
    node.append(el('button', {
      class: 'acl-btn acl-btn--ghost acl-btn--small',
      title: state.lastCrashReport || undefined,
      html: `${icon('folder', 11)}<span>${tr('homeViewCrash')}</span>`,
      onclick: () => {
        if (state.lastCrashReport) {
          api.shell.openPath(state.lastCrashReport).catch(() => { /* 打开失败已由 api 层 toast */ });
        } else {
          toast('info', tr('homeCrashP1'));
        }
      },
    }));
  }
  return node;
}

/** 实时追加一行日志（自动滚动受 settings.autoScrollLog 与上滚暂停控制） */
function appendLogLineEl(line) {
  if (!logBox) return;
  logBox.append(buildLogLineEl(line));
  if (state.settings.autoScrollLog && !logPaused) scrollLogToBottom();
}

/** 滚动日志到底部 */
function scrollLogToBottom() {
  if (logBox) logBox.scrollTop = logBox.scrollHeight;
}

/** 复制整段日志 */
async function copyLog() {
  const text = state.logLines
    .map((l) => `[${formatTime(l.time)}] [${levelName(l.level)}] ${l.text}`)
    .join('\n');
  if (!text) return toast('info', tr('homeClearLog'));
  if (await copyText(text)) toast('success', tr('copied'));
}

/** 清空日志（确认后清主进程存储 + 本地缓冲） */
async function clearLog() {
  const ok = await confirmDialog({ title: tr('homeClearLog'), message: tr('homeClearLogConfirm'), danger: true });
  if (!ok) return;
  try {
    await api.log.clear();
  } catch (e) { /* 主进程清空失败不阻断本地清空 */ }
  state.logLines.length = 0;
  renderLogBox();
  toast('success', tr('homeLogCleared'));
}

/** 渲染首页任务卡片（无活动任务时隐藏） */
function renderTaskCard(slotEl) {
  const slot = slotEl || rightEl?.querySelector('.acl-home-tasks-slot');
  if (!slot) return;
  const tasks = [...state.tasks.values()].filter((t) => t.status === 'running');
  if (!tasks.length) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(el('div', { class: 'acl-card' },
    el('div', { class: 'acl-card__bar' },
      el('div', { class: 'acl-card__bar-title', html: `${icon('list', 15)}<span>${tr('homeTaskTitle')}</span>` }),
    ),
    el('div', { class: 'acl-home-tasks' },
      tasks.map((t) => taskMiniRow(t, taskDetailModal)),
    ),
  ));
}

// ===================== 数据刷新 =====================

/** 刷新实例列表（失败静默，保留旧数据） */
async function refreshInstances() {
  try {
    state.instances = await api.instances.list();
    emit('instances', state.instances);
  } catch (e) { /* 已 toast */ }
}

/** 刷新已安装版本列表 */
async function refreshInstalled() {
  try {
    state.installed = await api.game.installed();
    if (!state.selectedVersion || !state.installed.some((v) => v.id === state.selectedVersion)) {
      setSelectedVersion(pickDefaultVersion());
    }
    emit('installed', state.installed);
  } catch (e) { /* 已 toast */ }
}

/** 默认版本选择：优先正式版，其次第一个 */
function pickDefaultVersion() {
  if (!state.installed.length) return null;
  return (state.installed.find((v) => v.type === 'release') || state.installed[0]).id;
}

/** 一次性加载主进程历史启动日志（仅 source==='launch' 的行） */
async function loadLogHistory() {
  if (state.logHistoryLoaded) return;
  state.logHistoryLoaded = true;
  try {
    const lines = await api.log.get();
    if (Array.isArray(lines)) {
      const launchLines = lines
        .filter((l) => l && l.source === 'launch')
        .map((l) => ({ time: l.time, level: l.level || 'info', text: l.text || '' }));
      state.logLines.unshift(...launchLines);
      if (state.logLines.length > 2000) state.logLines.splice(0, state.logLines.length - 2000);
      renderLogBox();
    }
  } catch (e) { /* 历史日志不可用时保持空日志 */ }
}
