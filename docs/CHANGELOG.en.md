# Changelog

Written in terms of what the user can feel, not code detail (that lives in `ARCHITECTURE.en.md`).

Current version: **1.4.0** ｜ [中文版](CHANGELOG.md)

---

## v1.4.0

**Theme: from "chat only" to "chat + image generation", with every trap on that path filled in.**

This is not a small release: a complete image-generation module was added, then several rounds of real testing and a whole-repo review fixed more than twenty real problems. Grouped by theme below, not by patch round.

---

### New: image generation

Open the model list from the top bar; painting models carry an orange **image** tag. Clicking one switches the panel into **image mode**:

- The prompt bar and MCP bar collapse (image models ignore system prompts and never call tools)
- Send becomes **Generate**
- The top-bar dot turns from green to orange
- A **💬 Chat** button at the end of the control bar switches back to the last chat model

Generation uses the standard OpenAI endpoints: `/images/generations` (text to image) and `/images/edits` (image to image, multipart). Providers that only return a URL are handled too.

### New: four buttons above the input box

Left to right: **Images / Upload / Size / Ratio / Polish**

| Button | What it does |
|---|---|
| **Images** | Opens the saved-image folder in Explorer. On mobile it shows the path. |
| **Upload** | Pick a local image (PNG/JPG/WEBP, up to 8 MB) as a reference; enables img2img. |
| **Size** | 1K / 2K / 4K / 4K+; the menu shows the long edge. |
| **Ratio** | Ten common ratios: 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 5:4, 4:5, 21:9. |
| **Polish** | A **chat model** rewrites your text into a Chinese image prompt, replacing the input. |

The control bar always shows the resulting pixels, e.g. `2560 × 1440`. If you pick 4K but the model cannot do it, it shows orange "actual 1536 × 1024 (swapped)" so you know exactly what you got.

### New: images saved into the plugin data folder

Every generated image is written to:

```
<workspace>\data\storage\petal\siyuan-plugin-ai-chat\images\
```

- Images are **never** placed inside `sessions.json`. History stores path, size, and prompt only — a 4K image is over ten megabytes as base64, and history would slow to a crawl.
- Closing and reopening the panel, or reopening old history, still shows the images.
- Deleting a conversation (or clearing all) deletes its image files too.
- If writing the file fails, the image still displays and you are told to use **Save to computer**.

### New: two buttons under every image

| Button | Behaviour |
|---|---|
| **Copy image** | Puts the image itself on the clipboard (not the text). Environments that cannot do it say so and point you at Save. |
| **Save to computer** | Desktop shows the **native Save As** dialog; mobile uses the system download. |

### New: multi-select models within one API

Every model name has a checkbox; the top bar lists exactly the ticked ones:

- Tick several; clicking a name switches immediately
- Unticked names are dimmed in settings
- The model in use cannot be unticked (the top bar would lose its label); switch away first
- **Old configs upgrade fully ticked**, so nothing changes for existing users

### New: remembering the last chat model

Once the top bar is on an image model, **Polish** still needs a model that can write. A second slot records "the last chat model you picked":

- Set automatically whenever you pick a chat model
- Preferred when you click **Polish**
- Falls back to the first usable chat model if it was deleted
- With no chat model at all, it says "add one in settings" instead of sending a doomed request

### Improved: sizes are screen resolutions

Previously 1K meant "long edge 1024", so 1K + 16:9 produced 1024×576 and could not fill a screen. Now it follows the consumer convention:

| Tier | 16:9 | 1:1 | 9:16 | Fills |
|---|---|---|---|---|
| **1K** | 1920×1080 | 1920×1920 | 1080×1920 | 1080p / typical laptop |
| **2K** | 2560×1440 | 2560×2560 | 1440×2560 | 2K monitor |
| **4K** | 3840×2160 | 3840×3840 | 2160×3840 | 4K monitor / TV |
| **4K+** | 4096×2304 | 4096×4096 | 2304×4096 | DCI 4K |

