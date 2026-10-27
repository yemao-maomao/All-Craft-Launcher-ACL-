# All Craft Launcher UI 规格（docs/UI-SPEC.md）

> 本文件是 renderer（`src/renderer/**`）实现的**权威设计规格**，由 Team Lead 维护。
> ui-dev 严格按本规格实现；**原创红线见 §10**（布局骨架与信息架构可借鉴 PCL2，文案/图标/配色/命名全部原创）。

## 1. 目标与原则

- 观感目标：**PCL2 面板风**——顶栏一级导航 + 左侧操作面板 + 右侧卡片流、半透明卡片、轻投影、克制动效、精致状态页。
- 技术：原生 HTML/CSS/JS，**零依赖、零构建、零框架**（`<script type="module">` 组织，无 npm 包、无 CDN、无外部字体/图片）。
- 注释：每个文件顶部注释职责、每个函数 JSDoc、关键样式注释，**全部中文注释**。
- 文案：全部自拟（见 §10 红线）；默认语言 zh_CN 完整，i18n 字典结构，en_US 仅占位。

## 2. 技术约束（硬性）

1. 渲染进程**没有任何 Node/Electron 能力**，所有功能经 `window.acl`（见 §9）。
2. 图标一律**手写内联 SVG**（原创线性图标），禁止外链/位图资源。
3. CSS 变量驱动主题（§4），禁止写死颜色到组件。
4. 无边框窗口：主进程已 `frame:false`；标题栏自绘；`-webkit-app-region: drag` 在标题栏，交互元素加 `no-drag`。

## 3. 全局框架

```
┌────────────────────────── 标题栏 44px ──────────────────────────┐
│ [ACL Logo+名称]   [启动] [下载] [设置] [更多]      [─] [□] [×]  │ ← 拖动区
├──────────────┬──────────────────────────────────────────────────┤
│ 左操作面板    │ 右内容区（滚动，卡片流）                            │
│ 280px 固定   │ 页面由顶部导航切换；每页左栏可能替换为子导航         │
└──────────────┴──────────────────────────────────────────────────┘
```
- 标题栏：左侧原创 Logo（内联 SVG：方块拼字 ACL）+「All Craft Launcher」文字；**中部一级导航**（启动/下载/设置/更多 4 项，图标+文字，激活态=主题色胶囊底+白字）；右侧窗口控制按钮（最小化/最大化/关闭，调用 `window.acl.minimize()/maximize()/close()`，最大化图标随 `acl:win-state` 事件切换）。
- 内容区切换：淡入 150ms + 上移 4px 过渡。
- 右下角常驻浮动按钮组：下载任务面板入口（带进行中任务数徽章）、返回顶部。

## 4. 设计令牌（CSS 变量，全部原创色值）

主题色预设（8 级色阶，命名原创，**勿用 PCL 的「龙猫蓝」等名称与精确色值**）：

| 预设 | --accent 主色 | 命名 |
|---|---|---|
| 默认「星空蓝」 | `#3D7BFD` | 蓝 |
| 「熔岩橙」 | `#F5822C` | 橙 |
| 「草叶绿」 | `#2FA66B` | 绿 |

每预设派生 8 级：`--accent-1`（最深文字/按压态）… `--accent-5`（主色）… `--accent-8`（最浅背景）。

浅色主题（默认）：
```
--bg: #E9EDF4（页面背景，可用径向渐变 + 顶部主题色 4% 光晕）
--card: rgba(255,255,255,.86)  + backdrop-filter: blur(8px)
--border: #D9E0EA
--text: #2A3342  --text-2: #6B7787  --text-3: #98A3B3
--danger: #D64545  --warning: #E8A33D  --success: #2FA66B
--shadow: 0 2px 8px rgba(30,41,59,.08)；hover 加深 .14 并 translateY(-1px)
```
深色主题：
```
--bg: #141A24（渐变加深） --card: rgba(30,38,52,.86)
--border: #2C3648 --text: #E8EDF5 --text-2: #97A3B4 --text-3: #5D6B7E
--danger: #FF6B6B --warning: #FFC94D --success: #4CD97B
```
基础：圆角卡片 10px / 控件 7px / 大按钮 12px / 胶囊 999px；字号基准 13px（正文），标题 16–20px，小字 12px；字体栈 `"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif`；动效 150–250ms ease；加载旋转动画 0.8s linear infinite。

