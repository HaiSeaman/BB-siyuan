/**
 * 生图的数据层：尺寸换算、接口地址、请求体、multipart、返回解析、文件名。
 *
 * 这一层错一步，用户看到的就是"点了生成没反应"或者"4K 出来是 1024"，
 * 而且从界面上完全看不出是哪一步错了，所以必须逐条卡死。
 */
import {
    RATIOS,
    SIZES,
    LONG_EDGE,
    computeSize,
    officialSizes,
    planSize,
    imageEndpoint,
    imageHeaders,
    imageBody,
    buildMultipart,
    editParts,
    parseImageResponse,
    imageErrorOf,
    toDataUrl,
    checkReference,
    imageFileName,
    stampOf,
    dataUrlToBytes,
    MAX_REF_BYTES,
} from "../.test/image.js";
import { mimeOfName } from "../.test/image-store.js";

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

console.log("界面上给的比例和大小档位：");
check("10 种比例", RATIOS.length, 10);
check("比例都在", RATIOS, ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "5:4", "4:5", "21:9"]);
check("四档大小", SIZES, ["1K", "2K", "4K", "4K+"]);
// 按屏幕分辨率的叫法：1K=1920(1080p)、2K=2560(1440p)、4K=3840(2160p)
check("1K 长边 1920", LONG_EDGE["1K"], 1920);
check("2K 长边 2560", LONG_EDGE["2K"], 2560);
check("4K 长边 3840", LONG_EDGE["4K"], 3840);
check("4K+ 长边 4096", LONG_EDGE["4K+"], 4096);

console.log("尺寸换算（长边像素，8 的倍数）：");
{
    const a = computeSize("1K", "1:1");
    check("1K + 1:1 = 1920×1920", [a.width, a.height], [1920, 1920]);

    const b = computeSize("1K", "16:9");
    check("1K + 16:9 = 正好 1920×1080（铺满 1080p）", [b.width, b.height], [1920, 1080]);
    check("算出来的短边是 8 的倍数", b.height % 8, 0);

    const c = computeSize("2K", "16:9");
    check("2K + 16:9 = 2560×1440", [c.width, c.height], [2560, 1440]);

    const d = computeSize("4K", "1:1");
    check("4K + 1:1 = 3840×3840", [d.width, d.height], [3840, 3840]);

    const e = computeSize("2K", "9:16");
    check("竖图：9:16 时高才是长边（1440×2560）", [e.width, e.height], [1440, 2560]);

    const f = computeSize("1K", "4:3");
    check("1K + 4:3 = 1920×1440", [f.width, f.height], [1920, 1440]);

    const g = computeSize("1K", "21:9");
    check("1K + 21:9 宽是 1920", g.width, 1920);
    check("21:9 高度是 8 的倍数", g.height % 8, 0);
    check("21:9 高度约 824", Math.abs(g.height - 824) <= 8, true);

    check("api 字段是 主机能吃的写法", c.api, "2560x1440");
    check("label 给人看带空格", c.label, "2560 × 1440");

    // 野值不能崩
    const bad = computeSize("2K", "乱写");
    check("比例乱写退回 1:1", [bad.width, bad.height], [2560, 2560]);
    const badLevel = computeSize("8K", "1:1");
    check("大小档位乱写退回 2K", badLevel.width, 2560);
}

