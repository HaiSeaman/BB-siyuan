# Architecture & Implementation Notes

> For anyone changing this plugin (including future me). After reading you will know: what the data looks like, how requests leave the machine, how image generation lands on disk, and which spots are traps.

Current version: **1.4.0** ｜ [中文版](ARCHITECTURE.md)

**Related:** [Features (English)](../README.md) ｜ [功能说明（中文）](../README.zh-CN.md) ｜ [Testing](TESTING.en.md) ｜ [Changelog](CHANGELOG.en.md) ｜ [Release notes](RELEASE-v1.4.0.en.md)

---

## 1. Overall shape

```
SiYuan
  └─ plugin (this repo)
       ├─ src/index.ts        Entry: dock, command, top-bar button, context menu
       ├─ src/ui/*.svelte     UI (Svelte 4)
       ├─ src/*.ts            Pure logic (no DOM, no network — testable in Node)
       └─ net-proxy.cjs       Desktop main-process network proxy
```

**Layering rules:**

- Every `src/*.ts` except `net.ts` and `index.ts` **touches neither `window` nor the network**; it only transforms data.
- All networking lives in `src/net.ts`. The UI only calls `streamChat` / `fetchOnce` / `fetchBinary`.
- `src/ui/*.svelte` handles display and interaction only; decisions live in `.ts`.

### Module map (v1.4.0)

| File | Responsibility | Pure |
|---|---|---|
| `index.ts` | Entry, dock, menus, mobile opening logic | No |
| `net.ts` | Three request channels | No |
| `providers.ts` | Request building and SSE parsing for three chat protocols | Yes |
| `settings.ts` | Settings store, the single save path, `chatApiFor` | Yes |
| `apis.ts` | API configs, model pulling, **three-way classification** | Yes |
| `thinking.ts` | Six thinking levels → per-vendor parameters | Yes |
| `image.ts` | **Generation**: sizing, endpoints, multipart, parsing | Yes |
| `image-store.ts` | **Image files**: save/load/delete/open folder, **magic-byte sniffing** | Yes |
| `inline-image.ts` | Extract markdown images from reply text | Yes |
| `optimize.ts` | System prompt and cleanup for prompt polishing | Yes |
| `sessions.ts` | History (image paths only) | Yes |
| `migrate.ts` | Legacy config migration | Yes |
| `template.ts` / `templates.ts` / `turnplan.ts` | Templates and request assembly | Yes |
| `tokens.ts` / `errors.ts` | Token estimate, error translation | Yes |
| `mcp-*.ts` / `tool-loop.ts` | MCP transports and the tool loop | Mostly |

---

## 2. Settings data

```ts
interface Settings {
    apis: ApiConfig[];
    activeApiId: string;
    temperature: number;
    maxTokens: number;
    thinking: ThinkingLevel;
    contextMessages: number;
    showReasoning: boolean;
    contextLimit: number;
    maxToolRounds: number;

    lastChatModel: string;  // "apiId::model", used by "Polish"
    imageSize: string;      // 1K / 2K / 4K / 4K+
    imageRatio: string;     // 16:9 etc.
    imageModels: string[];  // names manually marked as image models
}

interface ApiConfig {
    id: string;
    name: string;
    protocol: "openai" | "anthropic" | "gemini";
    baseURL: string;
    apiKey: string;
    models: string[];   // everything available on this endpoint
    picked: string[];   // **ticked** — decides what the top bar lists
    model: string;      // the one in use
}
```

**Why `models` and `picked` are separate:**

- `models` = "what this provider has" (a pull can return dozens).
- `picked` = "the few I want to switch between quickly".
- Merging them would either flood the top bar or delete the list when removing a model.

**The compatibility rule (important):**

```ts
export function pickedOf(api: ApiConfig): string[] {
    const p = Array.isArray(api?.picked) ? api.picked : [];
    return p.length ? p : Array.isArray(api?.models) ? api.models : [];
}
```

Old configs have no `picked`. Reading `api.picked.length` directly throws `TypeError`, and a throw during rendering **blanks the whole panel** — the user just sees "it will not open". Always go through `pickedOf()`, and its semantics are "not ticked = all ticked", so upgrading changes nothing.

**Key functions:**

| Function | Purpose | Watch out |
|---|---|---|
| `initSettings(loaded)` | Initialise the store from disk | Only on the **first** mount |
| `activeApi(s)` | The active API | Always returns an object |
| `updateSettings(patch, persist)` | Flat fields | Goes through the 400 ms debounce |
| `updateSettingsWith(fn, persist)` | Nested structures | Use this; never `settings.update` + direct write |
| `chatApiFor(s, isChat, manualImage)` | Pick a model that **can write** for polishing | The third argument is mandatory |
| `snapshot()` | Read-only snapshot | For the plugin entry point |

