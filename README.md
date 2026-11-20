# SiYuan AI Chat + Image Panel

An AI assistant panel for [SiYuan](https://b3log.org/siyuan/). It writes with you, and it **generates images** — saved automatically into the plugin's own folder.

> **It never touches your notes.** The plugin never inserts, edits, or overwrites note content. Answers stay in the panel; you copy them out yourself. Generated images live only in the plugin's data folder.

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Testing](docs/TESTING.md) · [Changelog](docs/CHANGELOG.md) · [v1.4.0 release notes](docs/RELEASE-v1.4.0.md)

Current version: **1.4.0**

---

## Contents

Features · Install · Quick start · Multiple APIs & multi-select models · Chat & prompts · Copy & resend · Thinking levels · Image generation · Image management · MCP tools · History · Mobile · Protocols · Configuration · Troubleshooting · Development · Privacy · Known limits

---

## Features

| Feature | What it does |
|---|---|
| **Prompt templates** | Save system prompts as templates; one click applies one. Three built-in examples. |
| **Multiple APIs** | Several endpoints (protocol + base URL + key + model list) side by side; switch from the top bar. |
| **Multi-select models per API** | Tick the models you actually use; the top bar lists only those. Click a name to switch. |
| **Pull models from the endpoint** | Calls `/models`. Chat models and image models are listed separately; embedding/speech models are filtered out with a count. |
| **Image generation** | A painting model puts the panel into image mode. Four size tiers, ten ratios, optional reference image (img2img). |
| **Images saved to disk** | Written into the plugin's `images/` folder. Survives closing the panel and reopening history. |
| **One-click image folder** | The **Images** button on the control bar opens the folder in your file manager. |
| **One-click prompt polish** | A chat model rewrites your one-liner into a proper Chinese image prompt. |
| **Streaming replies** | Character-by-character on desktop, rendered as Markdown. |
| **Copy / resend** | Copy your message or the answer. Resend replaces the answer in place — no extra message. |
| **Thinking levels** | Six levels, translated per vendor (GLM, DeepSeek, GPT/o, Claude, Gemini, Kimi, Qwen, MiniMax). |
| **MCP tools** | HTTP, SSE, and local command transports. The model decides when to call a tool. |
| **History** | Keeps the last 30 conversations; reopen, delete, or clear all. |
| **Works on mobile** | Android/iOS SiYuan. Requests go through the SiYuan kernel, so no CORS problems. |
| **Human-readable errors** | API and model errors are translated into plain advice. |

---

## Install

### From the release zip

1. Download `siyuan-plugin-ai-chat-v1.4.0.zip`.
2. In SiYuan: **Settings → Bazaar → Downloaded → Plugins → Install from package**, pick the zip.
3. Enable "AI Chat" and restart SiYuan.

### Manual copy

Unzip so that `plugin.json` sits directly in the plugin folder:

```
<your workspace>/data/plugins/siyuan-plugin-ai-chat/
├── plugin.json
├── index.js
├── index.css
├── icon.png
└── net-proxy.cjs
```

> `plugin.json` **must** be at this level. One extra folder and SiYuan will not find the manifest.

### Requirements

- SiYuan **3.8.5** or newer.
- Desktop: Windows / macOS / Linux.
- Mobile: Android / iOS / HarmonyOS.

---

## Quick start

### Chat

1. Open the panel: the **AI Generate** icon at the bottom of the right dock, the top-bar plugin menu, or `Alt+Ctrl+A`.
2. **⚙ Settings → APIs & models**, fill one API card: protocol `OpenAI compatible`, base URL (**must end with `/v1`**), key, model name.
3. Click **Test this API**. If the model replies, you are set.
4. Back in the panel: apply a template, type your request, press `Ctrl+Enter` or click **Send**.

### Image generation

1. Click the model name in the top bar, pick a model with the orange **image** tag (e.g. `gpt-image-1`, `gemini-3.1-flash-image`, `flux-schnell`).
2. The panel switches to image mode: prompt bar and MCP bar collapse, Send becomes **Generate**.
3. Describe the picture.
4. Optional: **Upload** a reference image, pick a size and ratio, or click **Polish** to let a chat model rewrite your prompt.
5. Click **Generate**. The result appears as a card with **Copy image** and **Save to computer**.

