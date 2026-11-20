/**
 * 把「模板 + 用户这句话 + 历史」组装成一次请求要发的消息。
 *
 * 规则：
 *   1. 模板正文进 system，只替换 {{date}} {{time}} {{weekday}} {{doc_title}}
 *   2. 不再有「素材」概念，也不再有 {{content}}
 *   3. 追问时模板继续作为 system
 *   4. 用户没写任何要求时给一个触发词，不能发空消息
 */
import type { ChatMessage } from "./net";
import type { PromptTemplate } from "./templates";
import { renderTemplate, type TemplateContext } from "./template";

const DEFAULT_TRIGGER = "请按上面的要求开始写。";

export interface TurnPlanInput {
    template: PromptTemplate | null;
    userText: string;
    ctx: TemplateContext;
    history: { role: "user" | "assistant"; content: string }[];
}

export interface TurnPlan {
    system: string;
    messages: ChatMessage[];
}

export function buildTurnPlan(input: TurnPlanInput): TurnPlan {
    const userText = (input.userText || "").trim();
    const templateBody = input.template?.content || "";

    let system = "";
    if (templateBody) {
        system = renderTemplate(templateBody, input.ctx);
    }

    const messages: ChatMessage[] = [];

    for (const h of input.history || []) {
        messages.push({ role: h.role, content: h.content });
    }

    if (userText) {
        messages.push({ role: "user", content: userText });
    } else if (messages.length === 0 || messages[messages.length - 1].role === "assistant") {
        messages.push({ role: "user", content: DEFAULT_TRIGGER });
    }

    return { system, messages };
}
