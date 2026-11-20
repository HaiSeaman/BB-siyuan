# Testing Guide

> This project does **no GUI click testing** (no windows, no browser, no desktop app). Button clicks are still verified — see section 3.

Current version: **1.4.0** ｜ [中文版](TESTING.md)

**Current size: 49 test files / 1459 assertions, all passing.**

---

## 1. Running the tests

```powershell
npm test
```

It first runs `npm run test:build` (compiling `.ts` / `.svelte` into `.test/`), then runs each `tests/*.test.mjs`.

**How to read the result:** only the final `全部测试通过` (all tests passed) means success. Otherwise you get `N 个测试文件失败` (N files failed) and a non-zero exit code.

Other commands:

```powershell
npm run test:build   # compile test artifacts only
npm run build        # production build into dist/
npm run pack         # build + zip
npx svelte-check --tsconfig ./tsconfig.json   # types and templates
```

---

## 2. How test files are organised

- Each file runs standalone, tracks its own `pass` / `fail`, ends with `process.exit(fail === 0 ? 0 : 1)`.
- Same shape everywhere: `check("name", actual, expected)` compared via `JSON.stringify`.
- Pure logic only (`src/*.ts`). Svelte components are handled with the technique in section 3.

After adding a file you **must** add it to the `files` array in `tests/all.mjs`, or it will not run.

### Writing a pure-logic test

```js
// Import the compiled artifact from .test/, never from src
import { parseModelList } from "../.test/apis.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { pass++; console.log("  OK   " + name); }
    else {
        fail++;
        console.log("  FAIL " + name);
        console.log("       actual:   " + JSON.stringify(actual));
        console.log("       expected: " + JSON.stringify(expected));
    }
}
```

---

## 3. Headless verification that the UI really responds

### Why

Reading code **cannot** show "clicking does nothing". Real case: `$: canThink = supportsThinking(currentModel())` read a `$:` variable that had not been assigned yet; the throw aborted the whole render. The code looked fine; only a real mount plus a click exposed it.

### Dependencies (devDependencies only, never shipped)

```
linkedom                  a pure-JS DOM
esbuild-svelte / vite     compiles .svelte into importable JS
```

### Procedure

1. Build `ChatPanel.svelte` into an `.mjs` with **Vite** (same chain as production).
2. Create a fake `window` / `document` with `linkedom`, assign to `globalThis`.
3. `new ChatPanel({ target: host, props })` to mount for real.
4. `querySelector` the button, `dispatchEvent(new Event("click"))`.
5. **Wait one tick** (Svelte updates in a microtask) before asserting.

```js
const tick = () => new Promise((r) => setTimeout(r, 0));

click(gear);
await tick();                       // ← omitting this looks like "no response"
ok("drawer appeared", !!$(".drawer"));
```

### Traps

| Trap | Symptom | Fix |
|---|---|---|
| Bundling child components with `esbuild-svelte` | `SettingsPanel is not defined` | **Use Vite** for the test bundle |
| Forgetting `await tick()` | State looks unchanged | Wait a tick after each click |
| `linkedom` lacks `MouseEvent` | `not a constructor` | `new window.Event("click", {bubbles:true})` |
| `globalThis.navigator` is read-only | `Cannot set property` | `Object.defineProperty(globalThis, "navigator", {...})` |
| `import(absolutePath)` on Windows | `ERR_UNSUPPORTED_ESM_URL_SCHEME` | Use `pathToFileURL(p).href` |
| **Sharing one module across sections** | A store change leaks into the next section | `import(url + "?fresh=" + n)` each time |
| **`net.ts` caches the bridge** | Swapping the fake bridge has no effect | Re-import `net` in every scenario |
| **Tests inventing their own paths** | Broken code stays green | Read the real config (see section 5) |

### Store isolation (important)

The settings store is a **module-level singleton**. Sections contaminate each other: one section switches to an image model, the next one declares a chat model in props yet the panel is already in image mode.

```js
let seq = 0;
async function freshPanel() {
    seq++;
    return (await import(pathToFileURL(bundle).href + "?fresh=" + seq + "-" + Date.now())).default;
}
```

Do **not** change production code to reset on every mount. At runtime the store is supposed to survive remounts (collapse the dock, reopen it, your settings are still there).

---

## 4. What the panel tests cover

### `tests/panel-render.test.mjs` (79)

