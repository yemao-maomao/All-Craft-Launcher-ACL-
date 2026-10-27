# All Craft Launcher 核心模块契约（docs/CONTRACTS.md）

> 本文件是 core 层（`src/main/core/**`）实现的**权威契约**，由 Team Lead 维护。
> core-dev 严格按本契约实现；ipc.js / preload.js / main.js / constants.js 已由 Lead 实现，**不得修改**。
> 发现契约缺陷时：报告 Lead，不要自行修改本文件或其他共享文件。

## 0. 编码规范（强制）

1. **语言**：CommonJS（`'use strict'`），Node ≥ 20 内置模块，**禁止任何 npm 运行时依赖**。
2. **注释**：每个文件顶部有 `@fileoverview` 职责说明；每个导出函数有 JSDoc（参数/返回/异常）；关键算法有行内注释。**全部中文注释**。
3. **原创边界**：禁止复制 `D:\mc\references` 下任何仓库的代码。算法按本契约的规格描述从零实现。
4. **无 electron 依赖**：core 模块不 `require('electron')`。目录信息经 `paths.init()` 注入。
5. **异步**：async/await；进度/日志/取消一律经回调或 tasks.js，禁止散乱全局事件（util/log 除外）。
6. **错误**：抛出带清晰中文 message 的 Error；用户可恢复错误不打印堆栈到应用日志（记 `warn` 级别即可）。

## 1. 架构总览

```
┌─────────────── 渲染进程 (src/renderer, 无 Node 能力) ───────────────┐
│  原生 HTML/CSS/JS  →  window.acl.*  (preload contextBridge 白名单)   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ ipcRenderer.invoke / on
┌──────────────────────────────────▼──────────────────────────────────┐
│ 主进程壳：main.js（窗口/生命周期） + ipc.js（通道注册/事件转发）        │
│  ipc.js 惰性 require core 模块，统一信封 {ok,data}|{ok:false,error}   │
├─────────────────────────────────────────────────────────────────────┤
│ core/（纯 Node，可独立测试）                                          │
│   util/{paths,sha1,log,http,mirror,zip}                              │
│   settings/store · instances · tasks                                 │
│   auth/{offline,microsoft} · download/{downloader,javaapi}           │
│   game/{manifest,version,libraries,assets,install,fabric}            │
│   java · launch/launch                                               │
└─────────────────────────────────────────────────────────────────────┘
        │                              │
   dataRoot（设置/缓存/Java 运行时）    实例目录（versions/libraries/assets/...）
```

## 2. core 目录结构（由 core-dev 创建）

```
src/main/core/
├── constants.js            # 已实现（Lead），勿改
├── util/
│   ├── paths.js            # 数据根/实例目录布局解析
│   ├── sha1.js             # SHA1 工具
│   ├── log.js              # 应用日志（环形缓冲 + EventEmitter）
│   ├── http.js             # 统一网络层（fetch 封装/重试/下载/续传）
│   ├── mirror.js           # 下载源 URL 构造器（mojang / bmclapi）
│   └── zip.js              # 零依赖 ZIP 读取/解压（natives 用）
├── settings/store.js       # 设置持久化（JSON + 原子写 + EventEmitter）
├── instances.js            # 实例（游戏目录）CRUD
├── tasks.js                # 后台任务注册表（进度/取消/完成事件）
├── auth/
│   ├── offline.js          # 离线登录（官方 UUID 算法）
│   └── microsoft.js        # 微软 OAuth 设备码全链路
├── download/
│   ├── downloader.js       # 批量并发下载（复用 http）
│   └── javaapi.js          # Mojang Java 运行时清单 + 下载安装
├── game/
│   ├── manifest.js         # 版本清单抓取/缓存
│   ├── version.js          # 版本 JSON 下载/继承合并/规则匹配
│   ├── libraries.js        # 运行库解析/下载/natives 提取
│   ├── assets.js           # 资源索引/objects 下载（含 legacy）
│   ├── install.js          # 安装编排 + 已安装列表 + 卸载
│   └── fabric.js           # Fabric 加载器安装
├── java.js                 # Java 检测/匹配/下载任务
└── launch/launch.js        # 启动参数组装 + 进程管理
```

## 3. 数据目录布局

```
dataRoot（paths.resolveDataRoot()）
├── settings.json             # 启动器设置
├── instances.json            # 实例清单
├── .acl-cache/               # version_manifest.json、java-runtime.json 等缓存
│                             #   （命名避开 Chromium 的 "Cache" 目录，防 Windows 大小写撞名误删）
├── logs/                     # 启动日志落盘（可选，v0.0.1 内存为主）
├── java/                     # 自动下载的运行时：java/jre-<major>/
└── instances/<id>/           # 每个实例 = 一个标准 .minecraft 目录
    ├── versions/<verId>/<verId>.json  # 合并后的版本 JSON（游戏也读它）
    ├── versions/<verId>/<verId>.jar   # 客户端主 jar（1.13+ 名同 client.jar）
    ├── versions/<verId>/natives/      # 原生库解压目录
    ├── libraries/            # 依赖库（按 Maven 路径）
    ├── assets/indexes/  assets/objects/  assets/virtual/
    ├── resourcepacks/  saves/  mods/  screenshots/  crash-reports/  logs/
```

`paths.init({ appRoot, userDataRoot })` 规则：
- **便携模式**：`appRoot`（exe 所在目录）下存在文件 `.portable` → `dataRoot = appRoot/.acl-data`；
- 否则 `dataRoot = userDataRoot`（`%APPDATA%\AllCraftLauncher`）。
- `ensureLayout()` 幂等创建上述全部目录。

## 4. 统一约定

### 4.1 IPC 信封
所有 `ipcMain.handle` 返回 `{ok:true, data}` 或 `{ok:false, error}`（ipc.js 已实现）。
core 模块自身**直接返回数据或抛错**，不关心信封。

