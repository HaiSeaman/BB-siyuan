# 思源笔记 AI 生成面板 · 开发文档

版本：1.1.0
日期：2026-11-18
状态：已交付，装在本机思源（3.8.10），仅个人使用

> 这份文档是「事后的实现记录」，写给未来的自己（或未来的 AI 助手）。
> 事前方案见 `2026-11-18-siyuan-ai-chat-plugin-design.md`，两份要一起看：
> 方案说「打算怎么做」，这份说「实际做成了什么、踩过哪些坑、为什么这么写」。

---

## 一、这个插件是什么

思源笔记的侧栏面板，把「输入内容 → 套自定义提示词 → AI 按规则回答（可按需调 MCP 工具）→ 复制走」串成一条流水线。

**核心边界：只读不写。** 插件从不修改、覆盖、插入你的任何笔记。生成的成稿只出现在面板里，由你自己点「复制」粘回思源。整份代码里没有任何「写块 / 更新块 / 插入块」的 API 调用。

**当前定位（1.1.0 起）：只做两件事——自定义提示词 + MCP。**

要处理的内容直接在面板输入框里写，不再有「选中笔记内容」这一层（1.0.0 的「素材」概念已整体移除）。

**用途**：写日记后，把内容敲进输入框，点一个提示词模板，得到一份按你规则整理的成稿；需要实时信息（时间、天气等）时由 MCP 工具提供。

---

## 二、最终功能清单

### 2.1 已完成

| 功能 | 说明 |
|---|---|
| 三种协议 | OpenAI 兼容 / Claude 原生 / Gemini 原生 |
| 流式输出 | 打字机效果，可中途停止 |
| 思考档位 | 六档：关 / 最小 / 低 / 中 / 高 / 最高，按模型自动翻译；主界面点一下循环切 |
| 思考过程展示 | 折叠区，可开关 |
| 自定义提示词 | 四个变量（date/time/weekday/doc_title），增删改排序，内置 3 个示例 |
| 提示词即规则 | 点一下只「套用规则」，之后该对话每条消息都带着它；不清空、不自动发 |
| 提示词快捷入口 | 主界面平铺一排 + 右键菜单每模板一条 |
| MCP | HTTP / SSE（旧版）/ 本地命令三种传输，真实协议实现 |
| MCP 状态常驻 | 一行状态条：已连N个服务器·M个工具 / 连接失败 / 未配置，点开即配 |
| 工具调用 | 模型自主调用，结果回灌，死循环保护；用模板时工具照样完整传出 |
| 对话展示 | 左右气泡式（用户靠右蓝底、AI 靠左灰底） |
| 抽屉式面板 | 设置 / 历史 / 提示词管理 / MCP 从右侧滑出，对话不丢 |
| 会话存档 | 最近 30 条，自动保存，切换恢复 |
| 报错翻译 | 20+ 种常见错误翻译成人话 |
| 一键安装 | `npm run install-plugin` |
| 一键打包 | 双击 `一键打包.bat`，产出可直接安装的 zip |

### 2.2 1.1.0 相比 1.0.0 的变化

**移除：**

- 「取选中内容」按钮与素材显示框
- `{{content}}` 变量（变量从 5 个减到 4 个）
- `material` / `activeMaterial` / `lastSentMaterial` / `grabSelection` / `pushSelection` 全部代码
- 内置模板里对 `{{content}}` 的引用

**改版：**

- 界面整体重做：提示词平铺、MCP 常驻状态条、模型与思考档位外露到主界面、对话改左右气泡
- 设置 / 历史 / 模板管理 / MCP 由「整页替换」改为「右侧抽屉」，不再遮挡对话
- 点模板由「清空对话并立即发送」改为「只绑定规则」，之后每条消息都经过模板

**修复：**

- 右键菜单看不到模板项（只监听 `click-blockitem`，未监听 `open-menu-content`）
- `pack.mjs` 用异步流写 zip、无错误处理，导致「显示打包成功却不产出文件」

### 2.3 明确不做

- 不写入思源笔记（只给复制按钮）
- 不做笔记内部检索 / RAG / 向量库
- 不做多模型并排对比
- 不做翻译、起标题、划词解释等零散工具
- 不做记忆系统、定时任务
- 不做中英双语（只自己用，不上架集市）
- 不做内置 MCP 服务器清单（你自己找、自己填）
- 不做 MCP 的 OAuth 授权（只能填静态请求头）
- 不做模板导入导出
- 不做历史对话搜索
- 不做「选中笔记内容自动注入」（1.1.0 起明确不做）

---

## 三、代码结构