---

## Multiple APIs & multi-select models

Each **API card** holds one protocol, one base URL, one key, and its own model list. Temperature, thinking level, and history depth are global.

### The checkbox: which models show in the top bar

- **Ticked** = this model appears in the top bar switcher.
- **Unticked** = dimmed in settings, hidden from the top bar, still kept in the list.
- Tick as many as you like; clicking a name switches immediately.
- **The model in use cannot be unticked** (the top bar would lose its label). Switch away first.
- Old configs upgrade with everything ticked, so behaviour does not change.

### Clearing un-ticked models

**Clear other models** always keeps three groups:

1. **Every model you ticked** (this is the fix — previously only the single active model survived, so ticking five left you with one).
2. **Every image model** (needed for generation).
3. **The model currently in use.**

Only models that are neither ticked, nor image models, nor active get removed. The confirmation dialog names what will be kept.

### Pulling the model list

Click **Pull from endpoint**. Two rules:

1. **It never auto-selects.** Pulling only adds names. The first entry from a relay is usually `text-embedding-3-small`; auto-selecting it guarantees a failed request.
2. **Clearly unusable names are filtered** — `embedding`, `bge`, `whisper`, `tts`, `rerank`, `moderation`. Image models are **not** filtered; they stay with an "image" tag.

### How models are classified

| Class | How it is decided | How it looks |
|---|---|---|
| **Chat model** | Neither image-like nor embedding/speech | Normal |
| **Image model** | Name contains `image`, or belongs to flux / sd / dall-e / imagen / seedream / wanx / cogview / midjourney | Orange chip with an "image" tag |
| **Unusable** | Embedding, speech, rerank | Dashed grey, with a warning |

**Multimodal models with `chat` / `vision` / `-vl` still count as chat** (`gpt-4o`, `qwen-vl-max`), so they are not misread as image models.

**Fallback: manual marking.** Every model name has a small **Mark as image / ✓ image** button. Anything the name heuristic misses can be classified by hand, and every derived list updates immediately.

---

## Chat & prompts

A template's body becomes the **system prompt** — it tells the model who it is and how to write.

| Variable | Meaning |
|---|---|
| `{{date}}` | Today, e.g. `2026-11-20` |
| `{{time}}` | Current time, e.g. `21:30` |
| `{{weekday}}` | Weekday |
| `{{doc_title}}` | Title of the open document |

Notes:

- **Clicking a template applies it; it does not send.** Write and send yourself.
- **It stays applied.** Every message in the conversation, including follow-ups, carries it until you click **Exit**.
- **Single braces are not variables.** `{like this}` is sent verbatim. Variables need double braces.
- **Three built-in examples**; edit or delete them. If all are deleted, defaults come back.

### Context menu

Right-click anywhere in a note to see **AI Generate (open panel)** plus one entry per template. Clicking a template only applies it and opens the panel — **it does not send**.

---

## Copy & resend

Both buttons sit under **your own** messages.

| Button | Behaviour |
|---|---|
| **Copy** | Copies the text. On mobile it tries the Android bridge, then `navigator.clipboard`, then `execCommand`. |
| **Resend** | Asks the same thing again and **replaces the existing answer in place**. |

Resend **does not add** a message. History sent to the model stops **before** that message, so the model does not read its own previous answer.

Both buttons are disabled while an answer is being generated.

---

## Thinking levels

Six levels: **off / minimal / low / medium / high / max**, translated per vendor.

| Family | What is sent |
|---|---|
| GLM | `low` / `high` / `max` (no medium; cannot be disabled) |
| DeepSeek | `high` / `max` |
| GPT / o series | `minimal` / `low` / `medium` / `high` |
| Claude native | `thinking.budget_tokens` + `effort` |
| Claude via OpenAI | `low` / `medium` / `high` |
| Gemini | `thinkingLevel`: `LOW` / `MEDIUM` / `HIGH` |
| Kimi / Qwen / MiniMax | `minimal` / `low` / `medium` / `high` |

If the model name is unrecognised, no thinking parameter is sent at all — better one missing feature than a hard 400.

---

## Image generation