## 5. 页面规格

### 5.1 启动页（结构参照 PCL：左面板 + 右卡片流）
**左栏（280px，垂直排列）**：
1. **账号卡片**：圆形头像（首字母，主题色渐变底）+ 昵称 + 类型徽章（`离线`/`微软`，小胶囊）+ 未登录时显示「登录」主按钮 + 两个次级入口「微软账户」「离线模式」；
2. **实例选择**：下拉框 + 右侧「管理」小按钮（弹实例管理对话框）；**版本选择**：下拉框（已安装版本）+ 右侧「下载」小按钮（跳下载页）；
3. **内存**：折叠块「自动分配」开关；关闭时显示 最小/最大 两个滑块+数字输入（MB）；
4. **分辨率**：下拉预设（854×480 / 1280×720 / 1600×900 / 1920×1080）；
5. **大启动按钮**：全宽 56px、主题色渐变（`--accent-5 → --accent-4`）、白字加粗 15px、圆角 12px、hover 上浮 2px + 光晕；文案「启动游戏」+ 小火箭 SVG；未登录/未选版本 → 点击 toast 提示并高亮缺失项；登录后按钮下小字显示 `正在以 <昵称> 启动 <版本>`。
6. **启动进程态**（启动后左栏原位替换，淡入）：旋转加载圈 + 「正在启动」标题 + 版本名 + 渐变进度条（不定长动画）+ 信息表四行（登录方式 / 内存 / Java 版本 / 游戏目录）+ 取消按钮（`acl.launch.kill(pid)`）。游戏退出后自动还原为启动按钮态。

**右栏（滚动，卡片流）**：
1. 可关闭提示条（首次使用欢迎提示：蓝色信息条 + 关闭按钮）；
2. **「主页」卡片**：原创欢迎卡（logo + 一句话简介 + 三个快捷入口按钮：下载版本 / 打开设置 / 阅读帮助(关于页)）+ 小贴士卡（随机一条原创提示，本地数组）；
3. **「启动日志」卡片**（占右栏主要高度）：工具栏（标题 + 自动滚动开关 + 复制 + 清空 + 打开日志目录(禁用态提示 P1)）；日志区等宽字体 12px：`[12:03:45] [信息] ...`，级别着色（info 默认 / warn 黄 / error 红加粗）；来源 `launch` 的行实时追加（订阅 `acl.on('launch-log')`）；游戏退出时输出状态行：正常退出（绿）「游戏已退出（代码 0）」/ 异常（红）「游戏异常退出（代码 N）—— 崩溃报告可能已生成于实例 crash-reports 目录」+ 「查看崩溃报告」按钮（存在文件时）；游戏运行中卡片标题右侧显示绿点「运行中」+「结束游戏」按钮。
4. **任务进度卡片**（有后台任务时出现）：任务名 + 进度条 + 百分比 + 取消按钮（订阅 task-progress/task-done）。