```
siyuan-plugin-ai-chat/
├── plugin.json              思源插件清单
├── package.json
├── vite.config.ts           构建：CJS 单文件 + index.css
├── svelte.config.js         让 Svelte 认识 TypeScript
├── tsconfig.json
├── icon.png
├── net-proxy.cjs            主进程网络代理（绕开跨域）
├── 一键打包.bat             双击即构建+打包（纯 ASCII，避免 936 代码页踩坑）
├── scripts/
│   ├── install.mjs          一键构建 + 安装
│   ├── pack.mjs             打 zip（同步写 + 字节数核对）
│   └── oneclick-pack.mjs    打包逻辑（bat 调用它）
├── src/
│   ├── index.ts             插件入口：停靠栏、命令、右键菜单
│   ├── settings.ts          设置项与默认值
│   ├── migrate.ts           旧版设置迁移与脏值清洗
│   ├── net.ts               请求通道（主进程优先 / fetch 降级）
│   ├── providers.ts         三种协议的请求构造 + 流式解析
│   ├── thinking.ts          六档思考 → 各厂商参数翻译
│   ├── template.ts          模板变量替换（4 个变量，无 content）
│   ├── templates.ts         模板清单增删改查 + 内置示例
│   ├── turnplan.ts          模板/用户输入/历史 → 一次请求
│   ├── tokens.ts            粗估 token、超长判断
│   ├── errors.ts            报错翻译成人话
│   ├── sessions.ts          会话存档
│   ├── tool-loop.ts         工具调用循环
│   ├── mcp-jsonrpc.ts       MCP 的 JSON-RPC 层 + 工具名清洗
│   ├── mcp-http.ts          MCP Streamable HTTP
│   ├── mcp-sse.ts           MCP 旧版 SSE
│   ├── mcp-stdio.ts         MCP 本地命令行
│   ├── mcp-spawn.ts         起子进程的 Windows 适配
│   ├── mcp-manager.ts       工具清单合并 + 名字对照表
│   ├── mcp-connect.ts       多服务器连接管理
│   └── ui/
│       ├── ChatPanel.svelte      主面板（顶栏/提示词/MCP条/气泡/抽屉）
│       ├── Settings.svelte       设置（抽屉内）
│       ├── TemplateManager.svelte 提示词管理（抽屉内）
│       └── McpSettings.svelte    MCP 服务器管理（抽屉内）
└── tests/
    ├── all.mjs               统一入口（逐个跑）
    ├── *.test.mjs            逻辑测试（21 个文件，562 项）
    └── live*.mjs             真机验证（6 个脚本）
```

**分层原则**：凡是能不碰 `window` 的逻辑，都抽成纯函数模块（`providers` / `thinking` / `template` / `turnplan` / `sessions` / `errors` / `tokens` / `mcp-jsonrpc` / `mcp-manager`）。这样能命令行直接测，不用起界面。

**UI 只有一层**：`ChatPanel.svelte` 是唯一常驻组件，另外三个（设置/模板/MCP）不替换整页，而是插进 `ChatPanel` 的右侧抽屉里。

---

## 四、关键设计决策与理由

### 4.1 为什么不用思源自带的 AI 接口

思源 3.8.10 内核已有 `/api/ai/*`、`/api/agent/*`，自带流式、思考、MCP。但它的请求结构里**没有任何可以替换系统提示词的位置**（`agentChatReq` 只有 `message`、`references`、`editorContext`）。

本插件的核心需求就是「用我自己的提示词模板」，所以这一层必须自建。代价是：思源里配过的模型在这里要再配一次，两套配置互不影响。

### 4.2 网络为什么走主进程

实测本机中转站（局域网地址，示例记为 `http://127.0.0.1:8080/v1`）**不做 CORS**：
- 预检请求返回 405
- 响应里没有任何 `Access-Control-Allow-*` 头

浏览器直接 fetch 会被拦死。所以 `net.ts` 优先用 `window.require('@electron/remote')` 拿主进程网络能力，加载 `net-proxy.cjs` 发请求；拿不到才退回普通 fetch。

**为什么不用思源的 `/api/network/forwardProxy`**：它不支持流式，必须等整个回答生成完才一次性返回，打字机效果直接废掉。

**可行性依据**：本机思源 3.8.10 主程序带 `@electron/remote@^2.1.4`，且对主窗口调用了 `remote.enable(currentWindow.webContents)`。

### 4.3 思考档位怎么翻译

界面只给一套六档，代码按模型家族翻译成各家参数：

| 模型家族 | 实际发什么 |
|---|---|
| glm 系 | `reasoning_effort`: low / high / max |
| deepseek-v4 | `reasoning_effort`: high / max |
| 旧 deepseek | `reasoning_effort`: high / max |
| gpt / o 系 | `reasoning_effort`: minimal / low / medium / high |
| gemini | `thinkingConfig.thinkingLevel`: LOW / MEDIUM / HIGH |
| Claude 原生 | `thinking.budget_tokens`（老版）或 `effort`（4.6+） |

