# 测试指南

> 这个项目按铁律**不做 GUI 点击测试**（不弹窗、不开浏览器、不启桌面软件）。但界面按钮能不能点，照样能验证 —— 见第三节。

## 一、跑测试

```powershell
npm test
```

它会先 `npm run test:build`（把 `.ts` / `.svelte` 编译到 `.test/`），再逐个跑 `tests/*.test.mjs`。

**看结果：** 最后一行 `全部测试通过` 才算成功；只要有文件失败，最后会打印 `N 个测试文件失败`，退出码非 0。

其他命令：

```powershell
npm run test:build   # 只编译测试产物
npm run build        # 正式构建到 dist/
npm run pack         # 构建 + 打 zip
npx svelte-check --threshold error   # 类型与模板检查
```

## 二、测试文件怎么组织

- 每个文件独立跑，自己统计 `pass` / `fail`，最后 `process.exit(fail === 0 ? 0 : 1)`
- 统一风格：`check("名字", 实际值, 期望值)`，用 `JSON.stringify` 比较
- 只测纯逻辑（`src/*.ts`），不 import Svelte 组件（除非用第三节的办法）

新增测试文件后，**必须加进 `tests/all.mjs` 的 `files` 数组**，否则不会自动跑。

### 纯逻辑测试的写法

```js
// 从 .test/ 里 import 编译产物，不是 src
import { parseModelList } from "../.test/apis.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { pass++; console.log("  OK   " + name); }
    else {
        fail++;
        console.log("  FAIL " + name);
        console.log("       实际: " + JSON.stringify(actual));
        console.log("       期望: " + JSON.stringify(expected));
    }
}
```

## 三、无界面验证界面真能点（重点）

### 为什么要这么做

静态读代码**看不出**「点了没反应」。真实例子：`$: canThink = supportsThinking(currentModel())` 读了一个还没赋值的 `$:` 变量，抛错后整块界面渲染中止 —— 代码看着完全正常，只有真挂起来点一次才会暴露。

### 依赖（只在 devDependencies，不进插件包）

```
linkedom       纯 JS 的 DOM 实现
esbuild-svelte / vite   把 .svelte 编译成可 import 的 JS
```

### 流程

1. 用 **Vite**（和正式构建同一条链）把 `ChatPanel.svelte` 打成 `.mjs`
2. 用 `linkedom` 造一个假 `window` / `document`，塞进 `globalThis`
3. `new ChatPanel({ target: host, props })` 真实挂载
4. `querySelector` 找按钮，`dispatchEvent(new Event("click"))`
5. **等一拍**（Svelte 更新是微任务）再断言 DOM 变化

```js
const tick = () => new Promise((r) => setTimeout(r, 0));

click(gear);
await tick();                       // ← 少了这行会误判成「没反应」
ok("抽屉出现了", !!$(".drawer"));
```

### 几个必踩的坑

| 坑 | 症状 | 解法 |
|---|---|---|
| 用 `esbuild-svelte` 打包子组件 | `SettingsPanel is not defined` | **改用 Vite** 构建测试包 |
| 忘了 `await tick()` | 状态没变，误判成 bug | 每次 click 后等一拍 |
| `linkedom` 没有 `MouseEvent` | `not a constructor` | 用 `new window.Event("click", {bubbles:true})` |
| `globalThis.navigator` 只读 | `Cannot set property` | `Object.defineProperty(globalThis, "navigator", {...})` |
| Windows 上 `import(绝对路径)` | `ERR_UNSUPPORTED_ESM_URL_SCHEME` | 用 `pathToFileURL(p).href` |

### 现有实现

见 `tests/panel-render.test.mjs`，**79 项断言**，覆盖：

**基础交互**

- 点设置 → 抽屉打开、有内容
- 点 × → 关掉
- 点新对话 → 不报错、界面还在
- 点模型按钮 → 切换器出现、在 layer 里
- 点另一个模型 → 切换器关闭、顶栏真的变了
- 点遮罩 → 关闭
- 点管理 → 打开模板抽屉
- 手机端形态 → 底部弹出、不盖顶栏

**我发的消息：复制 / 重发**（v1.3.0）

- 我的气泡下面确实有两个按钮（复制、重发）
- 点复制不崩、界面还在
- **点重发后消息条数不变**（不能新增一组）
- **我发的消息仍然只有一条**，原话一字不差
- 载入两轮对话后重发**中间那条**，后面的对话不会被挤掉、顺序不乱

**设置页：点模型名要真的切过去**（v1.3.0）

- 先切回 A，再点 B 卡片里的模型名
- **顶栏必须真的变成 n1**（这是「点了没反应」的原始 bug）
- 给出「已切到 X」的提示

**清除其他模型**（v1.3.0）

- 新建一张卡塞三个模型、选中中间那个
- 点「清除其他模型」后**只剩一个**
- **留下的是选中的 `m-two`**，不是清单第一个
- 留下的那个仍是选中态

**历史对话一键清空**（v1.3.0）

- 有「清空全部历史」按钮，按钮上写了几条
- 确认后历史全部消失、提示「已清空」
- **点取消（confirm 返回 false）时一条都不能少**