### 4.2 任务机制（tasks.js，长任务必用）
```js
const { createTask, cancel } = require('./tasks');   // 同时是 EventEmitter
const task = createTask({ name: '安装 1.21.4' });     // → { id, name, setProgress, log, getSignal, finish, fail }
task.setProgress({ done: 123, total: 456, extra: '下载运行库 3/40' }); // 进度事件自动节流
task.log('info', '...');                                // → 'log' 事件
task.finish({ stats: {...} });  task.fail(new Error('...'));           // 幂等；→ 'done' 事件
cancel(taskId) → boolean                                     // 触发该任务的 AbortController
```
事件：`progress {taskId,name,done,total,percent,extra}`、`done {taskId,ok,error,result}`、`log {taskId,level,text,time}`。
ipc.js 已把这些事件转发为 `acl:task-progress / acl:task-done / acl:task-log`。

### 4.3 下载源（source ∈ 'mojang' | 'bmclapi'）
URL **不搞通用字符串替换**，由 `util/mirror.js` 按「构造器」方式提供（第 7 节详表）。

### 4.4 应用日志（util/log.js）
EventEmitter；`add(level, source, text)`、`getAll()`、`clear()`；事件 `'line' {time,level,source,text}`；
环形缓冲上限 `constants.MAX_LOG_LINES`。ipc.js 已转发为 `acl:app-log`。启动模块、安装模块等一律经它记录关键日志。

## 5. 模块契约明细

### 5.1 util/paths.js
```js
init({ appRoot, userDataRoot })          // 一次性注入（main.js / smoke.js 调用）
resolveDataRoot() → string               // 便携模式判定见 §3
ensureLayout()                           // 幂等创建 dataRoot 全部目录
dataRoot(); cacheDir(); logsDir(); javaDir(); instancesDir();
settingsFile(); instancesFile();          // 均为绝对路径字符串
instanceDir(id);                          // instances/<id>
instanceVersionsDir(id); instanceLibrariesDir(id); instanceAssetsDir(id);
instanceNativesDir(id, versionId);        // versions/<versionId>/natives
instanceVersionJsonPath(id, versionId);   // versions/<versionId>/<versionId>.json
instanceVersionJarPath(id, versionId);    // versions/<versionId>/<versionId>.jar
```

### 5.2 util/sha1.js
```js
sha1Hex(data: Buffer|string) → string            // 40 位小写十六进制
fileSha1(filePath) → Promise<string>             // 流式计算，供下载校验/跳过判断
```

### 5.3 util/log.js — 见 §4.4。

### 5.4 util/http.js
```js
httpJson(url, opts?) → Promise<object|array>   // GET + JSON 解析；opts:{timeoutMs, headers, signal}
httpText(url, opts?) → Promise<string>
downloadFile(url, destPath, opts?) → Promise<{bytes, fromCache:boolean}>
// opts: { expectedSha1, onProgress({done,total,speedBytesPerSec}), signal, timeoutMs, headers }
probeUrl(url, opts?) → Promise<boolean>         // HEAD（或极小 GET）探测可达性
```
- 统一 User-Agent：`AllCraftLauncher/<APP_VERSION>`；Accept 按用途设置。
- 重试：GET/HEAD 幂等请求失败自动重试 `constants.DOWNLOAD_RETRY_TIMES` 次（指数退避 500ms/2s/5s）。
- `downloadFile`：下载到 `<dest>.part`，支持 HTTP Range 断点续传（已存在 .part 且服务器支持 Range 时续传；不支持则重下）；完成后校验 sha1（有 expectedSha1 且不符 → 删除重下，重试耗尽抛错）；`signal.aborted` → 抛 `AbortError`（message 含「已取消」）。下载完成校验 sha1 时若本地已存在且 sha1 匹配 → 直接返回 fromCache=true（**先查存在再查 .part**）。

### 5.5 util/mirror.js — URL 构造器（见 §7 完整映射表）
```js
versionManifestUrl(source) → string
versionJsonUrl(versionId, source) → string
clientJarUrl(versionId, source) → string          // 1.13+ downloads.client；旧版同样用 /version/<id>/client 构造
assetIndexUrl(assetIndexId, source) → string      // 例 launchermeta 包 → bmclapi /indexes/<id>.json
assetObjectUrl(sha1, source) → string             // resources.download → bmclapi /assets/<h1>/<h2>
libraryUrl(mavenPath, source) → string            // libraries.minecraft.net/<path> → bmclapi /libraries/<path>
fabricMetaUrl(path, source) → string              // meta.fabricmc.net/... → bmclapi /fabric-meta/...
```
未覆盖的官方 URL：source='bmclapi' 时提供 `fallbackCandidates(url)` → [url 官方原样, 可能的 bmclapi 等价物]（按规则表尽力生成）。

### 5.6 settings/store.js
```js
const DEFAULTS = {
  language: 'zh_CN',            // 界面语言
  theme: 'light',               // light | dark
  accent: 'blue',               // 主题色预设：blue | orange | green
  downloadSource: 'mojang',     // mojang | bmclapi（文件与清单共用）
  maxDownloadThreads: 4,        // 1..16
  autoMemory: true,             // 自动分配内存
  minMemory: 512, maxMemory: 4096,   // MB（自定义时生效）
  extraJvmArgs: '',             // 追加 JVM 参数（按空格分词）
  resolution: { width: 854, height: 480 },
  msClientId: '',               // 微软 OAuth 客户端 ID（空 = 未配置，登录时提示）
  javaPath: null,               // 手动指定 java.exe；null = 自动检测
  instance: 'default',          // 当前实例 id
  autoScrollLog: true,
  lastAccount: null,            // {type,name,uuid} 记忆上次账户
};
get() → settings（对象副本；内存缓存 + 文件；文件损坏→备份为 .broken 并回退默认）
set(patch) → settings（深合并、原子写 tmp+rename、emit 'changed' 传完整新 settings）
```
EventEmitter：`'changed' (settings)`。已由 ipc.js 转发为 `acl:settings-changed`。

