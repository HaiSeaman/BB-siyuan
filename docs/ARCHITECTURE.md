# 架构与实现说明

> 面向要改这个插件的人（包括以后的我）。读完这份能知道：数据长什么样、请求怎么发出去、手机端为什么要走另一条路、哪些地方有坑不能碰。

当前版本：**1.3.0**

**相关文档：** [功能说明（中文）](../README.zh-CN.md) ｜ [Features (English)](../README.md) ｜ [测试指南](TESTING.md) ｜ [版本记录](CHANGELOG.md) ｜ [发布说明](RELEASE-v1.3.0.md)

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
- 网络全部收在 `src/net.ts` 一个文件里，界面只调 `streamChat` / `fetchOnce`。
- `src/ui/*.svelte` 只负责显示和交互，业务判断都下沉到 `.ts`。

## 二、设置的数据结构（多 API 多模型）

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
}

interface ApiConfig {   // src/apis.ts
    id: string;         // 程序生成，"a"+时间戳+随机串
    name: string;       // 显示名，如「中转站A」
    protocol: "openai" | "anthropic" | "gemini";
    baseURL: string;
    apiKey: string;
    models: string[];   // 这套 API 下用户填的模型名
    model: string;      // 这套 API 当前选中的模型
}
```

**为什么这样分：**

- 「地址 / 密钥 / 模型」随 API 走 —— 换服务商这些必须整体换。
- 「温度 / 思考档位 / 历史条数」保持全局 —— 换 API 不该把使用习惯也重置掉。

**关键函数：**

| 函数 | 作用 | 注意 |
|---|---|---|
| `initSettings(loaded)` | 从磁盘数据初始化 store | 只在**首次**挂载时调，见「已初始化守卫」 |
| `isInitialized()` | 是否已初始化过 | 面板会被反复挂载，用它避免旧值覆盖新改动 |
| `activeApi(s)` | 取当前生效的 API | 永远返回一个对象（空配置时给空壳），调用方不用判空 |
| `updateSettings(patch, persist)` | 改**扁平字段**（温度、思考档位） | 走统一的 400ms 防抖 |
| `updateSettingsWith(fn, persist)` | 改**嵌套结构**（`apis` 里某张卡） | 必须用它，别直接 `settings.update` 里写盘 |
| `snapshot()` | 读一份只读快照 | 供插件入口在 `onMount` 前传初值 |

### 保存必须只有一条路（v1.3.0 修的）

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
2. **不能有第二条立刻写盘的入口**。以前 `ChatPanel.chooseModel` 和设置页的 `patchApi` 都是「`settings.update` 里直接 `persist(next)`」，和防抖保存互相覆盖，快速操作会丢改动。现在一律走 `updateSettingsWith`。

### 模型清单的两条规矩（v1.3.0 加的）

`src/apis.ts`：

| 函数 | 作用 |
|---|---|
| `isChatModel(name)` | 名字看起来能不能聊天（滤掉 embedding / whisper / tts / rerank / dall-e / flux 等） |
| `splitChatModels(list)` | 拆成「能聊天的」和「跳过几个」，跳过的数量要告诉用户 |

**拉取只加不选**：`fetchModels` 只返回清单，`pullModels` 合并进现有列表时，只有在一个模型都没有的情况下才补一个能聊天的当默认值。以前会选清单第一个，而中转站第一个常是 embedding，于是「拉来的不能用、手输就正常」。

**点模型名 = 连 API 一起切**：设置页的 `pickModel` 必须同时改 `apis[i].model` 和 `activeApiId`。只改前者的话，顶栏还显示旧模型、发出去还是旧模型。

### 已初始化守卫（必须保留）

```ts
// ChatPanel.svelte onMount
if (!isInitialized()) initSettings(initialSettings);
```

面板会被反复挂载（切工作区、收起侧栏再打开）。以前写成无条件 `initSettings`，会拿启动时那份旧值把用户中途改的配置打回去。

## 三、请求怎么发出去（三条通道）

`src/net.ts` 里按环境自动选一条，判一次就缓存（`currentChannel()`）：

| 通道 | 触发条件 | 优点 | 代价 |
|---|---|---|---|
| `native` | 桌面端，`window.require` 存在 | 真流式、逐字显示 | 依赖 `net-proxy.cjs` |
| `kernel` | 手机端（没有 `require`，且是 http(s) 页面） | 走内核，天然无跨域 | **不能流式**，等全文一次性返回 |
| `fetch` | 兜底（浏览器） | 无需额外依赖 | 受 CORS 限制，多半失败 |

### 桌面通道（native）

`net-proxy.cjs` 跑在 Electron 主进程，用 `net.request` 发请求，边收边回传：

```
渲染进程 → @electron/remote 拿到主进程模块 → startRequest(...) → 逐块回调
```

`net.ts` 里的 `loadBridge()` 负责加载它。**注意：加载失败时不能缓存 `null`**，否则整个会话期都连不上，只能重启思源。代码里留的是 `undefined`（下次再试）。

### 手机通道（kernel）

调用思源内核自带接口：

```
POST /api/network/forwardProxy
{
  url, method, timeout,
  headers: [{ 键: 值 }, ...],   // 注意是「对象数组」，不是普通对象
  contentType,
  payload,                       // 有 body 时是解析后的对象
  payloadEncoding                // 有 body 用 "json"，无 body 必须用 "text"
}
```

**几个必须记住的细节：**

1. `headers` 必须是 `[{k:v}]` 数组，传对象内核收不到。
2. **没有 body 时（如 MCP 的 DELETE）必须用 `"text"` 编码**。用 `json` 的话内核会把空载荷写成字符串 `null` 发出去，四个字符的 body 会让部分服务端直接报错。
3. 返回结构是 `{ code, msg, data: { status, body, contentType } }`，`code !== 0` 表示内核自己出错。
4. 安卓 App 的 WebView 加载的就是 `http://127.0.0.1:6806/`，与内核同源，所以请求自动带登录身份，不需要额外鉴权。