The short edge follows the ratio and is rounded to a multiple of 8. Verified against a real provider: 1920×1080, 2560×1440 and 3840×2160 all generated successfully, with file size growing with resolution.

### Improved: three-way model classification

Pulling models used to drop `dall-e`, `gpt-image`, `flux` as "cannot chat" — correct for chat, but the side effect was that **image generation had no model to choose**.

Now there are three groups:

- **Chat models**: listed normally
- **Image models**: orange chip with an "image" tag; clicking enters image mode
- **Unusable**: embedding and speech, dashed grey, with an explicit warning

Settings groups the same way, and **Clear other models** no longer removes image models by accident.

### Fixed: models like `gemini-3.1-flash-image` were not recognised

The rule used to be an enumerated list (dall-e, gpt-image, flux, sd…), which missed the whole `*-image` family — exactly where Gemini's image models live. Symptoms:

- Clicking **🎨 Image** said "no image model yet" despite one being configured
- None of the four buttons appeared
- The model was treated as a chat model and a request to it returned 400

Now **any name containing `image` counts as an image model**, plus diffusion / pixart / hidream families. The guard stays: names with `chat`, `vision`, or `-vl` (`gpt-4o`, `qwen-vl-max`) remain chat models.

**Fallback**: each model name in settings has a **Mark as image / ✓ image** button for anything the heuristic misses.

### Fixed: the four buttons were completely missing

They used to render only in image mode, and image mode required the current model to be recognised as an image model. Unrecognised name → mode never entered → buttons gone.

Now **all four are always present**, in both chat and image mode, positioned **to the right of the thinking pill**.

### Fixed: images "copy and save fine but never display"

Two causes stacked:

1. **The file type was a lie**: providers returned JPEG inside a data URL claiming png, so the file was named `.png`. Some SiYuan versions refuse to render a "declared png, actually jpeg" image — while copy/save passed raw bytes and worked.
2. **The template never recomputed**: it called `imageSrc(img)`. Svelte cannot see the reactive reads inside a function, so the template kept the first unreadable address forever.

Now the file header decides the real type (JPEG/PNG/WebP) and names the file accordingly; the template reads a reactive map and re-renders as soon as data arrives. Old mismatched files in history are renamed on open and their references updated.

### Fixed: images inside the reply text were plain text with no save button

Some providers (Gemini especially) return images embedded in text:

```text
![image](data:image/jpeg;base64,...)
```

They used to render as text with a generic Copy, could not be saved, and the base64 pushed the session file to 1 MB. Now they are extracted into image cards, large ones move into `images/`, and the base64 is stripped.

### Fixed: the Images button could not open the folder

SiYuan's `dataDir` is already `Z:\siyuan\data`; the code appended another `data\`, producing `Z:\siyuan\data\data\storage\...`, which does not exist.

Now the last path segment is checked, supporting both "already at data" and "workspace root only". Opening has four fallbacks (`@electron/remote` → `electron` → `explorer.exe` → show the path), and mobile explains it cannot open folders.

### Fixed: clearing models deleted the ticked ones too

The old logic kept only "the active model + image models" and **ignored the tick list entirely**. Tick five, clear once, one survives.

Now three groups are kept: **ticked** + **image models** + **active**. Only models that are none of those are removed, and the dialog states what is kept.

### Fixed: four concurrency and timeout problems in generation (found by review)

1. **`generating` was cleared unconditionally** after a generation: stop, then immediately generate again, and the old round's cleanup unlocks the new round's buttons → duplicate sends, two concurrent rounds.
2. **Stop was fake**: it used `Promise.race`, while the underlying request kept running for the full five minutes, burning quota. The losing promise also became an unhandled rejection. `fetchBinary` now genuinely supports `AbortSignal`.
3. **`fetchOnceViaNative` ignored the caller's timeout**, hard-coding 60 seconds, so slow MCP requests were reported as timeouts.
4. **`streamViaNative` had no timeout**, so a server that connects but never sends left the panel stuck on "generating" forever. A 5-minute backstop now applies uniformly.