### 5.7 instances.js
```js
list() → [{ id, name, createdAt, isDefault, dir }]  // dir 为实例目录绝对路径（供「打开文件夹」）
create(id) → instance      // 校验 /^[A-Za-z0-9._-]{1,32}$/、Windows 保留名（CON/PRN/AUX/NUL/COM1..LPT9）拒绝、不重名；创建实例完整目录布局
remove(id) → void          // 默认实例拒绝删除；删除前必须把 settings.instance 回退 'default'；fs.rm recursive
rename(oldId, newId) → instance  // 同 create 校验；改 instances.json + 目录改名；若 oldId 为当前实例同步更新 settings.instance
```
存储：`dataRoot/instances.json` = `{ default:'default', list:[{id,name,createdAt}] }`。

### 5.8 tasks.js — 见 §4.2。

### 5.9 auth/offline.js
```js
offlineLogin(name) → { type:'offline', name, uuid, token:'0', clientToken:'', userType:'legacy', userProperties:[{}] }
```
UUID 算法（与官方一致）：`MD5("OfflinePlayer:" + name)` 取 16 字节 → `bytes[6] = (bytes[6] & 0x0f) | 0x30`、`bytes[8] = (bytes[8] & 0x3f) | 0x80` → 格式化为 8-4-4-4-12 UUID 字符串。空名/纯空白拒绝。

### 5.10 auth/microsoft.js（OAuth 设备码流全链路）
```js
msStart() → { userCode, deviceCode, verificationUri, expiresIn, interval }
msPoll(deviceCode) → { status:'pending'|'ok', account?, error? }
// account = { type:'msa', name, uuid, token, userType:'msa', xuid, clientToken }
```
端点与流程（全部 HTTPS POST，content-type 表单）：
1. `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`
   body: `client_id=<settings.msClientId>&scope=XboxLive.signin offline_access`
   → `{ user_code, device_code, verification_uri, expires_in, interval }`。clientId 为空 → 抛错「请在设置中配置微软 OAuth 客户端 ID」。
2. `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`
   body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=...&device_code=...`
   → 错误码处理：`authorization_pending` → status 'pending'；`slow_down` → pending（外部按 interval+5s 重试）；`expired_token`/超时 → 抛错「登录已过期」。
3. XBL：`https://user.auth.xboxlive.com/user/authenticate`，JSON `{Properties:{AuthMethod:'RPS',SiteName:'user.auth.xboxlive.com',RpsTicket:'d='+accessToken},RelyingParty:'http://auth.xboxlive.com',TokenType:'JWT'}` → `Token`、`DisplayClaims.xui[0].uhs`。
4. XSTS：`https://xsts.auth.xboxlive.com/xsts/authorize`，JSON `{Properties:{SandboxId:'RETAIL',UserTokens:[xblToken]},RelyingParty:'rp://api.minecraftservices.com/',TokenType:'JWT'}` → `Token`、`uhs`。错误 `XErr` 码映射为中文提示：2148916233 无 Xbox 账户 / 2148916235 地区不可用 / 2148916238 未成年账户 / 其余带码提示。
5. MC：`https://api.minecraftservices.com/authentication/login_with_xbox`，JSON `{identityToken:'XBL3.0 x=<uhs>;<xstsToken>'}` → `access_token`。
6. 档案：`GET https://api.minecraftservices.com/minecraft/profile`（Bearer）→ `{ id, name }`（id 去横线为 uuid）。404 → 抛错「该账户未拥有 Minecraft Java 版」。
注：以上域在国内可能不可达，错误信息需提示用户检查网络；v0.0.1 仅实现设备码流。

### 5.11 download/downloader.js
```js
downloadBatch(files, opts) → Promise<{ files: number, bytes: number, fromCache: number }>
// files: [{ url, dest, sha1?, size? }]
// opts: { threads, onFile({url,dest,done,total}), onOverall({done,total}), signal, timeoutMs }
```
内部：并发队列（上限 threads）、单文件走 `http.downloadFile`（含重试）、sha1 校验失败重下（该文件最多重试 DOWNLOAD_RETRY_TIMES 次）。信号取消 → 抛 AbortError。

### 5.12 download/javaapi.js
```js
fetchJavaManifest({force}) → all.json 对象        // 缓存 dataRoot/cache/java-runtime.json，12h TTL
resolveJavaVersion(major, {os,arch}) → { version, manifestUrl, filesUrl }   // 从 all.json 选 windows-x64 对应大版本
downloadJava(major, {onProgress, signal}) → { javaDir, javaExe, major }
```
- 下载方式：平台 manifest 的 `files` 为 `{<sha1>: {type, downloads:{raw:{url,size},lzma:{url,size}}, executable?}}`；
  **逐文件下载 raw 版本**（并发 4-8 线程、断点续传、sha1 校验），`type:'directory'` 建目录、`type:'link'` 忽略（Windows 平台无链接）。
- 目标目录：`dataRoot/java/jre-<major>/`；`javaExe` = 该目录 `bin/java.exe`（不存在则抛错「运行时损坏」）。
- 下载失败重试；官方 raw.url 域不可达时，候选链追加 bmclapi 同路径（`https://bmclapi2.bangbang93.com/java-runtime/...`，以实测为准，未命中则回退官方）。
- 完成即视为「该 major 已就绪」，后续 java.js 检测时把 `dataRoot/java/jre-<major>/bin/java.exe` 纳入结果。