**关键实测**：这台中转站的 glm-5.3 **无法真正关闭思考**。
`thinking.type=disabled`、`enable_thinking=false`、`reasoning_effort=none` 全部无效，只有 `reasoning_effort=low` 能压到零输出。所以界面上的「关」和「低」都发 `low`，区别只在是否显示思考文字。

### 4.4 模板怎么进请求

**模板正文 = system prompt。** 只有四个小变量会被替换：

| 变量 | 替换成 |
|---|---|
| `{{date}}` | 今天日期，如 2026-11-18 |
| `{{time}}` | 当前时间，如 21:30 |
| `{{weekday}}` | 星期几 |
| `{{doc_title}}` | 当前文档标题 |

认不出的变量**原样保留**，绝不吞掉用户写的字。

`turnplan.ts` 只做三件事：

1. 有模板 → 渲染后作为 `system`
2. 拼历史（按 `contextMessages` 截取最近若干条）
3. 追加上用户这句话；用户没写就补一个触发词（不能发空消息）

**1.1.0 移除了「素材」这一层**：没有 `{{content}}`、没有 `material`、没有「模板没写 content 就单独补发一条 user」。要 AI 处理的内容请直接写在输入框里发出去。

**为什么删掉素材**：素材是模板变量的配套物。既然实际使用方式是「内容直接敲进输入框」，留着 `{{content}}` 只会产生死变量和空输入框，界面更乱。

### 4.5 模板和 MCP 是两条独立的线

这是被专门验证过的一点：**用模板对话时，MCP 工具照样完整传给模型**。

原因是两条路根本不交汇：

| 关注点 | 走哪里 |
|---|---|
| 模板（规矩、人设） | `plan.system` → 请求体的 `system` / `systemInstruction` |
| MCP 工具清单 | `mcp.toolSpecs()` → 请求体的 `tools` 字段 |

`startTurn()` 里分别取这两样，然后一起交给 `bodyFor(protocol, cfg, messages, system, tools)`。

**三种协议都验证过**（`tests/mcp-with-template.test.mjs`，14 项）：

| 协议 | 模板位置 | 工具位置 |
|---|---|---|
| OpenAI 兼容 | `messages[0]`（role: system） | `tools[].function` |
| Claude 原生 | 顶层 `system` 字段 | `tools[].input_schema` |
| Gemini | `systemInstruction.parts[0].text` | `tools[0].functionDeclarations` |

追问时（带历史）模板与工具也都还在。

**但要说清一个边界**：工具传过去 ≠ 模型一定调用。调不调由模型自己判断。没配 MCP 服务器时就是没有工具可调。

### 4.6 MCP 工具名的处理（踩过大坑）

接口对函数名有硬性限制：只能 `[A-Za-z0-9_-]`，最长 64 字符。

所以工具名要做两层处理：

1. **清洗**：非法字符换成下划线，连续的下划线压成一个，首尾下划线去掉
2. **前缀用服务器 id 而不是名字**：id 是我们自己生成的 ASCII 串，一定合法且唯一；名字可能是中文（如「计算器」），清洗后可能撞车

**执行时必须查对照表，不能靠字符串反推**。因为 `get-sum` 发给模型会变成 `get_sum`，反推就找不到。`buildToolSpecs` 同时产出 `specs`（给模型看的）和 `bindings`（名字对照表）。

**整段都是中文时的兜底**：不用 `srv` / `tool` 这种笼统名字（多个服务器会重名），而是用字符编码算一个稳定短标识，如 `mcp__srv_l1r82__tool_fvc1t`。

### 4.7 工具调用循环

`tool-loop.ts` 负责：模型说要调工具 → 执行 → 结果回灌 → 再问模型，直到它给出正文。

三个必须防的坑：

1. **死循环**：`maxRounds` 兜底（默认 8，可调）
2. **工具报错**：把错误当工具结果回灌，让模型自己判断要不要换办法，不能整体崩
3. **上层 UI 抛错**：不能让循环卡死

### 4.8 工具消息要按协议映射（不是拍平）

同一份内部消息结构发到三家要各自转换：

| 协议 | 工具调用的表示 |
|---|---|
| OpenAI 兼容 | 原样透传 `tool_calls` + `role:"tool"`（保留 `tool_call_id`） |
| Claude 原生 | assistant → `tool_use` 块；结果 → `tool_result` 块（带 `tool_use_id`） |
| Gemini | `functionCall` / `functionResponse` |

拍平成普通文本的话，模型根本不知道那是工具返回，多轮工具循环直接退化。

**同时要丢掉空 assistant 消息和空 text 块**，两家都会因此报 400。

### 4.9 Anthropic 开思考时不能带 temperature

这是真机踩到的硬坑：Claude 原生协议只要请求体里带 `thinking`，就**不能同时发 `temperature`**（只接受默认值 1），否则整次请求直接 400。

