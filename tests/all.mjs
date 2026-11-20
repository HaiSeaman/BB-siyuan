/**
 * 一条命令跑完所有逻辑测试。
 * 每个测试文件独立跑，任一失败就整体失败。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = [
    "thinking.test.mjs",
    "apis.test.mjs",
    "image.test.mjs",
    "image-model-detect.test.mjs",
    "inline-image.test.mjs",
    "optimize.test.mjs",
    "image-sessions.test.mjs",
    "chat-model-pick.test.mjs",
    "settings-store.test.mjs",
    "switch-api.test.mjs",
    "model-picking.test.mjs",
    "panel-layout.test.mjs",
    "mask-geometry.test.mjs",
    "panel-render.test.mjs",
    "panel-image-mode.test.mjs",
    "panel-fixes.test.mjs",
    "panel-multi-pick-image.test.mjs",
    "multi-pick-image.test.mjs",
    "size-clear-folder.test.mjs",
    "panel-folder-size.test.mjs",
    "open-folder.test.mjs",
    "panel-realpath.test.mjs",
    "providers.test.mjs",
    "migrate.test.mjs",
    "net.test.mjs",
    "net-kernel.test.mjs",
    "net-native-merged.test.mjs",
    "review-fixes.test.mjs",
    "template.test.mjs",
    "templates-store.test.mjs",
    "turnplan.test.mjs",
    "template-binding.test.mjs",
    "mcp-with-template.test.mjs",
    "tokens.test.mjs",
    "mcp-jsonrpc.test.mjs",
    "mcp-http.test.mjs",
    "mcp-sse.test.mjs",
    "mcp-stdio.test.mjs",
    "mcp-stdio-lifecycle.test.mjs",
    "mcp-manager.test.mjs",
    "mcp-lifecycle.test.mjs",
    "tool-loop.test.mjs",
    "tool-calls-parse.test.mjs",
    "tools-in-body.test.mjs",
    "mcp-spawn.test.mjs",
    "errors.test.mjs",
    "sessions.test.mjs",
    "sessions-flow.test.mjs",
    "tool-messages.test.mjs",
];

let failed = 0;
for (const f of files) {
    console.log("");
    console.log("=== " + f + " ===");
    try {
        execFileSync(process.execPath, [join(here, f)], { stdio: "inherit" });
    } catch {
        failed++;
    }
}

console.log("");
if (failed) {
    console.log(`${failed} 个测试文件失败`);
    process.exit(1);
}
console.log("全部测试通过");