### 5.13 game/manifest.js
```js
fetchManifest({force=false, source}) → { latest:{release,snapshot}, versions:[{id,type,url,releaseTime,sha1?}] }
```
- URL = `mirror.versionManifestUrl(source)`；缓存 `dataRoot/cache/version_manifest.json`（TTL `MANIFEST_CACHE_TTL_MS`；force 忽略缓存）。
- versions 保持官方顺序（新在前）；返回前不裁剪。

### 5.14 game/version.js（正确性核心）
```js
fetchVersionJson(id, {source}) → rawJson         // 由 manifest 条目 url（经 source 映射）下载并缓存到实例 versions/<id>/<id>.json
resolveInheritance(id, rawJson, {source}) → mergedJson
// 递归处理 inheritsFrom：父链同样下载+合并（循环引用检测，深度上限 10）
writeMergedJson(instanceId, id, mergedJson) → void   // 覆盖写 versions/<id>/<id>.json（游戏启动与后续安装都以它为准）
matchRule(rules, osInfo) → boolean
classifierForLib(lib, osInfo) → classifierObject|null
extractExcludes(lib) → string[]                    // lib.extract.exclude，默认 ['META-INF/']
```
**继承合并规则**（按官方语义实现）：
- `libraries`：父在前、子追加在后（保持 json 声明顺序）；不按 name 去重（不同来源同 name 的库规则不同，全部保留）。
- `arguments.jvm/game`：父与子都是数组时——子数组中的【字符串条目】按占位符前缀合并（同占位符名的用子的值）；【对象条目】直接追加到父之后。无父则直接用子的。
- `minecraftArguments`（≤1.6 字符串形式）：子有则用子的，否则用父的。
- 其他字段浅合并：`assetIndex`、`mainClass`、`downloads`（client/server/mappings 等）、`javaVersion`、`minimumLauncherVersion`、`logging`：**子优先，父补缺**。
- 合并结果中 `id` 保持子版本 id；`jar`（旧版）与 `downloads.client` 逻辑见 install。
- `osInfo` = `{ name:'windows', version:'10.0', arch:'x64'|'arm64' }`（version 来自 `os.release()`，arch 来自 `process.arch` 映射：x64→'x64'，arm64→'arm64'）。
- `matchRule`：无 rules → true；找到首个匹配的 `allow` → true；找到首个匹配的 `disallow` → false；都不匹配且存在 disallow → true；都不匹配且只有 allow → false。os 匹配：`name` 省略=任意；`version` 为正则（匹配 os.version）；`arch` 匹配（'x86' 匹配 x64 进程也视为 x86 兼容？**不**：严格相等即可）；features：`has_custom_resolution`（启动器传了分辨率时视为 true）、`is_demo_user`。
- natives 选择：`lib.natives['windows']` 存在 → 若 `lib.natives['windows-arm64']` 存在且 arch=arm64 用后者；其余情况用 'windows'。返回 `lib.downloads.classifiers[key]`。

### 5.15 game/libraries.js
```js
listLibraries(mergedJson, {osInfo, source}) → libs[]
// libs[]: { name, url, dest(绝对路径), sha1?, size?, isNative, classifier?, extractExclude[] }
// 规则不匹配的库过滤掉；native 库取 classifier 条目（见 5.14）
downloadLibraries(instanceId, libs, {onProgress, signal, threads}) → {files, bytes, fromCache}
extractNatives(instanceId, versionId, libs) → nativesDir
// 仅解压 isNative 的 jar：用 util/zip.js，排除 extractExclude 前缀；解压到 instanceNativesDir
```
- library 落盘路径：`instanceLibrariesDir/<maven 路径>`（path 字段直接给出）。
- 1.13+ 特殊文件：`downloads.client_mappings` 下载到 `versions/<id>/<id>.mappings.txt`（**启动时是否需要合并映射见 §8.5，以 Lead 后续研究报告结论为准，先按「下载保留、classpath 用 client.jar」实现，留 merge 扩展点**）。

### 5.16 game/assets.js
```js
fetchAssetIndex(mergedJson, {source}) → { id, objects: { '<path>': {hash,size} } }
// 下载 merged.assetIndex.url（经 source 映射）→ 存 instanceAssetsDir/indexes/<id>.json
downloadAssets(instanceId, index, {onProgress, signal, threads}) → {files, bytes, fromCache}
// objects 逐条：url = mirror.assetObjectUrl(hash, source)；dest = instanceAssetsDir/objects/<h1>/<h2>；sha1 校验/跳过
// legacy（index 带 virtual:true，如 'legacy'/'pre-1.6'）：额外把 objects 复制到 instanceAssetsDir/virtual/<indexId>/<path>
```

### 5.17 game/install.js
```js
createInstallTask(versionId, {source}) → { taskId }   // 内部 createTask，异步执行整个流程
listInstalled() → [{ id, type? }]                     // 扫描当前实例 versions/*/<id>.json（id==目录名）且存在 <id>.jar
uninstall(versionId) → void                           // 删除 versions/<versionId>/ 整个目录（assets/libraries 保留共享）
```
安装流程（每阶段 `task.setProgress` + `task.log`）：
1. `paths.ensureLayout()` + 实例目录确保存在；
2. `manifest.fetchManifest({source})` → 找 versionId（找不到抛「版本不存在」）；
3. `version.fetchVersionJson` → `resolveInheritance`（父链递归下载）→ `writeMergedJson`；
4. 下载客户端主 jar：1.13+ 用 `downloads.client`（经 source 映射，fallback `mirror.clientJarUrl(id, source)`），旧版用 `downloads.client`/`jar` 字段；落盘 `versions/<id>/<id>.jar`（sha1 校验）；
5. 下载 client_mappings（存在时）→ `<id>.mappings.txt`；下载 logging 配置（`downloads.client` 之外如有 `logging.client.file` → `versions/<id>/log_configs/`）；
6. `libraries.listLibraries + downloadLibraries`；
7. `assets.fetchAssetIndex + downloadAssets`（旧版无 assetIndex 字段则跳过并 log 提示）；
8. `task.finish({ versionId, files, bytes, fromCache })`。任何一步失败 → `task.fail`（保留半成品供续传，listInstalled 以「json 与 jar 都存在」为准）。

