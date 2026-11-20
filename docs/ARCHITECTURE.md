# 架构与实现说明

> 面向要改这个插件的人（包括以后的我）。读完能知道：数据长什么样、请求怎么发出去、生图怎么落地、哪些地方有坑不能碰。

当前版本：**1.4.0** ｜ [English](ARCHITECTURE.en.md)

**相关文档：** [功能说明（中文）](../README.zh-CN.md) ｜ [Features (English)](../README.md) ｜ [测试指南](TESTING.md) ｜ [版本记录](CHANGELOG.md) ｜ [发布说明](RELEASE-v1.4.0.md)

---

## 一、整体结构

```
思源主程序
  └─ 插件（本仓库）
       ├─ src/index.ts        插件入口：注册停靠栏 / 命令 / 顶栏按钮 / 右键菜单
       ├─ src/ui/*.svelte     界面（Svelte 4）
       ├─ src/*.ts            纯逻辑（不碰 DOM、不碰网络，方便测试）
       └─ net-proxy.cjs       桌面端主进程网络代理
```

**分层原则：**

- `src/*.ts`（除 `net.ts`/`index.ts`）**不碰 `window`、不碰网络**，只做数据变换。这样能在 Node 里直接测。
- 网络全部收在 `src/net.ts` 一个文件里，界面只调 `streamChat` / `fetchOnce` / `fetchBinary`。
- `src/ui/*.svelte` 只负责显示和交互，业务判断都下沉到 `.ts`。

### 模块地图（v1.4.0）

| 文件 | 职责 | 纯逻辑 |
|---|---|---|
| `index.ts` | 插件入口、停靠栏、菜单、手机端打开逻辑 | 否 |
| `net.ts` | 三条请求通道 | 否（碰 window） |
| `providers.ts` | 三种对话协议的请求构造与 SSE 解析 | 是 |
| `settings.ts` | 设置 store、唯一保存路径、`chatApiFor` | 是（用 svelte/store） |
| `apis.ts` | API 配置、模型清单、**聊天/画图/不可用三分类** | 是 |
| `thinking.ts` | 六档思考 → 各厂商参数 | 是 |
| `image.ts` | **生图**：尺寸换算、接口地址、multipart、返回解析 | 是 |
| `image-store.ts` | **图片文件**：存/读/删/打开文件夹、**字节嗅探** | 是 |
| `inline-image.ts` | 从回复正文里抽出 markdown 图片 | 是 |
| `optimize.ts` | 提示词优化的系统提示与结果清洗 | 是 |
| `sessions.ts` | 历史对话（图片只记路径） | 是 |
| `migrate.ts` | 老配置迁移 | 是 |
| `template.ts` / `templates.ts` / `turnplan.ts` | 模板与请求组装 | 是 |
| `tokens.ts` / `errors.ts` | token 粗估、报错翻译 | 是 |
| `mcp-*.ts` / `tool-loop.ts` | MCP 各传输层与工具循环 | 大部分是 |

---

## 二、设置的数据结构

`src/settings.ts`：

```ts
interface Settings {
    apis: ApiConfig[];      // 所有 API 配置
    activeApiId: string;    // 当前用哪一套
    temperature: number;    // 以下都是全局偏好，所有 API 共用
    maxTokens: number;
    thinking: ThinkingLevel;
    contextMessages: number;
    showReasoning: boolean;
    contextLimit: number;
    maxToolRounds: number;

    lastChatModel: string;  // "apiId::model"，给「优化」用
    imageSize: string;      // 1K / 2K / 4K / 4K+
    imageRatio: string;     // 16:9 等
    imageModels: string[];  // 手动标成画图模型的名字
}

interface ApiConfig {   // src/apis.ts
    id: string;
    name: string;
    protocol: "openai" | "anthropic" | "gemini";
    baseURL: string;
    apiKey: string;
    models: string[];   // 这套 API 下有哪些模型
    picked: string[];   // **勾选了哪些**（决定顶栏显示哪几个）
    model: string;      // 当前选中的那个
}
```