原代码无条件带 `temperature: 0.7`，而思考档位默认开着，等于「Claude 原生协议从来发不出去」。

现在的逻辑：开思考 → 只发 `thinking`，不发 `temperature`；关思考 → 才发 `temperature`。

### 4.9 会话存档

- 最多 30 条，最旧的自动清理
- 只存「有正文的」消息：只有思考没有正文的助手消息说明中途断了，不该存
- 内容没变化时不重复存：否则每次生成结束都更新 `updatedAt`，「最近对话」顺序会乱跳
- 当前模板**不存**：切回旧对话要重新选（1.1.0 起模板已取代原「素材」概念）

### 4.10 界面结构（1.1.0 重做）

从上到下五层，全部在 `ChatPanel.svelte` 一个组件里：

```
① 顶栏       AI 生成 | 模型▾ | 新对话 历史 管理 ⚙
② 提示词栏   "提示词" + 所有模板按钮（平铺）+ 末尾 [+]
③ MCP 条     ● 状态文案                                   ›
④ 对话区     左右气泡；抽屉从这里右侧滑出
⑤ 输入区     思考档位▾ | 退出「模板」 | Ctrl+Enter 提示
             [textarea                    ] [发送]
```

**四条设计决定（都是与主人逐项确认过的）：**

| 决定 | 理由 |
|---|---|
| 提示词**一直平铺**，不做下拉 | 主人要所有模板一眼可见；下拉会多一次点击 |
| MCP **常驻一行状态条** | 他的日记模板要 MCP 取时间/天气，必须一眼看出通没通 |
| 模型与思考档位**放到主界面** | 两个高频开关，不该藏在设置里 |
| 对话用**左右气泡** | 一眼分清谁说的，比原来的「你/AI」小标题更直观 |

**MCP 状态条三态：**

| 状态 | 圆点 | 文案 |
|---|---|---|
| 正常 | 绿 | `MCP 已连 N 个服务器 · M 个工具` |
| 有失败 | 橙 | `MCP 有 N 个服务器连接失败，点这里查看` |
| 未配置 | 灰 | `MCP 还没配置服务器，点这里添加` |

**抽屉而不是整页替换：**
`drawer` 变量是 `"settings" | "templates" | "mcp" | "history" | null`。非 null 时在对话区右侧渲染一层抽屉 + 半透明遮罩。
好处：改设置时对话还在左边，能对照着调。

**抽屉内的三个子组件不再自带滚动和关闭按钮**：滚动由 `.drawer-body` 统一管（避免双层滚动条），关闭统一用抽屉头的 ×（避免两个关闭入口）。

---

## 五、踩过的坑（完整清单）

按发现顺序排列，每条都写明「症状 → 原因 → 修法」。

### 阶段一：骨架与网络

**1. 跨域被拦**
- 症状：浏览器 fetch 直接失败
- 原因：中转站不做 CORS，预检返回 405
- 修法：走主进程代理

**2. 思考关不掉**
- 症状：设了「关」还冒思考内容
- 原因：该服务端的 glm-5.3 不认 `disabled` / `none` / `enable_thinking=false`
- 修法：「关」降级发 `low`

**3. 点「停止」报错**
- 症状：`abortFn is not a function`
- 原因：把请求对象当函数调用了
- 修法：改成 `abortFn.abort()`

**4. 每次打开面板清空密钥**
- 症状：设置全被重置
- 原因：`snapshot()` 里调了 `initSettings(null)`，把默认值写回去了
- 修法：只读当前值，绝不重置

**5. 追问时重复发整篇素材**
- 症状：token 消耗翻倍
- 原因：每轮都塞素材
- 修法：只在第一轮发

### 阶段二：三协议与思考

**6. Claude 预算越界**
- 症状：400
- 原因：`budget_tokens` 必须**小于** `max_tokens`，原来算成相等
- 修法：取 `max_tokens` 的 3/4 上限；放不下 1024 就不发 thinking

**7. Claude 消息不交替**
- 症状：400
- 原因：连续的 user 消息（素材 + 问题）被直接拒
- 修法：合并同角色消息；第一条必须是 user

**8. 解析出错导致流悬挂**
- 症状：界面永远停在「正在生成」
- 原因：`onDelta` 抛错后 `onEnd` 永远不被调用
- 修法：抛错时主动掐断底层请求并收尾

**9. 出错后没掐断底层请求**
- 症状：4xx 后连接还在拉数据
- 修法：`finish(err)` 里调 `abort()`

**10. 测试连接误报失败**
- 症状：设置页显示失败，但面板能发
- 原因：设置页用浏览器 fetch（被跨域拦）
- 修法：改走同一条本机通道

**11. `hasNativeChannel()` 每次重新加载**
- 症状：每发一条消息都 require 一遍 Electron 模块
- 修法：缓存结果

### 阶段三：模板

