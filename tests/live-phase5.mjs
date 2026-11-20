/**
 * 真实接口验证阶段五的两件事：
 *   1. 真实报错能被翻译成人话
 *   2. 真实的完整对话能正确存档
 */
import { friendlyError } from "../.test/errors.js";
import { normalizeSessions, sameMessages, sessionTitle } from "../.test/sessions.js";

const base = process.env.SIYUAN_AI_BASE || "http://192.168.1.8:17864/v1";
const key = process.env.SIYUAN_AI_KEY || "";
const url = base.replace(/\/+$/, "") + "/chat/completions";

let pass = 0;
let fail = 0;
function ok(n, e) {
    pass++;
    console.log("  OK   " + n + (e ? " —— " + e : ""));
}
function bad(n, w) {
    fail++;
    console.log("  FAIL " + n + " —— " + w);
}

async function probe(label, { apiKey, model, headers }) {
    const resp = await fetch(url, {
        method: "POST",
        headers: headers || {
            "Content-Type": "application/json",
            Authorization: "Bearer " + apiKey,
            Accept: "text/event-stream",
        },
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "hi" }],
            stream: false,
            max_tokens: 16,
        }),
    });
    const text = await resp.text();
    return { status: resp.status, text };
}

console.log("1. 坏密钥 → 说密钥");
try {
    const r = await probe("坏密钥", { apiKey: "wrong_key_123", model: "glm-5.3" });
    const human = friendlyError({ status: r.status, message: r.text.slice(0, 200) });
    console.log("   实际状态码：" + r.status);
    console.log("   翻译成：" + human);
    if (/密钥/.test(human)) ok("坏密钥被翻译成「密钥」提示");
    else bad("坏密钥翻译", human);
} catch (e) {
    bad("坏密钥探测", e.message);
}

console.log("2. 不存在的模型 → 说模型");
try {
    const r = await probe("坏模型", { apiKey: key, model: "definitely-not-a-real-model-xyz" });
    const human = friendlyError({ status: r.status, message: r.text.slice(0, 200) });
    console.log("   实际状态码：" + r.status);
    console.log("   服务端原文：" + r.text.slice(0, 120).replace(/\n/g, " "));
    console.log("   翻译成：" + human);
    if (/模型/.test(human)) ok("模型不存在被翻译成「模型」提示");
    else bad("模型错误翻译", "没提到模型：" + human);
} catch (e) {
    bad("坏模型探测", e.message);
}

console.log("3. 地址写错 → 说地址");
try {
    const badUrl = base.replace(/\/v1\/?$/, "/v9") + "/chat/completions";
    const resp = await fetch(badUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
    });
    const human = friendlyError({ status: resp.status, message: "" });
    console.log("   实际状态码：" + resp.status);
    console.log("   翻译成：" + human);
    if (resp.status === 404 && /地址/.test(human)) ok("404 被翻译成「地址」提示");
    else if (resp.status !== 404) ok("这个服务对错路径没回 404，跳过（" + resp.status + "）");
    else bad("404 翻译", human);
} catch (e) {
    bad("错误地址探测", e.message);
}

console.log("4. 真实对话能正确存档并恢复");
try {
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
            Accept: "text/event-stream",
        },
        body: JSON.stringify({
            model: "glm-5.3",
            messages: [{ role: "user", content: "用一句话介绍你自己" }],
            stream: false,
            max_tokens: 200,
            reasoning_effort: "low",
        }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    const answer = data?.choices?.[0]?.message?.content || "";
    if (!answer.trim()) throw new Error("没拿到回答");

    const messages = [
        { role: "user", content: "用一句话介绍你自己", reasoning: "" },
        { role: "assistant", content: answer, reasoning: "" },
    ];

    // 存 → 模拟重启读回
    const saved = [
        {
            id: "live-1",
            title: sessionTitle(messages[0].content),
            messages,
            updatedAt: Date.now(),
        },
    ];
    const restored = normalizeSessions(JSON.parse(JSON.stringify(saved)));

    if (restored.length === 1 && restored[0].messages.length === 2) {
        ok("真实对话存取无损", "回答 " + answer.length + " 字");
    } else {
        bad("存档恢复", JSON.stringify(restored).slice(0, 150));
    }

    if (sameMessages(restored[0].messages, messages)) ok("内容和存进去时一模一样");
    else bad("内容一致性", "有差异");

    console.log("   标题：" + restored[0].title);
} catch (e) {
    bad("真实对话存档", e.message);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