### Exactly one save path

```ts
function scheduleSave(persist: (s: Settings) => void) {
    persistFn = persist;
    clearTimeout(saveTimer);
    saveTimer = globalThis.setTimeout(() => {
        if (persistFn) persistFn(snapshot());   // ← always read the latest state
    }, 400) as unknown as number;
}
```

**Two traps that must not come back:**

1. **Never queue the snapshot taken at press time.** A later change gets overwritten by the stale object — "I changed it and it changed back".
2. **Never add a second immediate-write path.** That is what used to fight the debounce and lose edits.

### Initialisation guard (keep it)

```ts
// ChatPanel.svelte onMount
if (!isInitialized()) initSettings(initialSettings);
```

The panel mounts repeatedly (switching workspaces, collapsing and reopening the dock). Unconditional `initSettings` restores stale startup values over the user's edits.

---

## 3. Three-way model classification (v1.4.0)

This classification drives **UI visibility** and **mode switching**. One mistake hides a whole row of controls.

| Class | Rule |
|---|---|
| Image model | Name contains `image`, or matches flux / sd3 / sdxl / dall-e / imagen / kolors / seedream / wanx / cogview / midjourney / pixart / hidream / diffusion |
| Not an image model | Name contains `chat` / `vision` / `-vl` (multimodal models stay chat) |
| Unusable | `embed` / `bge` / `whisper` / `tts` / `rerank` / `moderation` |
| Manual override | Anything in `settings.imageModels` counts as an image model, ahead of name matching |

> **Never go back to an enumerated allow-list.** `/dall-e/`, `/gpt-image/` and friends missed the entire `*-image` family (`gemini-3.1-flash-image`). The user configured an image model and the plugin claimed there was none, hiding all four buttons.

**Official size table trap:** `OFFICIAL_SIZES` must match **exact official names** (`/^gpt-image-1$/i`). `/gpt-image/i` also locks third-party names such as `gpt-image-2.6-sunburst`, forcing 2560×1440 down to 1536×1024.

---

## 4. How requests leave the machine (three channels)

`currentChannel()` picks one and caches the decision:

| Channel | When | Pros | Cost |
|---|---|---|---|
| `native` | Desktop with `window.require` | Real streaming | Needs `net-proxy.cjs` |
| `kernel` | Mobile (no `require`, http(s) page) | No CORS issues | **No streaming** |
| `fetch` | Fallback | No extra dependency | CORS-limited |

### Desktop channel (native)

`net-proxy.cjs` runs in the Electron main process and streams chunks back.

v1.4.0 merged two near-identical functions into `runNativeRequest`:

```ts
function runNativeRequest(native, url, opts, timeoutMs) {
    // settled guard / chunk collection / status code / timeout / signal abort
}
```

`fetchOnceViaNative` and `fetchBinaryViaNative` only wrap it to return `text` or `bytes`. Changing this affects both callers.

**Three details:**

1. **Do not cache `null` on load failure** — the whole session would be unable to connect until a restart. The code leaves `undefined` so it retries next time.
2. **Binary bodies use `bodyBase64`.** An image-to-image multipart body is binary; passing it as a string re-encodes it as UTF-8 and corrupts the bytes.
3. **`signal` must abort the underlying request**, not just stop waiting.

### Mobile channel (kernel)

```
POST /api/network/forwardProxy
{
  url, method, timeout,
  headers: [{ key: value }, ...],   // array of objects, not a plain object
  contentType,
  payload,
  payloadEncoding                   // "text" for no body; "base64" for binary
}
```

**Must remember:**

1. `headers` must be an array of objects; a plain object is silently dropped.
2. **No body (e.g. MCP DELETE) must use `"text"`** — `json` would send the literal string `null`.
3. **Binary bodies (image-to-image multipart) must use `"base64"`** — the kernel decodes and sends raw bytes. `text`/`json` corrupt them.
4. The response is `{ code, msg, data: { status, body, contentType } }`; `code !== 0` means the kernel itself failed.

### SSE parsing

`ProviderParser` in `providers.ts` consumes raw SSE and emits text deltas, reasoning deltas, and tool calls for all three protocols.

**Tool calls must accumulate by index** — arguments arrive in fragments; not accumulating splits one call into N empty-argument calls (and executes a write N times).

---

## 5. Image generation (new in v1.4.0)

### Sizes are screen resolutions

```ts
export const SIZES = ["1K", "2K", "4K", "4K+"] as const;
export const LONG_EDGE = {
    "1K": 1920,    // 1080p
    "2K": 2560,    // 1440p
    "4K": 3840,    // 2160p
    "4K+": 4096,   // DCI 4K
};
```

`computeSize(level, ratio)` derives the short edge and rounds to a multiple of 8.