### Fixed: other medium-severity issues

- **An empty placeholder bubble stayed on screen after Stop** (history then filtered it out, so UI and storage disagreed). It is now removed.
- **Inline-image filenames hard-coded index 1**, so multiple images in one message overwrote each other and images were lost. They are now numbered.
- **`onDestroy` aborted generation but not the chat stream**, so a destroyed panel kept receiving state writes.
- **Prompt polishing omitted the manual image list**, so manually marked image models were chosen and always failed.
- **URL images were not byte-checked**, so a JSON error body could be saved as an image file that would not open.
- **Absorbing inline images did not save**, so the work was lost and the base64 stayed in history.

### Cleanup: merged duplicate implementations

- **Three mime inference functions** became one (`mimeOfName`), the other two became aliases
- **Two base64 chunk encoders** became one (`bytesToBase64`)
- **Two 68-line request functions sharing 63 lines** became `runNativeRequest`
- Removed the unused `modelKindLabel`
- Removed a `computeSize` call repeated four times in one expression and one no-op ternary

### Fixed: the official size table harmed third-party models

`/gpt-image/i` also matched `gpt-image-2.6-sunburst`, forcing 2560×1440 down to 1536×1024. Now only exact official names are restricted.

### Documentation

- Bilingual README covering generation, image management, multi-select models, size tiers
- New `ARCHITECTURE.md` / `ARCHITECTURE.en.md`
- New `TESTING.md` / `TESTING.en.md`
- New `CHANGELOG.md` / `CHANGELOG.en.md`
- New `RELEASE-v1.4.0.md` / `RELEASE-v1.4.0.en.md`

### Tests

**49 files / 1459 assertions** (v1.3.0 was 33 / 841).

The additions all verify things that previously required clicking by hand or guessing: the generation request body, size maths, image types, late results after Stop, clearing models while keeping ticked ones, and where the Images button actually points.

34 of them are dedicated regressions for this round's ten fixes, each proven to fail when the fix is reverted.

---

## v1.3.0

**Theme: copy and resend my messages · pulled models work when clicked · clear all history**

### New: two buttons under my own messages

- **Copy**: copies the message without manual selection.
- **Resend**: regenerates from the same prompt and **replaces the existing answer in place**.

Resend **never adds** a message. History sent to the model stops before that message, so the model does not read its own previous answer.

### Fixed: models pulled from the endpoint did not work when selected

Three causes stacked:

1. **Clicking a model name did not really switch**: only the per-API model field changed, not the active API pointer.
2. **Pulling auto-selected the first entry**: relays usually list `text-embedding-3-small` first, which always fails.
3. **Non-chat models polluted the list**: `embedding`, `whisper`, `tts`, `rerank`, `dall-e`, `flux`.

Now clicking a name switches the API too; pulling only adds names; unusable models are filtered with a count.

### Improved: "clear all models" became "clear other models"

Only unticked models are removed; the active one always survives.

### New: clear all history

A **Clear all history (N)** button in the history drawer, with a confirmation. The conversation on screen is cleared too, otherwise the next answer would save it again.

### Documentation

- Full English `README.md`, new full Chinese `README.zh-CN.md`
- New `docs/RELEASE-v1.3.0.md`
- `.gitignore` completed with comments

---

## v1.2.0

**Theme: multiple APIs and models · mobile support**

- One config became several API cards, grouped in the top bar
- Mobile requests go through the SiYuan kernel, avoiding CORS
- Mobile sidebar entry and a bottom-sheet model picker

---

## v1.1.0

**Theme: UI rebuilt · scope narrowed to prompts and MCP**

- New panel layout: top bar, prompt row, MCP status row, conversation, control bar, composer
- Scope narrowed: removed material selection, side-by-side comparison, SOUL modules
- Added prompt templates and MCP tool support