### 流式解析

`src/providers.ts` 里的 `ProviderParser` 吃 SSE 原文，输出「正文增量 / 思考增量 / 工具调用」。三家协议（OpenAI / Anthropic / Gemini）都在这里适配。

**工具调用必须按 index 累积**：参数是分片吐出来的，不累积就会把一个调用拆成 N 个空参数调用（写操作会被执行 N 次）。

## 四、界面结构（ChatPanel）

```
.panel （position: relative ← 必须有！）
 ├─ .topbar           品牌 / 模型切换按钮 / 新对话 / 历史 / 管理 / 设置
 ├─ .picker-layer     ← 只在切换器打开时渲染，只覆盖顶栏以下
 │   ├─ .picker-mask  点空白关闭
 │   └─ .picker       按 API 分组的模型列表
 ├─ .tpl-bar          提示词平铺
 ├─ .mcp-bar          MCP 状态条
 ├─ .stage            对话区
 │   └─ .drawer       设置 / 模板 / MCP / 历史 抽屉
 ├─ .ctrl-bar         思考档位
 └─ .compose          输入框 + 发送
```

### 遮罩的三道保险（不要简化）

历史上出过「所有按钮都点不动」的严重故障：`.picker-mask` 是 `position:absolute; inset:0`，但 `.panel` 当时**没有** `position:relative`，遮罩于是相对整个视口铺满，压住了思源全部界面。而遮罩唯一的行为是「点自己就关闭」，用户体感就是「点什么都没反应」。

现在三道保险：

1. `.panel` 有 `position: relative`（**必须有**，删了就会复发）
2. 遮罩和菜单包进 `.picker-layer`，layer 从 `top:40px` 开始，**不覆盖顶栏**
3. `.picker-layer` 设 `pointer-events: none`，只给子元素 `auto` —— 即使位置又算错，空白处点击也会穿透

另外加了 `Esc` 关闭，给键盘留退路。

### Svelte 响应式语句的执行顺序

**`$: x = ...` 之间没有可靠的先后保证。** 不能在一个 `$:` 里通过函数间接读另一个 `$:` 的结果：

```js
// ✗ 会崩：cfg 可能还没赋值
$: cfg = $settings;
$: canThink = supportsThinking(currentModel());   // currentModel 内部读 cfg.apis

// ✓ 直接读 store + 兜底
$: canThink = supportsThinking(currentModel($settings));

function currentModel(s = $settings) {
    const list = Array.isArray(s?.apis) ? s.apis : [];
    ...
}
```

这个错误会让**整块界面渲染中止**，表现成「点开就没反应」。

### 设置页的写入方式

改 API 字段必须**基于 store 最新值**，不能用渲染用的 `cfg` 快照：

```js
// ✓ 正确：updateSettingsWith 拿到的是 store 里的最新 s
function patchApi(id, patch) {
    updateSettingsWith(
        (s) => {
            if (!s.apis.some((a) => a.id === id)) return s;
            const apis = s.apis.map((a) => (a.id === id ? { ...a, ...patch } : a));
            return { ...s, apis };
        },
        (s) => persist(s)
    );
}
```

`cfg` 要等下一帧才更新，连续输入（地址框里快速打字）时后一次会用旧列表覆盖前一次，表现成「打字丢字符」。

### 一轮生成：新建和重发共用同一段（v1.3.0）

`ChatPanel.svelte` 拆成三个函数，改这里之前先看明白谁负责什么：