**为什么 `models` 和 `picked` 要分开：**

- `models` 是"这台服务商上有哪些"（拉取一次可能几十个）
- `picked` 是"我要在顶栏里能快速切的哪几个"
- 混成一个字段的话，要么顶栏几十个挤爆，要么删模型时把"清单"也删了

**`picked` 的兼容规则（重要）：**

```ts
export function pickedOf(api: ApiConfig): string[] {
    const p = Array.isArray(api?.picked) ? api.picked : [];
    return p.length ? p : Array.isArray(api?.models) ? api.models : [];
}
```

老配置没有 `picked` 字段，**不能直接读 `api.picked.length`** —— 那会抛 `TypeError`，而渲染中抛错会让整块面板空白，用户看到的是"面板打不开"。所有取值都走 `pickedOf()`，且语义是「没勾过 = 全选」，升级不改变行为。

**关键函数：**

| 函数 | 作用 | 注意 |
|---|---|---|
| `initSettings(loaded)` | 从磁盘数据初始化 store | 只在**首次**挂载时调 |
| `activeApi(s)` | 取当前生效的 API | 永远返回对象（空配置给空壳） |
| `updateSettings(patch, persist)` | 改扁平字段 | 走统一的 400ms 防抖 |
| `updateSettingsWith(fn, persist)` | 改嵌套结构 | 必须用它，别在 `settings.update` 里直接写盘 |
| `chatApiFor(s, isChat, manualImage)` | 挑一个**能写字**的模型去优化提示词 | 第三个参数必传，否则手动标成画图的会被选中 |
| `snapshot()` | 只读快照 | 供插件入口传初值 |

### 保存必须只有一条路

`settings.ts` 里只有一个 `scheduleSave()`，两个写入函数都走它：

```ts
function scheduleSave(persist: (s: Settings) => void) {
    persistFn = persist;
    clearTimeout(saveTimer);
    saveTimer = globalThis.setTimeout(() => {
        if (persistFn) persistFn(snapshot());   // ← 到点现取最新状态
    }, 400) as unknown as number;
}
```

**两个坑，都不能踩回去：**

1. **不能把按下那一刻的 `next` 排进定时器**。用户接着改了别的字段，0.4 秒后旧快照会把新改动整份盖掉，表现成「改完又自己变回去」。
2. **不能有第二条立刻写盘的入口**。以前 `ChatPanel.chooseModel` 和设置页的 `patchApi` 都是「`settings.update` 里直接 `persist(next)`」，和防抖保存互相覆盖，快速操作会丢改动。

### 已初始化守卫（必须保留）

```ts
// ChatPanel.svelte onMount
if (!isInitialized()) initSettings(initialSettings);
```

面板会被反复挂载（切工作区、收起侧栏再打开）。无条件 `initSettings` 会拿启动时那份旧值把用户中途改的配置打回去。

---

## 三、模型的三分类（v1.4.0）

`src/apis.ts` 把模型分成三类，这个分类会牵动**界面显隐**和**模式切换**，一处错就连带一片。

```ts
// 1. 名字里带 image，或属于已知画图系列 → 画图模型
function isImageModel(name) { ... }

// 2. 反例：带 chat / vision / -vl 的多模态仍算聊天
const IMAGE_FALSE_POSITIVE = /chat|vision|vl([/_-]|$)/i;

// 3. 综合判断（含手动标记）
function isImageModelOf(name, manual) { ... }
function isChatModelOf(name, manual) { ... }
```

**判定规则：**

| 类型 | 规则 |
|---|---|
| 画图 | 名字含 `image`，或匹配 flux / sd3 / sdxl / dall-e / imagen / kolors / seedream / wanx / cogview / midjourney / pixart / hidream / diffusion |
| 反例（仍算聊天） | 名字含 `chat` / `vision` / `-vl` |
| 不可用 | `embed` / `bge` / `whisper` / `tts` / `rerank` / `moderation` |
| 手动兜底 | `settings.imageModels` 里的名字**一律**算画图模型，优先于名字判断 |

