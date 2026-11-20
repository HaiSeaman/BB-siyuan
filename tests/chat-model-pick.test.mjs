/**
 * 「优化」该用哪个模型 —— 这是主人最容易被绕晕的地方。
 *
 * 现象：顶栏切到了 gpt-image-1（画图），点「优化」必须照样能工作。
 * 如果代码直接拿 activeApi 去请求，画图模型不会写字，必然失败，
 * 而用户完全不知道为什么。
 */
import { initSettings, snapshot, chatApiFor, packModelRef, unpackModelRef } from "../.test/settings.js";
import { isChatModel, isImageModel, modelKindLabel, fetchModels, splitChatModels } from "../.test/apis.js";

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

console.log("模型名分类：");
{
    check("gpt-image-1 是画图", isImageModel("gpt-image-1"), true);
    check("gpt-image-1 不是聊天", isChatModel("gpt-image-1"), false);
    check("dall-e-3 是画图", isImageModel("dall-e-3"), true);
    check("flux 是画图", isImageModel("black-forest-labs/flux-schnell"), true);
    check("sd 是画图", isImageModel("stable-diffusion-xl"), true);
    check("sd3 是画图", isImageModel("sd3-medium"), true);
    check("imagen 是画图", isImageModel("imagen-3"), true);
    check("seedream 是画图", isImageModel("doubao-seedream-3"), true);
    check("wanx 是画图", isImageModel("wanx-v1"), true);
    check("cogview 是画图", isImageModel("cogview-3"), true);
    check("midjourney 是画图", isImageModel("midjourney-v6"), true);

    check("glm 是聊天", isImageModel("glm-5.3"), false);
    check("glm 能聊天", isChatModel("glm-5.3"), true);
    check("gpt-4o 是聊天", isChatModel("gpt-4o"), true);
    check("gpt-4o 不是画图", isImageModel("gpt-4o"), false);
    check("空名字都不是", [isChatModel(""), isImageModel("")], [false, false]);

    // 别误杀：带 vision / chat 的多模态模型要算聊天
    check("带 vision 的不算画图", isImageModel("gpt-4-vision"), false);
    check("带 vision 的能聊天", isChatModel("gpt-4-vision"), true);
    check("带 vl 的不算画图", isImageModel("qwen-vl-max"), false);
    check("带 chat 的不算画图", isImageModel("flux-chat"), false);

    check("标签：画图", modelKindLabel("gpt-image-1"), "画图");
    check("标签：不能聊天", modelKindLabel("text-embedding-3-small"), "不能聊天");
    check("标签：聊天模型没有标签", modelKindLabel("glm-5.3"), "");
}

console.log("拉取时画图模型要留下来：");
{
    const mixed = async () => ({
        ok: true,
        status: 200,
        text: async () =>
            JSON.stringify({
                data: [
                    { id: "glm-5.3" },
                    { id: "gpt-image-1" },
                    { id: "text-embedding-3-small" },
                    { id: "dall-e-3" },
                ],
            }),
    });
    const r = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "k" }, mixed);
    check("聊天模型拉出来", r.models, ["glm-5.3"]);
    check("画图模型单独列出", r.imageModels, ["gpt-image-1", "dall-e-3"]);
    check("只跳过了嵌入模型", r.skipped, 1);
    check("整体成功", r.error, "");

    const both = splitChatModels(["glm-5.3", "gpt-image-1", "whisper-1"]);
    check("拆分：聊天", both.chat, ["glm-5.3"]);
    check("拆分：画图", both.image, ["gpt-image-1"]);
    check("拆分：跳过", both.skipped, 1);

    // 只有画图模型时也不能当失败
    const onlyImg = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "k" }, async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: "gpt-image-1" }] }),
    }));
    check("只有画图模型时不算错", onlyImg.error, "");
    check("画图模型能拿到", onlyImg.imageModels, ["gpt-image-1"]);
    check("聊天清单是空的", onlyImg.models, []);
}

