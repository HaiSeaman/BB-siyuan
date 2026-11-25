# 测试指南

> 这个项目按铁律**不做 GUI 点击测试**（不弹窗、不开浏览器、不启桌面软件）。但界面按钮能不能点，照样能验证 —— 见第三节。

当前版本：**1.4.0** ｜ [English](TESTING.en.md)

**当前规模：50 个测试文件 / 1496 项断言，全部通过。**

---

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
npx svelte-check --tsconfig ./tsconfig.json   # 类型与模板检查
```

---

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

---

## 三、无界面验证界面真能点（重点）

### 为什么

静态读代码**看不出**「点了没反应」。真实例子：`$: canThink = supportsThinking(currentModel())` 读了一个还没赋值的 `$:` 变量，抛错后整块界面渲染中止 —— 代码看着完全正常，只有真挂起来点一次才会暴露。

### 依赖（只在 devDependencies，不进插件包）

```
linkedom                  纯 JS 的 DOM 实现
esbuild-svelte / vite     把 .svelte 编译成可 import 的 JS
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
| **多段测试共用一个模块** | 上一段改的 store 漏到下一段 | 每次 `import(url + "?fresh=" + n)` 拿新实例 |
| **net.ts 缓存了 bridge** | 换了假 bridge 却不生效 | 每个场景重新 import 一份 net 模块 |
| **测试自己编的路径** | 代码拼错了测试照样绿 | 从真实配置读（见第五节） |

### 关于 store 隔离（重要）

设置 store 是**模块级单例**。段与段之间会串味：上一段把模型切成画图模型，下一段明明 `props` 里是聊天模型，界面却已经进了生图模式。

```js
let seq = 0;
async function freshPanel() {
    seq++;
    return (await import(pathToFileURL(bundle).href + "?fresh=" + seq + "-" + Date.now())).default;
}
```

注意：**不要去改生产代码把它变成每次重置**。真实运行时 store 就该跨挂载保留（切侧栏再打开配置还在），那是对的。

---

## 四、现有面板测试覆盖

### `tests/panel-render.test.mjs`（79 项）

**基础交互**

- 点设置 → 抽屉打开、有内容
- 点 × → 关掉
- 点新对话 → 不报错、界面还在
- 点模型按钮 → 切换器出现、在 layer 里
- 点另一个模型 → 切换器关闭、顶栏真的变了
- 点遮罩 → 关闭
- 点管理 → 打开模板抽屉
- 手机端形态 → 底部弹出、不盖顶栏

**我发的消息：复制 / 重发**

- 我的气泡下面确实有两个按钮
- 点复制不崩、界面还在
- **点重发后消息条数不变**（不能新增一组）
- 载入两轮对话后重发**中间那条**，后面的对话不会被挤掉

**设置页：点模型名要真的切过去**

- 先切回 A，再点 B 卡片里的模型名
- **顶栏必须真的变成 n1**（这是「点了没反应」的原始 bug）

**清除其他模型**

- 新建一张卡塞三个模型、选中中间那个
- 点「清除其他模型」后**只剩一个**，且**留下的是选中的那个**

**历史对话一键清空**

- 确认后全部消失、提示「已清空」
- **点取消时一条都不能少**

### `tests/panel-image-mode.test.mjs`（119 项）

- 选画图模型 → **自动进生图模式**（提示条出现、模板条/MCP 条收起、按钮变「生成」）
- **4 个按钮全在**，且在思考档位右边，顺序 上传 → 大小 → 尺寸 → 优化
- 大小菜单四档、比例菜单十种
- 上传：格式校验（GIF 被拦）、参考图条、点 × 去掉
- 优化：没有聊天模型时说人话、**一个请求都不发**
- **点生成时请求体正确**：`/images/generations`、model、prompt、size、base64
- **有参考图时走 `/images/edits` + multipart**
- 图片卡片两个按钮、读不到时给原因 + 重试
- 生图/对话来回切，模型跟着换
- 没有画图模型时点「生图」不硬切，给明确提示
- 生成中按钮禁用、点停止能停下
- **点停止后晚到的结果不能写进对话**
- 手机端四个按钮也在

### `tests/panel-fixes.test.mjs`（35 项）

用**主人真实配置**（`gemini-3.1-flash-image`）跑的：

