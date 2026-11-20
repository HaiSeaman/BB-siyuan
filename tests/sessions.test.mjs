/**
 * 会话存档：关掉面板再打开，之前的对话还在。
 *
 * 边界：
 *   - 存档不能无限长（否则越用越卡）
 *   - 坏数据不能让面板打不开
 *   - 生成中的空壳消息不该被存下来
 */
import {
    normalizeSessions,
    createSession,
    upsertSession,
    removeSession,
    trimSessions,
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

console.log("清洗外部数据：");
check("null 得到空列表", normalizeSessions(null), []);
check("字符串得到空列表", normalizeSessions("abc"), []);
{
    const raw = [
        { id: "a", title: "第一", messages: [{ role: "user", content: "hi" }], updatedAt: 100 },
        { title: "没有 id" },
        null,
        { id: "b", messages: "不是数组" },
    ];
    const clean = normalizeSessions(raw);
    check("脏数据被过滤", clean.length, 1);
    check("保留合法那条", clean[0].id, "a");
}
{
    // 空壳助手消息要丢掉（生成中断留下的）
    const clean = normalizeSessions([
        {
            id: "a",
            title: "t",
            updatedAt: 1,
            messages: [
                { role: "user", content: "问题" },
                { role: "assistant", content: "", reasoning: "" },
            ],
        },
    ]);
    check("空的助手消息被丢掉", clean[0].messages.length, 1);
    check("只剩用户那条", clean[0].messages[0].role, "user");
}
{
    // 有思考但没正文的助手消息，也不该算数
    const clean = normalizeSessions([
        {
            id: "a",
            title: "t",
            updatedAt: 1,
            messages: [
                { role: "user", content: "问题" },
                { role: "assistant", content: "", reasoning: "想了一半断了" },
            ],
        },
    ]);
    check("只有思考没正文的也算空壳", clean[0].messages.length, 1);
}
{
    // 消息全空的会话整个丢掉
    const clean = normalizeSessions([{ id: "a", title: "t", updatedAt: 1, messages: [] }]);
    check("空会话被丢掉", clean.length, 0);
}

console.log("新建会话：");
{
    const s = createSession("我的对话", () => "fixed", () => 1000);
    check("有 id", s.id, "fixed");
    check("有标题", s.title, "我的对话");
    check("消息为空", s.messages, []);
    check("有时间戳", s.updatedAt, 1000);
}

console.log("会话标题：");
check("短消息直接用", sessionTitle("今天开了会"), "今天开了会");
{
    const long = "很长".repeat(50);
  const t = sessionTitle(long);
    check("长消息被截断", t.length <= 30, true);
    check("截断有省略号", t.endsWith("…"), true);
}
check("换行被压平", sessionTitle("第一行\n第二行"), "第一行 第二行");
check("空消息给默认名", sessionTitle(""), "新对话");
check("纯空格给默认名", sessionTitle("   "), "新对话");

console.log("保存与更新：");
{
    const s1 = createSession("A", () => "a", () => 100);
    const s2 = createSession("B", () => "b", () => 200);

    let list = upsertSession([], s1);
    check("新增一条", list.length, 1);

    list = upsertSession(list, s2);
    check("再加一条", list.length, 2);
    check("最新的排最前", list[0].id, "b");

    const s1b = { ...s1, messages: [{ role: "user", content: "x" }], updatedAt: 300 };
    list = upsertSession(list, s1b);
    check("更新不会变成两条", list.length, 2);
    check("更新后跑到最前", list[0].id, "a");
    check("内容真的更新了", list[0].messages.length, 1);
}

console.log("删除：");
{
    const list = [
        { ...createSession("A", () => "a", () => 1), messages: [{ role: "user", content: "x" }] },
        { ...createSession("B", () => "b", () => 2), messages: [{ role: "user", content: "y" }] },
    ];
    const next = removeSession(list, "a");
    check("删掉一条", next.length, 1);
    check("剩下 b", next[0].id, "b");
}

console.log("数量上限：");
{
    // 按旧 → 新构造，然后走 normalize：它先排序再裁剪，应该留下最新的
    const many = [];
    for (let i = 0; i < MAX_SESSIONS + 10; i++) {
        many.push({ ...createSession("s" + i, () => "s" + i, () => i), messages: [{ role: "user", content: "x" }] });
    }
    const normalized = normalizeSessions(many);
    check("被裁到上限", normalized.length, MAX_SESSIONS);
    check("留下的是最新的那条", normalized[0].id, "s" + (MAX_SESSIONS + 9));
    check("最旧的被挤掉了", normalized.some((s) => s.id === "s0"), false);
}
{
    // trimSessions 假定输入已倒序，直接裁前 N 个
    const desc = [
        { ...createSession("新", () => "new", () => 300), messages: [{ role: "user", content: "x" }] },
        { ...createSession("旧", () => "old", () => 100), messages: [{ role: "user", content: "y" }] },
    ];
    const trimmed = trimSessions(desc);
    check("已倒序时保留前面的", trimmed[0].id, "new");
}

console.log("排序：");
{
  const list = [
    { ...createSession("旧", () => "old", () => 100), messages: [{ role: "user", content: "x" }] },
    { ...createSession("新", () => "new", () => 300), messages: [{ role: "user", content: "y" }] },
  ];
  const clean = normalizeSessions(list);
  check("按时间倒序", clean[0].id, "new");
}

console.log("判断内容是否变化（避免无意义重存）：");
check("完全一样", sameMessages([{ role: "user", content: "a", reasoning: "" }], [{ role: "user", content: "a", reasoning: "" }]), true);
check("内容变了", sameMessages([{ role: "user", content: "a", reasoning: "" }], [{ role: "user", content: "b", reasoning: "" }]), false);
check("条数变了", sameMessages([{ role: "user", content: "a", reasoning: "" }], []), false);
check("角色变了", sameMessages([{ role: "user", content: "a", reasoning: "" }], [{ role: "assistant", content: "a", reasoning: "" }]), false);
check("思考变了", sameMessages([{ role: "assistant", content: "a", reasoning: "x" }], [{ role: "assistant", content: "a", reasoning: "y" }]), false);
check("都空算一样", sameMessages([], []), true);

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