console.log("官方尺寸表（有的模型只认固定几档）：");
{
    check("gpt-image-1 只有三种", officialSizes("gpt-image-1").length, 3);
    check(
        "gpt-image-1 的三种尺寸",
        officialSizes("gpt-image-1").map((s) => s.w + "x" + s.h),
        ["1024x1024", "1536x1024", "1024x1536"]
    );
    check("dall-e-3 三种", officialSizes("dall-e-3").length, 3);
    check("flux 没有限制", officialSizes("flux-schnell"), null);
    check("普通名字没有限制", officialSizes("sd-xl"), null);
    check("空名字没有限制", officialSizes(""), null);
    check("大小写不敏感", officialSizes("GPT-Image-1").length, 3);

    // 2K + 16:9 想要 2048×1152，gpt-image-1 里最接近横向的是 1536×1024
    const p = planSize("2K", "16:9", "gpt-image-1");
    check("被换成官方尺寸", p.api, "1536x1024");
    check("标了「被改过」", p.adjusted, true);
    check("给了说明", /已从/.test(p.note), true);
    check("说明里写了原尺寸", /2560×1440/.test(p.note), true);
    check("说明里写了新尺寸", /1536×1024/.test(p.note), true);

    // 1K + 1:1 正好等于 1024x1024，不该被标成"改过"
    // 1K+1:1 想要 1920×1920，gpt-image-1 给不了，所以要报警
    const notExact = planSize("1K", "1:1", "gpt-image-1");
    check("1K+1:1 在官方模型上会被换", notExact.adjusted, true);
    check("换成 1024×1024", notExact.api, "1024x1024");
    // 真正对得上的是"本来就等于官方尺寸"的请求
    const exact = planSize("1K", "1:1", "flux-schnell");
    check("无限制模型不报警", exact.adjusted, false);
    check("无限制模型没有说明", exact.note, "");
    check("无限制模型按 1K 出 1920×1920", exact.api, "1920x1920");

    // 竖图要选竖向那个，不能选横向
    const tall = planSize("2K", "9:16", "gpt-image-1");
    check("竖图选竖向官方尺寸", tall.api, "1024x1536");

    // 没有官方限制的模型，原样发出
    const free = planSize("4K", "16:9", "flux-schnell");
    check("无限制模型按 4K 出 3840×2160", free.api, "3840x2160");
    check("无限制模型不报警", free.adjusted, false);

    // 第三方带后缀的名字不能被官方表锁死（真实踩过：gpt-image-2.6-sunburst）
    const thirdParty = planSize("2K", "16:9", "gpt-image-2.6-sunburst");
    check("第三方 gpt-image-2.6-sunburst 不被限制", thirdParty.api, "2560x1440");
    check("第三方不报警", thirdParty.adjusted, false);
}

console.log("生图接口地址：");
check("填到 /v1", imageEndpoint("http://a/v1", "generations"), "http://a/v1/images/generations");
check("末尾斜杠", imageEndpoint("http://a/v1/", "generations"), "http://a/v1/images/generations");
check("图生图走 edits", imageEndpoint("http://a/v1", "edits"), "http://a/v1/images/edits");
check(
    "已经填到 generations 不重复拼",
    imageEndpoint("http://a/v1/images/generations", "generations"),
    "http://a/v1/images/generations"
);
check(
    "已经填到 edits 不重复拼",
    imageEndpoint("http://a/v1/images/edits", "edits"),
    "http://a/v1/images/edits"
);
check(
    "填到 chat/completions 也能退回来",
    imageEndpoint("http://a/v1/chat/completions", "generations"),
    "http://a/v1/images/generations"
);
check("裸域名补 /v1", imageEndpoint("http://a", "generations"), "http://a/v1/images/generations");
check(
    "带路径的中转站也能接",
    imageEndpoint("http://a/openai/deploy/v1", "generations"),
    "http://a/openai/deploy/v1/images/generations"
);

console.log("请求头 / 请求体：");
{
    const h = imageHeaders("k1");
    check("Bearer 鉴权", h.Authorization, "Bearer k1");
    check("JSON 类型", h["Content-Type"], "application/json");
    check("没 key 时不加鉴权", "Authorization" in imageHeaders(""), false);

    const body = imageBody({
        protocol: "openai",
        baseURL: "http://a/v1",
        apiKey: "k",
        model: "gpt-image-1",
        prompt: "一只猫",
        size: "1024x1024",
    });
    check("带模型", body.model, "gpt-image-1");
    check("带提示词", body.prompt, "一只猫");
    check("默认出 1 张", body.n, 1);
    check("带尺寸", body.size, "1024x1024");
    check("要 base64 而不是网址", body.response_format, "b64_json");

    const n3 = imageBody({
        protocol: "openai",
        baseURL: "",
        apiKey: "",
        model: "m",
        prompt: "p",
        size: "1024x1024",
        n: 3,
    });
    check("能指定张数", n3.n, 3);
}

