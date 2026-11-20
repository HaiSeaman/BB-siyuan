/**
 * 模板功能的端到端验证：用真实接口跑内置模板，确认
 *   1. 模板正文确实作为 system 生效（能约束回答格式）
 *   2. {{content}} 里的素材确实被模型看到了
 *   3. 变量替换（日期）正常工作
 */
import { buildTurnPlan } from "../.test/turnplan.js";
import { makeContext } from "../.test/template.js";
import { BUILTIN_TEMPLATES } from "../.test/templates-store.js";
import { ProviderParser } from "../.test/providers.js";

const base = process.env.SIYUAN_AI_BASE || "http://192.168.1.8:17864/v1";
const key = process.env.SIYUAN_AI_KEY || "";
const url = base.replace(/\/+$/, "") + "/chat/completions";
const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + key,
    Accept: "text/event-stream",
};

let pass = 0;
let fail = 0;

async function call(system, messages) {
    const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: "glm-5.3",
            messages: system ? [{ role: "system", content: system }, ...messages] : messages,
            stream: true,
            max_tokens: 1200,
            reasoning_effort: "low",
        }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 150)}`);

    let text = "";
    const p = new ProviderParser("openai", (t) => (text += t), () => {});
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        p.push(dec.decode(value, { stream: true }));
    }
    p.end();
    return text;
}

const diary = "今天上午开了季度会，讨论了明年预算，决定砍掉两个项目。下午和客户吃了饭，对方对价格有意见。晚上跑步三公里。";

console.log("1. 内置「要点总结」模板");
try {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.name === "要点总结");
    const plan = buildTurnPlan({
        template: tpl,
        material: diary,
        userText: "",
        ctx: makeContext(diary, "今天的日记"),
        history: [],
    });
    const out = await call(plan.system, plan.messages);
    const hasBullet = /[-*•]|\d\./.test(out);
    const mentionsKey = /预算|项目|客户|价格|跑步/.test(out);
    if (hasBullet && mentionsKey) {
        pass++;
        console.log("  OK   要点清单格式，且抓住日记要点");
        console.log("       摘要：" + out.slice(0, 90).replace(/\n/g, " "));
    } else {
        fail++;
        console.log(`  FAIL 格式=${hasBullet} 要点=${mentionsKey}`);
        console.log("       " + out.slice(0, 200).replace(/\n/g, " "));
    }
} catch (e) {
    fail++;
    console.log("  FAIL " + e.message);
}

console.log("2. 模板里 {{content}} 确实被替换成素材");
try {
    const tpl = {
        id: "probe",
        name: "探针",
        content: "只回答一个词：用户给的素材里提到了几个数字？先说明白素材是关于什么的。",
        order: 0,
    };
    const plan = buildTurnPlan({
        template: tpl,
        material: diary,
        userText: "",
        ctx: makeContext(diary, "x"),
        history: [],
    });
    const out = await call(plan.system, plan.messages);
    // 模板没写 {{content}}，素材应作为独立 user 消息发过去
    const seesMaterial = /预算|项目|客户|跑步|会/.test(out);
    if (seesMaterial) {
        pass++;
        console.log("  OK   模型看到了素材：" + out.slice(0, 80).replace(/\n/g, " "));
    } else {
        fail++;
        console.log("  FAIL 模型没看到素材：" + out.slice(0, 150).replace(/\n/g, " "));
    }
} catch (e) {
    fail++;
    console.log("  FAIL " + e.message);
}

console.log("3. 日期变量确实传进去了");
try {
    const tpl = {
        id: "date-probe",
        name: "日期探针",
        content: "今天的日期是 {{date}}。请只回答这句话里的日期数字，格式 YYYY-MM-DD。",
        order: 0,
    };
    const ctx = makeContext("", "x", new Date(2026, 10, 18));
    const plan = buildTurnPlan({ template: tpl, material: "", userText: "", ctx, history: [] });
    const out = await call(plan.system, plan.messages);
    if (out.includes("2026-11-18")) {
        pass++;
        console.log("  OK   日期正确传达：" + out.trim().slice(0, 40));
    } else {
        fail++;
        console.log("  FAIL 日期没对上：" + out.slice(0, 120).replace(/\n/g, " "));
    }
} catch (e) {
    fail++;
    console.log("  FAIL " + e.message);
}

console.log("4. 追问时模板规则仍然生效");
try {
    const tpl = {
        id: "follow-probe",
        name: "追问探针",
        content: "无论用户说什么，每条回答都要以「收到：」开头。",
        order: 0,
    };
    const ctx = makeContext("", "x");
    const first = buildTurnPlan({ template: tpl, material: "", userText: "你好", ctx, history: [] });
    const out1 = await call(first.system, first.messages);
    const second = buildTurnPlan({
        template: tpl,
        material: "",
        userText: "再说一句",
        ctx,
        history: [
            { role: "user", content: "你好" },
            { role: "assistant", content: out1 },
        ],
    });
    const out2 = await call(second.system, second.messages);
    if (out1.includes("收到") && out2.includes("收到")) {
        pass++;
        console.log("  OK   两轮都遵守模板规则");
    } else {
        fail++;
        console.log(`  FAIL 第一轮=${out1.includes("收到")} 第二轮=${out2.includes("收到")}`);
        console.log("       二轮回答：" + out2.slice(0, 100).replace(/\n/g, " "));
    }
} catch (e) {
    fail++;
    console.log("  FAIL " + e.message);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
