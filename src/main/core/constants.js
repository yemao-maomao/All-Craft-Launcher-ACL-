'use strict';

/**
 * @fileoverview 全局常量定义模块
 *
 * 集中管理整个启动器共享的常量：应用元信息、远程 API 地址、下载源标识、
 * 默认配置值与 JVM 参数模板。core 层其余模块统一从这里引用，
 * 避免魔法字符串散落各处，便于维护与查找。
 */

/** 应用显示名称（窗口标题、关于页、品牌展示） */
const APP_NAME = 'All Craft Launcher';

/** 应用内部短标识（目录名、任务名前缀等使用，保持小写无空格） */
const APP_ID = 'acl';

/** 启动器版本号，与 package.json 的 version 字段保持一致 */
const APP_VERSION = '0.0.1';

/** 写入游戏 JVM 参数的启动器品牌名（-Dminecraft.launcher.brand） */
const BRAND_NAME = 'ACL';

// ===================== 下载源 =====================

/** 下载源标识：Mojang 官方源 */
const SOURCE_MOJANG = 'mojang';

/** 下载源标识：BMCLAPI 镜像（国内加速） */
const SOURCE_BMCLAPI = 'bmclapi';

/** 全部支持的下载源列表（用于设置页下拉框与参数校验） */
const DOWNLOAD_SOURCES = [SOURCE_MOJANG, SOURCE_BMCLAPI];

// ===================== 远程 API 地址 =====================

/** Mojang 官方版本清单接口：返回所有游戏版本及其版本 json 的下载地址 */
const MOJANG_VERSION_MANIFEST_URL =
  'https://launchermeta.mojang.com/mc/game/version_manifest.json';

/** Mojang v2 版本清单接口（piston-meta，条目带 sha1，可校验完整性） */
const MOJANG_VERSION_MANIFEST_V2_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

/** Mojang 官方 Java 运行时清单：各平台各 Java 大版本的下载清单入口 */
const MOJANG_JAVA_MANIFEST_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

/** BMCLAPI 镜像站基础地址（官方 URL 到镜像 URL 的映射规则见 util/mirror.js） */
const BMCLAPI_BASE_URL = 'https://bmclapi2.bangbang93.com';

/** Fabric 官方元数据接口基础地址（本机网络不可达时经 BMCLAPI fabric-meta 镜像访问） */
const FABRIC_META_BASE_URL = 'https://meta.fabricmc.net';

// ===================== Java / JVM =====================

/** 「Java 运行时」下载页提供的可选 Java 大版本（Mojang 运行时清单 windows-x64 可用组件） */
const JAVA_MAJORS = [8, 17, 21, 25];

/**
 * 按 Java 大版本划分的默认 JVM 参数模板（不含 -Xms/-Xmx 与启动器品牌参数，
 * 这些由 launch 模块在启动时动态追加）。
 * 模板思路参考社区通行实践：G1 垃圾回收器对 Minecraft 的大堆场景更平稳，
 * 关闭自适应策略减少停顿，关闭 OmitStackTraceInFastThrow 便于排查问题。
 */
const JVM_ARGS_TEMPLATE = {
  /**
   * Java 8（1.8.x，支持 1.7.10~1.16.5 的老版本游戏）。
   * G1 组合 + 收紧内联层级（缓解 1.8 特定卡顿），关闭自适应策略与快速抛异常优化。
   */
  8: [
    '-XX:+UseG1GC',
    '-XX:G1MixedGCCountTarget=5',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50',
    '-XX:G1HeapRegionSize=32m',
    '-XX:-UseAdaptiveSizePolicy',
    '-XX:-OmitStackTraceInFastThrow',
    '-XX:MaxInlineLevel=15',
  ],
  /** Java 9~16（1.17 过渡期版本）：Java 16 起反射访问默认收紧，需显式放行 */
  16: [
    '-XX:+UseG1GC',
    '-XX:-UseAdaptiveSizePolicy',
    '-XX:-OmitStackTraceInFastThrow',
    '--illegal-access=permit',
  ],
  /** Java 17（1.18 ~ 1.20.4） */
  17: [
    '-XX:+UseG1GC',
    '-XX:-UseAdaptiveSizePolicy',
    '-XX:-OmitStackTraceInFastThrow',
  ],
  /** Java 21+（1.20.5+ / 26.1+ 等新版本；24/25 需放行 sun.misc.Unsafe 内存访问） */
  25: [
    '-XX:+UseG1GC',
    '-XX:-UseAdaptiveSizePolicy',
    '-XX:-OmitStackTraceInFastThrow',
    '--sun-misc-unsafe-memory-access=allow',
  ],
};

/**
 * 根据 Java 大版本号取对应的 JVM 参数模板。
 * @param {number} major - Java 大版本号，如 8 / 17 / 21
 * @returns {string[]} JVM 参数数组
 */
function jvmArgsForJavaMajor(major) {
  if (major >= 17) return JVM_ARGS_TEMPLATE[17];
  if (major >= 9) return JVM_ARGS_TEMPLATE[16];
  return JVM_ARGS_TEMPLATE[8];
}

// ===================== 默认配置值 =====================

/** 默认内存配置（单位 MB） */
const DEFAULT_MIN_MEMORY = 512;
const DEFAULT_MAX_MEMORY = 4096;

/** 默认窗口尺寸（像素） */
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 800;

/** 版本清单本地缓存有效期（毫秒，30 分钟） */
const MANIFEST_CACHE_TTL_MS = 30 * 60 * 1000;

/** 网络请求默认超时（毫秒） */
const HTTP_TIMEOUT_MS = 30000;

/** 下载失败自动重试次数 */
const DOWNLOAD_RETRY_TIMES = 3;

/** 单个文件下载的并发分段数（HTTP Range 断点续传用） */
const DOWNLOAD_THREADS = 4;

/** 启动日志与应用日志在内存中的最大保留行数（超出丢弃最旧） */
const MAX_LOG_LINES = 2000;

// ===================== 导出 =====================

module.exports = {
  APP_NAME,
  APP_ID,
  APP_VERSION,
  BRAND_NAME,

  SOURCE_MOJANG,
  SOURCE_BMCLAPI,
  DOWNLOAD_SOURCES,

  MOJANG_VERSION_MANIFEST_URL,
  MOJANG_VERSION_MANIFEST_V2_URL,
  MOJANG_JAVA_MANIFEST_URL,
  BMCLAPI_BASE_URL,
  FABRIC_META_BASE_URL,

  JAVA_MAJORS,
  JVM_ARGS_TEMPLATE,
  jvmArgsForJavaMajor,

  DEFAULT_MIN_MEMORY,
  DEFAULT_MAX_MEMORY,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MANIFEST_CACHE_TTL_MS,
  HTTP_TIMEOUT_MS,
  DOWNLOAD_RETRY_TIMES,
  DOWNLOAD_THREADS,
  MAX_LOG_LINES,
};
