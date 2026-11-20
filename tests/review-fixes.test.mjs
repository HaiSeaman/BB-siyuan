/**
 * 本轮审查修复的回归测试。
 *
 * 每条都对应一个真实 bug，测试要能在"把修复撤掉"时变红。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
    if (cond) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name + (extra ? "  → " + extra : ""));
    }
}

console.log("1. 停止后台图片文件名不再撞车：");
{
    const src = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    // 正文插图搬盘那段必须带下标变量，不能硬传 1
    const m = src.match(/imageFileName\(new Date\(\), "msg", (\w+), realMime\)/);
    ok("传的是循环下标而不是固定 1", !!m, "没找到带下标的调用");
    ok("下标变量是 imgIdx", m?.[1] === "imgIdx", m?.[1]);
    // 必须有 imgIdx++ 
    ok("有 imgIdx 自增", src.includes("imgIdx++"), "没自增");
}

console.log("2. generating 只在仍是当前轮时才清（防按钮提前解锁）：");
{
    const src = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    ok(
        "finally 里 generating 在守卫内",
        /if \(genAbort === myAbort\) \{\s*generating = false;\s*genAbort = null;\s*\}/.test(src),
        "守卫没包住 generating"
    );
}

console.log("3. onDestroy 要中止聊天流：");
{
    const src = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    const m = src.match(/onDestroy\(\(\) => \{[\s\S]*?\}\);/);
    ok("找到 onDestroy", !!m);
    ok("里面有 abortFn.abort()", (m?.[0] || "").includes("abortFn.abort()"), m?.[0]?.slice(0, 200));
    ok("里面有 genAbort.abort()", (m?.[0] || "").includes("genAbort.abort()"));
}

console.log("4. 停止后不留空白占位：");
{
    const src = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    const m = src.match(/if \(isStopped\(\)\) \{[\s\S]{0,500}?return;/);
    ok("找到 isStopped 分支", !!m);
    ok("分支里删掉了占位消息", (m?.[0] || "").includes("messages.slice(0, answerIndex)"), m?.[0]?.slice(0, 250));
}

console.log("5. 优化提示词要传手动标记的名单：");
{
    const src = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    ok(
        "chatApiFor 收到第三个参数",
        /chatApiFor\(\$settings, isChatModel, manual\)/.test(src),
        "调用没带 manual"
    );
}

console.log("6. fetchBinary 支持 signal（真中止）：");
{
    const src = readFileSync("src/net.ts", "utf8");
    ok("签名里有 signal", /signal\?:\s*AbortSignal/.test(src));
    ok("浏览器通道用了 signal", /signal:\s*opts\.signal/.test(src));
    ok("native 通道监听了 abort", src.includes('sig.addEventListener("abort"'));
    ok("已经中止时直接抛", /opts\.signal\?\.aborted\) throw new Error\("已停止"\)/.test(src));
}

console.log("7. streamViaNative 有兜底超时：");
{
    const src = readFileSync("src/net.ts", "utf8");
    ok("有 idleTimer", src.includes("idleTimer"));
    ok("超时时间 5 分钟", /300000\)/.test(src));
    ok("finish 里清了定时器", /clearTimeout\(idleTimer\)/.test(src));
}

console.log("8. fetchOnce 的 timeoutMs 透传：");
{
    const src = readFileSync("src/net.ts", "utf8");
    ok("用 opts.timeoutMs ?? 60000", /opts\.timeoutMs \?\? 60000/.test(src), "还是硬编码");
}

console.log("9. 网址图片要按字节校验（JSON 错误体不能当图片）：");
{
    const src = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    const m = src.match(/const sniffed = sniffImageMime\(bytes, ""\);\s*if \(!sniffed\) return null;/);
    ok("有字节嗅探 + 认不出就返回 null", !!m, "没有校验");
}

console.log("10. mime 推断只有一份实现：");
{
    const store = readFileSync("src/image-store.ts", "utf8");
    const img = readFileSync("src/image.ts", "utf8");
    const inline = readFileSync("src/inline-image.ts", "utf8");

    ok("image-store 有 mimeOfName", /export function mimeOfName/.test(store));
    ok("image-store 的 mimeOfPath 是别名", /export const mimeOfPath = mimeOfName/.test(store));
    ok("image.ts 不再自己定义 mimeOfName", !/export function mimeOfName/.test(img));
    ok("inline-image 改成 re-export", /export \{ mimeOfName as inlineImageMime \}/.test(inline));
}

console.log("11. base64 编码只有一份实现：");
{
    const store = readFileSync("src/image-store.ts", "utf8");
    const net = readFileSync("src/net.ts", "utf8");
    ok("image-store 导出 bytesToBase64", /export function bytesToBase64/.test(store));
    ok("net.ts 不再自己定义", !/^function bytesToBase64/m.test(net), "net.ts 还有一份");
    ok("net.ts 从 image-store 导入", /import \{ bytesToBase64 \} from "\.\/image-store"/.test(net));
}

console.log("12. 长边取值不再重复算 4 次：");
{
    const img = readFileSync("src/image.ts", "utf8");
    const panel = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    ok("image.ts 有 longEdgeOf", /export function longEdgeOf/.test(img));
    ok("模板里用 longEdgeOf", /\{longEdgeOf\(s\)\}/.test(panel));
    ok("模板里不再连着调 4 次 computeSize", !/computeSize\(s, imageRatio\)\.width >= computeSize/.test(panel));
}

console.log("13. 整理正文图片后会保存（不留 base64 在存档里）：");
{
    const src = readFileSync("src/ui/ChatPanel.svelte", "utf8");
    const calls = [...src.matchAll(/absorbAllInlineImages\(\)\.then\(\(\) => saveCurrentSession\(\)\)/g)];
    ok("至少两处整理后保存（onMount / openSession）", calls.length >= 2, "只有 " + calls.length + " 处");
}

console.log("14. 行为回归：这些老功能还在：");
{
    // 用真实模块验证关键路径没被改坏
    const image = await import(pathToFileURL(".test/image.js").href + "?t=" + Date.now());
    ok("1K + 16:9 仍是 1920×1080", JSON.stringify(image.computeSize("1K", "16:9").label) === '"1920 × 1080"');
    ok("4K+ 仍是 4096 长边", image.longEdgeOf("4K+") === 4096);
    ok("gpt-image-1 仍只认 3 种", image.officialSizes("gpt-image-1").length === 3);
    ok("第三方 gpt-image-2.6 不受限", image.officialSizes("gpt-image-2.6-sunburst") === null);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
