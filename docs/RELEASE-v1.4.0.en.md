# Release notes — v1.4.0

> For pasting into a GitHub Release. Copy the block below into the release description.
> The Chinese original is in [RELEASE-v1.4.0.md](RELEASE-v1.4.0.md). The asset is `siyuan-plugin-ai-chat-v1.4.0.zip`.

---

## 1. GitHub release form

| Field | Value |
|---|---|
| **Tag** | `v1.4.0` |
| **Release title** | `v1.4.0 — Image generation: pick a painting model, images save themselves` |
| **Describe this release** | Copy the English block below |
| **Attach binaries** | `siyuan-plugin-ai-chat-v1.4.0.zip` |
| **Set as the latest release** | Yes |

---

## 2. English release description (copy this)

```markdown
## v1.4.0

The big change is **image generation**. Along the way, nearly every trap on
that path was closed, plus a batch of long-standing chat issues.

### 1. Generation: pick a painting model and draw

Open the model list from the top bar; painting models carry an orange **image** tag.
Clicking one switches the panel into **image mode**:

- The prompt bar and MCP bar collapse (image models ignore system prompts and never call tools)
- Send becomes **Generate**, and the top-bar dot turns from green to orange
- A **💬 Chat** button at the end of the control bar returns to the last chat model

It uses the standard OpenAI endpoints: `/images/generations` for text-to-image,
`/images/edits` for image-to-image.

### 2. Five controls above the input box

**Images / Upload / Size / Ratio / Polish**

- **Images**: opens the folder where generated images are saved
- **Upload**: pick a local image as a reference (PNG/JPG/WEBP, up to 8 MB) for img2img
- **Size**: 1K / 2K / 4K / 4K+, each showing its long edge
- **Ratio**: ten common ratios (1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 5:4, 4:5, 21:9)
- **Polish**: a **chat model** rewrites your text into a proper Chinese image prompt

### 3. Images save themselves into the plugin folder

```
<workspace>\data\storage\petal\siyuan-plugin-ai-chat\images\
```

- Images are **never** stored inside the session file. History keeps only the path,
  size, and prompt — a 4K image is over ten megabytes as base64
- Close and reopen the panel, or reopen old history: the images are still there
- Deleting or clearing conversations deletes their image files too

Every image card has two buttons: **Copy image** (puts the actual image on the clipboard)
and **Save to computer** (native Save As dialog).

### 4. Sizes now mean screen resolutions

1K used to mean "long edge 1024", so 1K + 16:9 produced 1024×576 and could not fill a screen. Now:

| Tier | 16:9 | 1:1 | 9:16 | Fills |
|---|---|---|---|---|
| 1K | 1920×1080 | 1920×1920 | 1080×1920 | 1080p / typical laptop |
| 2K | 2560×1440 | 2560×2560 | 1440×2560 | 2K monitor |
| 4K | 3840×2160 | 3840×3840 | 2160×3840 | 4K monitor / TV |
| 4K+ | 4096×2304 | 4096×4096 | 2304×4096 | DCI 4K |

### 5. Multi-select models within one API

Each model name has a checkbox: tick a few and the top bar lists only those;
unticked names are dimmed in settings; the model in use cannot be unticked.
Existing configs upgrade fully ticked, so nothing changes.

**Clear other models** now keeps **ticked models, image models, and the active model** —
only models that are none of those are removed. (It used to keep just the active one,
so ticking five left you with one.)

### 6. Main fixes

- **Image models like `gemini-3.1-flash-image` were not recognised**, so the plugin
  claimed none existed and hid all four buttons. Any name containing `image` now counts;
  anything else can be marked by hand in settings.
- **The four buttons were missing entirely**: they only rendered in image mode, and
  entering image mode depended on that recognition. They are now always visible,
  to the right of the thinking pill.
- **Images "copy and save fine but never display"**: JPEG bytes were named `.png`, which
  some SiYuan versions refuse to render, and the template never recomputed after the image
  data arrived. Type now comes from the file header, and the template reads a reactive map.
- **Images embedded in reply text were plain text**: Gemini-style replies put images inside
  the message, which showed a generic Copy and inflated the session file to 1 MB. They are
  now extracted into image cards and moved into `images/`.
- **The Images button could not open the folder**: the path had a duplicated `data`
  segment. It now handles both layouts and tries four ways to open the folder.
- **Generation concurrency and timeouts**: stop-then-generate could run two rounds at once;
  Stop was fake (the request kept running for five minutes); the desktop channel ignored
  the timeout argument; the streaming channel had no timeout at all and could hang forever.
- **Inline image filenames collided**: several images in the same second overwrote each
  other, losing pictures.
- **An empty bubble stayed after Stop**, leaving UI and storage inconsistent.
- **Prompt polishing ignored the manual image list**, so manually marked image models were
  chosen and always failed.

### 7. Docs and tests

- README, architecture, testing guide, changelog, and release notes are **bilingual**
- **50 test files / 1496 assertions** (previous: 33 / 841)

### Upgrade notes

- Install over the old version; settings and history are preserved.
- Images generated by earlier versions are renamed to their real type when a conversation
  is opened, and references are updated.
- **Generation is OpenAI-compatible only** and requires the provider to expose
  `/images/generations`.
- **The base URL must include `/v1`**; omitting it returns 404 `Invalid URL`.
```

---

## 3. Post-publish checklist

1. Download the asset you just uploaded; confirm `plugin.json` is at the root and `version` is `1.4.0`.
2. Install from the zip in SiYuan, restart, then confirm:
   - the panel opens
   - settings show checkboxes next to model names
   - picking an image model enters image mode with all four buttons present
   - the **Images** button opens the folder
3. If publishing both languages, put the Chinese block first and the English block after it.