### 5.2 下载页（左子导航 + 右内容）
**左栏（220px 单选列表**，图标+标题+右侧 hover 刷新按钮）：「原版游戏」「模组加载器」「Java 运行时」（v0.0.1 三类；其余灰态占位：社区资源 / 整合包「即将支持」）。
**原版游戏**：
- 工具条：搜索框（按版本号即时过滤）+ 过滤 chips（全部 / 正式版 / 快照 / 远古 / 已安装）+ 下载源切换（下拉：官方 / BMCLAPI）+ 刷新按钮；
- 版本列表卡片流（虚拟化可选，v0.0.1 直接全量渲染）：每行 = 原创方块图标（SVG 色块按类型：正式=草绿、快照=蓝、远古=棕、已安装加绿色小勾角标）+ 版本号 + 类型徽章 + 发布时间 + 右侧操作区：未安装「安装」→ 安装中「进度条+百分比+取消」→ 已安装「启动」（跳启动页并选中）/「卸载」（确认弹窗）；列表底部「加载更多」或滚动分页（每页 50 条，滚动到底自动加载）；
- 状态：加载骨架卡（3 条闪烁占位）/ 空态卡片（「没有匹配的版本」+ 清空筛选按钮）/ 错误态（重试按钮）。
**模组加载器**：
- Fabric 卡片：游戏版本下拉（从已安装/可安装版本列表取）→ 加载器版本下拉（`acl.game.fabricLoaders(gameVersion, {source})`，通道已实现）→ 安装按钮 → 任务进度。
- 其他加载器占位卡（Forge / NeoForge / Quilt：灰态 + 「即将支持」徽章）。
**Java 运行时**：
- 四张卡片（Java 8 / 17 / 21 / 25，按 constants.JAVA_MAJORS）：说明行（适用游戏版本区间，按 CONTRACTS §12.8 表）+ 状态区（本机已检测：列出匹配 runtime 版本与路径；否则「未检测到」）+ 「自动下载」按钮 → 任务进度 → 完成后状态刷新（`acl.java.detect()` 重新调用）。
- 打开页面时自动 `acl.java.detect()` 填充状态。

### 5.3 设置页（左子导航 + 右表单卡片）
**左栏**：「通用」「启动」「账户」「下载」「更多」（更多页 = 关于）。
- **通用**：语言（下拉：简体中文 / English(占位)）、主题（浅色/深色 单选卡）、主题色（三个预设色卡单选，即时预览）、启动行为（P1 灰态行：启动后隐藏启动器）。
- **启动**：
  - 实例管理卡：实例列表（每行：名称 + 默认徽章 + 操作：设为当前/重命名/删除/打开文件夹）+「新建实例」按钮 → 对话框（输入框 + 校验规则提示 + 创建）；
  - Java 卡：自动检测结果列表（radio 选择：版本+路径+来源，含「自动选择」项）+ 「手动指定」按钮（`acl.dialog.selectDir()` → 选目录后校验 java.exe）+「下载运行时」按钮（跳下载页 Java 标签）；检测触发：进入页面自动 `acl.java.detect()`；
  - 内存卡：自动分配开关 + 最小/最大滑块（1024–16384 MB）+ 数字显示；
  - 高级卡：JVM 附加参数文本框（等宽字体，占位符提示示例）、分辨率默认值下拉。
- **账户**：当前账户卡（头像/昵称/类型/「退出登录」按钮）、微软登录卡（客户端 ID 输入框 + 说明文字「如何注册 Azure 应用（链接到 https://learn.microsoft.com/...）」，保存后生效）、离线登录卡（昵称输入 + 立即登录按钮）。
- **下载**：下载源（官方/BMCLAPI 单选 + 说明）、并发线程（滑块 1–16）、缓存清理（按钮 → 清 cache/，toast 反馈）。
- **更多 → 关于**：Logo + 名称 + 版本号（`acl.getInfo()`）+ 运行时信息表（Electron/Node/Chrome）+ 开源协议（GPL-3.0，链接）+ 灵感致谢卡（文字：HMCL / Plain Craft Launcher 2 / Fold Craft Launcher，链接各自 GitHub）+ GitHub 仓库链接 + 免责声明（非 Mojang 官方出品）。

### 5.4 登录弹窗
- 两个标签：「微软账户」「离线模式」。
- 微软：说明三步（1 点击打开浏览器 → 2 输入代码 → 3 回到此窗口等待）；**userCode 大字显示**（等宽、可点击复制）+「打开浏览器」主按钮（`acl.shell.openExternal(verificationUri)`）+ 轮询状态动画（按 interval 循环 `acl.auth.msPoll`，进行中/成功（自动关闭+toast）/失败（错误文案+重试按钮））；clientId 未配置时显示引导（跳到设置-账户）。
- 离线：昵称输入框（默认随机生成一个建议昵称）+「开始游戏之旅」主按钮。

