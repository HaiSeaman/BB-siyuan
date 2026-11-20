# Release notes — v1.3.0

> 这份文件是给你手动发布 GitHub Release 用的。直接复制下面的文字填到发布页即可。
> 英文版在后面。文件名固定为 `siyuan-plugin-ai-chat-v1.3.0.zip`。

---

## 一、GitHub 发布页怎么填

| 字段 | 填什么 |
|---|---|
| **Tag** | `v1.3.0`（仓库里已有这个标签，选它） |
| **Release title** | `v1.3.0 — 重发不再多消息 · 拉取的模型点了能用 · 一键清空历史` |
| **Describe this release** | 复制下面「中文发布说明」整段 |
| **Attach binaries** | 上传 `siyuan-plugin-ai-chat-v1.3.0.zip` |
| **Set as the latest release** | 勾上 |

如果要照顾英文读者，可以在 Release 描述里先放中文、再放英文（本文最后有英文完整版）。

---

## 二、中文发布说明（直接复制）

```markdown
## v1.3.0

这个版本主要修三处「用起来别扭」的地方，另外给历史对话补了一键清空。

### 新增：我发的消息多了「复制」「重发」

- **复制**：点一下就复制自己发的那句话，不用手划选。
- **重发**：用这条原话重新生成，**回答直接替换原来那一条**。

重发**不会多出一条消息**。聊天记录里始终只有一组「原话 + 回答」，只是答案换成新的。
发给模型的历史也只截到这条之前，不会让它看着自己的旧答案再答一遍。
重发用的是**当前**绑定的提示词规则，不是当初那条消息用的规则。

生成过程中两个按钮都不让点，会提示「等这一轮结束」。

### 修复：从接口拉来的模型，选中后用不了

这是三个原因叠在一起：

1. **点模型名不会真的切过去**：在别的 API 卡片里点模型名，只改了「这套 API 记住哪个模型」，没改「当前用哪套 API」。所以顶栏还显示旧模型、发出去还是旧模型，看起来就是点了没反应。
2. **拉取后偷偷选中清单第一个**：中转站的模型清单头一项常是 `text-embedding-3-small` 这种不能聊天的，自动选中就必然报错。
3. **清单里混着不能聊天的模型**：`embedding`、`whisper`、`tts`、`rerank`、`dall-e`、`flux` 这些。

现在：点模型名会连 API 一起切，顶栏立刻变并提示「已切到 X」；拉取只往清单里加、不自动选；不能聊天的会被滤掉，并告诉你跳过了几个（名单刻意写得很窄，宁可漏也不误杀）。
另外，删掉当前模型时会优先退回**能聊天**的那个，而不是清单第一个。

### 改进：「清除所有模型」改为「清除其他模型」

只清**没选中**的，当前选中的一定保留。以前会把刚挑好的也一起清掉，等于白挑一次。
还会告诉你「清除另外 N 个，只留当前选中的「X」」。没选中模型时不会让你点；只剩一个时直接说没有可清除的。

### 新增：历史对话一键清空

历史抽屉里多了「清空全部历史（N 个）」，二次确认后全部删掉，不用一个个点 ×。
当前正在聊的内容也会一起清空，否则下一轮生成又会把它存回历史。

### 修复：设置改完又自己变回去

保存是延迟 400ms 写盘的，以前会把按下那一刻的旧配置排进队列，期间改的别的字段会被整份盖掉。
现在只有一条保存路，写盘前现取最新状态。

### 安装

1. 思源 → 设置 → 集市 → 已下载 → 插件 → 从压缩包安装
2. 选 `siyuan-plugin-ai-chat-v1.3.0.zip`
3. 启用「AI 对话」，重启思源

要求思源 **3.8.5** 以上。电脑、安卓、iOS 都能用。

**完整说明**见 [README.zh-CN.md](../README.zh-CN.md)。
```

---

## 三、英文发布说明（直接复制）

```markdown
## v1.3.0

Three annoyances fixed, plus a one-click "clear all history".

### New: Copy and regenerate on your own messages

- **Copy** — copy the message you sent, no manual selection needed.
- **Regenerate** — ask the model again with the same text and **replace the existing answer in place**.

Regenerate does **not** add a message pair. The conversation always keeps exactly one "your message + answer" group; only the answer changes.
The history sent to the model stops right before that message, so the model never sees its own previous answer.
Regeneration uses the template that is **currently** bound, not the one used originally.

Both buttons are disabled while an answer is streaming.

### Fixed: models fetched from the provider could not be used

Three causes stacked together:

1. **Clicking a model name did not switch the API.** It only changed "which model this API card remembers", not "which API is active". The top bar kept showing the old model and requests went to the old one — it looked like the click did nothing.
2. **Fetching auto-selected the first entry.** Relays often list `text-embedding-3-small` first, and selecting it guarantees a failed request.
3. **Non-chat models were mixed into the list** — `embedding`, `whisper`, `tts`, `rerank`, `dall-e`, `flux`.

Now: clicking a model name switches the API too, the top bar updates immediately and confirms with "switched to X"; fetching only appends names and never auto-selects; non-chat models are filtered out and the number skipped is reported (the list is deliberately narrow — a missed name just fails once, a wrong match would hide a usable model).
Deleting the current model also falls back to the next **chat-capable** model instead of the first entry.

### Changed: "Clear all models" is now "Clear other models"

Only models that are **not** selected get removed; the current one always stays. Previously it also wiped the model you had just picked.
The confirmation states exactly how many will go and which one will stay. You cannot trigger it without a selected model, and with only one model it says there is nothing to clear.

### New: Clear all chat history

The history drawer gained **Clear all history (N)** with a confirmation — no more deleting conversations one × at a time.
The conversation currently on screen is cleared as well; otherwise the next response would immediately save it back.

### Fixed: settings reverting themselves

Saving was debounced by 400 ms and queued the snapshot taken at the moment of the keystroke, so a later edit could be overwritten wholesale by stale data.
There is now a single save path that reads the latest state right before writing.

### Install

1. SiYuan → Settings → Marketplace → Downloaded → Plugins → Install from package
2. Choose `siyuan-plugin-ai-chat-v1.3.0.zip`
3. Enable **AI 对话** and restart SiYuan

Requires SiYuan **3.8.5** or newer. Works on desktop, Android, and iOS.

**Full documentation:** [README.md](../README.md).
```

---

## 四、给发布页用的英文短摘要（列表页会显示，可填在 description 里）

> Prompt-driven AI panel for SiYuan Note: multiple APIs and models, streaming answers, prompt templates, MCP tools, chat history, mobile support. Read-only — it never writes to your notes. v1.3.0 adds copy/regenerate, fixes model selection after fetching, keeps your selected model when cleaning up the list, and adds one-click history clearing.

---

## 五、发布前的自检清单

发布前请逐条确认（这些我都已经验证过，你只要确认结果即可）：

1. `plugin.json` 里的 `version` 是 `1.3.0`
2. 待上传的文件名是 `siyuan-plugin-ai-chat-v1.3.0.zip`
3. 压缩包里 `plugin.json` 在**根部**（不是套一层文件夹）
4. 包内共 5 个文件：`plugin.json`、`index.js`、`index.css`、`icon.png`、`net-proxy.cjs`
5. 仓库里已有 tag `v1.3.0`
6. `README.md`（英文）与 `README.zh-CN.md`（中文）都在仓库根部
