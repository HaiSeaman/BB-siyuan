# AI Chat for SiYuan

An AI assistant panel for [SiYuan Note](https://b3log.org/siyuan/). Pick a prompt template, write your request, get a streamed answer, copy it back into your notes.

> **Read-only by design.** The plugin never inserts, edits, or overwrites your notes. Answers are shown in the panel and you copy them yourself. Nothing is written to your workspace without you.

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Testing](docs/TESTING.md) · [Changelog](docs/CHANGELOG.md)

---

## Table of contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Multiple APIs and models](#multiple-apis-and-models)
- [Prompt templates](#prompt-templates)
- [Copy and regenerate](#copy-and-regenerate)
- [Thinking effort](#thinking-effort)
- [MCP tools](#mcp-tools)
- [Chat history](#chat-history)
- [Mobile](#mobile)
- [Providers and protocols](#providers-and-protocols)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Privacy and safety](#privacy-and-safety)
- [Known limitations](#known-limitations)

---

## Features

| Feature | What it does |
|---|---|
| **Prompt templates** | Save reusable system prompts. Tap one to apply it; every message in that conversation follows it. Built-in examples included. |
| **Multiple APIs and models** | Keep several endpoints side by side (protocol + URL + key + model list). Switch from the top bar in one click. |
| **Pull model lists** | Fetch the model list from your provider (`/models`). Non-chat models such as `embedding`, `whisper`, `tts` are filtered out and reported. |
| **Streaming answers** | Token-by-token output on desktop, rendered as Markdown. |
| **Copy / regenerate** | Copy your own message or an answer. Regenerate replaces the answer in place — no duplicate messages. |
| **Thinking effort** | Six levels, translated per vendor (GLM, DeepSeek, GPT/o-series, Claude, Gemini, Kimi, Qwen, MiniMax). |
| **MCP tools** | Connect MCP servers over HTTP, SSE, or a local command. Tools are passed to the model and called automatically. |
| **Chat history** | Last 30 conversations saved automatically. Reopen, continue, delete one, or clear all. |
| **Mobile support** | Works on Android / iOS SiYuan. Requests are relayed by the SiYuan kernel, so no CORS problems. |
| **Friendly errors** | HTTP and model errors are translated into plain-language hints with a next step. |

---

## Install

### From the release zip

1. Download `siyuan-plugin-ai-chat-v1.3.0.zip` from the release page.
2. In SiYuan: **Settings → Marketplace → Downloaded → Plugins → Install from package**, choose the zip.
3. Enable **AI 对话** and restart SiYuan.

### Manual copy

Extract the zip so that `plugin.json` sits directly inside the plugin folder:

```
<your-workspace>/data/plugins/siyuan-plugin-ai-chat/
├── plugin.json
├── index.js
├── index.css
├── icon.png
└── net-proxy.cjs
```

> `plugin.json` **must** be at the root of that folder, not one level deeper.

### Requirements

- SiYuan **3.8.5** or newer.
- Desktop: Windows, macOS, or Linux.
- Mobile: Android, iOS, or HarmonyOS.

---

## Quick start

1. Open the panel: click the **AI 生成** icon at the bottom of the right sidebar, use the top-bar plugin menu, or press `Alt+Ctrl+A`.
2. Open **⚙ Settings → API and models**.
3. Fill in one API card:
   - **Protocol**: `OpenAI compatible` for most relay services.
   - **Base URL**: e.g. `http://127.0.0.1:8080/v1`.
   - **API key**: your key.
   - **Model**: type a name, or click **Fetch from API**.
4. Click **Test this API** — you should see the model reply.
5. Back in the panel, type your request and press `Ctrl+Enter` (or click **Send**).

---

## Multiple APIs and models

Each **API card** holds one protocol, one base URL, one key, and its own list of models. Temperature, thinking level, and history length are global.

- **+ Add API** creates another card.
- **Set as current** makes that card active.
- **Click a model name** to switch to it immediately. The top bar updates and a confirmation appears.
- **×** removes one model.
- **Clear other models** keeps the model currently selected and deletes the rest — handy after pulling dozens of models.

### Pulling a model list

Click **Fetch from API**. The plugin calls the provider's model-list endpoint and merges the result into the current list.

Two rules worth knowing:

1. **Nothing is auto-selected.** Pulling only adds names. Relays often list `text-embedding-3-small` first; auto-selecting it would make the next request fail.
2. **Obvious non-chat models are filtered** — `embedding`, `bge`, `whisper`, `tts`, `rerank`, `moderation`, `dall-e`, `gpt-image`, `stable-diffusion`, `sdxl`, `flux`. The result tells you how many were skipped. Models that merely look suspicious are shown dimmed instead of being removed.

If your provider does not expose a model list, just type the model name.

---

## Prompt templates

A template's body becomes the **system prompt** — the rules the model follows.

| Variable | Meaning |
|---|---|
| `{{date}}` | Today's date, e.g. `2026-11-20` |
| `{{time}}` | Current time, e.g. `21:30` |
| `{{weekday}}` | Day of the week |
| `{{doc_title}}` | Title of the document open right now |

Notes:

- **Tap to apply, not to send.** Tapping a template only binds the rules. You still write and send your own message.
- **Applied templates persist** across every message in the conversation, including follow-ups, until you tap **Exit**.
- **Single braces are not variables.** `{like this}` is sent to the model verbatim. Use double braces.
- **Three built-in examples** are included and can be edited or deleted. Deleting all of them restores the defaults, so the list is never empty.

### Right-click menu

Right-click anywhere in a note to find **AI 生成（open panel）** plus one entry per template. Choosing a template applies it and opens the panel — it does not send anything.

---

## Copy and regenerate

Both buttons appear under **your own** messages.

| Button | Behaviour |
|---|---|
| **Copy** | Copies the text of that message. Uses the Android native bridge on mobile, then `navigator.clipboard`, then `execCommand`. |
| **Regenerate** | Re-asks the model with the same text and **replaces the existing answer in place**. |

Regenerate does **not** add a new message pair. The conversation always holds exactly one "your message + answer" group for that question. The history sent to the model is truncated to everything *before* that message, so the model never sees its own previous answer.

Regeneration uses the template that is **currently** bound, not the one used originally — useful when you have changed the rules and want the answer redone under them.

Both buttons are disabled while a response is streaming.

---

## Thinking effort

Six levels: **Off / Minimal / Low / Medium / High / Max**. The plugin translates them into whatever the selected model understands.

| Model family | What gets sent |
|---|---|
| GLM | `low` / `high` / `max` (no medium, cannot truly disable) |
| DeepSeek | `high` / `max` (v4 accepts `high` for lower levels) |
| GPT / o-series | `minimal` / `low` / `medium` / `high` |
| Claude (native) | `thinking.budget_tokens` + `effort` |
| Claude (OpenAI-compatible) | `low` / `medium` / `high` |
| Gemini | `thinkingLevel`: `LOW` / `MEDIUM` / `HIGH` |
| Kimi / Qwen / MiniMax | `minimal` / `low` / `medium` / `high` |

If the model name is unrecognised, no thinking parameter is sent at all — that avoids `400` errors from strict gateways.

> **Measured behaviour:** on the author's relay, `glm-5.3` cannot fully disable thinking. `reasoning_effort=low` is the only value that suppresses the reasoning output. Even then the model sometimes emits reasoning anyway; that is the model's own behaviour. Turn off **Show reasoning** if you don't want to see it.

---

## MCP tools

The plugin ships **no** MCP servers. You add your own.

### Adding a server

1. Open **MCP** from the panel.
2. Click **+ Add HTTP** or **+ Add local command**.
3. Fill in a name (the model uses it to tell tools apart) and the URL or command.
4. Save and click **Test all servers**.

| Type | What you fill in | Where it works |
|---|---|---|
| HTTP | URL, e.g. `http://127.0.0.1:3000/mcp` | Everywhere |
| SSE (legacy) | URL | Everywhere |
| Local command | Command + args, e.g. `npx` `-y @modelcontextprotocol/server-time` | Desktop only |

A ready-made server to try:

```text
npx -y @modelcontextprotocol/server-everything
```

### How the model uses tools

Connected tools are added to the request's `tools` field. When the model decides to call one, the panel shows **"Calling tool: server / tool"**, sends the result back, and the model continues. A round limit (default 8) prevents infinite loops.

### Safety boundaries

- Local commands are spawned **without a shell**; arguments are passed separately, so an injected `&` or `|` cannot execute.
- Tools whose names contain `delete`, `write`, `update`, `remove`, `insert`, or `create` are flagged as write operations internally, but they are **still executed**. Only connect MCP servers you trust.
- Each server connects independently; one failure does not break the others.
- Tool names are sanitised to ASCII for the model and mapped back to the original name before execution.

---

## Chat history

Everything is saved automatically after each completed response.

- Up to **30** conversations, newest first.
- Click a conversation to reopen and continue it.
- **×** deletes one; **Clear all history** deletes every one after a confirmation.
- Clearing also resets the conversation currently on screen — otherwise the next response would immediately save it again.
- Identical content is not re-saved, so the list order does not jump around.
- The bound template is **not** saved with the conversation. Re-apply it after switching back.

---

## Mobile

| Aspect | Desktop | Mobile |
|---|---|---|
| Request path | Plugin's Electron main-process proxy | SiYuan kernel relay (`/api/network/forwardProxy`) |
| Rendering | Token-by-token streaming | Full answer appears at once |
| Sending | `Ctrl+Enter` | Tap **Send** (soft keyboard send key also works) |
| Model picker | Dropdown from the top bar | Bottom sheet |
| Clipboard | `navigator.clipboard` | Android native bridge, then fallbacks |
| Local MCP | Supported | Not available (no `require`) |

To make the panel easy to reach on mobile: **Settings → Appearance → Sidebar** and enable **AI 生成**.

---

## Providers and protocols

| Protocol | Chat endpoint | Auth header |
|---|---|---|
| OpenAI compatible | `{base}/chat/completions` | `Authorization: Bearer` |
| Claude native | `{base}/v1/messages` | `x-api-key` + `anthropic-version` |
| Gemini native | `{base}/v1beta/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key` |

For model lists: `{base}/models`, `{base}/v1/models`, `{base}/v1beta/models` respectively.

Any OpenAI-compatible gateway (relay services, Ollama, vLLM, LM Studio, one-api, etc.) works with the first protocol.

---

## Configuration reference

### Per API card

| Field | Description |
|---|---|
| Name | Display label, e.g. `Relay A` |
| Protocol | `openai`, `anthropic`, or `gemini` |
| Base URL | Endpoint root |
| API key | Stored in plain text in the plugin data folder |
| Models | List of model names for this endpoint |
| Model | The currently selected model |

### Global preferences

| Field | Default | Description |
|---|---|---|
| Temperature | `0.7` | Sampling temperature |
| Max output tokens | `4096` | Upper bound for the answer |
| Thinking | `high` | Thinking effort level |
| Show reasoning | off | Display the model's reasoning block |
| Context messages | `10` | How many past messages to send |
| Context limit | `200000` | Token budget; `0` disables the check |
| Max tool rounds | `8` | Tool-call iterations per turn |

### Where data is stored

| File | Contents |
|---|---|
| `settings.json` | APIs, active API, global preferences |
| `templates.json` | Prompt templates |
| `mcp.json` | MCP server definitions |
| `sessions.json` | Chat history |

All of it lives under `<workspace>/data/storage/petal/siyuan-plugin-ai-chat/`. **Keys are stored unencrypted** — do not publish screenshots that show them.

---

## Troubleshooting

| Message | Meaning |
|---|---|
| Invalid or expired API key | Check the key |
| Endpoint not found | Check whether the base URL should end in `/v1` |
| Request rejected (400) | Usually a wrong model name |
| Provider error (500/502) | The provider's side — wait and retry |
| Content too long | Start a new chat, or send a shorter message |
| Local MCP program failed to start | Check the command and arguments |
| Model not found | The name is not in the provider's list — pull the list again |

If an error is not recognised, the original text is shown so you can search for it.

---

## Development

```powershell
npm install
npm test                 # 841 assertions across 33 files
npm run build            # build to dist/
npm run pack             # build + create the installable zip
npm run install-plugin   # build + copy into your SiYuan workspace
```

Useful extra commands:

```powershell
npx svelte-check --tsconfig ./tsconfig.json   # type and template check
node scripts/oneclick-pack.mjs                # build + pack in one step
```

### Layout

```
src/
├── index.ts              plugin entry: dock, command, top bar, context menu
├── net.ts                three request channels (native / kernel / fetch)
├── providers.ts          three protocols: URLs, headers, bodies, stream parsing
├── settings.ts           settings store + single debounced save path
├── apis.ts               multi-API config, model list fetching and filtering
├── thinking.ts           six thinking levels → per-vendor parameters
├── template.ts           {{variable}} substitution
├── templates.ts          template CRUD + built-in examples
├── turnplan.ts           template + input + history → request messages
├── tokens.ts             rough token estimate and length check
├── sessions.ts           chat history storage
├── errors.ts             error messages → plain language
├── mcp-*.ts              MCP transports (JSON-RPC, HTTP, SSE, stdio, spawn, manager)
├── tool-loop.ts          tool-call loop with a round limit
└── ui/*.svelte           panel, settings, template manager, MCP settings
```

Everything under `src/*.ts` except `net.ts` and `index.ts` is pure logic: no DOM, no network. That is why most of it can be tested in plain Node.

---

## Privacy and safety

- **No telemetry.** Nothing is sent anywhere except to the API endpoints you configure.
- **Your keys stay local**, in the plugin data folder, unencrypted.
- **No automatic writing.** The plugin never calls SiYuan's block-write APIs. You copy the text yourself.
- **Local MCP is shell-free.** No `shell: true` anywhere; arguments are escaped for `cmd.exe` on Windows.

---

## Known limitations

- **GUI interactions are not covered by automated tests.** Clicks are verified headlessly (component mounted, events dispatched), but real-theme appearance must be checked by eye.
- **Mobile has no streaming** — the kernel relay returns the full body at once. That is a SiYuan kernel limitation, not a plugin choice.
- **Context length is estimated**, roughly one token per two characters. It is a warning system, not an exact count.
- **No template import/export** yet.
- **No OAuth for MCP servers** — static headers only.
- **No conversation search** — the 30 most recent are listed.
- **The non-chat model filter is deliberately narrow.** A missed name simply appears in the list and fails when used; a wrong match would hide a usable model.

---

## Credits

Built for personal use with SiYuan Note. Thanks to the SiYuan team for a plugin API that makes this possible.

License: not published — this is a personal project.