- 这个模型名要能自动进生图模式，不再说"没有模型"
- 4 个按钮位置正确（思考在最左，上传在它右边，依次到优化）
- 图片底下**正好两个**按钮（复制图片、保存到电脑）
- **真实那条 964KB 的 base64 消息**能被抽成图片卡片，base64 不再当正文显示

### `tests/panel-multi-pick-image.test.mjs`（17 项）

- 顶栏只列**勾过的**模型；一个没勾就退回全部
- 图片能读到 → 渲染 `<img>` 且 `src` 是真 data URL
- 读不到 → 显示原因 + 重试，**点重试真的再请求一次并能恢复**
- `content-type` 是 `octet-stream` 但字节是图也要能显示

### `tests/panel-folder-size.test.mjs`（23 项）

- 「图片」按钮在思考右边、上传左边
- 点它**调用了 `shell.openPath`**，且路径里有 `petal` 和 `images`
- **路径里只有一层 data**（不出现 `data\data`）
- 失败时给原因 + 路径；手机端说清不能打开
- 尺寸下拉四档，2K 那项写着长边 2560
- 1K + 16:9 显示 1920 × 1080

### `tests/panel-realpath.test.mjs`（6 项）

用**真实 `conf.json` 里的 dataDir** 跑面板，验证按钮传给 `openPath` 的路径
**完全等于** `Z:\siyuan\data\storage\petal\siyuan-plugin-ai-chat\images`，且该目录真实存在。

> 这一条是「测试别自己编环境」的正面例子：早期版本的测试把 `dataDir` 编成 `Z:\siyuan`（真实是 `Z:\siyuan\data`），假 `fs.existsSync` 一律返回 false，于是代码多拼一层 `data\` 造出不存在的路径，测试照样全绿。

---

## 五、数据层与工具层测试

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `image.test.mjs` | 114 | 尺寸换算（4 档 × 10 比例都是 8 的倍数）、官方尺寸表、接口地址、multipart 字节、返回解析、文件名 |
| `apis.test.mjs` | 72 | 模型清洗、拉取、合并、分类 |
| `image-model-detect.test.mjs` | 30 | `gemini-3.1-flash-image` 认成画图、反例不误伤、手动标记兜底、老配置升级 |
| `inline-image.test.mjs` | 33 | 从正文抽图片（base64 / 网址 / 多张）、别误伤普通链接、该不该搬盘 |
| `optimize.test.mjs` | 42 | 提示词清洗（去围栏/引号/前缀）、空话判定、错误翻译 |
| `image-sessions.test.mjs` | 26 | 图片消息存档、**图片数据绝不进 JSON**、张数上限 |
| `chat-model-pick.test.mjs` | 51 | `chatApiFor` 六种场景、`packModelRef`、分类标签 |
| `multi-pick-image.test.mjs` | 25 | 多选勾选、正在用的不能取消、至少留一个、字节嗅探 |
| `size-clear-folder.test.mjs` | 27 | 四档尺寸、清除保留勾选的、`pickedOf` 兜底 |
| `open-folder.test.mjs` | 20 | 路径拼接三种 dataDir 形式、目录不存在、手机端、四层兜底 |
| `net-native-merged.test.mjs` | 16 | 桌面通道：200/401/多段/错误/超时/bytes |
| `review-fixes.test.mjs` | 34 | 本轮审查的 10 个修复，每条一个断言组 |
| `providers.test.mjs` | 60 | 三种协议构造与解析 |
| `sessions.test.mjs` | 37 | 存档清洗、上限、标题 |
| `mcp-*.test.mjs` | 154 | JSON-RPC、HTTP、SSE、stdio、生命周期、工具循环 |
| 其余 | — | 模板、token、错误、迁移、设置 |

---

## 六、布局守卫测试

`tests/panel-layout.test.mjs` 直接读 `src/ui/ChatPanel.svelte` 源码和 `dist/index.css`，断言：

- `.panel` 必须有 `position: relative`
- 遮罩必须在 `.picker-layer` 里
- layer 必须 `top: 40px`（避开顶栏）
- layer 必须 `pointer-events: none`

`tests/mask-geometry.test.mjs` 用几何模型复现历史故障：算出遮罩实际覆盖哪块区域，验证顶栏按钮不会被盖住。

**这两类测试是「防复发」的**，改动布局后请务必跑一遍。

---

## 七、验证测试真的有效（必做）

写完修复测试后，**临时把修复撤掉**，确认测试会报红。

```js
// 思路：备份源文件 → 改回旧写法 → 跑测试 → 确认失败数 > 0 → 复原
copyFileSync(file, backup);
writeFileSync(file, brokenSource);
const failed = runTest();          // 应当 > 0
copyFileSync(backup, file);
```

实测记录（v1.4.0）：

| 撤掉的修复 | 测试报红 |
|---|---|
| 正文插图文件名下标 | 2 项 |
| 生图 `finally` 里的 `generating` 守卫 | 1 项 |

> 注意：撤的时候**只改回原写法，别顺手改动依赖关系**。依赖图一变，测试可能就复现不出来，白测一轮。

---

## 八、真实接口验证（手动，可选）

`tests/live*.mjs` 会连真实服务商，需要自己填密钥：

```powershell
$env:SIYUAN_AI_KEY="你的密钥"
node tests/live.mjs            # 三种协议 + 思考档位
node tests/live-template.mjs   # 模板是否真的生效
node tests/live-mcp.mjs        # 真 MCP 服务器
node tests/live-mcp-full.mjs   # 全链路：真模型 + 真 MCP + 真工具调用
```

这些**不在 `npm test` 里**（会花钱、依赖网络），只在需要时手动跑。

生图可以这样直接验（不需要插件）：

```powershell
# 换成你自己的地址、密钥、模型名
$body = @{ model='your-image-model'; prompt='a red apple'; n=1; size='2560x1440'; response_format='b64_json' } | ConvertTo-Json -Compress
Invoke-WebRequest -Uri 'https://your-relay/v1/images/generations' -Method POST `
  -Headers @{ Authorization='Bearer YOUR_KEY'; 'Content-Type'='application/json' } `
  -Body $body -TimeoutSec 180