### 5.5 其他弹窗
- 新建实例（输入+校验提示）、重命名实例、删除实例（危险红标题 + 需输入实例名确认 + 红色确认按钮）、卸载版本确认、Java 手动选择、任务详情（进度+速度+日志最近 10 行）。
- 通用：遮罩 rgba(0,0,0,.4) + 弹窗 320–460px 圆角 12px 淡入缩放；Esc/点遮罩关闭；异步提交时按钮 loading 禁用。

## 6. 组件规范（class 前缀 `acl-`，全部原创）

`acl-btn`（primary/ghost/danger/text + small/large + disabled/loading）、`acl-card`（标题栏+可折叠 `acl-card--collapsed`）、`acl-input`、`acl-select`、`acl-switch`、`acl-slider`、`acl-chip`（筛选）、`acl-tag`（徽章：类型/状态）、`acl-progress`（渐变主题色，`--indeterminate` 不定长动画）、`acl-modal`、`acl-toast`（右上角，成功/错误/警告/信息，3s 自动消失）、`acl-empty`（空态：大标题+分隔线+说明+行动按钮）、`acl-loading`（旋转圈）、`acl-skeleton`（骨架屏）、`acl-tooltip`（hover 显示，纯 CSS）、`acl-avatar`（圆形首字母）、`acl-hint`（三色提示条，可关闭）。

## 7. 交互细节

- 所有异步操作：按钮进入 loading/禁用态，完成后 toast 反馈；失败统一错误弹窗/toast（来自 api.js 解包）。
- 日志卡片：自动滚动默认开（`settings.autoScrollLog`），用户上滚时暂停（检测 scrollTop 距底 >40px），回底恢复。
- 任务进度：订阅 `acl.on('task-progress')` 更新对应任务条；`task-done` 成功→绿色完成态 2s 后消失，失败→红色+错误 toast。
- 主题切换：body 挂 `data-theme`，CSS 变量切换 + 200ms 过渡。
- 删除类操作一律二次确认；实例删除输入名称确认。
- 键盘：Esc 关闭弹窗；对话框聚焦首个输入框。

## 8. 文件结构（renderer 目录树，由 ui-dev 创建）

```
src/renderer/
├── index.html            # 唯一入口：标题栏+导航+页面容器+浮动按钮+弹窗层
├── css/
│   ├── base.css          # reset、CSS 变量（两套主题）、字体、滚动条、工具类
│   ├── layout.css        # 标题栏/导航/双栏骨架/浮动按钮
│   ├── components.css    # §6 全部组件
│   └── pages/
│       ├── home.css      # 启动页（左面板/启动按钮/日志卡）
│       ├── download.css  # 下载页（版本列表/Fabric/Java）
│       ├── settings.css  # 设置页（表单/列表）
│       └── about.css     # 关于页
├── js/
│   ├── i18n.js           # 文案字典（zh_CN 全量 + en_US 占位）+ tr(key)
│   ├── api.js            # window.acl 封装：解包 {ok,data}|{ok:false,error}，!ok 抛错+toast
│   ├── state.js          # 全局状态（settings/account/instances/manifest/installed/version 选择）+ 简易发布订阅
│   ├── app.js            # 启动引导：拉 settings→应用主题→渲染导航→路由注册→页面切换
│   ├── components.js     # modal/toast/confirm/骨架屏/进度条 助手函数
│   └── pages/
│       ├── home.js       # 启动页逻辑（含启动进程态、日志流）
│       ├── download.js   # 下载页逻辑（三个标签）
│       ├── settings.js   # 设置页逻辑（含实例/Java/账户）
│       └── about.js      # 关于页逻辑
```
路由：hash 路由（`#/home` 等），`app.js` 统一管理；页面模块导出 `{ render(container), onEnter(), onLeave() }`。

## 9. window.acl API 使用（契约：src/preload/preload.js，勿改）

