/**
 * 模板清单的增删改查。
 * 纯函数，不碰存储，方便测试；存盘由调用方（插件入口）负责。
 */

export interface PromptTemplate {
    id: string;
    name: string;
    content: string;
    order: number;
}

function newId(): string {
    // 时间戳 + 随机，够个人用，不会和内置的撞
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
    {
        id: "builtin-review",
        name: "日记复盘",
        content:
            "你是一位善于归纳的写作教练。\n\n" +
            "我会把日记内容写在消息里，请按下面的格式整理：\n" +
            "第一部分「今天发生了什么」：用 3 到 6 条要点，客观复述事实，不评判。\n" +
            "第二部分「值得注意的地方」：指出 2 到 3 个模式或倾向，再给 3 条明天就能执行的具体建议。\n\n" +
            "要求：\n" +
            "- 用第二人称「你」来写\n" +
            "- 不要空话套话，每条建议都要能立刻做\n" +
            "- 不要编造日记里没有的信息\n" +
            "- 今天是 {{date}}（{{weekday}}）",
        order: 0,
    },
    {
        id: "builtin-expand",
        name: "内容扩展",
        content:
            "你是一位耐心的编辑。我会给你一段简略的记录。\n\n" +
            "请把它扩写成一篇完整、通顺的短文：\n" +
            "- 保留原意和所有事实细节，一个都不能丢\n" +
            "- 补足逻辑衔接和过渡，让读起来连贯\n" +
            "- 不要添加原文没有的事实\n" +
            "- 篇幅控制在原文的 2 到 3 倍\n\n" +
            "日期：{{date}}",
        order: 1,
    },
    {
        id: "builtin-summary",
        name: "要点总结",
        content:
            "你是做会议纪要的老手。\n\n" +
            "请把我给你的内容压缩成要点清单：\n" +
            "- 每条不超过 25 字\n" +
            "- 只留结论、决定、待办这类有信息量的\n" +
            "- 去掉重复和铺垫\n" +
            "- 按重要性排序",
        order: 2,
    },
];

export function createTemplate(
    name: string,
    content: string,
    idFactory: () => string = newId,
    orderFactory: () => number = () => 0
): PromptTemplate {
    return {
        id: idFactory(),
        name: name.trim(),
        // 正文不能 trim：用户可能刻意留缩进和空行
        content,
        order: orderFactory(),
    };
}

/**
 * 把从磁盘读到的数据洗成能用的清单。
 * 读不出来或全是脏数据时退回内置示例 —— 空列表比默认示例更让人不知所措。
 */
export function normalizeTemplates(raw: unknown): PromptTemplate[] {
    if (!Array.isArray(raw)) return cloneBuiltins();

    const clean: PromptTemplate[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const t = item as Record<string, unknown>;
        const id = typeof t.id === "string" ? t.id.trim() : "";
        const name = typeof t.name === "string" ? t.name.trim() : "";
        const content = typeof t.content === "string" ? t.content : "";
        if (!id || !name || !content) continue;
        clean.push({
            id,
            name,
            content,
            order: typeof t.order === "number" && Number.isFinite(t.order) ? t.order : clean.length,
        });
    }

    if (clean.length === 0) return cloneBuiltins();

    // 去重：同一 id 只留第一个，防止手改配置导致列表里出现重复项
    const seen = new Set<string>();
    const unique = clean.filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
    });

    return reindex(unique);
}

function cloneBuiltins(): PromptTemplate[] {
    return BUILTIN_TEMPLATES.map((t) => ({ ...t }));
}

function reindex(list: PromptTemplate[]): PromptTemplate[] {
    return list.map((t, i) => ({ ...t, order: i }));
}

export function addTemplate(list: PromptTemplate[], t: PromptTemplate): PromptTemplate[] {
    return reindex([...list, t]);
}

export function updateTemplate(
    list: PromptTemplate[],
    id: string,
    patch: Partial<Pick<PromptTemplate, "name" | "content">>
): PromptTemplate[] {
    return list.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

export function removeTemplate(list: PromptTemplate[], id: string): PromptTemplate[] {
    return reindex(list.filter((t) => t.id !== id));
}

/** 上移传 -1，下移传 1；到边界就原样返回 */
export function moveTemplate(list: PromptTemplate[], id: string, delta: number): PromptTemplate[] {
    const i = list.findIndex((t) => t.id === id);
    if (i === -1) return list;
    const j = i + (delta < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return reindex(next);
}

export function findTemplate(list: PromptTemplate[], id: string): PromptTemplate | undefined {
    return list.find((t) => t.id === id);
}