### 5.18 game/fabric.js
```js
fetchFabricLoaders(gameVersion, {source}) → [{ loader:{version}, intermediary:{version}, launcherMeta:{version} }]
// GET <fabricMetaUrl>/v2/versions/loader/<gameVersion>（source 决定域名；bmclapi 走 /fabric-meta/v2/...）
createInstallTask({gameVersion, loaderVersion, source}) → { taskId }
```
安装流程：下载 profile JSON `<meta>/v2/versions/loader/<gameVersion>/<loaderVersion>/profile/json` → 该 JSON 即完整 version json（`id` 形如 `fabric-loader-<loader>-<game>`，含 inheritsFrom、libraries、mainClass=`net.fabricmc.loader.impl.launch.knot.KnotClient`）→ 落盘 `versions/<id>/<id>.json` → 若原版未安装，先安装原版（复用 install 流程）→ 下载 profile 中新增 libraries（fabric maven 坐标，`maven.fabricmc.net` → bmclapi 映射 `https://bmclapi2.bangbang93.com/maven/<path>`）。
- 官方 meta.fabricmc.net 与 maven.fabricmc.net 在国内不可达 → 默认 source 由调用方传 'bmclapi'；source='mojang' 时也允许候选链回退 bmclapi。

### 5.19 java.js
```js
detect() → [{ path(目录), exe(java.exe), major, version('21.0.3'...), arch, origin }]
createDownloadTask(major) → { taskId }    // 任务完成 result = { javaDir, javaExe, major }
bestJavaFor(major) → java 对象 | null      // 精确 major 优先；否则最近的更高 major
requiredJavaMajor(versionJson) → number   // javaVersion.majorVersion 存在则用之；否则按版本号区间表
```
- 检测来源：`JAVA_HOME`；`PATH`（`where java`）；注册表 `reg query`（HKLM/HKCU 的 `SOFTWARE\JavaSoft\{Java Runtime Environment,JDK}`、`SOFTWARE\Eclipse Adoptium\JDK`、`SOFTWARE\Microsoft\JDK`、`SOFTWARE\Azul Systems\Zulu` 及 WOW6432Node 同名路径）；常见目录扫描 `C:\Program Files\Java`、`...\Eclipse Adoptium`、`...\Microsoft`、`...\Zulu`、`C:\Program Files (x86)\Java`（仅列一层）；最后并入 `dataRoot/java/jre-*/bin/java.exe`。按 exe 路径去重。
- 版本解析：spawn `<java> -version` 读 stderr 首行，正则取 `"(\d+)\.(\d+)(\.(\d+))?` 与 `"1.8.0_xxx"` 兼容（1.8 → major 8）。失败 → major 未知，不进入候选列表但保留 origin 供 UI 展示。
- **版本区间表**（versionId 数字段比较）：
  | 游戏版本 | Java |
  |---|---|
  | ≤ 1.16.5（含远古/快照） | 8 |
  | 1.17 ~ 1.17.1 | 16 |
  | 1.18 ~ 1.20.4 | 17 |
  | ≥ 1.20.5 | 21 |
  | version json 有 javaVersion.majorVersion | 以该字段为准 |
- 版本比较：自实现 `compareVersions(a,b)`（按 `.` 分段数字比较，处理 '1.8' vs '1.8.9' vs '1.17.1-pre1'：忽略后缀段）。

### 5.20 launch/launch.js（正确性核心）
```js
start(opts, { onLine, onExit }) → Promise<{ pid, kill() }>
// opts: { instanceId, versionId, account, javaPath?, memory:{auto,min,max},
//         resolution:{width,height}, extraJvmArgs?, source? }
// onLine({level:'info'|'error', text}), onExit({code, pid})
kill(pid) → boolean          // taskkill /PID <pid> /T /F（进程树）
```
组装顺序（每步 log 到 util/log）：
1. 读 `versions/<id>/<id>.json`（merged）；不存在 → 抛「请先安装该版本」；
2. Java：`opts.javaPath` 优先，否则 `bestJavaFor(requiredJavaMajor(json))`；无 → 抛「未找到 Java X，请在设置中选择或下载」；
3. classpath：`listLibraries` 解析出的本地文件路径（按 json 声明顺序）+ `versions/<id>/<id>.jar` **在最后**；Windows 分隔符 `;`；
4. natives：`instanceNativesDir` 不存在或空 → 现场 `extractNatives`；
5. JVM 参数 = `jvmArgsForJavaMajor(major)` + `-Xms<min>M -Xmx<max>M` + `-Djava.library.path=<natives>` + `-Dminecraft.launcher.brand=<BRAND_NAME>` + `-Dminecraft.launcher.version=<APP_VERSION>` + `-cp <classpath>` + extraJvmArgs 分词；**官方 arguments.jvm 数组**（如存在）：逐条处理——对象条目按 `matchRule` 过滤，字符串条目替换占位符后追加；
6. mainClass = json.mainClass（无则 `net.minecraft.client.main.Main`）；
7. game 参数：`arguments.game` 数组（对象按规则过滤、字符串替换占位符）或旧版 `minecraftArguments` 按空格分词后替换；
8. 占位符替换表：
   `${auth_player_name}`=account.name、`${auth_uuid}`=account.uuid、`${auth_access_token}`=account.token、
   `${version_name}`=versionId、`${game_directory}`=instanceDir、`${assets_root}`=instanceAssetsDir、
   `${assets_index_name}`=json.assetIndex.id、`${game_assets}`=legacy 时为 `assets/virtual/<indexId>` 否则 assetsRoot、
   `${user_type}`=account.userType、`${version_type}`=manifest 类型（release/snapshot/old）、
   `${user_properties}`=JSON.stringify(account.userProperties||[{}])、`${auth_session}`=token（旧版）、`${clientid}`=''、`${auth_xuid}`=account.xuid||''、
   `${resolution_width}/${resolution_height}`、`${natives_directory}`（jvm 用）、`${classpath}`（jvm 用）、`${launcher_name}/${launcher_version}`（jvm 用，替换为 BRAND_NAME/APP_VERSION）、`${library_directory}`=libraries 目录。