**12. 素材被吞掉**
- 症状：模板没写 `{{content}}` 但选了素材时，素材丢了
- 修法：单独发一条 user + 触发词

**13. 追问时素材变空**
- 症状：`{{content}}` 变成空字符串
- 原因：素材只存在界面状态里
- 修法：`activeMaterial` 一直带着；素材变了补发

**14. 模板管理连续操作丢失**
- 症状：连点两次↑只上移一次；新建后立刻保存失败
- 原因：读的是父组件回传的旧 props（Svelte props 更新有一 tick 延迟）
- 修法：用本地镜像 `list`

**15. `{{ }}` 被 Svelte 当表达式**
- 症状：编译报错 `Cannot find name 'content'`
- 修法：HTML 实体 `&#123;&#123;content&#125;&#125;`

### 阶段四：MCP

**16. Windows 上 npx 起不来（最严重）**
- 症状：`spawn npx ENOENT`，然后 `spawn EINVAL`
- 原因：`npx` 实际是 `npx.cmd`；新版 Node 出于安全修复**拒绝直接 spawn `.cmd`**
- 修法：`cmd.exe /d /s /c npx.cmd <参数>`，**不开 shell**

**17. `shell:true` 有注入风险**
- 症状：Node 警告 DEP0190
- 修法：完全不用 shell，参数独立传

**18. cmd.exe 二次解释参数**
- 症状：`https://x/a?foo=1&bar=2` 被拆成两段；`%USERPROFILE%` 被展开
- 修法：给 `& | < > ^ %` 加 `^` 转义

**19. 工具名横线被吃掉**
- 症状：`Tool get_sum not found`
- 原因：服务器上是 `get-sum`，发给模型变成 `get_sum`，执行时反推找不到
- 修法：建「模型可见名 → 原始名」对照表，按表查

**20. 中文工具名非法**
- 症状：整次请求 400
- 原因：接口只认 `[A-Za-z0-9_-]`
- 修法：清洗成 ASCII；前缀改用服务器 id

**21. 子进程崩过一次永久连不上**
- 症状：每次调用干等 30 秒超时
- 原因：`exit` 后没把 `this.child` 置空，下次直接跳过启动，写进已销毁的管道
- 修法：`exit` / `error` 里置空并清空行缓冲

**22. MCP 子进程泄漏**
- 症状：node 进程越攒越多
- 原因：`rebuildMcp` 每次 new 一个 manager，旧连接从不 close
- 修法：重建前 `closeAll()`；组件 `onDestroy` 兜底

**23. 旧版 SSE 挂死**
- 症状：「测试所有服务器」永久转圈
- 原因：SSE 正常状态是「不关闭」，`await resp.text()` 永远不返回
- 修法：读到 `event: endpoint` 就停止读取

**24. 工具分片缺 index 制造假调用**
- 症状：一个工具调用被拆成 N 个，写操作执行 N 次
- 修法：无 index 时按「有没有新 id/新名字」判断是续接还是新开；index > 32 忽略

**25. Anthropic 完整 input 与 delta 拼坏**
- 症状：工具收到空参数
- 原因：先拿到完整 input，后面又追加 delta，JSON 解析失败
- 修法：收到第一个 delta 时先清空再累加

### 阶段五与审查

**26. 模型名写错只说 param is invalid**
- 症状：翻译不出来，只剩英文原文
- 原因：该中转站返回 400 + `the param is invalid`，没有 `model not found`
- 修法：加 400 兜底规则，**放在规则列表最后**（更具体的错误优先）

**27. 切模板时丢上一轮对话**
- 修法：先存档再清空

**28. 历史列表顺序乱跳**
- 修法：内容没变化时不重存

**29. 切换会话后思考区串位**
- 修法：切换时重置 `openReasoning`

**30. 一键安装脚本路径算错**
- 症状：`构建完没看到 dist 目录`
- 原因：脚本在 `scripts/` 下，`import.meta.url` 指向子目录
- 修法：`root = dirname(here)`

**31. 面板可能打不开**
- 症状：右键菜单点「AI 生成」没反应
- 原因：直接调 `rightDock.toggleModel()` 跳过了「按位置找 dock」
- 修法：在 `leftDock` / `rightDock` / `bottomDock` 里按 `data[type]` 找，找到再 toggle；找不到就退回点按钮

**32. 生成中点「新对话」崩**
- 症状：`Cannot read properties of undefined`
- 修法：生成中拦住，提示先停止

**33. 停止显示成报错**
- 症状：状态栏「出错了：已停止」
- 修法：`catch` 里先判是不是「已停止」

**34. 停止后再发，新请求停不下来**
- 原因：旧循环的 `finally` 把新一轮的 `abortFn` 清掉了
- 修法：`finally` 里判断 `abortFn === myHandle` 才清

