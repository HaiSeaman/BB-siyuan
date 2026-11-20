/**
 * 提示词优化。
 *
 * 用「会写字的聊天模型」把主人随手写的一两句话，改写成一段
 * 生图模型能听懂的中文提示词。
 *
 * 三个硬要求（都是主人明确说的）：
 *   1. 必须用中文
 *   2. 用聊天模型，不能用画图模型（画图模型压根不会写字）
 *   3. 只输出提示词本身，别加解释、别加引号、别加标题
 *
 * 这一层不碰网络：发请求的那个函数由调用方传进来，
 * 所以能在 Node 里用假的模型回复测一遍。
 */

/** 优化的系统提示词。写得越死，模型越不会自作多情 */
export const OPTIMIZE_SYSTEM = [
    "你是一位资深的 AI 绘画提示词工程师。",
    "用户会给你一句很随口的中文描述，你要把它改写成一段适合 AI 生图的中文提示词。",
    "",
    "硬性要求：",
    "1. 只用中文输出，不要出现英文单词（专有名词可以保留，如 4K、HDR）。",
    "2. 只输出提示词本身，不要任何解释、标题、编号、引号、markdown 标记。",
    "3. 一段话，不超过 180 个汉字，用逗号分隔各项要素。",
    "4. 保留用户原本想表达的主体和意图，不要换成别的东西。",
    "5. 补全这些要素：主体细节、动作或状态、环境与背景、光线、色调、构图或视角、画面风格、清晰度。",
    "6. 不要写「请画」「帮我生成」这类指令语，直接描述画面。",
    "7. 如果用户写的内容已经很完整，就只做润色，不要加戏。",
].join("\n");

/** 用户那句话的包装。把原话单独一段，模型不容易跑偏 */
export function optimizeUserPrompt(text: string): string {
    return "把下面这句改写成生图提示词：\n\n" + String(text || "").trim();
}

/** 不同思考档位的粗估 token 上限：优化是短任务，给太多反而慢 */
export const OPTIMIZE_MAX_TOKENS = 800;

/**
 * 把模型吐回来的东西洗成"能直接填进输入框"的一段话。
 *
 * 模型经常忍不住加包装，都要处理：
 *   - ```text 围栏
 *   - 开头的「提示词：」
 *   - 整体包一层引号
 *   - 多段之间空行 → 压成一句
 */
export function cleanOptimized(raw: string): string {
    let t = String(raw || "");

    // 去掉 markdown 代码围栏
    t = t.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "");

    t = t.trim();

    // 去掉「提示词：」「优化后：」这类前缀
    t = t.replace(/^(优化后(的)?提示词|提示词|英文提示词|中文提示词|结果)\s*[:：]\s*/i, "");

    // 去掉整体包的引号（成对才去）
    const pairs: [string, string][] = [
        ['"', '"'],
        ["“", "”"],
        ["'", "'"],
        ["「", "」"],
        ["『", "』"],
    ];
    for (const [a, b] of pairs) {
        if (t.length > 2 && t.startsWith(a) && t.endsWith(b)) {
            t = t.slice(a.length, t.length - b.length).trim();
            break;
        }
    }

    // 多行压成一段：句子之间用逗号，不要换行（生图模型对换行不敏感，但看着乱）
    t = t
        .split(/\r?\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join("，")
        // 别把本来就有的句号/逗号搞成连续逗号
        .replace(/[，,]\s*[，,]+/g, "，")
        .replace(/，\s*$/g, "");

    return t.trim();
}

/**
 * 判断模型回复是不是"没在干活"。
 *
 * 有的模型会回一句「好的，我来帮你优化：」然后什么都没写，
 * 这种要当成失败，不能把废话填进输入框。
 */
export function looksEmpty(raw: string): boolean {
    const t = cleanOptimized(raw);
    if (!t) return true;
    // 太短的多半是"好的""收到"这类
    if (t.length < 6) return true;
    // 「我来帮你优化」这种客套话：没有画面要素，全是"我/帮/你/优化"
    const chatter = /^(好的|好|收到|明白|没问题)?[，,]?\s*(我)?(来|会)?(帮|给)(你|您)?(优化|改写|润色|生成|写)/;
    if (chatter.test(t)) return true;
    return false;
}

/**
 * 提示词里要告诉用户的那句"用的是哪个模型"。
 * 让主人知道钱花在哪儿了，出问题也知道去查哪个模型。
 */
export function optimizeHint(apiName: string, model: string): string {
    return `已用 ${apiName || "未命名"} · ${model} 改写成中文提示词`;
}

/** 失败时的建议 */
export function optimizeFallbackHint(): string {
    return "优化失败。可以先去设置里确认有一套能聊天的模型，或者自己手动改提示词。";
}

/** 给用户的错误翻译：优化这条路最常见的就是"没有聊天模型" */
export function optimizeErrorMessage(raw: string): string {
    const m = String(raw || "");
    // 已经是给人看的整句（界面自己拼的那几句）就原样放行，别再套一层"优化失败："
    if (/没有.*聊天模型|先加一个.*模型|要用聊天模型|去设置里加/.test(m)) return m;
    if (/401|403/.test(m)) return "优化失败：密钥不对或没权限。去设置里检查那套 API。";
    if (/404/.test(m)) return "优化失败：那套 API 的地址找不到。去设置里核对接口地址。";
    if (/429/.test(m)) return "优化失败：请求太频繁或额度用完了，等一会儿再试。";
    if (/model.*not.*found|模型不存在|invalid\s*model/i.test(m)) {
        return "优化失败：那个聊天模型名字不对。去设置里重新选一个能聊天的模型。";
    }
    return "优化失败：" + (m || "原因不明");
}