> **为什么不用逐个列举的白名单**：曾经用 `/dall-e/`、`/gpt-image/` 这类穷举，漏掉了 `gemini-3.1-flash-image` 一整类。主人配了画图模型，插件却说"没有画图模型"，连带 4 个按钮全被藏起来。

**官方尺寸表的坑**：`image.ts` 里 `OFFICIAL_SIZES` **只匹配精确官方名**（`/^gpt-image-1$/i`），不能用 `/gpt-image/i` —— 那会把第三方的 `gpt-image-2.6-sunburst` 也锁死，强行把 2560×1440 换成 1536×1024。

---

## 四、请求怎么发出去（三条通道）

`src/net.ts` 里按环境自动选一条，判一次就缓存（`currentChannel()`）：

| 通道 | 触发条件 | 优点 | 代价 |
|---|---|---|---|
| `native` | 桌面端，`window.require` 存在 | 真流式、逐字显示 | 依赖 `net-proxy.cjs` |
| `kernel` | 手机端（没有 `require`，且是 http(s) 页面） | 走内核，天然无跨域 | **不能流式** |
| `fetch` | 兜底（浏览器） | 无需额外依赖 | 受 CORS 限制 |

### 桌面通道（native）

`net-proxy.cjs` 跑在 Electron 主进程，用 `net.request` 发请求，边收边回传。

v1.4.0 里把两个几乎一样的函数合成了一个 `runNativeRequest`：

```ts
function runNativeRequest(native, url, opts, timeoutMs) {
    // settled 防重入 / chunks 收集 / statusCode / 超时兜底 / signal 中止
}
```

`fetchOnceViaNative` 和 `fetchBinaryViaNative` 只是包一层，决定返回 `text` 还是 `bytes`。改这里要同时照顾两条调用方。

**三个细节：**

1. **加载失败时不能缓存 `null`**，否则整个会话期都连不上，只能重启思源。代码里留的是 `undefined`（下次再试）。
2. **二进制请求体走 `bodyBase64`**。图生图的 multipart 是二进制，字符串会被 UTF-8 再转一次，图片字节就坏了。
3. **必须支持 `signal`**。用户点「停止」时要真正 abort 底层请求，不能只让上层不等了。

### 手机通道（kernel）

```
POST /api/network/forwardProxy
{
  url, method, timeout,
  headers: [{ 键: 值 }, ...],   // 注意是「对象数组」
  contentType,
  payload,
  payloadEncoding                // 无 body 必须 "text"；二进制用 "base64"
}
```

**必须记住：**

1. `headers` 必须是 `[{k:v}]` 数组，传对象内核收不到。
2. **没有 body 时（如 MCP 的 DELETE）必须用 `"text"`**，否则内核会把空载荷写成字符串 `null` 发出去。
3. **二进制（图生图的 multipart）必须用 `"base64"`** —— 内核会解回来按字节发。用 text/json 会把图片字节改坏。
4. 返回是 `{ code, msg, data: { status, body, contentType } }`，`code !== 0` 表示内核自己出错。

### 流式解析

`src/providers.ts` 的 `ProviderParser` 吃 SSE 原文，输出「正文增量 / 思考增量 / 工具调用」。三家协议都在这适配。

**工具调用必须按 index 累积**：参数是分片吐出来的，不累积就会把一个调用拆成 N 个空参数调用（写操作会被执行 N 次）。

---

## 五、生图（v1.4.0 新增）

### 尺寸：按屏幕分辨率

`src/image.ts`：

```ts
export const SIZES = ["1K", "2K", "4K", "4K+"] as const;
export const LONG_EDGE = {
    "1K": 1920,    // 1080p
    "2K": 2560,    // 1440p
    "4K": 3840,    // 2160p
    "4K+": 4096,   // DCI 4K
};
```