**35. 设置页数字框删空写 0**
- 症状：`max_tokens` 变 0，之后每次 400
- 修法：`setNumber` 拦截非法值

**36. 右键菜单模板是旧快照**
- 修法：模板变更时同步给插件实例

**37. MCP 页测试后列表不刷新**
- 原因：`{@const st = stateOf(s.id)}` 里 `stateOf` 是函数，Svelte 不把 `states` 记为依赖
- 修法：改成内联 `states.find(...)`

**38. 本地命令参数按空格硬拆**
- 症状：`C:\Program Files\x.js` 被拆坏
- 修法：按引号解析

**39. Ctrl+Enter 在子页也发请求**
- 修法：判断当前显示哪个子页

**40. 流式长文越写越卡**
- 原因：每次 `Lute.New()` 新建实例并整篇重解析
- 修法：Lute 实例只建一次；流式期间显示纯文本

**41. 本机通道一次失败永久失效**
- 原因：缓存成 `null`，而代码只认 `undefined` 才重试
- 修法：失败时设回 `undefined`

**42. 定时器泄漏**
- 修法：`finish` 里 `clearTimeout`

**43. abort 时不回调**
- 症状：调用方永久挂起
- 修法：abort 里也调 `onEnd`

### 阶段六：1.1.0 范围收窄与界面重做

**44. 点模板像按钮失灵**
- 症状：点了模板按钮毫无反应，既不发送也不高亮
- 原因：旧实现「点模板 = 清空对话 + 立刻发送」，且没取到素材时直接 `return`，界面上没有任何反馈
- 修法：改成「点模板 = 只绑定规则」；按钮高亮 + 底部出现「退出「模板名」」；不再依赖素材

**45. 右键菜单看不到模板项**
- 症状：选中文字右键，菜单里只有「AI 生成（打开面板）」，没有「用模板：XXX」
- 原因：只监听了 `click-blockicon`，那是**点块前小图标**才触发的事件；选中文字右键走的是 `open-menu-content`
- 修法：两个事件都挂，共用 `addTemplateMenuItems`
- **教训**：思源的菜单事件有好几种，动手前先确认触发场景对应哪个

**46. 打包显示成功却没有 zip**
- 症状：第一次点 bat 能出包，把 zip 删掉后再点就不出包了
- 原因：`pack.mjs` 用 `createWriteStream` **异步**写文件，且**没有任何错误处理**，失败时照样打印「打包完成」
- 修法：改 `writeFileSync` + 写完 `statSync` 核对字节数 + 被占用时自动换带时间戳的文件名
- **教训**：凡是「生成交付文件」的脚本，都要同步写 + 写后核对，不能信没有错误处理的流式写

**47. bat 里的中文被当命令执行**
- 症状：双击 bat，屏幕上出现 `'存帴瀹夎鐨?zip' 不是内部或外部命令`
- 原因：bat 文件是 UTF-8，而 cmd 双击时按 GBK（936）读取，**连 `rem` 注释里的中文都被当成命令**
- 修法：bat 本体**纯 ASCII**，中文提示全部交给 node 脚本输出；运行 node 前临时 `chcp 65001`
- **教训**：给中文 Windows 写 bat，注释也必须英文

**48. bat 调用 npm 会静默卡死**
- 症状：卡在 `[2/3] Building...` 后一片空白，vite 一行输出都没有，只能 Ctrl+C
- 原因：`bat → node → cmd shell → npm → node → vite` 层数太多（退出码 `-1073741510` = 被 Ctrl+C 中断）
- 修法：bat 里**直接调 node** 跑 `vite.js` 和 `pack.mjs`，完全不经 npm、不开 shell
- **教训**：一键脚本里只调 `process.execPath` + 具体 `.js/.mjs`

**49. 抽屉里出现双层滚动条**
- 症状：抽屉内容滚到底后外面还能再滚
- 原因：`.drawer-body` 和三个子组件都设了 `overflow-y: auto; height: 100%`
- 修法：去掉子组件的滚动与高度，统一交给抽屉

**50. 三个子页面各有一个「返回」**
- 症状：抽屉头有 ×，页面内又有「返回」，两个关闭入口
- 修法：删掉页面内的「返回」，只保留 `editingId` 时的「取消」；同步删掉不再使用的 `close` 属性

---

## 六、验证方式

### 6.1 逻辑测试（562 项）

```powershell
npm test
```

21 个测试文件，覆盖：思考档位翻译、三种协议请求构造与解析、工具调用解析、设置迁移、网络层错误路径、模板变量替换（4 变量、无 content）、模板清单增删改、回合组装、模板绑定持续性、**模板与 MCP 共存**、token 估算、MCP JSON-RPC、MCP 三种传输、工具清单合并、工具调用循环、错误翻译、会话存档。

**测试策略**：每个 bug 先写测试看到它失败（RED），再改代码让它通过（GREEN）。所有测试用例尽量用**真实抓到的接口数据**，而不是自己编的格式。

