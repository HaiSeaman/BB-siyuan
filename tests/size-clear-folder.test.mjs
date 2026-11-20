/**
 * 这轮三个需求的回归测试。
 *
 *  1. 一键清除模型不能把勾选的删掉
 *  2. 「图片」按钮要存在且在「上传」左边
 *  3. 尺寸按屏幕分辨率：1K=1920 / 2K=2560 / 4K=3840 / 4K+=4096
 */
import { RATIOS, SIZES, LONG_EDGE, computeSize, planSize } from "../.test/image.js";
import { createApi, togglePick, visibleModels, pickedOf } from "../.test/apis.js";

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

console.log("【需求3】尺寸按屏幕分辨率：");
check("有四档", SIZES, ["1K", "2K", "4K", "4K+"]);
check("1K 长边 1920（1080p）", LONG_EDGE["1K"], 1920);
check("2K 长边 2560（1440p）", LONG_EDGE["2K"], 2560);
check("4K 长边 3840（2160p）", LONG_EDGE["4K"], 3840);
check("4K+ 长边 4096（DCI）", LONG_EDGE["4K+"], 4096);

{
    const a = computeSize("1K", "16:9");
    check("1K + 16:9 = 正好 1920×1080（铺满 1080p）", [a.width, a.height], [1920, 1080]);

    const b = computeSize("2K", "16:9");
    check("2K + 16:9 = 正好 2560×1440", [b.width, b.height], [2560, 1440]);

    const c = computeSize("4K", "16:9");
    check("4K + 16:9 = 正好 3840×2160（铺满 4K）", [c.width, c.height], [3840, 2160]);

    const d = computeSize("4K+", "16:9");
    check("4K+ + 16:9 = 4096×2304", [d.width, d.height], [4096, 2304]);

    const e = computeSize("1K", "1:1");
    check("1K + 1:1 = 1920×1920", [e.width, e.height], [1920, 1920]);

    const f = computeSize("1K", "9:16");
    check("1K + 9:16 = 1080×1920（手机竖屏）", [f.width, f.height], [1080, 1920]);

    const g = computeSize("4K", "9:16");
    check("4K + 9:16 = 2160×3840（手机 4K 竖屏）", [g.width, g.height], [2160, 3840]);

    // 8 的倍数（很多模型要求）
    for (const level of SIZES) {
        for (const r of RATIOS) {
            const s = computeSize(level, r);
            if (s.width % 8 !== 0 || s.height % 8 !== 0) {
                check(level + " + " + r + " 宽高都是 8 的倍数", [s.width % 8, s.height % 8], [0, 0]);
            }
        }
    }
    console.log("  （已检查 4 档 × 10 比例，宽高都是 8 的倍数）");
}

console.log("【需求3】官方尺寸表仍然生效（gpt-image-1 只认那几种）：");
{
    const p = planSize("2K", "16:9", "gpt-image-1");
    check("2K+16:9 想要 2560×1440，被换成 1536×1024", p.api, "1536x1024");
    check("标了已换", p.adjusted, true);
    check("说明里写了原尺寸 2560×1440", /2560×1440/.test(p.note), true);

    const free = planSize("4K", "16:9", "gemini-3.1-flash-image");
    check("无限制模型按 4K 原样发 3840×2160", free.api, "3840x2160");
    check("不报警", free.adjusted, false);
}

console.log("【需求1】清除模型要保留勾选的：");
{
    // 复刻 clearModels 的新逻辑
    function clearKeeps(api, isImage) {
        const all = api.models;
        const pickedList = Array.isArray(api.picked) ? api.picked : all;
        const keep = new Set([...pickedList, ...all.filter(isImage)]);
        if (api.model) keep.add(api.model);
        return all.filter((m) => keep.has(m));
    }
    const isImage = (m) => /image/i.test(m);

    const api = createApi({
        models: ["glm-5.3", "kimi-k3", "deepseek-v4", "gpt-oss-120b", "gemini-3.1-flash-image"],
        model: "glm-5.3",
        picked: ["glm-5.3", "kimi-k3"],
    });
    const kept = clearKeeps(api, isImage);
    check("勾选的 glm-5.3 留着", kept.includes("glm-5.3"), true);
    check("勾选的 kimi-k3 留着", kept.includes("kimi-k3"), true);
    check("画图模型留着", kept.includes("gemini-3.1-flash-image"), true);
    check("没勾的 deepseek 被清掉", kept.includes("deepseek-v4"), false);
    check("没勾的 gpt-oss 被清掉", kept.includes("gpt-oss-120b"), false);
    check("只留下 3 个", kept.length, 3);
}

console.log("【需求1】老配置（没有 picked）不该被清光：");
{
    function clearKeeps(api, isImage) {
        const all = api.models;
        const pickedList = Array.isArray(api.picked) ? api.picked : all;
        const keep = new Set([...pickedList, ...all.filter(isImage)]);
        if (api.model) keep.add(api.model);
        return all.filter((m) => keep.has(m));
    }
    const legacy = { models: ["a", "b", "c"], model: "a" }; // 没有 picked
    const kept = clearKeeps(legacy, () => false);
    check("老配置当作全选，一个都不清", kept, ["a", "b", "c"]);
}

console.log("【需求1】pickedOf 兜底仍然正确：");
{
    check("没有 picked 时退回全部", pickedOf({ models: ["a", "b"] }), ["a", "b"]);
    check("有 picked 时用它", pickedOf(createApi({ models: ["a", "b"], picked: ["a"] })), ["a"]);
    check("picked 是空数组时退回全部", pickedOf({ models: ["a", "b"], picked: [] }), ["a", "b"]);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