console.log("multipart（图生图必须用它）：");
{
    const img = { data: new Uint8Array([1, 2, 3, 4]), mime: "image/png", name: "a.png" };
    const { body, contentType } = buildMultipart(
        [
            { name: "model", value: "gpt-image-1" },
            { name: "prompt", value: "一只猫" },
            { name: "image", file: img },
        ],
        "BOUNDARY123"
    );

    check("content-type 带 boundary", contentType, "multipart/form-data; boundary=BOUNDARY123");

    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    check("开头是 boundary", text.startsWith("--BOUNDARY123\r\n"), true);
    check("结尾是收尾 boundary", text.endsWith("--BOUNDARY123--\r\n"), true);
    check("含 model 字段", /name="model"\r\n\r\ngpt-image-1/.test(text), true);
    check("含 prompt 字段", /name="prompt"\r\n\r\n一只猫/.test(text), true);
    check("含文件名字段", /name="image"; filename="a.png"/.test(text), true);
    check("含文件类型", /Content-Type: image\/png/.test(text), true);

    // 二进制原样进去，不能被当成 UTF-8 改坏
    const marker = body.findIndex((b, i) => b === 1 && body[i + 1] === 2 && body[i + 2] === 3 && body[i + 3] === 4);
    check("图片字节原样保留", marker > 0, true);
    check("图片字节长度正确", marker > 0 && body.length > marker + 4, true);

    const parts = editParts({
        protocol: "openai",
        baseURL: "",
        apiKey: "",
        model: "m",
        prompt: "p",
        size: "1024x1024",
        reference: img,
    });
    check("字段顺序按官方文档", parts.map((p) => p.name), ["model", "prompt", "image", "n", "size"]);
    check("带上了参考图", parts[2].file.name, "a.png");
}

console.log("解析返回：");
{
    // 官方形态：data[].b64_json
    const r1 = parseImageResponse({ data: [{ b64_json: "AAAABBBB" }, { b64_json: "CCCC" }] });
    check("认 b64_json", r1.dataUrls.length, 2);
    check("拼成 data URL", r1.dataUrls[0].startsWith("data:image/png;base64,"), true);

    // 中转站常只给网址
    const r2 = parseImageResponse({ data: [{ url: "https://x/1.png" }] });
    check("认 url", r2.urls, ["https://x/1.png"]);
    check("走 url 时 dataUrls 为空", r2.dataUrls.length, 0);

    // 有的国产中转站自造格式
    const r3 = parseImageResponse({ images: ["BBBBCCCC"] });
    check("认 images 数组", r3.dataUrls.length, 1);

    // 改写过提示词
    const r4 = parseImageResponse({ data: [{ b64_json: "AA", revised_prompt: "改写后的" }] });
    check("抓到 revised_prompt", r4.revisedPrompt, "改写后的");

    // 空壳不能崩
    check("null 不崩", parseImageResponse(null).dataUrls, []);
    check("空对象不崩", parseImageResponse({}).dataUrls, []);
    check("data 不是数组不崩", parseImageResponse({ data: "x" }).dataUrls, []);
    check("空 base64 被丢掉", parseImageResponse({ data: [{ b64_json: "" }] }).dataUrls, []);

    // 已经是 data URL 就不要再套一层
    const already = parseImageResponse({ data: [{ b64_json: "data:image/webp;base64,ZZZZ" }] });
    check("已经是 data URL 不重复包", already.dataUrls[0], "data:image/webp;base64,ZZZZ");
}