### 6.2 真机验证（6 个脚本，31 项）

需要真实密钥：

```powershell
$env:SIYUAN_AI_KEY="你的密钥"

node tests/live.mjs          # 三种协议 + 思考档位（6 项）
node tests/live-template.mjs # 模板真的生效（4 项）
node tests/live-mcp.mjs      # 连官方 MCP 服务器，stdio + HTTP（5 项）
node tests/live-mcp-full.mjs # 全链路：真模型 + 真 MCP + 真工具调用（4 项）
node tests/live-fixes.mjs    # 本轮修复验证：Anthropic 开思考、工具映射、中文工具名（7 项）
node tests/live-phase5.mjs   # 真实报错翻译 + 真实对话存档（5 项）
```

**这些脚本的意义**：单元测试能抓「代码写错」，抓不到「真实服务端的行为和文档不一致」。上面 40 多个坑里，至少有 12 个是真机测试才发现的。

### 6.3 静态检查

```powershell
npx tsc --noEmit                              # 0 错误
npx svelte-check --threshold error            # 0 错误 0 警告
```

### 6.4 本机环境实测记录

| 项目 | 结果 |
|---|---|
| OpenAI 兼容协议 | 完全可用，流式正常 |
| Claude 原生协议 | 可用（修掉 temperature 冲突后），thinking 块能正确分离 |
| Gemini 原生协议 | **不可用**，该中转站没有这个端点（404），网关还要求另一套密钥 |
| glm-5.3 关闭思考 | **做不到**，只有 `low` 能压到零输出 |
| MCP stdio（官方测试服务器） | 可用，16 个工具，调用正常 |
| MCP HTTP（官方测试服务器） | 可用，16 个工具，调用正常 |

---

## 七、已知限制与风险

### 7.1 硬限制（改不了）

1. **Gemini 协议在本机无法验证**：中转站没这个端点。代码按官方规范写完并有契约测试，但没有真机证据。
2. **glm-5.3 关不掉思考**：服务端行为，最多压到 `low`。
3. **思考内容是否输出由模型自己决定**：同一个「低档」，一次实测 157 字思考，另一次 0 字。
4. **报错翻译是规则匹配**：一定会遇到翻译不出来的错误，那种情况保留原文。

### 7.2 灰色地带

**stdio MCP 依赖 Electron 的非公开能力**（`window.require` + `@electron/remote`）。思源未来版本若收紧，这个功能会失效。代码有检测，拿不到就禁用选项并给提示。

### 7.3 未验证的部分

**界面点击流程没有自动化测试**（按规矩不做 GUI 测试）。以下只能人工确认：

- 右键菜单能否打开面板
- 历史面板的点击与删除
- 模板管理的新建/编辑/排序
- MCP 页的添加/测试/删除

底层逻辑都有测试，但「点下去会不会真的触发」没测到。

---

## 八、开发命令速查

```powershell
# 装依赖
npm install

# 跑全部逻辑测试
npm test

# 构建
npm run build

# 构建 + 打包成 zip（等价于双击 一键打包.bat）
npm run pack

# 构建 + 安装到思源（自动找 Z:\siyuan）
npm run install-plugin

# 指定工作空间
npm run install-plugin -- Z:\siyuan

# 静态检查
npx tsc --noEmit
npx svelte-check --threshold error
```

### 一键打包（推荐给非开发者）

双击 `一键打包.bat` 即可。它会：

1. 检查 node 与必要文件
2. 当前目录没有依赖时，从主仓库临时 `mklink /J` 借用，用完自动删
3. 直接调 `node_modules\vite\bin\vite.js build` 构建
4. 直接调 `scripts\pack.mjs` 打包
5. 打印 `RESULT : SUCCESS` + zip 完整路径

**几条硬性约束（踩过坑，别改回去）：**

- bat 本体**必须纯 ASCII**（936 代码页会把中文注释当命令执行）
- **不要**在 bat 里调 `npm run xxx`，要直接调 `node 脚本.js`
- 每个 node 调用后加 `< nul`，避免子进程等键盘输入
- 成功判定看产物文件是否真的新生成，不能只信退出码