9. spawn：`javaExe`、args、`cwd=instanceDir`、`stdio:['ignore','pipe','pipe']`、`windowsHide:false`；stdout → onLine('info')，stderr → onLine('error')；逐行（按 \r?\n 切分缓存半行）；`error` 事件 → 抛「Java 启动失败：<message>」；`close` → onExit({code}) 并 log；
10. 内存自动分配算法（FCL 同款）：`ram = os.totalmem()/1MB`；预留 384MB；`max = ram<=8G ? ram*0.8 : 8G*0.8+(ram-8G)*0.2`；上限 16G、下限 1024MB；`min = Math.min(512, max)`。
11. 崩溃报告：exit code ≠ 0 且 `crash-reports/crash-<time>-<...>.txt` 最新文件存在 → appLog warn「游戏崩溃，报告：<path>」。

### 5.21 util/zip.js（零依赖 ZIP 读取）
```js
readZipEntries(filePath) → [{ name, isDirectory, size, compressedSize, readData(): Buffer }]
extractZip(filePath, destDir, { filter?, excludePrefixes? }) → string[]  // 已解压文件绝对路径列表
```
- 依据 PKZIP APPNOTE 手写解析：定位 EOCD（末尾 65557 字节内搜索签名 0x06054b50）→ 读 central directory（0x02014b50）→ 逐条 local header（0x04034b50）。
- 压缩方法：0=stored 直接读；8=deflate 用 `zlib.inflateRawSync`。
- 安全：条目名拒绝绝对路径与 `..` 穿越；目录自动创建；覆盖写。
- 仅用于 natives 解压，无需支持 zip64/加密（遇到抛清晰错误）。

### 5.22 scripts/smoke.js（CLI 冒烟，core-dev 实现）
```bash
node scripts/smoke.js help                          # 用法
node scripts/smoke.js manifest [--force]            # 拉版本清单，打印 latest 与前 5 条
node scripts/smoke.js version <id>                  # 下载+合并版本 JSON，打印合并摘要
node scripts/smoke.js install <id>                  # 完整安装到 .smoke-data（进度输出）
node scripts/smoke.js java-detect                   # 打印检测结果表
node scripts/smoke.js java-download <major>         # 自动下载运行时（8/17/21）
node scripts/smoke.js fabric-loaders <gameVersion>  # 打印 loader 列表
node scripts/smoke.js launch-test <versionId> [playerName]  # 离线账号+自动 Java 启动，流式日志，60s 后 kill
```
- 初始化：`paths.init({ appRoot: 仓库根, userDataRoot: <仓库>/.smoke-data/appdata })`；下载源默认 mojang，`SMOKE_SOURCE=bmclapi` 环境变量覆盖。
- 进度输出：每文件级别太吵 → 汇总每秒一行 `[12.3%] 34.5 MB/s 已下载 12/40 文件`。

## 6. IPC 通道表（对照 ipc.js / preload.js，已实现）

| 通道 | 入参 | 返回 data |
|---|---|---|
| app:info | - | {name,version,electron,chrome,node,platform,arch} |
| win:minimize / win:maximize / win:close | - | true |
| win:is-maximized | - | boolean |
| settings:get / settings:set | patch | settings 对象 |
| instances:list / create / remove / rename | id... | 实例数组 / 实例对象 |
| auth:offline | name | account |
| auth:ms-start | - | {userCode,deviceCode,verificationUri,expiresIn,interval} |
| auth:ms-poll | deviceCode | {status,account?,error?} |
| game:manifest | {force,source} | {latest,versions} |
| game:installed | - | [{id,type?}] |
| game:install | versionId,{source} | {taskId} |
| game:uninstall | versionId | true |
| game:install-fabric | {gameVersion,loaderVersion,source} | {taskId} |
| game:fabric-loaders | gameVersion,{source} | [{loader,intermediary,launcherMeta}] |
| java:detect | - | [{path,exe,major,version,arch,origin}] |
| java:download | major | {taskId} |
| launch:start | opts | {pid} |
| launch:kill | pid | boolean |
| log:get / log:clear | - | 行数组 / true |
| dialog:select-dir | - | {path\|null} |
| shell:open-external | url | true |
| shell:open-path | 绝对路径 | true（资源管理器中打开文件夹/文件） |
| app:clear-cache | - | {freedBytes} |
| tasks:cancel | taskId | boolean |

事件：`acl:task-progress` `acl:task-done` `acl:task-log` `acl:app-log` `acl:launch-log` `acl:launch-exit` `acl:settings-changed` `acl:win-state`。

## 7. 下载源 URL 构造表（mirror.js）

