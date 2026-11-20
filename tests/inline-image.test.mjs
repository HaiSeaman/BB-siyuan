/**
 * 服务商把图塞在文字里返回 —— 必须能拆出来变成卡片。
 *
 * 真实数据（主人那台 gemini-3.1-flash-image）：
 *   ![image](data:image/jpeg;base64,/9j/4AAQ...)   整条消息 964KB
 */
import { splitInlineImages, isHeavyInlineImage, inlineImageMime } from "../.test/inline-image.js";

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
        console.log("       实际: " + JSON.stringify(actual).slice(0, 300));
        console.log("       期望: " + JSON.stringify(expected).slice(0, 300));
    }
}

const B64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(40000);

console.log("base64 图片（主人真实遇到的形态）：");
{
    const text = "这是你要的图：\n\n![image](data:image/jpeg;base64," + B64 + ")\n\n希望你喜欢";
    const r = splitInlineImages(text);
    check("挑出一张图", r.images.length, 1);
    check("地址是 data URL", r.images[0].src.startsWith("data:image/jpeg;base64,"), true);
    check("alt 读到了", r.images[0].alt, "image");
    check("正文只剩文字（图被摘掉）", r.rest, "这是你要的图：\n\n希望你喜欢");
    check("正文里不再有 base64", r.rest.includes("base64"), false);
    check("正文长度合理", r.rest.length < 40, true);
}

console.log("只有图没有文字：");
{
    const r = splitInlineImages("![image](data:image/png;base64," + B64 + ")");
    check("挑出图", r.images.length, 1);
    check("正文是空的", r.rest, "");
}

console.log("网址图片：");
{
    const text = "看这张 ![cat](https://x.com/1.png) 好不好";
    const r = splitInlineImages(text);
    check("挑出网址图", r.images.length, 1);
    check("地址对", r.images[0].src, "https://x.com/1.png");
    check("alt 是 cat", r.images[0].alt, "cat");
    check("正文只剩文字", r.rest, "看这张  好不好");
}

console.log("多张图：");
{
    const text = "![a](data:image/png;base64,AAA) 文字 ![b](https://x/2.jpg)";
    const r = splitInlineImages(text);
    check("两张都挑出来", r.images.length, 2);
    check("第一张 alt", r.images[0].alt, "a");
    check("第二张 alt", r.images[1].alt, "b");
    check("正文只剩文字", r.rest.includes("文字"), true);
    check("正文没图了", r.rest.includes("!["), false);
}

console.log("别误伤普通文字和链接：");
{
    check("纯文字原样返回", splitInlineImages("今天天气不错").rest, "今天天气不错");
    check("纯文字没有图", splitInlineImages("今天天气不错").images.length, 0);
    check("普通链接不算图", splitInlineImages("[点这里](https://x.com)").images.length, 0);
    check("代码里的方括号不算图", splitInlineImages("arr[0] = 1").images.length, 0);
    check("空串不崩", splitInlineImages("").rest, "");
    check("null 不崩", splitInlineImages(null).images.length, 0);
}

console.log("判断该不该搬到磁盘：");
{
    check("大 base64 要搬", isHeavyInlineImage("data:image/png;base64," + B64), true);
    check("小 base64 不用搬", isHeavyInlineImage("data:image/png;base64,AAAA"), false);
    check("网址不用搬", isHeavyInlineImage("https://x/1.png"), false);
    check("普通文字不用搬", isHeavyInlineImage("文字"), false);
}

console.log("mime 判断：");
{
    check("data URL 里读 jpeg", inlineImageMime("data:image/jpeg;base64,AA"), "image/jpeg");
    check("data URL 里读 png", inlineImageMime("data:image/png;base64,AA"), "image/png");
    check("从扩展名推 jpg", inlineImageMime("https://x/1.jpg"), "image/jpeg");
    check("从扩展名推 webp", inlineImageMime("https://x/1.webp"), "image/webp");
    check("认不出当 png", inlineImageMime("https://x/1"), "image/png");
    check("data URL 写 png 就是 png", inlineImageMime("data:image/png;base64,AA"), "image/png");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