### Sizes are screen resolutions

**1K/2K/4K mean "which screen does this fill"**, not the "long edge 1024" convention.

| Tier | Long edge | 16:9 | 1:1 | 9:16 | Fills |
|---|---|---|---|---|---|
| **1K** | 1920 | 1920×1080 | 1920×1920 | 1080×1920 | 1080p / typical laptop |
| **2K** | 2560 | 2560×1440 | 2560×2560 | 1440×2560 | 2K monitor |
| **4K** | 3840 | 3840×2160 | 3840×3840 | 2160×3840 | 4K monitor / TV |
| **4K+** | 4096 | 4096×2304 | 4096×4096 | 2304×4096 | DCI 4K |

The short edge follows the ratio and is rounded to a multiple of 8 (many models require it). The control bar always shows the final pixels.

### Ten ratios

1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 5:4, 4:5, 21:9.

### A few models only accept fixed sizes

| Model | Accepted sizes |
|---|---|
| `gpt-image-1` | 1024×1024, 1536×1024, 1024×1536 |
| `dall-e-3` | 1024×1024, 1792×1024, 1024×1792 |
| Others (Flux / SD / third-party relays) | Usually whatever you ask for |

For those two official models the plugin picks the **closest ratio** and states it in orange on the control bar: "actual 1536 × 1024 (swapped)".

> The official size table matches **exact official model names only**. Third-party names like `gpt-image-2.6-sunburst` are not restricted — they usually accept any size.

### The four buttons above the input box

| Button | What it does |
|---|---|
| **Images** | Opens the image folder in your file manager. On mobile it shows the path. |
| **Upload** | Pick a local image (PNG / JPG / WEBP, up to 8 MB) as a reference; enables img2img. |
| **Size** | 1K / 2K / 4K / 4K+; the menu shows the long edge. |
| **Ratio** | Ten ratios. |
| **Polish** | A **chat model** rewrites your text into a Chinese image prompt, replacing the input box content. |

### Which model polishes the prompt

Image models cannot write. Polishing always uses a **chat model**. The plugin remembers the last chat model you selected:

- Even if the top bar is on an image model, **Polish** still uses that chat model.
- If it was deleted, the first usable chat model is used instead.
- **Models you manually marked as image models are never chosen.**
- With no chat model at all, it says so plainly instead of sending a doomed request.

### Limits

- **OpenAI-compatible protocol only.** Claude native and Gemini native have no such image endpoint.
- **The provider must support it.** Not every relay exposes `/images/generations`. A 404 usually means it is not enabled, or the base URL is missing `/v1`.
- **One image per request.** `n=1` is fixed in the UI.
- **Stop really stops.** Clicking Stop aborts the underlying request, not just the wait.

---

## Image management

### Where images live

```
<workspace>\data\storage\petal\siyuan-plugin-ai-chat\images\
```

For example `Z:\siyuan\data\storage\petal\siyuan-plugin-ai-chat\images\img-20261120-162954-2048x1152.jpg`.

The **Images** button on the control bar opens exactly this folder.

### Why they are not stored in the session file

A 4K image is over ten megabytes as base64. Inside `sessions.json` history would get slower with every picture until the panel could not open. So:

- Images are separate files.
- History stores only **path + size + prompt**.
- Closing and reopening the panel, or reopening old history, still shows the images.
- Deleting a conversation (or clearing all) also deletes its image files.

### Image type comes from bytes, not the extension

Providers sometimes hand back **JPEG bytes** inside a data URL that says `image/png`. Naming the file `.png` makes some SiYuan versions refuse to render a "declared type does not match content" image — the symptom is **copy and save work, but nothing shows**.

Now the file header decides (`FF D8 FF` = JPEG, `89 50 4E 47` = PNG, `RIFF....WEBP` = WebP). Old mismatched files in history are renamed on open and their references updated.

### Images embedded in the reply text

Some providers (Gemini especially) return images mixed into the text:

```text
![image](data:image/jpeg;base64,...)
```

These are extracted into proper image cards, large ones are moved into `images/`, and the base64 is stripped from the message text. A 964 KB message shrinks back to normal.

### The two buttons on an image card

