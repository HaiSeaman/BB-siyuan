/**
 * 这轮两个需求的测试：
 *   1. 一个 API 里能多选模型（picked），顶栏只列勾过的
 *   2. 图片显示链路：字节嗅探、静态地址兜底、失败原因
 */
import {
    createApi,
    normalizeApis,
    togglePick,
    isPicked,
    visibleModels,
} from "../.test/apis.js";
import { sniffImageMime, mimeOfPath, bufferToDataUrl } from "../.test/image-store.js";

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

console.log("多选模型：老配置行为不变");
{
    const a = createApi({ models: ["m1", "m2", "m3"], model: "m2" });
    check("没有 picked 时默认全选", a.picked, ["m1", "m2", "m3"]);
    check("顶栏显示全部（和老版本一样）", visibleModels(a), ["m1", "m2", "m3"]);
    check("当前模型在里面", a.model, "m2");
}

console.log("多选模型：勾选/取消");
{
    const a = createApi({ models: ["m1", "m2", "m3"], model: "m1" });
    const b = togglePick(a, "m2");
    check("取消 m2 后只剩 m1、m3", b.picked, ["m1", "m3"]);
    check("顶栏跟着变", visibleModels(b), ["m1", "m3"]);
    check("原对象没被改", a.picked, ["m1", "m2", "m3"]);

    const c = togglePick(b, "m2");
    check("再勾回来", c.picked.sort(), ["m1", "m2", "m3"]);
    check("isPicked 判断对", isPicked(c, "m2"), true);
    check("没勾的判断对", isPicked(b, "m2"), false);
}

console.log("多选模型：正在用的不能取消");
{
    const a = createApi({ models: ["m1", "m2"], model: "m1" });
    const b = togglePick(a, "m1");
    check("取消当前模型被拒绝（返回原对象）", b === a, true);
    check("当前模型还在勾选里", b.picked.includes("m1"), true);
}

console.log("多选模型：至少留一个");
{
    const a = createApi({ models: ["only"], model: "only" });
    const b = togglePick(a, "only");
    check("只有一个时取消被拒", b === a, true);
    check("仍然有一个可见", visibleModels(b).length, 1);
}

console.log("多选模型：清洗时丢掉不存在的名字");
{
    const a = createApi({ models: ["m1", "m2"], model: "m1", picked: ["m1", "不存在的", "m2"] });
    check("不存在的被丢掉", a.picked, ["m1", "m2"]);

    const b = createApi({ models: ["m1", "m2"], model: "m2", picked: ["m1"] });
    check("当前模型不在勾选里时自动补进去", b.picked.includes("m2"), true);
}

console.log("多选模型：从磁盘读回来也保留勾选");
{
    const list = normalizeApis([
        { id: "a", name: "A", models: ["m1", "m2", "m3"], model: "m1", picked: ["m1", "m3"] },
    ]);
    check("picked 被保留", list[0].picked, ["m1", "m3"]);
    check("顶栏只显示两个", visibleModels(list[0]), ["m1", "m3"]);
    check("models 还是三个", list[0].models.length, 3);
}

console.log("图片：按字节嗅探真实类型（这是显示不出来的根因之一）");
{
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 0, 0, 0, 0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

    check("JPEG 认出来", sniffImageMime(jpeg), "image/jpeg");
    check("PNG 认出来", sniffImageMime(png), "image/png");
    check("WEBP 认出来", sniffImageMime(webp), "image/webp");
    check("空字节走兜底", sniffImageMime(new Uint8Array(0), "image/png"), "image/png");

    // 真实场景：文件名 .png，内容是 JPEG
    check("文件名说 png 但内容是 jpeg → 嗅探成 jpeg", sniffImageMime(jpeg, mimeOfPath("a.png")), "image/jpeg");
}

console.log("图片：data URL 编码");
{
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const d = bufferToDataUrl(png, "image/png");
    check("前缀正确", d.startsWith("data:image/png;base64,"), true);
    check("能解回原字节", atob(d.split(",")[1]).length, 4);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
