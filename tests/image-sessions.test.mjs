/**
 * 带图片的会话存档。
 *
 * 核心红线：图片数据绝不能进 sessions.json。
 * 一旦进去，4K 图的 base64 有十几兆，存档会越来越慢，最后打不开。
 */
import {
    normalizeSessions,
    upsertSession,
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

console.log("图片消息能存下来：");
{
    const raw = [
        {
            id: "s1",
            title: "画猫",
            updatedAt: 10,
            messages: [
                { role: "user", content: "一只猫", reasoning: "" },
                {
                    role: "assistant",
                    content: "",
                    reasoning: "",
                    images: [{ path: "images/a.png", size: "2048 × 1152", prompt: "一只猫" }],
                },
            ],
        },
    ];
    const list = normalizeSessions(raw);
    check("会话留下来了", list.length, 1);
    check("两条消息都在（带图那条不能因为没文字被丢）", list[0].messages.length, 2);
    check("图片路径存对了", list[0].messages[1].images[0].path, "images/a.png");
    check("尺寸存下来了", list[0].messages[1].images[0].size, "2048 × 1152");
    check("提示词存下来了", list[0].messages[1].images[0].prompt, "一只猫");
}

console.log("图片数据绝对不能进存档：");
{
    // 就算脏数据里塞了 base64/bytes，也要被扔掉
    const dirty = [
        {
            id: "s1",
            updatedAt: 1,
            messages: [
                { role: "user", content: "画", reasoning: "" },
                {
                    role: "assistant",
                    content: "",
                    reasoning: "",
                    images: [
                        {
                            path: "images/a.png",
                            dataUrl: "data:image/png;base64," + "A".repeat(500),
                            b64: "A".repeat(500),
                            bytes: [1, 2, 3],
                            size: "1024 × 1024",
                            prompt: "猫",
                        },
                    ],
                },
            ],
        },
    ];
    const list = normalizeSessions(dirty);
    const img = list[0].messages[1].images[0];
    check("只留 path", Object.keys(img).sort().join(","), "path,prompt,size");
    check("dataUrl 被丢掉", "dataUrl" in img, false);
    check("b64 被丢掉", "b64" in img, false);
    check("bytes 被丢掉", "bytes" in img, false);
}

console.log("只有网址的图也要留：");
{
    const list = normalizeSessions([
        {
            id: "s1",
            updatedAt: 1,
            messages: [
                { role: "user", content: "x", reasoning: "" },
                {
                    role: "assistant",
                    content: "",
                    reasoning: "",
                    images: [{ url: "https://x/1.png", size: "1024 × 1024", prompt: "猫" }],
                },
            ],
        },
    ]);
    check("网址存下来了", list[0].messages[1].images[0].url, "https://x/1.png");
    check("没有 path 时不硬造", list[0].messages[1].images[0].path, "");
}

console.log("图和网址都没有的，丢掉：");
{
    const list = normalizeSessions([
        {
            id: "s1",
            updatedAt: 1,
            messages: [
                { role: "user", content: "x", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ size: "1024", prompt: "猫" }] },
            ],
        },
    ]);
    // 第二条既没文字也没图，这条该被丢掉；但用户那句还在，整个会话不该消失
    check("会话还在（用户那句是有效内容）", list.length, 1);
    check("空壳图片消息被丢", list[0].messages.length, 1);
    check("剩下的就是用户那句", list[0].messages[0].role, "user");
}

console.log("张数上限：");
{
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `images/${i}.png`, size: "s", prompt: "p" }));
    const list = normalizeSessions([
        {
            id: "s1",
            updatedAt: 1,
            messages: [
                { role: "user", content: "x", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: many },
            ],
        },
    ]);
    check("一条消息最多留 8 张", list[0].messages[1].images.length, 8);
}

console.log("参考图文件名也存：");
{
    const list = normalizeSessions([
        {
            id: "s1",
            updatedAt: 1,
            messages: [
                { role: "user", content: "改成油画", reasoning: "", refName: "photo.jpg" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/a.png", size: "1", prompt: "p" }] },
            ],
        },
    ]);
    check("参考图名字留着", list[0].messages[0].refName, "photo.jpg");
}

console.log("内容比较要能看出图片变化：");
{
    const a = [{ role: "assistant", content: "", reasoning: "", images: [{ path: "images/a.png", size: "1", prompt: "p" }] }];
    const b = [{ role: "assistant", content: "", reasoning: "", images: [{ path: "images/b.png", size: "1", prompt: "p" }] }];
    const c = [{ role: "assistant", content: "", reasoning: "", images: [{ path: "images/a.png", size: "2", prompt: "p" }] }];
    const d = [{ role: "assistant", content: "", reasoning: "", images: [] }];
    check("路径变了算不同", sameMessages(a, b), false);
    check("尺寸变了算不同", sameMessages(a, c), false);
    check("有图 vs 没图算不同", sameMessages(a, d), false);
    check("完全一样算相同", sameMessages(a, JSON.parse(JSON.stringify(a))), true);
    check("参考图名变了算不同", sameMessages(
        [{ role: "user", content: "x", reasoning: "", refName: "a.png" }],
        [{ role: "user", content: "x", reasoning: "", refName: "b.png" }]
    ), false);
}

console.log("旧的纯文字存档不受影响：");
{
    const list = normalizeSessions([
        {
            id: "old",
            title: "老对话",
            updatedAt: 5,
            messages: [
                { role: "user", content: "你好" },
                { role: "assistant", content: "你也好", reasoning: "想了下" },
            ],
        },
    ]);
    check("老数据照常读出来", list[0].messages.length, 2);
    check("没有 images 字段", "images" in list[0].messages[1], false);
    check("思考内容还在", list[0].messages[1].reasoning, "想了下");
}

console.log("会话数量上限仍然有效：");
{
    const many = [];
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
        many.push({
            id: "s" + i,
            updatedAt: i,
            messages: [
                { role: "user", content: "x", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/" + i + ".png", size: "1", prompt: "p" }] },
            ],
        });
    }
    const list = normalizeSessions(many);
    check("被裁到上限", list.length, MAX_SESSIONS);
    check("留下最新的", list[0].id, "s" + (MAX_SESSIONS + 4));
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
