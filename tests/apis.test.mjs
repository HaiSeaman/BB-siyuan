/**
 * 多 API / 多模型的数据层：清洗、合并、拉取、地址拼接。
 * 这些是切换功能的地基，错了会表现成「点模型没反应」或「拉到一堆乱七八糟的名字」。
 */
import {
    createApi,
    normalizeApis,
    pickActiveApi,
    findApi,
    modelsEndpoint,
    parseModelList,
    modelsHeaders,
    mergeModels,
    fetchModels,
    isChatModel,
    splitChatModels,
} from "../.test/apis.js";

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

console.log("新建一套 API：");
{
    const a = createApi();
    check("有 id", typeof a.id, "string");
    check("id 不为空", a.id.length > 0, true);
    check("默认协议 openai", a.protocol, "openai");
    check("模型清单是空数组", a.models, []);
    check("当前模型为空", a.model, "");
}
{
    const a = createApi({ protocol: "乱写", models: ["  m1  ", "m1", ""], model: "m2" });
    check("协议野值退回 openai", a.protocol, "openai");
    // " m1 " 和 "m1" 去空格后重复，只留一个；空字符串丢掉；model 里的 m2 补进来
    check("模型去空格去重，model 补进清单", a.models, ["m1", "m2"]);
}

console.log("清洗外部配置：");
check("不是数组给空", normalizeApis("x"), []);
check("null 给空", normalizeApis(null), []);
// 有 id = 用户真建过，哪怕还没填内容也要留着，否则重启后他会以为配置丢了
check("只有 id 的空壳要留着", normalizeApis([{ id: "a" }]).length, 1);
check("没有 id 的丢掉", normalizeApis([{ name: "没 id" }]).length, 0);
{
    const list = normalizeApis([
        { id: "a", name: "A", models: ["m"] },
        { id: "a", name: "重复" },
        { id: "b", name: "B", models: [] },
    ]);
    check("重复 id 只留第一个", list.map((x) => x.name), ["A", "B"]);
}

console.log("找当前 API：");
{
    const list = [
        createApi({ name: "A" }, "a"),
        createApi({ name: "B" }, "b"),
    ];
    check("按 id 找到", pickActiveApi(list, "b").name, "B");
    check("id 失效退回第一个", pickActiveApi(list, "不存在").name, "A");
    check("空列表返回 undefined", pickActiveApi([], "a"), undefined);
    check("findApi 正常", findApi(list, "a").name, "A");
}

console.log("模型列表地址：");
check("openai 拼 /models", modelsEndpoint("openai", "http://a/v1"), "http://a/v1/models");
check("openai 末尾多余斜杠去掉", modelsEndpoint("openai", "http://a/v1/"), "http://a/v1/models");
check(
    "openai 已填到 chat/completions 也能退回来",
    modelsEndpoint("openai", "http://a/v1/chat/completions"),
    "http://a/v1/models"
);
check("claude 拼 /v1/models", modelsEndpoint("anthropic", "https://api.anthropic.com"), "https://api.anthropic.com/v1/models");
check(
    "claude 已带 /v1 不重复",
    modelsEndpoint("anthropic", "https://api.anthropic.com/v1"),
    "https://api.anthropic.com/v1/models"
);
check(
    "claude 已填到 /messages 也能退回来",
    modelsEndpoint("anthropic", "https://api.anthropic.com/v1/messages"),
    "https://api.anthropic.com/v1/models"
);
check("gemini 拼 /v1beta/models", modelsEndpoint("gemini", "https://g"), "https://g/v1beta/models");
check(
    "gemini 已带 /v1beta 不重复",
    modelsEndpoint("gemini", "https://g/v1beta"),
    "https://g/v1beta/models"
);

console.log("解析模型清单：");
{
    const openai = parseModelList("openai", { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] });
    check("openai 取 data[].id", openai, ["gpt-4o", "gpt-4o-mini"]);

    const rawArray = parseModelList("openai", [{ id: "a" }, "b"]);
    check("直接返回数组也认", rawArray, ["a", "b"]);

    const anthropic = parseModelList("anthropic", { data: [{ id: "claude-x", display_name: "X" }] });
    check("claude 取 id 不是 display_name", anthropic, ["claude-x"]);

    const gemini = parseModelList("gemini", {
        models: [
            { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        ],
    });
    check("gemini 去掉 models/ 前缀", gemini, ["gemini-2.0-flash"]);
    check("gemini 只留能聊天的", gemini.length, 1);

    const gemini2 = parseModelList("gemini", { models: [{ name: "models/a" }] });
    check("gemini 没有方法字段时全留", gemini2, ["a"]);

    check("空对象给空", parseModelList("openai", {}), []);
    check("重复名字去重", parseModelList("openai", { data: [{ id: "x" }, { id: "x" }] }), ["x"]);
}

