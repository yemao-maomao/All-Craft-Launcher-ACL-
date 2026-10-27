/**
 * @fileoverview i18n 文案字典模块
 *
 * 职责：集中管理全部界面文案。默认语言 zh_CN（全量完整），en_US 仅占位
 * （当前为空字典，tr() 自动回退到 zh_CN，保证任何语言下界面都可读）。
 * 全部文案为项目原创，禁止出现任何现存启动器的成段文案。
 *
 * 用法：
 *   import { tr, setLang, getLang } from './i18n.js';
 *   tr('homeLaunch')                    // '启动游戏'
 *   tr('homeLaunchAs', { name: '史蒂夫', version: '1.21.4' })
 */

/** 当前界面语言（默认 zh_CN） */
let currentLang = 'zh_CN';

/** 全量文案字典：zh_CN 完整，en_US 为空占位（tr 自动回退） */
const dict = {
  zh_CN: {
    // ===================== 全局通用 =====================
    appName: 'All Craft Launcher',
    navHome: '启动',
    navDownload: '下载',
    navSettings: '设置',
    navAbout: '更多',
    winMin: '最小化',
    winMax: '最大化',
    winRestore: '还原',
    winClose: '关闭',
    confirm: '确定',
    cancel: '取消',
    close: '关闭',
    save: '保存',
    delete: '删除',
    rename: '重命名',
    create: '创建',
    retry: '重试',
    refresh: '刷新',
    loading: '加载中…',
    copied: '已复制到剪贴板',
    comingSoon: '即将支持',
    p1Note: '该功能将在 P1 版本提供',
    levelInfo: '信息',
    levelWarn: '警告',
    levelError: '错误',

    // ===================== 启动页 =====================
    homeNotLogin: '未登录',
    homeLogin: '登录',
    homeMsLogin: '微软账户',
    homeOfflineLogin: '离线模式',
    homeAccTypeOffline: '离线',
    homeAccTypeMs: '微软',
    homeInstance: '游戏实例',
    homeManage: '管理实例',
    homeVersion: '游戏版本',
    homeNoVersion: '未安装任何版本',
    homeGoDownload: '去下载',
    homeMemory: '内存设置',
    homeAutoMemory: '自动分配',
    homeMinMemory: '最小内存',
    homeMaxMemory: '最大内存',
    homeResolution: '游戏分辨率',
    homeLaunch: '启动游戏',
    homeLaunching: '正在启动',
    homeRunning: '运行中',
    homeLaunchAs: '正在以 {name} 启动 {version}',
    homeNeedLogin: '请先登录账户',
    homeNeedVersion: '请先选择游戏版本',
    homeCancelLaunch: '取消启动',
    homeKillSent: '已请求结束游戏，等待游戏进程退出…',
    homeInfoLogin: '登录方式',
    homeInfoMemory: '内存',
    homeInfoJava: 'Java 版本',
    homeInfoDir: '游戏目录',
    homeAutoMemoryVal: '自动分配',
    homeManualMemoryVal: '{min} MB ~ {max} MB',
    homeJavaAuto: '自动检测',
    homeJavaManual: '手动指定',
    homeWelcome: '欢迎使用 All Craft Launcher！一款简洁、开源、轻量的 Minecraft 启动器。',
    homeCardTitle: '欢迎回来',
    homeCardDesc: 'All Craft Launcher 是一款开源轻量的 Minecraft 启动器，开箱即用，随时开始你的方块之旅。',
    homeQuickDownload: '下载游戏版本',
    homeQuickSettings: '打开设置',
    homeQuickAbout: '阅读帮助',
    homeTipTitle: '小贴士',
    homeLogTitle: '启动日志',
    homeAutoScroll: '自动滚动',
    homeCopyLog: '复制日志',
    homeClearLog: '清空日志',
    homeOpenLogDir: '打开日志目录',
    homeClearLogConfirm: '确定清空全部日志吗？',
    homeLogCleared: '日志已清空',
    homeExitNormal: '游戏已退出（代码 {code}）',
    homeExitAbnormal: '游戏异常退出（代码 {code}）',
    homeCrashHint: '崩溃报告可能已生成于实例的 crash-reports 目录',
    homeViewCrash: '查看崩溃报告',
    homeCrashP1: '崩溃报告位于实例目录的 crash-reports 文件夹，打开目录功能将在 P1 版本提供',
    homeEndGame: '结束游戏',
    homeTaskTitle: '后台任务',
    homeLaunchFailed: '启动失败',
    homeSwitchAccount: '切换账户',

    // ===================== 下载页 =====================
    dlVanilla: '原版游戏',
    dlLoader: '模组加载器',
    dlJava: 'Java 运行时',
    dlCommunity: '社区资源',
    dlModpack: '整合包',
    dlMoreSection: '更多内容',
    dlSearch: '搜索版本号…',
    dlAll: '全部',
    dlRelease: '正式版',
    dlSnapshot: '快照',
    dlOld: '远古',
    dlInstalled: '已安装',
    dlSource: '下载源',
    dlSourceMojang: '官方源',
    dlSourceBmclapi: 'BMCLAPI 镜像',
    dlInstall: '安装',
    dlUninstall: '卸载',
    dlLaunch: '启动',
    dlUninstallTitle: '卸载版本',
    dlUninstallConfirm: '确定卸载 {id} 吗？该版本的目录将被删除。',
    dlUninstalled: '已卸载 {id}',
    dlManifestFailed: '版本列表加载失败',
    dlNoMatch: '没有匹配的版本',
    dlClearFilter: '清空筛选',
    dlReleaseTime: '发布于 {time}',
    dlShown: '已显示 {shown} / {total} 个版本',
    dlAllShown: '已加载全部 {total} 个版本',
    dlLoadingMore: '加载更多…',
    dlTypeRelease: '正式版',
    dlTypeSnapshot: '快照',
    dlTypeOld: '远古',
    dlFabricTitle: 'Fabric 加载器',
    dlFabricDesc: '为原版安装 Fabric 加载器后，即可加载海量模组。',
    dlGameVersion: '游戏版本',
    dlLoaderVersion: '加载器版本',
    dlQueryLoaders: '查询加载器版本',
    dlQuerying: '查询中…',
    dlQueryFailed: '加载器版本查询失败',
    dlPickGameFirst: '请先选择游戏版本',
    dlPickLoaderFirst: '请先选择加载器版本',
    dlFabricInstall: '安装 Fabric',
    dlForgeTitle: 'Forge',
    dlForgeDesc: '经典模组加载器，即将支持',
    dlNeoForgeTitle: 'NeoForge',
    dlNeoForgeDesc: 'Forge 的新一代分支，即将支持',
    dlQuiltTitle: 'Quilt',
    dlQuiltDesc: '轻量模组加载器，即将支持',
    dlJavaTitle: 'Java {major}',
    dlJavaDesc8: '适合 1.16.5 及更早的经典版本',
    dlJavaDesc17: '适合 1.18 ~ 1.20.4 的版本',
    dlJavaDesc21: '适合 1.20.5 及以上的现代版本',
    dlJavaDesc25: '适合 26.1 及以上的最新版本',
    dlJavaDetected: '已检测到 {count} 个运行时',
    dlJavaNotDetected: '未检测到',
    dlJavaDownload: '自动下载',
    dlJavaDetectFailed: 'Java 检测失败',
    dlJavaDetecting: '检测中…',
    dlJavaDownloaded: 'Java {major} 运行时已就绪',
    dlManifestEmpty: '版本清单为空',

    // ===================== 设置页 =====================
    setGeneral: '通用',
    setLaunch: '启动',
    setAccount: '账户',
    setDownload: '下载',
    setMore: '更多',
    setLanguage: '界面语言',
    langZh: '简体中文',
    langEn: 'English（占位）',
    setTheme: '界面主题',
    themeLight: '浅色',
    themeDark: '深色',
    themeLightDesc: '明亮通透，适合白天使用',
    themeDarkDesc: '深色护眼，我们的差异化卖点',
    setAccent: '主题色',
    accentBlue: '星空蓝',
    accentOrange: '熔岩橙',
    accentGreen: '草叶绿',
    setHideAfter: '启动游戏后隐藏启动器',
    setHideAfterP1: '启动游戏后自动隐藏启动器窗口（P1 版本提供）',
    setInstanceTitle: '实例管理',
    setNewInstance: '新建实例',
    setCurrent: '设为当前',
    setOpenFolder: '打开文件夹',
    setCurrentBadge: '当前',
    setDefaultBadge: '默认',
    setInstanceName: '实例名称',
    setInstanceRule: '仅允许字母、数字、点、下划线、连字符，长度 1~32，且不能与现有实例重名',
    setCreateInstance: '创建实例',
    setRenameInstance: '重命名实例',
    setDeleteInstanceTitle: '删除实例',
    setDeleteInstanceMsg: '请输入实例名称「{name}」以确认删除。该实例的全部数据将被永久删除！',
    setInstanceCreated: '实例「{name}」已创建',
    setInstanceRenamed: '已重命名',
    setInstanceRemoved: '实例「{name}」已删除',
    setInstanceCurrent: '已切换当前实例为「{name}」',
    setJavaTitle: 'Java 运行时',
    setJavaAuto: '自动选择',
    setJavaManual: '手动指定',
    setJavaManualCurrent: '手动指定：{path}',
    setJavaDownload: '下载运行时',
    setJavaPickHint: '请选择 Java 安装目录（将使用其中的 bin\\java.exe）',
    setJavaSaved: '已设置 Java 路径',
    setJavaNone: '未检测到 Java，可以点击下方按钮下载运行时',
    setJavaDetecting: '检测中…',
    setJavaDetectFailed: 'Java 检测失败',
    setMemoryTitle: '内存设置',
    setMemoryAuto: '自动分配内存',
    setMemoryHint: '关闭自动分配后，可手动指定最小 / 最大内存',
    setAdvancedTitle: '高级设置',
    setJvmArgs: 'JVM 附加参数',
    setJvmArgsPlaceholder: '例如：-Dfile.encoding=UTF-8',
    setResolution: '默认分辨率',
    setAccountTitle: '当前账户',
    setLogout: '退出登录',
    setLogoutConfirm: '确定退出当前账户吗？',
    setMsTitle: '微软账户',
    setMsId: '客户端 ID',
    setMsIdPlaceholder: '粘贴你的 Azure 应用客户端 ID',
    setMsHelp: '如何注册 Azure 应用',
    setMsSave: '保存',
    setMsSaved: '客户端 ID 已保存',
    setOfflineTitle: '离线登录',
    setOfflineName: '昵称',
    setOfflineLogin: '立即登录',
    setDlTitle: '下载设置',
    setDlSource: '下载源',
    setDlSourceMojangDesc: '官方源：稳定可靠，国内网络可能较慢',
    setDlSourceBmDesc: 'BMCLAPI 镜像：国内加速，快照可能有延迟',
    setThreads: '并发线程',
    setCache: '缓存',
    setCacheDesc: '清理版本清单等缓存文件，不影响游戏数据',
    setClearCache: '清理缓存',
    setClearCacheConfirm: '确定清理全部缓存文件吗？（不会影响已安装版本与游戏数据）',
    cacheCleared: '已清理缓存，释放 {size}',

    // ===================== 关于页 =====================
    aboutIntro: '一款开源、轻量的 Minecraft 启动器，Windows 优先。',
    aboutRuntime: '运行时信息',
    aboutPlatform: '平台',
    aboutArch: '架构',
    aboutLicense: '开源协议',
    aboutLicenseName: 'GNU GPL v3.0',
    aboutAck: '灵感致谢',
    aboutAckDesc: '感谢以下开源项目提供的灵感与经验（本项目代码与素材均为原创）',
    aboutRepo: '项目仓库',
    aboutDisclaimerTitle: '免责声明',
    aboutDisclaimer: '本项目与 Mojang Studios、Microsoft 无任何关联，并非官方产品。「Minecraft」是 Mojang Synergies AB 的商标。',

    // ===================== 登录弹窗 =====================
    loginTitle: '登录账户',
    msStep1: '第一步：点击下方按钮，在浏览器中打开微软登录页面',
    msStep2: '第二步：在页面中输入下面这串代码',
    msStep3: '第三步：回到本窗口，等待登录完成',
    msOpenBrowser: '打开浏览器',
    msCopyCode: '点击复制代码',
    msWaiting: '等待授权中',
    msElapsed: '已等待 {sec} 秒',
    msSuccess: '登录成功',
    msRetry: '重新获取代码',
    msNoClientId: '尚未配置微软 OAuth 客户端 ID，请先在设置中完成配置。',
    msGoSettings: '前往设置',
    msLoginError: '登录失败：{msg}',
    offHint: '输入一个昵称，开始你的离线之旅',
    offStart: '开始游戏之旅',
    offNameEmpty: '昵称不能为空',
    randomName: '随机昵称',
    loginWelcome: '欢迎回来，{name}',

    // ===================== 任务面板 =====================
    taskPanelTitle: '下载任务',
    taskNoActive: '暂无进行中的任务',
    taskTotal: '总进度',
    taskDetailTitle: '任务详情',
    taskSpeed: '速度',
    taskRecentLogs: '最近日志',
    taskCancel: '取消任务',
    taskCancelConfirm: '确定取消任务「{name}」吗？',
    taskCancelled: '任务已取消',
    taskSucceed: '任务完成',
    taskFailed: '任务失败',
    taskStatusRunning: '进行中',
    taskStatusDone: '已完成',
    taskStatusFailed: '已失败',
    taskFabsTip: '下载任务',
    fabsTop: '返回顶部',
  },

  /** en_US：占位字典（空），tr() 自动回退 zh_CN，保证界面始终可读 */
  en_US: {},
};

/**
 * 设置当前界面语言（非法值自动回退 zh_CN）。
 * @param {string} lang - 语言标识，如 'zh_CN' / 'en_US'
 */
export function setLang(lang) {
  currentLang = Object.prototype.hasOwnProperty.call(dict, lang) ? lang : 'zh_CN';
}

/**
 * 读取当前界面语言。
 * @returns {string} 语言标识
 */
export function getLang() {
  return currentLang;
}

/**
 * 取文案（当前语言缺失时回退 zh_CN，再缺失时返回 key 本身）。
 * @param {string} key - 文案键
 * @param {Record<string, string|number>} [params] - 占位参数，替换 {name} 形式
 * @returns {string} 文案
 */
export function tr(key, params) {
  let s = dict[currentLang][key] ?? dict.zh_CN[key] ?? key;
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.split(`{${k}}`).join(String(params[k]));
    }
  }
  return s;
}