`computeSize(level, ratio)` 按长边算短边，并 `round8()` 凑成 8 的倍数（很多模型要求）。

> **不要改回"长边 1024"那套**。那是 AI 生图圈的叫法，但主人要的是"能铺满多大的屏幕"，1K 应当是 1920×1080。

### 接口与请求

| 模式 | 地址 | Content-Type |
|---|---|---|
| 文生图 | `{base}/images/generations` | `application/json` |
| 图生图 | `{base}/images/edits` | `multipart/form-data` |

`imageEndpoint()` 会处理各种地址写法（已填到 `/images/generations`、缺少 `/v1`、带尾部斜杠）。

`buildMultipart()` 手拼 multipart 字节，**不能**用浏览器的 `FormData` —— 内核转发那条路要的是原始字节。

### 返回解析

`parseImageResponse()` 认三种形态：

1. `{ data: [{ b64_json }] }` —— 官方
2. `{ data: [{ url }] }` —— 有的中转站只给网址
3. `{ images: ["base64"] }` —— 个别国产站自造格式

### 一轮生图的执行顺序

```
generateImage(text)
 ├─ 插占位消息（用户那句 + 空 assistant）
 ├─ requestImages(...)  → fetchBinary（带 signal）
 ├─ 每张图：dataUrlToBytes → sniffImageMime → saveImage
 ├─ 写进 messages[answerIndex].images
 └─ finally: 只有还是当前轮时才清 generating / genAbort
```

**finally 里的守卫不能去掉**：用户点停止后立刻再生成，旧一轮的 finally 会晚到，无条件清 `generating` 会让新一轮的按钮提前解锁（能重复发送）。

---

## 六、图片文件管理

`src/image-store.ts`。

### 存哪

```
<dataDir>/storage/petal/<插件名>/images/
```