```

能返回 `data[0].b64_json` 就说明服务商支持这个尺寸。

---

## 九、交付前自检清单

1. `npx svelte-check --tsconfig ./tsconfig.json` → 必须是 `0 errors and 0 warnings`
2. `npm test` → 必须是 `全部测试通过`，并记下文件数与断言数
3. `npm run pack` → 确认 `plugin.json` 在 zip **根部**
4. 解压 zip 独立核对（别只信打包脚本）：

```powershell
$tmp = "$env:TEMP\chk"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path 'siyuan-plugin-ai-chat-v1.4.0.zip' -DestinationPath $tmp
$pj = [IO.File]::ReadAllText("$tmp\plugin.json") | ConvertFrom-Json
$js = [IO.File]::ReadAllText("$tmp\index.js")
Write-Output $pj.version
Write-Output ($pj.frontends -contains 'mobile')
Write-Output $js.Contains('images/generations')
Write-Output $js.Contains('openPath')
```

> 读产物必须用 `[IO.File]::ReadAllText`，别用 `Get-Content -Raw` 或 `findstr` 匹配中文 —— 会被编码搞坏，误报「没找到」。

5. 装进思源后按字节再核一遍关键功能字符串：

```powershell
node -e "const fs=require('fs');const p='Z:/siyuan/data/plugins/siyuan-plugin-ai-chat/';const js=fs.readFileSync(p+'index.js','utf8');for(const k of ['images/generations','openPath','image/jpeg']){console.log(k+' -> '+js.includes(k))}"
```

**注意：** 构建会压缩代码，函数名会被改名。核对时用**功能特征字符串**（中文文案、URL 片段、错误提示），别查函数名。

---

## 十、测试数量的意义

**1496 项 / 50 个文件**（v1.4.0）。

数量不是目标，但它能说明一件事：改动越大，越需要「同样的输入必须得到同样的输出」来兜住。

这一轮从 841 项涨到 1496 项，加的都是**以前只能靠人点或靠猜**的地方：

- 生图请求体到底长什么样（`/images/generations` 还是 `/edits`、multipart 有没有 boundary）
- 尺寸换算对不对（1K + 16:9 必须正好 1920×1080）
- 图片类型要不要按字节判断
- 点「停止」之后晚到的结果会不会偷偷写进对话
- 清除模型时勾选的会不会被误删
- 「图片」按钮传出去的路径到底指哪儿

**它们不是装饰**：本轮 10 个修复，每一条都补了能在撤掉修复时变红的断言。