| Button | Behaviour |
|---|---|
| **Copy image** | Puts the image itself on the clipboard. Unsupported environments say so and suggest Save. |
| **Save to computer** | Desktop shows the **native Save As** dialog (`<a download>` silently fails in Electron); mobile uses the system download. |

### When an image cannot be read

You never get a bare "not found". The reason is stated and a **Retry** button is provided:

- folder not created yet (no image generated so far)
- file read failed (mentions that other extensions were tried)
- the provider's URL is unreachable

---

## MCP tools

The plugin ships **no** MCP servers; add your own.

### Adding a server

1. Click **MCP** in the panel.
2. **+ Add HTTP** or **+ Add local command**.
3. Fill in a name plus a URL or command.
4. Save, then **Test all servers**.

| Type | What to enter | Where it works |
|---|---|---|
| HTTP | URL, e.g. `http://127.0.0.1:3000/mcp` | Everywhere |
| SSE (legacy) | URL | Everywhere |
| Local command | Command + args, e.g. `npx` `-y @modelcontextprotocol/server-time` | Desktop only |

### How the model uses tools

Connected tools are sent in the request's `tools` field. When the model wants one, the panel shows "calling tool: server / tool name", feeds the result back, and the model continues. Rounds are capped (8 by default) to prevent loops.

### Safety

- Local commands **never use a shell**; arguments are passed separately, so injected `&` or `|` is inert.
- Tools whose names contain `delete`, `write`, `update`, `remove`, `insert`, `create` are flagged as writes but **still execute**. Only connect servers you trust.
- Each server connects independently; one failing does not affect the others.

---

## History

Saved automatically after every answer.

- Up to **30** conversations, most recent first.
- Click one to switch and continue.
- **×** deletes one; **Clear all history** wipes everything after confirmation (including its image files).
- Clearing also empties the conversation on screen — otherwise the next answer would save it again.
- Unchanged content is not re-saved, so the list does not jump around.
- Templates are **not** stored with a conversation; reapply after switching back.

---

## Mobile

| Item | Desktop | Mobile |
|---|---|---|
| Request channel | Plugin's main-process proxy | SiYuan kernel forward (`/api/network/forwardProxy`) |
| Streaming | Character by character | Whole answer at once |
| Send | `Ctrl+Enter` | **Send** button (soft-keyboard send works) |
| Model picker | Top-bar dropdown | Bottom sheet |
| Clipboard | `navigator.clipboard` | Android bridge, several fallbacks |
| Local MCP | Supported | Not supported (no `require`) |
| Open image folder | Supported | Shows the path for a file manager |
| Image generation | Supported | Supported (same kernel forward) |

To make the panel easier to find: **Settings → Appearance → Sidebar**, enable **AI Generate**.

---

## Protocols & providers

| Protocol | Chat endpoint | Auth header |
|---|---|---|
| OpenAI compatible | `{base}/chat/completions` | `Authorization: Bearer` |
| Claude native | `{base}/v1/messages` | `x-api-key` + `anthropic-version` |
| Gemini native | `{base}/v1beta/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key` |

Image generation is OpenAI-compatible only: `{base}/images/generations` (text to image) and `{base}/images/edits` (image to image).

Model list endpoints: `{base}/models`, `{base}/v1/models`, `{base}/v1beta/models`.

> **The base URL must include `/v1`.** `https://api.example.com` yields 404 `Invalid URL`; `https://api.example.com/v1` works. The plugin appends `/images/generations` for you.

---

## Configuration

### Each API card

| Field | Meaning |
|---|---|
| Name | Display label |
| Protocol | `openai` / `anthropic` / `gemini` |
| Base URL | Root URL, **ending in `/v1`** |
| API key | Stored in plain text in the plugin data folder |
| Model list | Model names available on this endpoint |
| Ticks | Which ones appear in the top bar |
| Current model | The one in use |

### Global preferences

| Field | Default | Meaning |
|---|---|---|
| Temperature | `0.7` | Sampling temperature |
| Max output tokens | `4096` | Answer length cap |
| Thinking level | `high` | Thinking tier |
| Show reasoning | off | Display the model's reasoning |
| History depth | `10` | Messages carried into each request |
| Context limit | `200000` | Token budget; `0` disables the check |
| Tool round cap | `8` | Tool calls per turn |