- Settings opens the drawer; × closes it
- New chat does not throw; the panel survives
- The model button opens the switcher inside the layer
- Clicking another model closes it and **the top bar really changes**
- Clicking the mask closes it
- Manage opens the template drawer
- Mobile form: bottom sheet, does not cover the top bar
- My messages have Copy / Resend; resend **does not add a message**
- Resending the **middle** message keeps later turns intact
- Clicking a model chip switches the active API too (the original "click does nothing" bug)
- "Clear other models" keeps exactly the selected one
- "Clear all history" works, and cancel deletes nothing

### `tests/panel-image-mode.test.mjs` (119)

- Picking an image model **enters image mode** (banner appears, prompt and MCP bars collapse, Send becomes Generate)
- **All four buttons exist**, to the right of the thinking pill, in order Upload → Size → Ratio → Polish
- Four size tiers, ten ratios
- Upload validates format (GIF rejected), shows the reference chip, × removes it
- Polish with no chat model says so and **sends no request at all**
- **Generate sends the right body**: `/images/generations`, model, prompt, size, base64
- **With a reference image it uses `/images/edits` + multipart**
- Image cards have both buttons; unreadable images show a reason plus Retry
- Switching modes back and forth also switches models
- "Image mode" with no image model refuses to switch and explains why
- Buttons disable while generating; Stop works
- **Late results after Stop are discarded**
- Mobile shows the same four buttons

### `tests/panel-fixes.test.mjs` (35)

Runs with the **owner's real config** (`gemini-3.1-flash-image`):

- That name auto-enters image mode instead of claiming "no model"
- The four buttons are in the right places
- An image card has **exactly two** buttons
- **The real 964 KB base64 message** becomes an image card; the base64 is gone from the text

### `tests/panel-multi-pick-image.test.mjs` (17)

- The top bar lists **only ticked** models; with none ticked it falls back to all
- A readable image renders `<img>` with a real data URL
- An unreadable one shows the reason and Retry, and **Retry really re-requests and recovers**
- `content-type: octet-stream` with image bytes still displays

### `tests/panel-folder-size.test.mjs` (23)

- The **Images** button sits between thinking and Upload
- Clicking it **calls `shell.openPath`** with a path containing `petal` and `images`
- **The path contains exactly one `data` segment** (no `data\data`)
- Failure reports the reason and the path; mobile explains it cannot open
- Four size tiers; the 2K entry shows long edge 2560
- 1K + 16:9 shows 1920 × 1080

### `tests/panel-realpath.test.mjs` (6)

Uses the **real `dataDir` from `conf.json`**, and asserts the path handed to `openPath`
**equals** `Z:\siyuan\data\storage\petal\siyuan-plugin-ai-chat\images`, and that the folder exists.