**安装位置**：`Z:\siyuan\data\plugins\siyuan-plugin-ai-chat\`
**需要文件**：`index.js`、`index.css`、`plugin.json`、`icon.png`、`net-proxy.cjs`

---

## 九、数据存放在哪里

全部在 `工作空间/data/storage/petal/siyuan-plugin-ai-chat/`：

| 文件 | 内容 |
|---|---|
| `settings.json` | 接口地址、密钥、模型、思考档位等 |
| `templates.json` | 提示词模板清单 |
| `mcp.json` | MCP 服务器配置 |
| `sessions.json` | 会话存档（最多 30 条） |

**API Key 是明文存的**，没有加密。思源本身是本地优先软件，这和工作空间里其他数据一个级别。别把工作空间截图公开。

---

## 十、如果以后要接着改

### 加一种新协议

1. 在 `providers.ts` 的 `Protocol` 加类型
2. `endpointFor` / `headersFor` 加分支
3. 写对应的 `xxxBody`
4. 在 `ProviderParser.handle` 加分支
5. **先写测试**（请求体 + 流式解析各几条），再写真机脚本

### 加一个新 MCP 传输

1. 实现 `connect()` / `callTool()` / `close()` 三个方法
2. 在 `mcp-connect.ts` 的 `createClient` 加分支
3. 用假 fetcher / 假 spawn 写契约测试

### 加一个新的模板变量

1. `template.ts` 的 `VARS` 加名字
2. `TemplateContext` 加字段
3. `renderTemplate` 的 `values` 加映射
4. `makeContext` 里算出该字段的值
5. `TemplateManager.svelte` 的变量按钮会自动跟着 `VARS` 变，无需改
6. 补测试（替换、未知变量保留、边界）

**注意**：`content` 这个变量已于 1.1.0 移除，不要再加回来——它依赖「素材」这一整套已删除的状态。

### 改界面时注意

1. 四个 UI 组件里只有 `ChatPanel.svelte` 常驻，其余三个是抽屉内的子组件
2. 子组件**不要**再自带 `overflow-y: auto` 和 `height: 100%`，滚动交给 `.drawer-body`
3. 子组件**不要**再放「返回」按钮，关闭统一用抽屉头的 ×
4. 改完跑 `svelte-check --threshold warning`，保持 0 错误 0 警告

### 改代码后必须做的检查

```powershell
npm test && npx tsc --noEmit && npx svelte-check --threshold error
```

改到协议或 MCP，还要跑对应的 `live*.mjs`。

---

## 十一、版本历史

### 1.1.0（2026-11-18）

在 1.0.0 基础上做了一次范围收窄 + 界面重做。

**1. 功能范围收窄为「自定义提示词 + MCP」**

- 删除「取选中内容」按钮与素材显示框
- 删除 `{{content}}` 变量（变量 5 → 4）
- 删除 `material` / `activeMaterial` / `lastSentMaterial` / `grabSelection` / `pushSelection`
- 内置 3 个模板去掉对 `{{content}}` 的引用
- 理由：实际使用方式是「内容直接敲进输入框」，素材这一层是死重量，只带来空框和误导

**2. 点模板的语义改变**

- 旧：点模板 = 清空对话 + 立刻发请求；没取素材时静默返回，看起来像按钮失灵
- 新：点模板 = **只绑定规则**，不清空、不发送；之后该对话每条消息都经过模板
- 「新对话」保留模板；只有点「退出「模板名」」才取消

**3. 界面整体重做**

- 提示词平铺一行（当前项蓝底高亮，末尾 `+` 进管理）
- MCP 常驻一行状态条（绿=已连 / 橙=失败 / 灰=未配置）
- 模型移到顶栏、思考档位移到输入框上方
- 对话改左右气泡（用户右蓝、AI 左灰）
- 设置 / 历史 / 模板管理 / MCP 由整页替换改为右侧抽屉

**4. 修复的两个真实 bug**

| bug | 症状 | 原因 | 修法 |
|---|---|---|---|
| 右键菜单无模板项 | 选中文字右键看不到「用模板：XXX」 | 只监听 `click-blockicon`（点块前小图标才触发） | 补挂 `open-menu-content` |
| 打包「成功」却没 zip | 第一次能打，删掉 zip 后再点就不出包 | `pack.mjs` 用 `createWriteStream` 异步写、无错误处理、失败仍打印「打包完成」 | 改 `writeFileSync` + 写后核对字节数 + 被占用时换名 |

**5. 新增一键打包**

- `一键打包.bat`（纯 ASCII，避免 GBK 代码页把中文注释当命令执行）
- 调 `scripts/oneclick-pack.mjs`，由 cmd 直接调 `vite.js` 与 `pack.mjs`，不经 npm
- 产出解压即用的 zip

**验证规模**：逻辑测试 562 项（新增模板绑定 9 项、模板与 MCP 共存 14 项），svelte-check 0 错误 0 警告，构建产物解压核对通过。

### 1.0.0（2026-11-18）

首个完整版本。五个阶段全部完成：

1. **骨架 + 网络 + 流式 + 复制**
2. **三种协议 + 六档思考**
3. **提示词模板 + 右键入口**
4. **MCP（三种传输 + 工具调用循环）**
5. **会话存档 + 报错翻译 + 一键安装**

外加一轮完整代码审查，修掉 19 个真实 bug（其中 3 个是「功能完全不能用」级别）。

测试规模：逻辑测试 550 项，真机验证 31 项，全部通过。