console.log("拉取请求头：");
{
    check("openai 用 Bearer", modelsHeaders("openai", "k").Authorization, "Bearer k");
    check("claude 用 x-api-key", modelsHeaders("anthropic", "k")["x-api-key"], "k");
    check("claude 带版本头", modelsHeaders("anthropic", "k")["anthropic-version"], "2023-06-01");
    check("gemini 用 x-goog-api-key", modelsHeaders("gemini", "k")["x-goog-api-key"], "k");
    check("没 key 时不加鉴权头", "Authorization" in modelsHeaders("openai", ""), false);
}

console.log("合并模型清单：");
check("保留原有顺序", mergeModels(["a", "b"], ["c", "a"]), ["a", "b", "c"]);
check("空的不加", mergeModels(["a"], ["", "a"]), ["a"]);

console.log("拉取：");
{
    const okFetcher = async (url, opts) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }),
    });
    const r1 = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "k" }, okFetcher);
    check("拿到模型", r1.models, ["m1", "m2"]);
    check("没有错误", r1.error, "");
    check("没有跳过任何模型", r1.skipped, 0);

    let seenUrl = "";
    let seenMethod = "";
    await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "k" }, async (url, opts) => {
        seenUrl = url;
        seenMethod = opts.method;
        return { ok: true, status: 200, text: async () => "{}" };
    });
    check("请求的是 /models", seenUrl, "http://a/v1/models");
    check("用的是 GET", seenMethod, "GET");

    const noBase = await fetchModels({ protocol: "openai", baseURL: "  ", apiKey: "" }, okFetcher);
    check("没地址直接报错", noBase.error, "先填接口地址");

    const httpErr = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "" }, async () => ({
        ok: false,
        status: 401,
        text: async () => "bad key",
    }));
    check("HTTP 错误带状态码", /401/.test(httpErr.error), true);
    check("HTTP 错误带响应体", /bad key/.test(httpErr.error), true);

    const notJson = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "" }, async () => ({
        ok: true,
        status: 200,
        text: async () => "<html>nope</html>",
    }));
    check("不是 JSON 说清楚", /不是 JSON/.test(notJson.error), true);

    const empty = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "" }, async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
    }));
    check("空清单提示手动填", /手动填/.test(empty.error), true);

    const boom = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "" }, async () => {
        throw new Error("连不上");
    });
    check("网络异常被兜住", boom.error, "连不上");
}

console.log("能不能聊天：");
{
    check("普通模型能", isChatModel("glm-5.3"), true);
    check("带供应商前缀的能", isChatModel("zhipu/glm-5.3"), true);
    check("embedding 不能", isChatModel("text-embedding-3-small"), false);
    check("bge 不能", isChatModel("BAAI/bge-m3"), false);
    check("whisper 不能", isChatModel("whisper-1"), false);
    check("tts 不能", isChatModel("tts-1"), false);
    check("rerank 不能", isChatModel("gte-rerank"), false);
    check("moderation 不能", isChatModel("text-moderation-latest"), false);
    check("dall-e 不能", isChatModel("dall-e-3"), false);
    check("gpt-image 不能", isChatModel("gpt-image-1"), false);
    check("sd 画图不能", isChatModel("stable-diffusion-xl"), false);
    check("flux 画图不能", isChatModel("black-forest-labs/flux-schnell"), false);
    check("空名字不算", isChatModel(""), false);
    // 窄名单：别把带这些字样的正经对话模型误杀
    check("窄名单：'embed' 出现在名字里就算非聊天", isChatModel("qwen-embedding-chat"), false);
    check("普通 llama 不误杀", isChatModel("llama-3-70b"), true);

    const s = splitChatModels(["glm-5.3", "text-embedding-3-small", "", "kimi-k3"]);
    check("拆出能聊的", s.chat, ["glm-5.3", "kimi-k3"]);
    check("跳过的数量对", s.skipped, 2);
}

console.log("拉取时滤掉不能聊天的：");
{
    const mixed = async () => ({
        ok: true,
        status: 200,
        text: async () =>
            JSON.stringify({
                data: [
                    { id: "text-embedding-3-small" },
                    { id: "glm-5.3" },
                    { id: "whisper-1" },
                    { id: "kimi-k3" },
                ],
            }),
    });
    const r = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "k" }, mixed);
    check("只留能聊的", r.models, ["glm-5.3", "kimi-k3"]);
    check("报告跳过了几个", r.skipped, 2);
    check("不算失败", r.error, "");

    // 全被滤掉时宁可全放出来，也不给空清单让人以为接口坏了
    const allBad = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: "whisper-1" }] }),
    });
    const r2 = await fetchModels({ protocol: "openai", baseURL: "http://a/v1", apiKey: "k" }, allBad);
    check("全滤掉时兜底全放出", r2.models, ["whisper-1"]);
    check("兜底时不算跳过", r2.skipped, 0);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