> This is the counter-example to "invent your own test environment": an earlier version hard-coded `dataDir` as `Z:\siyuan` (the real value is `Z:\siyuan\data`) and had a fake `fs.existsSync` return false, so code that appended a second `data\` produced a nonexistent path while the suite stayed green.

---

## 5. Data and utility layer

| File | Assertions | Covers |
|---|---|---|
| `image.test.mjs` | 114 | Size maths (4 tiers × 10 ratios all multiples of 8), official size table, endpoints, multipart bytes, response parsing, filenames |
| `apis.test.mjs` | 72 | Model normalisation, pulling, merging, classification |
| `image-model-detect.test.mjs` | 30 | `gemini-3.1-flash-image` classified as image; counter-examples not harmed; manual override; old config upgrade |
| `inline-image.test.mjs` | 33 | Extracting images from text (base64 / URL / multiple), not harming normal links, whether to move to disk |
| `optimize.test.mjs` | 42 | Prompt cleanup (fences, quotes, prefixes), empty-reply detection, error translation |
| `image-sessions.test.mjs` | 26 | Image messages in history, **image data never enters JSON**, per-message cap |
| `chat-model-pick.test.mjs` | 51 | Six `chatApiFor` scenarios, `packModelRef`, classification labels |
| `multi-pick-image.test.mjs` | 25 | Multi-select, the active model cannot be unticked, at least one remains, magic-byte sniffing |
| `size-clear-folder.test.mjs` | 27 | Four tiers, clearing keeps ticked models, `pickedOf` fallback |
| `open-folder.test.mjs` | 20 | Three `dataDir` shapes, missing folder, mobile, four fallbacks |
| `net-native-merged.test.mjs` | 16 | Desktop channel: 200/401/multi-chunk/error/timeout/bytes |
| `review-fixes.test.mjs` | 34 | The ten review fixes, one assertion group each |
| `providers.test.mjs` | 60 | Three protocols, building and parsing |
| `sessions.test.mjs` | 37 | History cleanup, caps, titles |
| `mcp-*.test.mjs` | 154 | JSON-RPC, HTTP, SSE, stdio, lifecycle, tool loop |
| Others | — | Templates, tokens, errors, migration, settings |

---

## 6. Layout guard tests

`tests/panel-layout.test.mjs` reads the `ChatPanel.svelte` source and `dist/index.css` and asserts:

- `.panel` has `position: relative`
- the mask lives inside `.picker-layer`
- the layer starts at `top: 40px`
- the layer is `pointer-events: none`

`tests/mask-geometry.test.mjs` models the historical outage geometrically: it computes which area the mask covers and proves the top-bar buttons are reachable.

**Both are regression guards.** Run them after any layout change.

---

## 7. Proving the tests actually work

After writing a fix test, **temporarily revert the fix** and confirm the suite goes red.

```js
// Backup → restore the old code → run → expect failures > 0 → restore
copyFileSync(file, backup);
writeFileSync(file, brokenSource);
const failed = runTest();          // should be > 0
copyFileSync(backup, file);
```

Measured (v1.4.0):

| Reverted fix | Failures |
|---|---|
| Inline-image filename index | 2 |
| `generating` guard in the image `finally` | 1 |

> Revert **only the original code**, never the dependency wiring. Changing the dependency graph can make the failure unreproducible, and the check proves nothing.

---

## 8. Live endpoint checks (manual, optional)

`tests/live*.mjs` hit real providers and need your key:

```powershell
$env:SIYUAN_AI_KEY="your-key"
node tests/live.mjs            # three protocols + thinking levels
node tests/live-template.mjs   # whether templates really apply
node tests/live-mcp.mjs        # a real MCP server
node tests/live-mcp-full.mjs   # full chain: real model + real MCP + real tool call
```

These are **not** part of `npm test` (they cost money and need network).

Image generation can be checked without the plugin:

```powershell
# Replace URL, key, and model with your own
$body = @{ model='your-image-model'; prompt='a red apple'; n=1; size='2560x1440'; response_format='b64_json' } | ConvertTo-Json -Compress
Invoke-WebRequest -Uri 'https://your-relay/v1/images/generations' -Method POST `
  -Headers @{ Authorization='Bearer YOUR_KEY'; 'Content-Type'='application/json' } `
  -Body $body -TimeoutSec 180
```

A `data[0].b64_json` in the response proves the provider accepts that size.

---

## 9. Pre-delivery checklist

1. `npx svelte-check --tsconfig ./tsconfig.json` → `0 errors and 0 warnings`
2. `npm test` → `全部测试通过`; note the file and assertion counts
3. `npm run pack` → `plugin.json` must be at the zip **root**
4. Verify the zip independently (do not trust the packing script):

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

> Read artifacts with `[IO.File]::ReadAllText`. `Get-Content -Raw` and `findstr` corrupt Chinese text and produce false "not found" results.

5. After installing into SiYuan, re-check key strings byte-for-byte:

```powershell
node -e "const fs=require('fs');const p='Z:/siyuan/data/plugins/siyuan-plugin-ai-chat/';const js=fs.readFileSync(p+'index.js','utf8');for(const k of ['images/generations','openPath','image/jpeg']){console.log(k+' -> '+js.includes(k))}"
```

**Note:** the build minifies and renames functions. Check **feature strings** (UI copy, URL fragments, error text), never function names.

---

## 10. What the numbers mean

**1459 assertions across 49 files** (v1.4.0).

The count is not the goal, but it does show one thing: the bigger the change, the more "same input must give same output" assertions are needed to hold it.

This round grew from 841 to 1459, and the additions are all places that previously required clicking by hand or guessing:

- What the generation request body actually is (`/images/generations` vs `/edits`, whether multipart has a boundary)
- Whether the size maths is right (1K + 16:9 must be exactly 1920×1080)
- Whether image type should be decided from bytes
- Whether late results after Stop sneak into the conversation
- Whether clearing models deletes the ticked ones
- Where the Images button actually points

**They are not decoration:** each of the ten fixes this round came with an assertion proven to fail when the fix is reverted.