| 用途 | mojang（官方） | bmclapi（镜像） |
|---|---|---|
| 版本清单 | `https://launchermeta.mojang.com/mc/game/version_manifest.json` | `https://bmclapi2.bangbang93.com/mc/game/version_manifest.json` |
| 版本 JSON | manifest 条目 url（launchermeta/piston-meta 包地址） | `https://bmclapi2.bangbang93.com/version/<id>/json` |
| 客户端 jar | version json `downloads.client.url`（piston-data/launcher.mojang.com objects） | `https://bmclapi2.bangbang93.com/version/<id>/client` |
| 资源索引 | `launchermeta.mojang.com/v1/packages/<hash>/<id>.json`（json.assetIndex.url） | 同路径 host 替换（实测 200；`/indexes/<id>.json` 实测 404 不可用） |
| 资源对象 | `https://resources.download.minecraft.net/<h1>/<h2>` | `https://bmclapi2.bangbang93.com/assets/<h1>/<h2>` |
| 依赖库 | `https://libraries.minecraft.net/<path>`（lib.path） | `https://bmclapi2.bangbang93.com/libraries/<path>` |
| Maven（Forge/Fabric 等） | `https://maven.fabricmc.net/<path>` 等 | `https://bmclapi2.bangbang93.com/maven/<path>` |
| Fabric 元数据 | `https://meta.fabricmc.net/v2/...` | `https://bmclapi2.bangbang93.com/fabric-meta/v2/...` |
| Java 运行时 | Mojang java-runtime 清单 raw.url（piston-data） | 候选链追加 `https://bmclapi2.bangbang93.com/java-runtime/...`（实测为准） |

以实测为准：core-dev 在 smoke 中验证每条镜像路径可用性并修正。

## 8. 关键正确性要点（Checklist）

8.1 **版本 JSON 继承**：合并结果必须落盘 `versions/<id>/<id>.json`（游戏与后续启动读它）；父链递归下载。
8.2 **规则匹配**：os.name 省略=任意；version 是正则；arch 严格相等；features 两项。
8.3 **natives**：classifier 按平台；解压到 `versions/<id>/natives`；排除 META-INF；`-Djava.library.path` 指向它。
8.4 **classpath 顺序**：libraries 按声明顺序 + 版本 jar 最后；Windows `;` 分隔。
8.5 **1.13+ client_mappings（研究报告已定论）**：原版启动**只需** `downloads.client` 落为 `<id>.jar`；`client_mappings`（client.txt）仅供 Forge/NeoForge 安装器 processor 使用——**原版安装不下载、启动不合并**（把 mappings 合进 jar 反而破坏游戏）。等未来支持 Forge 时再按需下载。
8.6 **legacy assets**：index 带 `virtual:true` → 复制到 `assets/virtual/<indexId>/`，`${game_assets}` 指向它。
8.7 **离线 UUID**：MD5("OfflinePlayer:"+name) + RFC4122 v3 位修正。
8.8 **JVM 参数**：模板按 major；内存算法见 5.20-10；`-Dminecraft.launcher.brand/version` 必带。
8.9 **占位符**：全表见 5.20-8；未知占位符原样保留。
8.10 **取消/中断**：所有长任务响应 AbortSignal，取消抛「已取消」而非崩溃。
8.11 **断点续传**：.part + Range；完成后 rename；sha1 校验失败重下。
8.12 **MS OAuth**：XErr 码中文映射；authorization_pending 不是错误。

## 9. 验收标准（core-dev 自查）

- [ ] `node scripts/smoke.js manifest` 成功打印 latest 与版本条目
- [ ] `node scripts/smoke.js version 1.21.4`（或任一当前 release）合并 JSON 结构正确（libraries/arguments/assetIndex/downloads 存在）
- [ ] `node scripts/smoke.js java-detect` 可运行（本机无 Java 时应输出空或提示）
- [ ] 所有模块文件存在且 `node -e "require('./src/main/core/xxx')"` 不报语法错
- [ ] 全仓库无 `require('electron')`（core 内）
- [ ] 全部文件中文注释齐全

---

## 12. 研究报告结论补丁（HMCL 源码 + 线上实测，2026-10-28）

> 本节依据「Minecraft 启动技术规格」研究报告（HMCLCore 源码研读 + Mojang/BMCLAPI/Fabric 接口实测）整理。
> **与上文任何表述冲突时，以本节为准。**

### 12.1 版本 JSON
- 官方 release 恒无 `inheritsFrom`（第三方/模组实例才有）。合并语义：子覆盖父；`arguments` 父在前子在后拼接；`libraries` 拼接后按 `group:artifact` 去重（同规则取高版本）；`mainClass/assetIndex/downloads/logging` 子优先；`minimumLauncherVersion` 取最大（**它是启动器版本号，不是 Java 版本**）。
- `assetIndex` 缺省兜底：json 无 `assetIndex` 时按 `assets` 键名查硬编码表 → `https://launchermeta.mojang.com/v1/packages/<sha1>/<id>.json`。把常用映射（legacy / pre-1.6 / 1.7.3 / 1.7.4 / 1.7.10 等）内置进 assets.js。
- TLauncher 等第三方 json 字段残缺（`classifies` 拼写错误、无 `downloads`）：解析必须宽容，缺失字段给默认值而非抛错。

### 12.2 JVM 参数组装（权威顺序）
1. `-Dfile.encoding=<系统编码>`（`os` 无系统编码概念，Windows 用 `GBK`/`UTF-8` 探测，默认 UTF-8）。
2. Log4j 安全组（防 RCE，历史漏洞缓解）：`-Djava.rmi.server.useCodebaseOnly=true`、`-Dcom.sun.jndi.rmi.object.trustURLCodebase=false`、`-Dcom.sun.jndi.cosnaming.object.trustURLCodebase=false`、`-Dlog4j2.formatMsgNoLookups=true`。
3. Windows 专属：`-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump`、`-Dos.name=Windows 10`、`-Dos.version=10.0`。
4. 内存：`-Xms<min>M -Xmx<max>M`；Java<8 加 `-XX:PermSize=128M`；Java≥8 加 `-XX:MetaspaceSize=256M`。
5. GC 模板：`jvmArgsForJavaMajor(major)`；**若 extraJvmArgs 含 `-XX:+Use*GC` 则跳过模板中的 GC 相关项**（避免冲突）。
6. 64 位且 maxMemory>4096：追加 `-XX:ReservedCodeCacheSize=400M`；32 位 Java：追加 `-Xss 1m`。
7. 品牌：`-Dminecraft.launcher.brand=<BRAND_NAME>`、`-Dminecraft.launcher.version=<APP_VERSION>`、`-Dminecraft.client.jar=<版本 jar 绝对路径>`、`-Dfml.ignoreInvalidMinecraftCertificates=true`、`-Dfml.ignorePatchDiscrepancies=true`、`-Djava.net.useSystemProxies=true`。
8. json `arguments.jvm`（对象条目按规则过滤、字符串条目替换占位符；`-Xincgc` 在 Java9+ 剔除）。
9. `-Djava.library.path=<natives>`、`-cp <classpath>`、extraJvmArgs（用户自定义靠后，覆盖默认）。

