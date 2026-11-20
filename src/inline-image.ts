/**
 * 从模型回复的正文里挑出图片。
 *
 * 为什么需要：有的服务商（尤其 Gemini 系）不走 /images/generations，
 * 而是把图片以 markdown 图片的形式混在文字里返回：
 *     ![image](data:image/jpeg;base64,....)
 *     ![image](https://x/1.png)
 * 这种图以前只会被当成一段文字渲染，底下一个「复制」按钮，
 * 既没法保存，base64 还会把 sessions.json 撑到 1MB。
 *
 * 这里只做"认出来 + 拆出正文"，搬盘和渲染由调用方负责。
 */

const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface InlineImage {
    /** 图片地址：data:image/...;base64,... 或 http(s)://... */
    src: string;
    /** markdown 里那个 alt 文本 */
    alt: string;
    /** 剥掉图片之后的正文 */
    rest: string;
}

/**
 * 从正文里取出所有图片。
 *
 * rest 是"去掉图片之后剩下的文字"，两边都会 trim。
 * 一张图都没有时 images 为空、rest 就是原文（不改动）。
 */
export function splitInlineImages(text: string): { images: InlineImage[]; rest: string } {
    const src = String(text || "");
    if (!src) return { images: [], rest: "" };

    const images: InlineImage[] = [];
    let rest = src;

    MD_IMAGE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const found: { whole: string; alt: string; src: string }[] = [];
    while ((m = MD_IMAGE.exec(src)) !== null) {
        const url = m[2];
        // 只认图片：data:image/... 或 http(s) 里像图片的地址
        if (!/^data:image\//i.test(url) && !/^https?:\/\//i.test(url)) continue;
        found.push({ whole: m[0], alt: m[1] || "", src: url });
    }

    for (const f of found) {
        images.push({ src: f.src, alt: f.alt, rest: "" });
        rest = rest.replace(f.whole, "");
    }

    rest = rest.replace(/\n{3,}/g, "\n\n").trim();
    for (const img of images) img.rest = rest;
    return { images, rest };
}

/**
 * 一张图是不是大的 base64（说明它不该留在 sessions.json 里）。
 * 超过 ~20KB 的 base64 就值得搬到磁盘上。
 */
export function isHeavyInlineImage(src: string): boolean {
    return /^data:image\//i.test(src) && src.length > 20 * 1024;
}

/**
 * data URL 的 mime；不是 data URL 时按扩展名猜。
 * 实现已统一到 image-store.ts，这里只做转出，避免三份同样的逻辑。
 */
export { mimeOfName as inlineImageMime } from "./image-store";
