/**
 * 会话存档的实际行为验证：模拟「聊天 → 存 → 重启 → 恢复」。
 * 不涉及界面，只验数据。
 */
import {
    normalizeSessions,
    upsertSession,
    removeSession,
    sessionTitle,
    sameMessages,
    MAX_SESSIONS,
} from "../.test/sessions.js";

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name);
        console.log("       实际: " + JSON.stringify(actual));
        console.log("       期望: " + JSON.stringify(expected));
    }
}

/** 模拟组件的 saveCurrentSession */
function buildSave(messages, currentId, sessions, now) {
    const usable = messages.filter((m) => m.content.trim());
    if (!usable.length) return { saved: false, sessions, id: currentId };

    const snapshot = usable.map((m) => ({ role: m.role, content: m.content, reasoning: m.reasoning }));
    const existing = sessions.find((s) => s.id === currentId);
    if (existing && sameMessages(existing.messages, snapshot)) {
        return { saved: false, sessions, id: currentId };
    }

    const firstUser = snapshot.find((m) => m.role === "user");
    const session = {
        id: currentId || "s" + now,
        title: existing ? existing.title : sessionTitle(firstUser?.content || snapshot[0].content),
        messages: snapshot,
        updatedAt: now,
    };
    const next = upsertSession(sessions, session).slice(0, MAX_SESSIONS);
    return { saved: true, sessions: next, id: session.id };
}

console.log("完整流程：聊完存一次，重启后能读回来");
{
    const messages = [
        { role: "user", content: "把今天日记扩写成复盘", reasoning: "" },
        { role: "assistant", content: "## 今天发生了什么\n\n1. 开了季度会…", reasoning: "先梳理事实" },
    ];

    const first = buildSave(messages, "", [], 1000);
    check("第一次保存成功", first.saved, true);
    check("标题取用户第一句", first.sessions[0].title, "把今天日记扩写成复盘");
    check("两条消息都存了", first.sessions[0].messages.length, 2);
    check("思考过程也存了", first.sessions[0].messages[1].reasoning, "先梳理事实");

    // 模拟重启：从磁盘读回（走 normalize）
    const restored = normalizeSessions(JSON.parse(JSON.stringify(first.sessions)));
    check("重启后能读回", restored.length, 1);
    check("内容完整", restored[0].messages[1].content.includes("季度会"), true);
    check("标题还在", restored[0].title, "把今天日记扩写成复盘");
}

console.log("同一对话再存一次：更新而不是新增");
{
    let state = buildSave([{ role: "user", content: "问题一", reasoning: "" }], "", [], 1000);
    state = buildSave(
        [
            { role: "user", content: "问题一", reasoning: "" },
            { role: "assistant", content: "答案一", reasoning: "" },
        ],
        state.id,
        state.sessions,
        2000
    );
    check("还是只有一条会话", state.sessions.length, 1);
    check("消息变成两条", state.sessions[0].messages.length, 2);
    check("时间是新的", state.sessions[0].updatedAt, 2000);
}

console.log("内容没变就不重复存（避免历史列表乱跳）");
{
    const messages = [{ role: "user", content: "问", reasoning: "" }];
    const state = buildSave(messages, "", [], 1000);
    const again = buildSave(messages, state.id, state.sessions, 9999);
    check("第二次不保存", again.saved, false);
    check("时间戳没被改", again.sessions[0].updatedAt, 1000);
}

console.log("空对话不存");
{
    const r = buildSave([], "", [], 1000);
    check("什么都不存", r.saved, false);
    check("列表还是空的", r.sessions.length, 0);
}
{
    // 只有思考没有正文：不该存
    const r = buildSave([{ role: "assistant", content: "", reasoning: "想了半天断了" }], "", [], 1000);
    check("空壳助手不触发保存", r.saved, false);
}

console.log("新对话：存旧的，开新的");
{
    const state = buildSave([{ role: "user", content: "旧对话", reasoning: "" }], "", [], 1000);
    check("旧对话存下了", state.sessions.length, 1);

    // 开新对话：id 清空，消息清空
    const newId = "";
    const newMessages = [];
    const after = buildSave(newMessages, newId, state.sessions, 2000);
    check("新对话没内容不存", after.saved, false);
    check("旧对话还在", after.sessions.length, 1);
    check("旧标题没变", after.sessions[0].title, "旧对话");
}

console.log("删除会话");
{
    let state = buildSave([{ role: "user", content: "A", reasoning: "" }], "", [], 1000);
    const idA = state.id;
    state = buildSave([{ role: "user", content: "B", reasoning: "" }], "", state.sessions, 2000);

    check("现在有两条", state.sessions.length, 2);
    const left = removeSession(state.sessions, idA);
    check("删掉一条", left.length, 1);
    check("剩的是后存的那条", left[0].title, "B");
}

console.log("超过上限时挤掉最旧的");
{
    let sessions = [];
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
        const r = buildSave([{ role: "user", content: "对话" + i, reasoning: "" }], "", sessions, 1000 + i);
        sessions = r.sessions;
    }
    check("被裁到上限", sessions.length, MAX_SESSIONS);
    check("最新那条在最前", sessions[0].title, "对话" + (MAX_SESSIONS + 4));
    check("最早的被挤掉", sessions.some((s) => s.title === "对话0"), false);
}

console.log("坏存档不影响启动");
{
    const garbage = [null, "abc", { id: 123 }, { id: "x", messages: "不是数组" }, []];
    const clean = normalizeSessions(garbage);
    check("坏数据全被过滤", clean.length, 0);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