### 12.3 游戏参数占位符补充
- `${auth_uuid}` 必须 **32 位无连字符**；`${auth_session}` 与 `${auth_access_token}` 均为 accessToken（离线用 `'0'`）；`${user_properties}` 空值传 `{}`；`${version_type}` 用 json `type`；`${profile_name}` = `Minecraft`。
- 1.19.1+ 新增 `${clientid}` 与 `${auth_xuid}`：微软登录时传 settings.msClientId 与 account.xuid；离线/未配置时传 `'0'`。
- 未映射的占位符**原样保留**。
- 旧版 `minecraftArguments` 与新版 `arguments.game` 同时存在时**都追加**。

### 12.4 natives 修正
- 目录命名：`versions/<id>/natives-<platform>`，platform = `windows-x86_64` / `windows-arm64`。
- classifier 描述符选择顺序：依次尝试 `natives-windows`、`natives-windows-64`、`natives-windows-x86_64`、`natives-windows-arm64`（os[-arch|-位数] 组合，取第一个存在于 downloads.classifiers 的）。
- 解压过滤：`extract.exclude` + 固定排除 `.sha1`、`.git`。

### 12.5 启动环境变量（Windows 必须）
- **`APPDATA` 重设为游戏目录的父目录**（否则老版本把存档写进系统 AppData）。
- 附加 `INST_NAME`、`INST_ID`、`INST_DIR`、`INST_MC_DIR`、`INST_JAVA`（模组生态读取）。

### 12.6 资源文件修正
- assetIndex 下载：**仅当 URL 本身含 sha1 才做 SHA-1 校验**，否则只要求 JSON 可解析（官方索引 sha1 可能过期）。
- legacy/virtual（索引 `virtual:true` 或 `map_to_resources:true`）：启动前重建 `assets/virtual/<assetId>/<name>` 树（`map_to_resources` 再复制到 `<gameDir>/resources/`）；重建前完整性检查——已存在对象数 ×10 < 总数 → 回退直接用 `assets/` 根。
- 1.7.10 用独立索引（无 virtual），直接用 assets/ 根。

### 12.7 下载源镜像修正（实测，2026-10-28 二次复核）
- ⚠️ BMCLAPI 的 `/indexes/<id>.json` 返回 **404**（不可用）；而官方 launchermeta/piston-meta 的 `/v1/packages/<sha1>/<id>.json` 在 bmclapi2 上以**同路径 host 替换**实测 **200** 可用 → 资源索引改用「host 替换 /v1/packages 优先 + 官方兜底」（`assetIndexUrl()` 按契约签名保留，仅作探测/展示）。
- 版本 JSON 走 `/version/<id>/json`（200 ✓）不变；客户端 jar 走 `/version/<id>/client`（200 ✓）。
- Java 运行时 raw 文件：`/java-runtime/...` 路径实测 **403**；piston-data `/v1/objects/<sha1>/<name>` 的 host 替换实测 **200** → 按后者实现。
- BMCLAPI 版本清单有缓存滞后（快照可能滞后官方一周），UI 不要据此宣称「最新」。
- 所有镜像路径均以「候选链 + 官方兜底」实现，镜像行为再变也不会断链。

### 12.8 Java 选版表（json 无 javaVersion 字段时）

| 游戏版本 | Java |
|---|---|
| ≥ 26.1 | 25 |
| ≥ 1.20.5 | 21 |
| ≥ 1.18 | 17 |
| ≥ 1.17 | 16（无 16 时自动用 17） |
| ≥ 1.13 | 8（建议 ≥ 1.8.0_51） |
| < 1.13 | 8 |

json 有 `javaVersion.majorVersion` 时以它为准（1.7.10+ 可信）。

### 12.9 Mojang Java 运行时
- all.json：`{平台: {组件: [{version:{name}, manifest:{url,sha1,size}, availability}]}}`；windows-x64 组件：`jre-legacy`(8) / `java-runtime-alpha`(16) / `java-runtime-beta`(17) / `java-runtime-gamma`(17) / `java-runtime-delta`(21) / `java-runtime-epsilon`(25)。
- 取「组件列表中第一个 version.name 主版本 ≥ 所需」的条目；平台 manifest `{files:{<sha1>:{type,executable,downloads:{raw,lzma}}}}`。
- **零依赖策略：只用 raw 逐文件下载**（HMCL 优先 lzma 因其有解压库；我们 raw + sha1 校验 + 断点续传，行为等价）。`type:'link'` 忽略（Windows 平台无符号链接）。

### 12.10 认证
- 离线：`userType:'legacy'`、`token:'0'`、`auth_uuid` = MD5 命名 UUID v3（§5.9 已对）。
- 微软：XSTS 401 = 未拥有游戏；entitlements 检查 200 = 拥有 Java 版（§5.10 全链路已对）。

### 12.11 Fabric（实测补充）
- `meta.fabricmc.net/v2/versions/loader/<game>` 响应条目的 `launcherMeta.mainClass.client` 即主类（`net.fabricmc.loader.impl.launch.knot.KnotClient`）。
- profile json 即完整 version json（`id=fabric-loader-<loader>-<game>`、约 8 个库），直接落盘 + 继承合并即可（§5.18 已对）。