console.log("toDataUrl：");
check("普通 base64 加前缀", toDataUrl("AAAA"), "data:image/png;base64,AAAA");
check("换行被去掉", toDataUrl("AA\nAA"), "data:image/png;base64,AAAA");
check("空字符串给空", toDataUrl(""), "");
check("能指定 mime", toDataUrl("AA", "image/jpeg"), "data:image/jpeg;base64,AA");

console.log("错误信息：");
{
    check("没有返回给一句人话", /没返回图片/.test(imageErrorOf(null)), true);
    check("认 error.message", imageErrorOf({ error: { message: "坏了" } }), "坏了");
    check("认 error 字符串", imageErrorOf({ error: "坏了" }), "坏了");
    check("认顶层 message", imageErrorOf({ message: "坏了" }), "坏了");
}

console.log("参考图检查：");
{
    check("PNG 可以", checkReference({ name: "a.png", type: "image/png", size: 1000 }), "");
    check("JPG 可以", checkReference({ name: "a.jpg", type: "image/jpeg", size: 1000 }), "");
    check("WEBP 可以", checkReference({ name: "a.webp", type: "image/webp", size: 1000 }), "");
    check("GIF 不行", /PNG/.test(checkReference({ name: "a.gif", type: "image/gif", size: 1000 })), true);
    check("PDF 不行", /PNG/.test(checkReference({ name: "a.pdf", type: "application/pdf", size: 1000 })), true);
    check("空文件不行", /空/.test(checkReference({ name: "a.png", type: "image/png", size: 0 })), true);
    check(
        "超过 8MB 不行",
        /8 MB/.test(checkReference({ name: "a.png", type: "image/png", size: MAX_REF_BYTES + 1 })),
        true
    );
    check("正好 8MB 可以", checkReference({ name: "a.png", type: "image/png", size: MAX_REF_BYTES }), "");

    check("由名字推 jpg", mimeOfName("x.JPG"), "image/jpeg");
    check("由名字推 webp", mimeOfName("x.webp"), "image/webp");
    check("认不出当 png", mimeOfName("x.bmp"), "image/png");
}

console.log("文件命名：");
{
    const d = new Date(2026, 10, 20, 21, 30, 45); // 2026-11-20 21:30:45
    check("时间戳格式", stampOf(d), "20261120-213045");
    check("第一张不带序号", imageFileName(d, "1024x1024", 1), "img-20261120-213045-1024x1024.png");
    check("第二张带序号", imageFileName(d, "1024x1024", 2), "img-20261120-213045-1024x1024-2.png");
    check("jpeg 用 jpg 后缀", imageFileName(d, "2048x1152", 1, "image/jpeg").endsWith(".jpg"), true);
    check("webp 后缀", imageFileName(d, "2048x1152", 1, "image/webp").endsWith(".webp"), true);
    check("尺寸里的怪字符被清掉", imageFileName(d, "1024 × 1024", 1), "img-20261120-213045-1024x1024.png");
}

console.log("data URL 拆回字节：");
{
    // "AAAA" 的 base64 解码是三个 0 字节
    const got = dataUrlToBytes("data:image/png;base64,AAAA");
    check("拆得出来", !!got, true);
    check("mime 对", got.mime, "image/png");
    check("字节数对", got.bytes.length, 3);

    check("不是 data URL 返回 null", dataUrlToBytes("http://x/1.png"), null);
    check("非 base64 的 data URL 返回 null", dataUrlToBytes("data:text/plain,abc"), null);
    check("空串返回 null", dataUrlToBytes(""), null);

    // 往返测试：编出来再拆回去，字节必须一致
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250, 251, 252]);
    let bin = "";
    for (const b of original) bin += String.fromCharCode(b);
    const round = dataUrlToBytes("data:image/png;base64," + btoa(bin));
    check("编解码往返字节一致", Array.from(round.bytes), Array.from(original));
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