console.log("lastChatModel 的存储格式：");
{
    check("拼得出来", packModelRef("a1", "glm-5.3"), "a1::glm-5.3");
    check("拆得回来", unpackModelRef("a1::glm-5.3"), { apiId: "a1", model: "glm-5.3" });
    check("模型名里带冒号也能拆", unpackModelRef("a1::org/model:v2"), { apiId: "a1", model: "org/model:v2" });
    check("空串拆不出来", unpackModelRef(""), null);
    check("没有分隔符拆不出来", unpackModelRef("abc"), null);
    check("没 id 拆不出来", unpackModelRef("::m"), null);
    check("没模型拆不出来", unpackModelRef("a::"), null);
    check("空输入拼出空", packModelRef("", "m"), "");
    check("空模型拼出空", packModelRef("a", ""), "");
}

console.log("优化该用哪个模型（核心）：");
{
    // 场景一：两套 API，A 有聊天+画图，当前停在画图模型上
    initSettings({
        apis: [
            {
                id: "a",
                name: "中转站A",
                baseURL: "http://a/v1",
                apiKey: "ka",
                models: ["glm-5.3", "gpt-image-1"],
                model: "gpt-image-1", // 当前是画图
            },
        ],
        activeApiId: "a",
        lastChatModel: packModelRef("a", "glm-5.3"),
    });
    {
        const got = chatApiFor(snapshot(), isChatModel);
        check("记住了上次的聊天模型", got?.model, "glm-5.3");
        check("用的是那套 API", got?.api.id, "a");
        check("不会拿画图模型去优化", got?.model !== "gpt-image-1", true);
    }

    // 场景二：没记过，当前是画图 → 退到第一个能聊天的
    initSettings({
        apis: [
            {
                id: "a",
                name: "A",
                baseURL: "http://a/v1",
                apiKey: "",
                models: ["gpt-image-1", "glm-5.3"],
                model: "gpt-image-1",
            },
        ],
        activeApiId: "a",
        lastChatModel: "",
    });
    {
        const got = chatApiFor(snapshot(), isChatModel);
        check("退回第一个能聊天的", got?.model, "glm-5.3");
    }

    // 场景三：记住的那个模型被删掉了 → 不能报错，要退回可用的
    initSettings({
        apis: [
            {
                id: "a",
                name: "A",
                baseURL: "http://a/v1",
                apiKey: "",
                models: ["glm-5.3"],
                model: "glm-5.3",
            },
        ],
        activeApiId: "a",
        lastChatModel: packModelRef("a", "已经被删掉的模型"),
    });
    {
        const got = chatApiFor(snapshot(), isChatModel);
        check("记住的没了就退回现有的", got?.model, "glm-5.3");
    }

    // 场景四：记住的是另一套 API 的模型
    initSettings({
        apis: [
            { id: "a", name: "A", baseURL: "http://a/v1", apiKey: "", models: ["glm-5.3"], model: "glm-5.3" },
            { id: "b", name: "B", baseURL: "http://b/v1", apiKey: "", models: ["kimi-k3"], model: "kimi-k3" },
        ],
        activeApiId: "a",
        lastChatModel: packModelRef("b", "kimi-k3"),
    });
    {
        const got = chatApiFor(snapshot(), isChatModel);
        check("优先用记住的那套 API", got?.api.id, "b");
        check("模型也是那套的", got?.model, "kimi-k3");
    }

    // 场景五：一个聊天模型都没有 → 返回 null，让界面说人话
    initSettings({
        apis: [
            {
                id: "a",
                name: "A",
                baseURL: "http://a/v1",
                apiKey: "",
                models: ["gpt-image-1", "text-embedding-3-small"],
                model: "gpt-image-1",
            },
        ],
        activeApiId: "a",
        lastChatModel: "",
    });
    {
        check("没有聊天模型就返回 null", chatApiFor(snapshot(), isChatModel), null);
    }

    // 场景六：当前就是聊天模型，直接用
    initSettings({
        apis: [{ id: "a", name: "A", baseURL: "http://a/v1", apiKey: "", models: ["glm-5.3"], model: "glm-5.3" }],
        activeApiId: "a",
        lastChatModel: "",
    });
    {
        const got = chatApiFor(snapshot(), isChatModel);
        check("当前就是聊天模型时直接用", got?.model, "glm-5.3");
    }
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
