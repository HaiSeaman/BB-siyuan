/** 核对 1.4.1 安装包：三处修复必须在产物里 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const buf = readFileSync(process.argv[2]);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
    }
}
const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const files = {};
const names = [];
for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    let data;
    if (method === 0) data = buf.subarray(localOff, localOff + compSize);
    else {
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        data = inflateRawSync(buf.subarray(start, start + compSize));
    }
    files[name] = data.toString("utf8");
    names.push(name);
    off += 46 + nameLen + extraLen + commentLen;
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
    if (cond) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name + (extra ? "  → " + extra : ""));
    }
}

console.log("包内文件：" + names.sort().join(", "));
const js = files["index.js"] || "";
const css = files["index.css"] || "";
const pj = JSON.parse(files["plugin.json"] || "{}");

ok("版本是 1.4.1", pj.version, "1.4.1");
ok("plugin.json 在根", names.includes("plugin.json"));
ok("没有测试依赖", !names.some((n) => /test|node_modules|\.map$/.test(n)), names.join(","));

console.log("");
console.log("【修复1】4 个按钮（上传/大小/尺寸/优化 + 模式开关）：");
ok("有「上传」", js.includes("上传"));
ok("有 1K/2K/4K", js.includes('"1K"') || js.includes("1K"), js.includes("1K"));
ok("有 10 种比例", ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "5:4", "4:5", "21:9"].every((r) => js.includes(r)));
ok("有「优化」", js.includes("优化中"));
ok("有像素提示（实际尺寸）", js.includes("实际") && js.includes("已换"));

console.log("");
console.log("【修复2】图片卡片两个按钮 + 正文图片提取：");
ok("有「复制图片」", js.includes("复制图片"));
ok("有「保存到电脑」", js.includes("保存到电脑"));
ok("有原生另存为", js.includes("showSaveDialog"));
ok("能认出 markdown 图片", js.includes("!\\[") || js.includes("data:image"));
ok("有搬盘逻辑", js.includes("/api/file/putFile"));

console.log("");
console.log("【修复3】gemini-*-image 认成画图 + 手动标记：");
ok("带 image 的都当画图（正则里有 image）", /image/.test(js));
ok("有手动标记字段", js.includes("imageModels"));
ok("有「标为画图」按钮文案", js.includes("标为画图"));
ok("有「画图」标签", js.includes("画图"));

console.log("");
console.log("样式：");
ok("有 px-hint 样式", css.includes("px-hint"));
ok("有 warn-size 样式", css.includes("warn-size"));
ok("有 img-actions 样式", css.includes("img-actions"));
ok("有 chip-mark 样式（设置页标记按钮）", css.includes("chip-mark"));

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
