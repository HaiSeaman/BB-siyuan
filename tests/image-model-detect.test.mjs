/**
 * 这轮修复的回归测试：三个真实故障各来一条。
 *
 *  1. gemini-3.1-flash-image 认不出是画图模型 → 4 个按钮一个都不显示、点「生图」说没模型
 *  2. 图片底下只有复制、没有保存
 *  3. 手动标记的名单要能在所有分类处生效
 */
import { isChatModel, isImageModel, isImageModelOf, isChatModelOf, modelKindLabelOf, splitChatModels } from "../.test/apis.js";
import { initSettings, snapshot, chatApiFor, packModelRef } from "../.test/settings.js";

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

console.log("真实场景：主人那台服务商的模型名");
{
    // 这是主人在设置里真实填的名字，以前认不出来
    check("gemini-3.1-flash-image 是画图模型", isImageModel("gemini-3.1-flash-image"), true);
    check("它不算聊天模型", isChatModel("gemini-3.1-flash-image"), false);
    check("下拉标签是「画图」", modelKindLabelOf("gemini-3.1-flash-image", []), "画图");

    check("带 image 的都认", isImageModel("qwen-image"), true);
    check("带 image 的都认（大写）", isImageModel("GEMINI-3.1-FLASH-IMAGE"), true);
    check("gpt-image-1 仍然认", isImageModel("gpt-image-1"), true);
    check("dall-e-3 仍然认", isImageModel("dall-e-3"), true);
    check("flux 仍然认", isImageModel("black-forest-labs/flux-schnell"), true);
}

console.log("别把看图的模型误判成画图：");
{
    check("gpt-4o（能看图也能聊天）不算画图", isImageModel("gpt-4o"), false);
    check("gpt-4-vision 不算画图", isImageModel("gpt-4-vision"), false);
    check("qwen-vl-max 不算画图", isImageModel("qwen-vl-max"), false);
    check("Gemini 纯聊天模型不算画图", isImageModel("gemini-3.8-flash"), false);
    check("带 chat 的不算画图", isImageModel("flux-chat"), false);
    check("Gemini 聊天模型能聊天", isChatModel("gemini-3.8-flash"), true);
}

console.log("主人那台服务商的整个清单：");
{
    const list = [
        "claude-opus-4-6",
        "claude-opus-4-6-thinking",
        "claude-sonnet-4-6",
        "gemini-3.1-flash-image",
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash",
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-low",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-tiered",
        "gpt-oss-120b",
        "gpt-oss-120b-medium",
    ];
    const s = splitChatModels(list);
    check("画图模型只挑出 gemini-3.1-flash-image", s.image, ["gemini-3.1-flash-image"]);
    check("聊天模型有 11 个", s.chat.length, 11);
    check("没有被当成垃圾丢掉的", s.skipped, 0);
}

console.log("手动标记兜底（名字认不出来时）：");
{
    const weird = "my-unofficial-drawer-v2";
    check("没标记时不认为是画图", isImageModel(weird), false);
    check("标记后就认了", isImageModelOf(weird, [weird]), true);
    check("标记后不算聊天", isChatModelOf(weird, [weird]), false);
    check("标记后标签是画图", modelKindLabelOf(weird, [weird]), "画图");
    check("标记名单为空不影响正常判断", isImageModelOf("gemini-3.1-flash-image", []), true);
    check("标记名单是脏值也不崩", isImageModelOf("gemini-3.1-flash-image", null), true);
}

console.log("优化不能用画图模型（含手动标记的）：");
{
    initSettings({
        apis: [
            {
                id: "a",
                name: "A",
                baseURL: "http://a/v1",
                apiKey: "",
                models: ["gemini-3.8-flash", "gemini-3.1-flash-image", "my-drawer"],
                model: "my-drawer",
            },
        ],
        activeApiId: "a",
        lastChatModel: "",
        imageModels: ["my-drawer"],
    });
    const got = chatApiFor(snapshot(), isChatModel, snapshot().imageModels);
    check("挑到的是真聊天模型", got?.model, "gemini-3.8-flash");
    check("绝不拿画图模型去优化", got?.model !== "gemini-3.1-flash-image" && got?.model !== "my-drawer", true);
}

console.log("老配置升级：新字段要自动补上：");
{
    initSettings({ apis: [{ id: "a", name: "A", baseURL: "", apiKey: "", models: [], model: "" }], activeApiId: "a" });
    check("没有 imageModels 时给空数组", snapshot().imageModels, []);
    check("生图大小默认 2K", snapshot().imageSize, "2K");
    check("生图比例默认 16:9", snapshot().imageRatio, "16:9");

    initSettings({
        apis: [{ id: "a", name: "A", baseURL: "", apiKey: "", models: [], model: "" }],
        activeApiId: "a",
        imageModels: ["  x  ", "", 123, null, "y"],
    });
    check("脏值被洗干净", snapshot().imageModels, ["x", "y"]);
}

console.log("上次聊天模型的记录仍然有效：");
{
    initSettings({
        apis: [
            { id: "a", name: "A", baseURL: "http://a/v1", apiKey: "", models: ["gemini-3.8-flash"], model: "gemini-3.8-flash" },
        ],
        activeApiId: "a",
        lastChatModel: packModelRef("a", "gemini-3.8-flash"),
    });
    const got = chatApiFor(snapshot(), isChatModel, []);
    check("记住的聊天模型能用", got?.model, "gemini-3.8-flash");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