| 函数 | 职责 |
|---|---|
| `prepareTurn(text, templateId, history)` | 校验配置、拼 system、估算 token。超长/没配置就返回 `null` 并写好提示 |
| `startTurn({text, templateId})` | **新建**：先算历史（必须在插入新消息之前），再追加「我的消息 + 空回答占位」，然后交给 `runTurn` |
| `runTurn({userIndex, plan})` | 真正跑工具循环，回答写进 `messages[userIndex + 1]` |
| `resend(i)` | **重发**：历史只取 `messages.slice(0, i)`，清空 `messages[i+1]`（不是 `assistant` 就插在 `i+1`），再 `runTurn({userIndex: i})` |

**为什么重发要清空而不是新增**：主人的要求是「同一条消息换个答案」。新增会让记录里出现两组一模一样的「原话 + 回答」。

**两个位置不能写错：**
- 历史必须截到这条**之前**，否则模型会看着自己的旧答案再答一遍
- 补占位必须插在 `i + 1`，因为 `runTurn` 写的固定是 `messages[userIndex + 1]`

### 一键清空历史（v1.3.0）

`clearAllSessions()` 除了清 `sessions`，还要把 `currentSessionId` 和 `messages` 一起清空。
不清的话，下一次生成结束会调 `saveCurrentSession()`，把当前这段对话重新存成一条历史 —— 用户看起来就是「没删干净」。

## 五、MCP

| 文件 | 职责 |
|---|---|
| `mcp-jsonrpc.ts` | JSON-RPC 2.0 构造与解析、工具名映射 |
| `mcp-http.ts` | Streamable HTTP 传输 |
| `mcp-sse.ts` | 旧版 SSE 传输 |
| `mcp-stdio.ts` | 本地命令行传输（仅桌面端） |
| `mcp-spawn.ts` | Windows 启动适配（`.cmd` 补全、cmd 包一层、参数转义） |
| `mcp-manager.ts` | 服务器配置清洗、工具清单合并、名字对照表 |
| `mcp-connect.ts` | 多服务器连接管理 |
| `tool-loop.ts` | 工具调用循环（含轮数上限与错误回灌） |

### stdio 进程生命周期（容易写错）

每个回调都要先确认「我还是当前那个进程」：

```js
const isCurrent = () => this.child === child;
child.on("exit", () => {
    if (!isCurrent()) return;   // 旧进程的 exit 可能比新进程启动更晚到
    ...
});
```

不判断的话，旧进程退出的通知会把**新**进程的 `child` 置空，表现成「刚重连就报进程已断开，怎么点都连不上」。

`close()` 也要先摘引用再 kill，否则自己的 exit 回调又会去清状态。

## 六、手机端三个必备条件

要让插件在安卓/iOS 上能跑，缺一不可（都是思源官方行为，不是 bug）：

1. **`plugin.json` 声明**：`frontends` 加 `mobile`，`backends` 加 `android`/`ios`/`harmony`。
   内核判定不兼容就直接跳过，连 `onload` 都不执行。
2. **不能依赖 `window.require`**：手机没有。请求走内核转发（见第三节）。
3. **面板打开方式不同**：手机没有 `window.siyuan.layout`。要按
   `[data-type="sidebar-<插件名+类型>-tab"]` 找 tab，滑出侧栏，再派发 `CustomEvent("click", {detail})`。

另外 `addDock` 的 `show` 要设 `true`，否则手机侧栏里默认看不见入口。

## 七、构建与产物

```
npm run build   → dist/（index.js / index.css / plugin.json / net-proxy.cjs / icon.png）
npm run pack    → siyuan-plugin-ai-chat-v<version>.zip（plugin.json 必须在 zip 根部）
```

`vite.config.ts` 用 `vite-plugin-static-copy` 把 `plugin.json`、`icon.png`、`net-proxy.cjs` 复制进 `dist/`。

`rollupOptions.external` 里排除了 `siyuan` 与 `process` —— 思源运行时自己提供，不能打进包。

## 八、不能碰的红线

1. `.panel` 的 `position: relative` —— 删了就复发全屏遮罩故障。
2. `.picker-layer` 的 `pointer-events: none` —— 删了就没有「点不中也能穿透」的兜底。
3. `plugin.json` 的 `frontends` / `backends` —— 删了手机端直接不加载。
4. `onMount` 里的 `isInitialized()` 判断 —— 删了用户配置会被旧值覆盖。
5. stdio 的 `isCurrent()` 判断 —— 删了会出现「刚重连就断开」。
6. 内核转发的 `payloadEncoding: "text"`（无 body 时）—— 删了会发出字面量 `null`。
7. 保存只走 `scheduleSave()`（`updateSettings` / `updateSettingsWith`）—— 另开一条立刻写盘的路，就会和防抖保存互相覆盖，表现为「改完自己变回去」。
8. `pickModel` 必须同时改 `model` 和 `activeApiId` —— 只改模型的话顶栏不变、发出去还是旧模型。
9. `resend` 只能原地替换，不能新增消息 —— 新增会在记录里堆出一模一样的两组。
10. `clearAllSessions` 必须连 `currentSessionId` 和 `messages` 一起清 —— 不清的话下一轮生成又把它存回历史。