| 调用 | 返回 data | 说明 |
|---|---|---|
| `acl.getInfo()` | 运行信息 | 关于页 |
| `acl.minimize()/maximize()/close()/isMaximized()` | - | 标题栏按钮 |
| `acl.settings.get()/set(patch)` | settings | patch 深合并 |
| `acl.instances.list()/create(id)/remove(id)/rename(old,new)` | 实例列表/对象 | 实例管理 |
| `acl.auth.offline(name)` | account | 离线登录 |
| `acl.auth.msStart()/msPoll(deviceCode)` | 设备码/轮询结果 | 微软登录 |
| `acl.game.manifest({force,source})` | {latest,versions} | 版本列表（缓存 30min） |
| `acl.game.installed()` | [{id,type?}] | 已安装版本 |
| `acl.game.install(id,{source})` | {taskId} | 安装任务 |
| `acl.game.uninstall(id)` | true | 卸载 |
| `acl.game.installFabric({gameVersion,loaderVersion,source})` | {taskId} | Fabric 安装 |
| `acl.game.fabricLoaders(gameVersion,{source})` | [{loader,intermediary,launcherMeta}] | 已实现 |
| `acl.java.detect()` | [{path,exe,major,version,arch,origin}] | Java 列表 |
| `acl.java.download(major)` | {taskId} | Java 下载任务 |
| `acl.launch.start(opts)` | {pid} | opts={instanceId,versionId,account,memory:{auto,min,max},resolution,extraJvmArgs} |
| `acl.launch.kill(pid)` | boolean | 结束游戏 |
| `acl.log.get()/clear()` | 行数组/true | 应用日志（含启动日志） |
| `acl.dialog.selectDir()` | {path\|null} | 目录选择 |
| `acl.shell.openExternal(url)` | true | 外链 |
| `acl.tasks.cancel(taskId)` | boolean | 取消任务 |
| `acl.on(event, cb) → unsub` | - | 事件订阅 |

事件：`task-progress {taskId,name,done,total,percent,extra}` · `task-done {taskId,ok,error,result}` · `task-log {taskId,level,text,time}` · `app-log {time,level,source,text}` · `launch-log {level,text}` · `launch-exit {code,pid}` · `settings-changed {settings}` · `win-state {maximized}`。

api.js 规范：统一解包函数 `call(channel, args)`；所有调用经它；错误统一 toast（message 原样中文）。

## 10. 原创红线（合规）

**禁止**（来自研究结论）：
- 复制 PCL2/HMCL/FCL 的任何文件内容、成段文案、语言文件字符串、图标/Logo 矢量数据、主题命名（如「龙猫蓝」）、主页预设文案；
- 使用任何现存启动器的截图/位图素材。

**允许**（功能性/结构性层面）：
- 布局骨架：顶栏导航 + 左操作面板 + 右卡片流、卡片折叠、三态（加载/空/内容）、启动进程态原位替换、左栏子导航 + 右区表单、右下角浮动按钮；
- 信息架构：启动/下载/设置/更多 分域、下载页「原版游戏/加载器/Java」分类、设置分组；
- 通用设计语汇：半透明卡片+投影、HSL 主题色阶推导、13px 基准字号、克制动效。

**原创要求**：文案全部自拟（如「星空蓝」「开始游戏之旅」）；图标全部手写 SVG；默认蓝 `#3D7BFD` 与 PCL 的 `#1370F3` 不同值；深浅双主题（暗色是我们的差异化）。

## 11. 验收清单（ui-dev 自查）

- [ ] 四页面 + 登录弹窗 + 各对话框全部实现且中文文案完整
- [ ] 主题切换（浅/深 × 三主题色）即时生效无闪白
- [ ] 无边框窗口交互正常（拖动/最小化/最大化/关闭），窗口控制按钮可用
- [ ] 版本列表能加载真实 manifest（`acl.game.manifest()`），安装按钮触发任务并显示进度、可取消
- [ ] 离线登录 → 账号卡片更新 → 启动按钮可用 → 启动后日志流显示、可结束进程
- [ ] Java 检测列表展示、下载任务进度可见
- [ ] 设置全部落盘（刷新后保留），实例 CRUD 可用
- [ ] 空态/加载态/错误态齐全；toast 与确认弹窗工作
- [ ] 全部文件中文注释；零外部依赖；无任何 PCL 素材