**`dataDir` 的坑（踩过一次）**：思源 `conf.json` 的 `system.dataDir` 实测已经是 `Z:\siyuan\data`（**已含 data 层**）。再拼一层 `data\` 会得到 `Z:\siyuan\data\data\storage\...`，目录不存在，打开文件夹必然失败。

```ts
const last = root.split(/[\\/]/).filter(Boolean).pop() || "";
if (last.toLowerCase() === "data") return root + "\\" + tail;  // dataDir 已到 data 层
return root + "\\data\\" + tail;                              // 只到工作空间根
```

### 图片类型按字节判断

```ts
export function sniffImageMime(bytes, fallback = "image/png"): string {
    // FF D8 FF → jpeg / 89 50 4E 47 → png / RIFF....WEBP → webp / GIF8 → gif
}
```

**为什么必须嗅探**：服务商返回 JPEG，data URL 却写 `image/png`。照 data URL 起名 `.png`，思源的部分版本会拒绝渲染「声明与实际不符」的图 —— 表现是**能复制、能另存，但看不见**。而复制/保存走字节直通，所以完全正常，特别迷惑。

### 三个函数各自的位置

| 函数 | 用什么路径 | 为什么 |
|---|---|---|
| `saveImage` / `loadImageDataUrl` / `deleteImage` | **相对** `data/storage/petal/...` | 内核 `/api/file/*` 接口要的是相对工作空间的路径 |
| `imagesFolderHint` / `openImagesFolder` | **绝对** `Z:\siyuan\data\storage\...` | 给系统文件管理器用 |

**两者不能混用**。把绝对路径交给内核接口，会 403；把相对路径交给 `openPath`，会打不开。

### 打开文件夹的四层兜底

```ts
1. @electron/remote 的 shell.openPath
2. electron 模块的 shell.openPath
3. child_process.spawn("explorer.exe", [dir])   ← Windows 原生，最不容易被拦
4. 都失败：把完整路径写进状态栏，让人手动粘贴
```

打开前先 `fs.existsSync(dir)`，目录不存在就说"还没生成过图片"，而不是抛一个看不懂的错。

### 图片卡片取图优先级

显示和"复制/保存"**必须用同一套顺序**，否则会出现"界面看得到、保存说找不到"：

```ts
function imageSourceOf(img, thumbs, errors) {
    if (img.path && thumbs[img.path]) return { kind: "data", ... };  // 读好的 data URL
    if (img.url) return { kind: "url", ... };                        // 服务商网址
    if (img.mem) return { kind: "data", ... };                       // 存盘失败的内存副本
    if (img.path && errors[img.path]) return { kind: "none" };       // 明确失败 → 显示原因
    if (img.path) return { kind: "file", ... };                      // 还没读完 → 静态地址占位
}
```

---

## 七、界面结构（ChatPanel）

```
.panel （position: relative ← 必须有！）
 ├─ .topbar           品牌 / 模型切换 / 新对话 / 历史 / 管理 / 设置
 ├─ .img-banner       生图模式提示条（只在生图模式）
 ├─ .picker-layer     模型切换器（只覆盖顶栏以下）
 ├─ .tpl-bar          提示词平铺（生图模式隐藏）
 ├─ .mcp-bar          MCP 状态条（生图模式隐藏）
 ├─ .stage
 │   └─ .drawer       设置 / 模板 / MCP / 历史
 ├─ .ctrl-bar         左：思考档位 ｜ 右：图片 上传 大小 尺寸 优化 模式开关
 ├─ .ref-bar          参考图预览（选了图才出现）
 └─ .compose          输入框 + 发送/生成
```

### 遮罩的三道保险（不要简化）

历史上出过「所有按钮都点不动」的严重故障：`.picker-mask` 是 `position:absolute; inset:0`，但 `.panel` 当时**没有** `position:relative`，遮罩于是相对整个视口铺满，压住了思源全部界面。

现在三道保险：

1. `.panel` 有 `position: relative`（**必须有**，删了就复发）
2. 遮罩和菜单包进 `.picker-layer`，layer 从 `top:40px` 开始，**不覆盖顶栏**
3. `.picker-layer` 设 `pointer-events: none`，只给子元素 `auto`

### Svelte 响应式的两个坑

**坑一：`$:` 之间没有可靠的执行顺序。**

```js
// ✗ 会崩：cfg 可能还没赋值
$: cfg = $settings;
$: canThink = supportsThinking(currentModel());   // 内部读 cfg.apis

// ✓ 直接读 store + 兜底
$: canThink = supportsThinking(currentModel($settings));
```

**坑二：模板里调用函数，函数内部读的响应式变量不会被追踪。**

```js
// ✗ refThumbs 更新后模板不会重算，src 永远停在最初那个值
<img src={imageSrc(img)}>

// ✓ 在脚本里算出响应式映射表，模板直接查表
$: imgSrcMap = (() => { ... })();
<img src={imgSrcMap[key]}>
```

第二个坑导致过「图片能复制能保存却看不见」—— 数据全对，只是模板不重渲染。

### 一轮对话：新建和重发共用同一段

| 函数 | 职责 |
|---|---|
| `prepareTurn(text, templateId, history)` | 校验配置、拼 system、估算 token。超长/没配置就返回 `null` |
| `startTurn({text, templateId})` | **新建**：先算历史（必须在插入新消息之前），再追加「我的消息 + 空回答占位」 |
| `runTurn({userIndex, plan})` | 真正跑工具循环，回答写进 `messages[userIndex + 1]` |
| `resend(i)` | **重发**：历史只取 `messages.slice(0, i)`，清空 `messages[i+1]`，再 `runTurn({userIndex: i})` |

**两个位置不能写错：**
- 历史必须截到这条**之前**
- 补占位必须插在 `i + 1`，因为 `runTurn` 写的固定是 `messages[userIndex + 1]`

---

## 八、MCP

| 文件 | 职责 |
|---|---|
| `mcp-jsonrpc.ts` | JSON-RPC 2.0 构造与解析、工具名映射 |
| `mcp-http.ts` | Streamable HTTP 传输 |
| `mcp-sse.ts` | 旧版 SSE 传输 |
| `mcp-stdio.ts` | 本地命令行传输（仅桌面端） |
| `mcp-spawn.ts` | Windows 启动适配（`.cmd` 补全、参数转义） |
| `mcp-manager.ts` | 配置清洗、工具清单合并、名字对照表 |
| `mcp-connect.ts` | 多服务器连接管理 |
| `tool-loop.ts` | 工具调用循环（含轮数上限与错误回灌） |

### stdio 进程生命周期

每个回调都要先确认「我还是当前那个进程」：

```js
const isCurrent = () => this.child === child;
child.on("exit", () => {
    if (!isCurrent()) return;   // 旧进程的 exit 可能比新进程启动更晚到
    ...
});
```

不判断的话，旧进程退出的通知会把**新**进程的 `child` 置空，表现成「刚重连就报进程已断开」。

---

## 九、手机端三个必备条件

1. **`plugin.json` 声明**：`frontends` 加 `mobile`，`backends` 加 `android`/`ios`/`harmony`。内核判定不兼容就直接跳过，连 `onload` 都不执行。
2. **不能依赖 `window.require`**：手机没有。请求走内核转发。
3. **面板打开方式不同**：按 `[data-type="sidebar-<插件名+类型>-tab"]` 找 tab，滑出侧栏，再派发 `CustomEvent("click", {detail})`。

另外 `addDock` 的 `show` 要设 `true`，否则手机侧栏里默认看不见入口。

---

## 十、构建与产物

```
npm run build   → dist/（index.js / index.css / plugin.json / net-proxy.cjs / icon.png）
npm run pack    → siyuan-plugin-ai-chat-v<version>.zip（plugin.json 必须在 zip 根部）
```

`vite.config.ts` 用 `vite-plugin-static-copy` 把 `plugin.json`、`icon.png`、`net-proxy.cjs` 复制进 `dist/`。

`rollupOptions.external` 排除了 `siyuan` 与 `process` —— 思源运行时自己提供，不能打进包。

---

## 十一、不能碰的红线

1. `.panel` 的 `position: relative` —— 删了就复发全屏遮罩故障。
2. `.picker-layer` 的 `pointer-events: none` —— 删了就没有「点不中也能穿透」的兜底。
3. `plugin.json` 的 `frontends` / `backends` —— 删了手机端直接不加载。
4. `onMount` 里的 `isInitialized()` 判断 —— 删了用户配置会被旧值覆盖。
5. stdio 的 `isCurrent()` 判断 —— 删了会出现「刚重连就断开」。
6. 内核转发无 body 时 `payloadEncoding: "text"` —— 删了会发出字面量 `null`。
7. 保存只走 `scheduleSave()` —— 另开一条立刻写盘的路，就会「改完自己变回去」。
8. `pickModel` 必须同时改 `model` 和 `activeApiId`。
9. `resend` 只能原地替换，不能新增消息。
10. `clearAllSessions` 必须连 `currentSessionId` 和 `messages` 一起清。
11. **`pickedOf()` 兜底不能删** —— 老配置没有 `picked`，直接读会崩掉整个面板。
12. **图片类型必须按字节嗅探** —— 别信 data URL 或扩展名。
13. **`dataDir` 已含 `data` 层** —— 拼绝对路径前先判断，否则多一层目录。
14. **`imagesFolderHint`（绝对）和 `dataRoot`（相对）不能混用**。
15. **生图的 `finally` 里清 `generating` 必须有守卫** —— 否则停止后立刻重发生会并发两轮。
16. **正文插图搬盘的文件名必须带下标** —— 固定传 1 会让同一条消息里的多张图互相覆盖。