> **Do not revert to "long edge 1024".** That is an AI-generator convention; the requirement here is "which screen does it fill", so 1K must be 1920×1080.

### Endpoints

| Mode | URL | Content-Type |
|---|---|---|
| Text to image | `{base}/images/generations` | `application/json` |
| Image to image | `{base}/images/edits` | `multipart/form-data` |

`imageEndpoint()` normalises the various ways a base URL can be typed.

`buildMultipart()` assembles the bytes by hand — the browser `FormData` cannot be used because the kernel channel needs raw bytes.

### Response parsing

`parseImageResponse()` accepts three shapes:

1. `{ data: [{ b64_json }] }` — official
2. `{ data: [{ url }] }` — some relays only return URLs
3. `{ images: ["base64"] }` — a few domestic relays

### Order of operations for one generation

```
generateImage(text)
 ├─ insert placeholder messages (the prompt + an empty assistant slot)
 ├─ requestImages(...)  → fetchBinary (with signal)
 ├─ per image: dataUrlToBytes → sniffImageMime → saveImage
 ├─ write into messages[answerIndex].images
 └─ finally: clear generating / genAbort only if still the current round
```

**The guard in `finally` is load-bearing.** If the user stops and immediately generates again, the old round's `finally` arrives late; clearing `generating` unconditionally unlocks the new round's buttons and allows a duplicate send.

---

## 6. Image files

### Where

```
<dataDir>/storage/petal/<plugin>/images/
```

**The `dataDir` trap (hit once):** SiYuan's `system.dataDir` is already `Z:\siyuan\data` (it **includes** the `data` segment). Appending another `data\` yields `Z:\siyuan\data\data\storage\...`, which does not exist.

```ts
const last = root.split(/[\\/]/).filter(Boolean).pop() || "";
if (last.toLowerCase() === "data") return root + "\\" + tail;
return root + "\\data\\" + tail;
```

### Type comes from bytes

```ts
export function sniffImageMime(bytes, fallback = "image/png"): string {
    // FF D8 FF → jpeg / 89 50 4E 47 → png / RIFF....WEBP → webp / GIF8 → gif
}
```

**Why sniffing is mandatory:** providers return JPEG bytes inside a data URL tagged `image/png`. Naming the file `.png` makes some SiYuan versions refuse to render a "declared type does not match content" image — copy and save still work because they pass bytes through, so the symptom is "it is there, it just will not show".

### Two path styles, never mixed

| Functions | Path style | Why |
|---|---|---|
| `saveImage` / `loadImageDataUrl` / `deleteImage` | **Relative** `data/storage/petal/...` | Kernel `/api/file/*` wants workspace-relative paths |
| `imagesFolderHint` / `openImagesFolder` | **Absolute** `Z:\siyuan\data\storage\...` | The OS file manager wants absolute paths |

Absolute to the kernel → 403. Relative to `openPath` → will not open.

### Opening the folder: four fallbacks

```ts
1. @electron/remote → shell.openPath
2. electron module → shell.openPath
3. child_process.spawn("explorer.exe", [dir])   // native, hardest to block
4. all failed: print the full path so it can be pasted manually
```

`fs.existsSync(dir)` runs first; a missing folder reports "no image generated yet" instead of an opaque error.

### Source priority for a card

Display and copy/save **must use the same order**, otherwise "visible but unsavable" appears:

```ts
function imageSourceOf(img, thumbs, errors) {
    if (img.path && thumbs[img.path]) return { kind: "data", ... };  // decoded data URL
    if (img.url) return { kind: "url", ... };                        // provider URL
    if (img.mem) return { kind: "data", ... };                       // in-memory fallback
    if (img.path && errors[img.path]) return { kind: "none" };       // known failure
    if (img.path) return { kind: "file", ... };                      // not read yet
}
```

---

## 7. Panel layout

```
.panel (position: relative ← required!)
 ├─ .topbar           brand / model switcher / new chat / history / manage / settings
 ├─ .img-banner       image-mode banner
 ├─ .picker-layer     model switcher, covers only below the top bar
 ├─ .tpl-bar          templates (hidden in image mode)
 ├─ .mcp-bar          MCP status (hidden in image mode)
 ├─ .stage
 │   └─ .drawer       settings / templates / MCP / history
 ├─ .ctrl-bar         left: thinking ｜ right: Images Upload Size Ratio Polish Mode
 ├─ .ref-bar          reference image preview
 └─ .compose          textarea + send/generate
```

### Three safeguards on the overlay (do not simplify)

A past outage: `.picker-mask` used `position:absolute; inset:0` while `.panel` lacked `position:relative`, so the mask covered the entire viewport and swallowed every click. Its only behaviour is "click to dismiss", so the user experienced "nothing responds".