> 这些测试不是装饰：开发时临时撤掉修复重跑，会分别报红「消息条数不变 → 2 → 4」「只剩一个模型 → 实际 0」「历史被清空了 → 还剩 2」。新增功能时请保持这个习惯 —— 先证明测试能抓到 bug，再相信它。

## 四、布局守卫测试

`tests/panel-layout.test.mjs` 直接读 `src/ui/ChatPanel.svelte` 源码和 `dist/index.css`，断言几条硬规矩：

- `.panel` 必须有 `position: relative`
- 遮罩必须在 `.picker-layer` 里
- layer 必须 `top: 40px`（避开顶栏）
- layer 必须 `pointer-events: none`

`tests/mask-geometry.test.mjs` 用几何模型复现历史故障：算出遮罩实际覆盖哪块区域，验证顶栏按钮不会被盖住。

**这两类测试是「防复发」的**，改动布局后请务必跑一遍。

## 五、真实接口验证（手动，可选）

`tests/live*.mjs` 会连真实服务商，需要自己填密钥：

```powershell
$env:SIYUAN_AI_KEY="你的密钥"
node tests/live.mjs            # 三种协议 + 思考档位
node tests/live-template.mjs   # 模板是否真的生效
node tests/live-mcp.mjs        # 真 MCP 服务器
node tests/live-mcp-full.mjs   # 全链路：真模型 + 真 MCP + 真工具调用
```

这些**不在 `npm test` 里**（会花钱、依赖网络），只在需要时手动跑。

## 六、交付前自检清单

1. `npx svelte-check --threshold error` → 必须是 `0 errors and 0 warnings`
2. `npm test` → 必须是 `全部测试通过`
3. `npm run pack` → 确认 `plugin.json` 在 zip **根部**
4. 解压 zip 独立核对（别只信打包脚本）：

```powershell
$tmp="$env:TEMP\chk"
Expand-Archive -Path 'siyuan-plugin-ai-chat-v1.3.0.zip' -DestinationPath $tmp -Force
$j = [IO.File]::ReadAllText("$tmp\plugin.json") | ConvertFrom-Json
$js = [IO.File]::ReadAllText("$tmp\index.js")
Write-Output $j.version
Write-Output ($j.frontends -contains 'mobile')
Write-Output $js.Contains('切换模型')
```

> 读产物必须用 `[IO.File]::ReadAllText`，别用 `Get-Content -Raw` 或 `findstr` 匹配中文 —— 会被编码搞坏，误报「没找到」。

## 七、数据层的回归测试（v1.3.0 新增）

`tests/model-picking.test.mjs`，**27 项**，专治这轮修的几个数据层 bug。它和界面测试互补：界面测试证明「点得动」，这里证明「点完之后数据真的对」。

| 断言组 | 防的是什么 |
|---|---|
| 点模型名必须把 `activeApiId` 一起切过去 | 只改 model 不改 API → 顶栏不变、发出去还是旧模型 |
| 在**非当前** API 上点模型也要生效 | 同上，换一张卡就不管用了 |
| 点到不存在的 API 不能把状态弄坏 | `activeApiId` 悬空，整个面板拿不到配置 |
| 清除其他模型：只留选中的 | 把刚挑好的那个也清掉 |
| 没选中模型时不许乱清 | 空 `model` 时误清空清单 |
| 只剩一个模型时清除不报错也不变 | 边界情况 |
| 删掉当前模型后优先退回能聊天的 | 退回到 embedding 那种一发就 400 |
| **保存必须写最新状态** | 连续两次改动被旧快照覆盖 |
| 拉取不会自动选中第一个 | 自动选中 embedding |
| 拉取结果里不能混进 embedding | 清单污染 |

> 其中「保存必须写最新状态」这条有讲究：两次 `updateSettingsWith` 必须传**同一个 `persist`**，否则后一次会把前一次的保存回调覆盖掉，测试反而测不到东西。真实界面里两处用的都是同一个 `persist`，所以这样写才是对的。

## 八、拉取模型的解析测试

`tests/apis.test.mjs`，**72 项**，其中 v1.3.0 新增的部分：

- `isChatModel` 的判定：`glm-5.3` 能、`text-embedding-3-small` 不能、`BAAI/bge-m3` 不能、`whisper-1` 不能、`tts-1` 不能、`dall-e-3` 不能、`black-forest-labs/flux-schnell` 不能、`llama-3-70b` 不被误杀
- `splitChatModels` 能正确报告「跳过了几个」
- `fetchModels` 拉到混合清单时只留能聊天的，并带上 `skipped` 计数
- **全被滤掉时兜底全放出来**（不能因为名单误杀就给用户一个空清单）

## 九、测试数量的意义

当前 **841 项 / 33 个文件**（v1.3.0）。

**数量不是目标**，但它能说明一件事：改动越大，越需要「同样的输入必须得到同样的输出」这类断言来兜住。

这一轮从 744 项涨到 841 项，加的都是**以前只能靠人点**的地方：重发到底有没有多出一条、点模型名顶栏有没有跟着变、清除是不是只清了没选中的、清空历史会不会误删。