### Image preferences

| Field | Default | Meaning |
|---|---|---|
| Size | `2K` | 1K / 2K / 4K / 4K+ |
| Ratio | `16:9` | Ten options |
| Manual image list | empty | Force specific models to count as image models |

### Where data lives

| File / folder | Contents |
|---|---|
| `settings.json` | API configs, active API, global preferences |
| `templates.json` | Prompt templates |
| `mcp.json` | MCP server definitions |
| `sessions.json` | History (image paths only, never image data) |
| `images/` | Generated and absorbed image files |

All under `<workspace>/data/storage/petal/siyuan-plugin-ai-chat/`. **Keys are stored in plain text** — do not publish screenshots containing them.

---

## Troubleshooting

| Message | Meaning |
|---|---|
| Key is wrong or expired | Check the API key |
| Endpoint not found / `Invalid URL` | The base URL is missing `/v1` |
| Rejected (400) | Usually a wrong model name |
| Provider error (500/502) | Their side; retry in a few minutes |
| Content too long | Start a new chat or shorten the input |
| Local MCP program failed to start | Check the command and arguments |
| This model only supports fixed sizes, X replaced by Y | Expected; the model has a hard size table |
| This image cannot be shown right now | The reason follows, with a Retry button |
| Image folder not created yet | Generate one image first |

Unrecognised errors keep the original text so you can search it.

---

## Development

```powershell
npm install
npm test                 # 1459 assertions across 49 files
npm run build            # build into dist/
npm run pack             # build + create the installable zip
npm run install-plugin   # build + copy into your SiYuan workspace
```

Two more handy commands:

```powershell
npx svelte-check --tsconfig ./tsconfig.json   # types and templates
node scripts/oneclick-pack.mjs                # build + pack in one step
```

### Layout

```
src/
├── index.ts              Entry: dock, command, top-bar button, context menu
├── net.ts                Three request channels (main process / kernel / fetch)
├── providers.ts          Three chat protocols: URL, headers, body, SSE parsing
├── settings.ts           Settings store + the single debounced save path
├── apis.ts               API configs, model pulling, classification
├── thinking.ts           Six thinking levels → per-vendor parameters
├── image.ts              Image sizing, request building, multipart, parsing
├── image-store.ts        Save/load/delete images, open folder, magic-byte sniffing
├── inline-image.ts       Extract markdown images from reply text
├── optimize.ts           System prompt and cleanup for prompt polishing
├── sessions.ts           History storage (images by path only)
├── template.ts           {{variable}} substitution
├── templates.ts          Template CRUD + built-ins
├── turnplan.ts           Template + input + history → request messages
├── tokens.ts             Rough token estimate and length check
├── errors.ts             Errors translated into plain language
├── mcp-*.ts              MCP transports
├── tool-loop.ts          Tool-call loop with a round cap
└── ui/*.svelte           Panel, settings, template manager, MCP settings
```

Every `src/*.ts` except `net.ts` and `index.ts` is pure logic: no DOM, no network. That is why they can be tested directly in Node.

---

## Privacy & security

- **No telemetry.** Nothing leaves your machine except requests to the endpoint you configured.
- **Keys stay local**, in plain text in the plugin data folder.
- **Never writes to your notes.** The plugin does not call SiYuan's block-writing APIs.
- **Image generation only writes into the plugin's own data folder.**
- **Local MCP never goes through a shell.**

---

## Known limits

- **No GUI automation for the interface.** Clicks are verified headlessly (a real mount plus dispatched events); visual polish still needs your eyes.
- **No streaming on mobile.** The kernel forward returns the whole answer at once.
- **Image generation is OpenAI-compatible only.**
- **One image per request.**
- **Token counts are estimates**, roughly two characters per token. A warning, not an exact meter.
- **No template import/export.**
- **No OAuth for MCP servers**; static headers only.
- **No conversation search** — just the last 30.
- **Model classification is name-based**; unusual names may be misread. Use **Mark as image** in settings to correct it.

---

## Notes

Built for personal use. Thanks to the SiYuan team for a plugin API that is genuinely pleasant to work with.

License: unpublished — a personal project.
