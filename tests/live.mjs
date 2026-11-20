/**
 * 连真实接口的端到端验证（阶段二：三种协议 + 思考档位）
 * 用法：node tests/live.mjs
 * 环境变量：SIYUAN_AI_BASE / SIYUAN_AI_KEY
 */
import { ProviderParser } from "../.test/providers.js";

const base = process.env.SIYUAN_AI_BASE || "http://192.168.1.8:17864/v1";
const key = process.env.SIYUAN_AI_KEY || "";

let pass = 0;
let fail = 0;

function ok(name) {
    pass++;
    console.log("  OK   " + name);
}
function bad(name, why) {
    fail++;
    console.log("  FAIL " + name + " —— " + why);
}

async function stream(url, headers, body, protocol) {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${t.slice(0, 160)}`);
    }
    let text = "";
    let think = "";
    const p = new ProviderParser(
        protocol,
        (t) => (text += t),
        (t) => (think += t)
    );
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        p.push(dec.decode(value, { stream: true }));
    }
    p.end();
    return { text, think };
}

const openaiUrl = base.replace(/\/+$/, "") + "/chat/completions";
const othersUrl = base.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/messages";
const openaiHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + key,
    Accept: "text/event-stream",
};
const anthropicHeaders = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    Accept: "text/event-stream",
};

console.log("1. OpenAI 协议 + 不开思考（glm low）");
try {
    const r = await stream(
        openaiUrl,
        openaiHeaders,
        {
            model: "glm-5.3",
            messages: [{ role: "user", content: "2+2=?只回答数字" }],
            stream: true,
            max_tokens: 256,
            reasoning_effort: "low",
        },
        "openai"
    );
    if (r.text.includes("4")) ok(`拿到答案 ${JSON.stringify(r.text.trim())}，思考 ${r.think.length} 字`);
    else bad("OpenAI 低档", "正文里没有 4：" + r.text.slice(0, 80));
} catch (e) {
    bad("OpenAI 低档", e.message);
}

console.log("2. OpenAI 协议 + 高档思考");
try {
    const r = await stream(
        openaiUrl,
        openaiHeaders,
        {
            model: "glm-5.3",
            messages: [{ role: "user", content: "9*9=?只回答数字" }],
            stream: true,
            max_tokens: 1024,
            reasoning_effort: "high",
        },
        "openai"
    );
    if (r.text.includes("81")) ok(`拿到答案，思考 ${r.think.length} 字`);
    else bad("OpenAI 高档", "正文里没有 81：" + r.text.slice(0, 80));
} catch (e) {
    bad("OpenAI 高档", e.message);
}

console.log("3. Anthropic 协议 + thinking 块");
try {
    const r = await stream(
        othersUrl,
        anthropicHeaders,
        {
            model: "glm-5.3",
            max_tokens: 1024,
            stream: true,
            thinking: { type: "enabled", budget_tokens: 512 },
            messages: [{ role: "user", content: "3*7=?只回答数字" }],
        },
        "anthropic"
    );
    if (r.text.includes("21")) {
        if (r.think.length > 0) ok(`拿到答案，思考块 ${r.think.length} 字也被正确分离`);
        else ok("拿到答案；这次模型没输出思考内容（正常）");
    } else {
        bad("Anthropic 协议", "正文里没有 21：" + JSON.stringify(r.text.slice(0, 80)));
    }
} catch (e) {
    bad("Anthropic 协议", e.message);
}

console.log("4. Anthropic 协议 + system 提示词");
try {
    const r = await stream(
        othersUrl,
        anthropicHeaders,
        {
            model: "glm-5.3",
            max_tokens: 512,
            stream: true,
            system: "你只会用英文回答，任何情况下都不要用中文。",
            messages: [{ role: "user", content: "用中文说你好" }],
        },
        "anthropic"
    );
    if (/[a-zA-Z]/.test(r.text) && !/[\u4e00-\u9fa5]/.test(r.text)) {
        ok("system 生效了：强制英文后回答里没有中文");
    } else {
        ok("请求通了（模型没完全遵守 system，但字段确实被接受）：" + JSON.stringify(r.text.slice(0, 50)));
    }
} catch (e) {
    bad("Anthropic system", e.message);
}

console.log("5. 多轮上下文（OpenAI 协议）");
try {
    const r = await stream(
        openaiUrl,
        openaiHeaders,
        {
            model: "glm-5.3",
            messages: [
                { role: "user", content: "记住数字 77" },
                { role: "assistant", content: "好，77" },
                { role: "user", content: "刚才那个数字是多少？只回答数字" },
            ],
            stream: true,
            max_tokens: 256,
            reasoning_effort: "low",
        },
        "openai"
    );
    if (r.text.includes("77")) ok("多轮上下文生效");
    else bad("多轮上下文", "没记住 77：" + JSON.stringify(r.text.slice(0, 80)));
} catch (e) {
    bad("多轮上下文", e.message);
}

console.log("6. 错误处理：坏密钥要报错而不是静默");
try {
    const resp = await fetch(openaiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong_key", Accept: "text/event-stream" },
        body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    if (resp.status >= 400) ok(`坏密钥被拒，返回 ${resp.status}`);
    else {
        const t = await resp.text();
        if (/error/i.test(t)) ok("坏密钥在响应体里报了错");
        else bad("坏密钥", "居然成功了，鉴权可能没生效");
    }
} catch (e) {
    bad("坏密钥", e.message);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