1. `.panel` has `position: relative`.
2. The mask and menu live inside `.picker-layer`, which starts at `top:40px`.
3. `.picker-layer` is `pointer-events: none`, children are `auto`.

### Two Svelte reactivity traps

**Trap 1: `$:` statements have no reliable order.**

```js
// ✗ may throw: cfg might not be assigned yet
$: cfg = $settings;
$: canThink = supportsThinking(currentModel());

// ✓ read the store directly, with a fallback
$: canThink = supportsThinking(currentModel($settings));
```

**Trap 2: a function called from the template does not track its reactive reads.**

```js
// ✗ the template never recomputes when refThumbs changes
<img src={imageSrc(img)}>

// ✓ compute a reactive map in the script, look it up in the template
$: imgSrcMap = (() => { ... })();
<img src={imgSrcMap[key]}>
```

Trap 2 caused "the image copies and saves but never displays" — data was fine, the template simply never re-rendered.

### One chat turn

| Function | Responsibility |
|---|---|
| `prepareTurn(text, templateId, history)` | Validate config, build system prompt, estimate tokens; returns `null` with a message when unsuitable |
| `startTurn({text, templateId})` | **New**: compute history first, then append the user message and an empty assistant slot |
| `runTurn({userIndex, plan})` | Run the tool loop, writing into `messages[userIndex + 1]` |
| `resend(i)` | **Resend**: history is `messages.slice(0, i)`, clear `messages[i+1]`, then `runTurn({userIndex: i})` |

**Two positions are load-bearing:**
- History must stop **before** the message.
- The placeholder must be inserted at `i + 1`, because `runTurn` writes to `messages[userIndex + 1]`.

---

## 8. MCP

| File | Responsibility |
|---|---|
| `mcp-jsonrpc.ts` | JSON-RPC 2.0 framing, tool-name mapping |
| `mcp-http.ts` | Streamable HTTP transport |
| `mcp-sse.ts` | Legacy SSE transport |
| `mcp-stdio.ts` | Local command transport (desktop only) |
| `mcp-spawn.ts` | Windows launch adaptation (`.cmd` completion, escaping) |
| `mcp-manager.ts` | Config normalisation, tool list merging, name mapping |
| `mcp-connect.ts` | Multi-server connection management |
| `tool-loop.ts` | Tool loop with a round cap and error feedback |

### stdio process lifecycle

Every callback must first confirm it is still the current process:

```js
const isCurrent = () => this.child === child;
child.on("exit", () => {
    if (!isCurrent()) return;   // an old process can exit after the new one starts
    ...
});
```

Without it, the old process's exit nulls the **new** process handle — "it disconnects the moment it reconnects".

---

## 9. Three requirements for mobile

1. **`plugin.json`** must declare `mobile` in `frontends` and `android`/`ios`/`harmony` in `backends`. The kernel skips incompatible plugins entirely — `onload` never runs.
2. **No `window.require`** on mobile; requests go through the kernel forward.
3. **Different panel opening:** find `[data-type="sidebar-<plugin>-tab"]`, slide out the sidebar, dispatch `CustomEvent("click", {detail})`.

`addDock` needs `show: true`, otherwise the entry is hidden by default on mobile.

---

## 10. Build and artifacts

```
npm run build   → dist/ (index.js / index.css / plugin.json / net-proxy.cjs / icon.png)
npm run pack    → siyuan-plugin-ai-chat-v<version>.zip (plugin.json at the zip root)
```

`vite.config.ts` copies `plugin.json`, `icon.png`, and `net-proxy.cjs` into `dist/` via `vite-plugin-static-copy`.

`rollupOptions.external` excludes `siyuan` and `process` — SiYuan provides them at runtime.

---

## 11. Red lines

1. `.panel { position: relative }` — removing it revives the full-screen overlay bug.
2. `.picker-layer { pointer-events: none }` — the click-through fallback.
3. `plugin.json` `frontends` / `backends` — mobile will not load.
4. The `isInitialized()` guard in `onMount`.
5. `isCurrent()` in stdio — otherwise "disconnects right after reconnecting".
6. `payloadEncoding: "text"` for body-less kernel forwards.
7. One save path (`scheduleSave`).
8. `pickModel` must set both `model` and `activeApiId`.
9. `resend` replaces in place, never appends.
10. `clearAllSessions` must clear `currentSessionId` and `messages`.
11. **`pickedOf()` fallback** — old configs have no `picked`; reading it directly blanks the panel.
12. **Magic-byte sniffing** — never trust the data URL or the extension.
13. **`dataDir` already contains `data`** — check before appending.
14. **`imagesFolderHint` (absolute) and `dataRoot` (relative) must not be mixed.**
15. **The `generating` guard in the image `finally`** — without it, stop-then-generate allows two concurrent rounds.
16. **Inline-image filenames need an index** — a fixed `1` overwrites siblings in the same message.
