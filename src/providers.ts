import type { ChatMessage } from "./net";
import { effortFor, anthropicEffort, anthropicBudget, type ThinkingLevel } from "./thinking";

export type Protocol = "openai" | "anthropic" | "gemini";

export interface ChatConfig {
    baseURL: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    thinking: ThinkingLevel;
}

function trimBase(baseURL: string): string {
    return baseURL.replace(/\/+$/, "");
}

export function endpointFor(protocol: Protocol, baseURL: string, model = ""): string {
    const base = trimBase(baseURL);
    if (protocol === "anthropic") {
        if (base.endsWith("/messages")) return base;
        if (/\/v1$/.test(base)) return base + "/messages";
        return base + "/v1/messages";
    }
    if (protocol === "gemini") {
        const head = base.replace(/\/v1beta$|\/v1$/, "");
        // 模型名为空时拼出来的是 /models/:streamGenerateContent，必然 404。
        // 直接用标记让上层报一句人话，而不是发一个畸形地址出去。
        if (!model.trim()) return head + "/v1beta/models/__MISSING_MODEL__:streamGenerateContent?alt=sse";
        return `${head}/v1beta/models/${model.trim()}:streamGenerateContent?alt=sse`;
    }
    if (base.endsWith("/chat/completions")) return base;
    return base + "/chat/completions";
}

export function headersFor(protocol: Protocol, cfg: Pick<ChatConfig, "apiKey">): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (protocol === "anthropic") {
        h.Accept = "text/event-stream";
        h["anthropic-version"] = "2023-06-01";
        if (cfg.apiKey) h["x-api-key"] = cfg.apiKey;
        return h;
    }
    if (protocol === "gemini") {
        h.Accept = "text/event-stream";
        if (cfg.apiKey) h["x-goog-api-key"] = cfg.apiKey;
        return h;
    }
    h.Accept = "text/event-stream";
    if (cfg.apiKey) h.Authorization = "Bearer " + cfg.apiKey;
    return h;
}

export function bodyFor(
    protocol: Protocol,
    cfg: ChatConfig,
    messages: ChatMessage[],
    system = "",
    tools: ToolSpec[] = []
): Record<string, any> {
    // 模板作为系统提示：拼在最前面，三种协议各自的构造逻辑会把它放到正确位置
    const withSystem: ChatMessage[] = system.trim()
        ? [{ role: "system", content: system }, ...messages]
        : messages;

    if (protocol === "anthropic") return anthropicBody(cfg, withSystem, tools);
    if (protocol === "gemini") return geminiBody(cfg, withSystem, tools);
    return openaiBody(cfg, withSystem, tools);
}

/** 工具的通用形状（OpenAI 那套，Anthropic 只是少个 type 字段） */
export interface ToolSpec {
    type: "function";
    function: { name: string; description: string; parameters: any };
}

function openaiBody(cfg: ChatConfig, messages: ChatMessage[], tools: ToolSpec[]): Record<string, any> {
    const body: Record<string, any> = {
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: true,
    };
    const effort = effortFor(cfg.model, cfg.thinking);
    if (effort) body.reasoning_effort = effort;
    if (tools.length) body.tools = tools;
    return body;
}

function anthropicBody(
    cfg: ChatConfig,
    messages: unknown[],
    tools: ToolSpec[] = []
): Record<string, any> {
    const src = messages as any[];

    const system = src
        .filter((m) => m?.role === "system")
        .map((m) => String(m.content ?? ""))
        .join("\n\n");

    // Claude 要求 messages 严格交替 user/assistant，
    // 连着两条 user（比如素材 + 问题）会被直接拒绝。
    // 同时要把工具调用和工具结果按官方格式还原，否则模型看不懂那是工具返回。
    const merged: any[] = [];
    for (const m of src) {
        if (!m || m.role === "system") continue;

        if (m.role === "tool") {
            // 工具结果必须是 user 消息里的 tool_result 块
            const block = {
                type: "tool_result",
                tool_use_id: m.tool_call_id || "",
                content: String(m.content ?? ""),
            };
            const last = merged[merged.length - 1];
            if (last && last.role === "user" && Array.isArray(last.content)) {
                last.content.push(block);
            } else {
                merged.push({ role: "user", content: [block] });
            }
            continue;
        }

        if (m.role === "assistant") {
            const blocks: any[] = [];
            if (typeof m.content === "string" && m.content.trim()) {
                blocks.push({ type: "text", text: m.content });
            }
            if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    let input: any = {};
                    try {
                        input = JSON.parse(tc?.function?.arguments || "{}");
                    } catch {
                        input = {};
                    }
                    blocks.push({
                        type: "tool_use",
                        id: tc?.id || "",
                        name: tc?.function?.name || "",
                        input,
                    });
                }
            }
            // 空 assistant 会被拒，宁可不带这一条
            if (!blocks.length) continue;
            merged.push({ role: "assistant", content: blocks });
            continue;
        }

        const text = String(m.content ?? "");
        const last = merged[merged.length - 1];
        if (last && last.role === "user") {
            if (typeof last.content === "string") last.content = (last.content + "\n\n" + text) || text;
            else last.content.push({ type: "text", text });
        } else {
            merged.push({ role: "user", content: text });
        }
    }

    // 官方要求第一条必须是 user
    if (merged.length && merged[0].role === "assistant") {
        merged.unshift({ role: "user", content: "继续" });
    }

    const body: Record<string, any> = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        stream: true,
        messages: merged.length ? merged : [{ role: "user", content: "" }],
    };
    if (system) body.system = system;

    const effort = anthropicEffort(cfg.thinking);
    const budget = anthropicBudget(cfg.thinking, cfg.maxTokens);

    // 开思考时不能带 temperature：Anthropic 要求此时 temperature 必须为 1，
    // 带 0.7 会被直接 400。干脆不发，让它用默认。
    if (effort && budget) {
        body.thinking = { type: "enabled", budget_tokens: budget };
    } else {
        body.temperature = cfg.temperature;
        if (effort) body.effort = effort;
    }

    // Anthropic 的工具字段：不要 type 包层，参数叫 input_schema
    if (tools.length) {
        body.tools = tools.map((t) => ({
            name: t.function.name,
            description: t.function.description || t.function.name,
            input_schema: t.function.parameters || { type: "object", properties: {} },
        }));
    }
    return body;
}

function geminiBody(
    cfg: ChatConfig,
    messages: unknown[],
    tools: ToolSpec[] = []
): Record<string, any> {
    const src = messages as any[];

    const system = src
        .filter((m) => m?.role === "system")
        .map((m) => String(m.content ?? ""))
        .join("\n\n");

    const contents: any[] = [];
    for (const m of src) {
        if (!m || m.role === "system") continue;

        if (m.role === "tool") {
            // 工具结果要用 functionResponse，连续多个工具结果合并到同一条 user 回合里
            const part = {
                functionResponse: {
                    name: m.tool_name || "tool",
                    response: { result: String(m.content ?? "") },
                },
            };
            const prev = contents[contents.length - 1];
            if (prev?.role === "user" && prev.parts.every((p: any) => p.functionResponse)) {
                prev.parts.push(part);
            } else {
                contents.push({ role: "user", parts: [part] });
            }
            continue;
        }

        if (m.role === "assistant") {
            const parts: any[] = [];
            if (typeof m.content === "string" && m.content.trim()) {
                parts.push({ text: m.content });
            }
            if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    let args: any = {};
                    try {
                        args = JSON.parse(tc?.function?.arguments || "{}");
                    } catch {
                        args = {};
                    }
                    parts.push({ functionCall: { name: tc?.function?.name || "", args } });
                }
            }
            if (!parts.length) continue;
            contents.push({ role: "model", parts });
            continue;
        }

        contents.push({ role: "user", parts: [{ text: String(m.content ?? "") }] });
    }

    const generationConfig: Record<string, any> = {
        temperature: cfg.temperature,
        maxOutputTokens: cfg.maxTokens,
    };
    const level = geminiThinkingLevel(cfg.thinking);
    if (level) generationConfig.thinkingConfig = { thinkingLevel: level, includeThoughts: true };

    const body: Record<string, any> = {
        contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }],
        generationConfig,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    // Gemini 的工具格式：一组 functionDeclarations
    if (tools.length) {
        body.tools = [
            {
                functionDeclarations: tools.map((t) => ({
                    name: t.function.name,
                    description: t.function.description || t.function.name,
                    parameters: t.function.parameters || { type: "object", properties: {} },
                })),
            },
        ];
    }
    return body;
}

function geminiThinkingLevel(level: ThinkingLevel): string | undefined {
    if (level === "off" || level === "minimal" || level === "low") return "LOW";
    if (level === "medium") return "MEDIUM";
    return "HIGH";
}

/** 逐行切分 SSE，只取 data: 行 */
class LineBuffer {
    private buf = "";

    push(chunk: string): string[] {
        this.buf += chunk;
        const out: string[] = [];
        let i = this.buf.indexOf("\n");
        while (i !== -1) {
            const line = this.buf.slice(0, i).replace(/\r$/, "");
            this.buf = this.buf.slice(i + 1);
            if (line.startsWith("data:")) {
                const p = line.slice(5).trim();
                if (p) out.push(p);
            }
            i = this.buf.indexOf("\n");
        }
        return out;
    }

    flush(): string[] {
        const line = this.buf.replace(/\r$/, "");
        this.buf = "";
        if (line.startsWith("data:")) {
            const p = line.slice(5).trim();
            if (p) return [p];
        }
        return [];
    }
}

/**
 * 三种协议的流式解析器。
 * 把字节转成「正文增量」「思考增量」「工具调用」。
 */
export class ProviderParser {
    private line = new LineBuffer();

    /** 已拼好的工具调用；三家都在这里累积 */
    private calls: { id: string; name: string; argsText: string }[] = [];
    /** Anthropic 按 index 记当前正在收哪个工具的参数 */
    private anthropicBlockIndex = new Map<number, number>();
    /** 记哪些槽位已经有完整 input，等 delta 来了要覆盖 */
    private anthropicHadFullInput = new Set<number>();
    private geminiSeq = 0;

    constructor(
        private protocol: Protocol,
        private onText: (t: string) => void,
        private onReasoning: (t: string) => void
    ) {}

    push(chunk: string) {
        for (const payload of this.line.push(chunk)) this.handle(payload);
    }

    end() {
        for (const payload of this.line.flush()) this.handle(payload);
    }

    /** 流结束后取工具调用；参数坏掉的兜底成空对象，别让整次请求白跑 */
    toolCalls(): { id: string; name: string; args: Record<string, unknown> }[] {
        return this.calls
            .filter((c) => c.name)
            .map((c) => ({
                id: c.id,
                name: c.name,
                args: parseArgs(c.argsText),
            }));
    }

    private handle(payload: string) {
        if (this.protocol === "anthropic") return this.handleAnthropic(payload);
        if (this.protocol === "gemini") return this.handleGemini(payload);
        return this.handleOpenAI(payload);
    }

    private handleOpenAI(payload: string) {
        if (payload === "[DONE]") return;
        const json = parseJson(payload);
        if (!json) return;
        if (json.error) throw new Error(errorText(json.error));
        const delta = json.choices?.[0]?.delta;
        if (!delta) return;

        const reasoning =
            pick(delta.reasoning_content) ?? pick(delta.reasoning) ?? pick(delta.thinking_content);
        if (reasoning) this.onReasoning(reasoning);
        if (typeof delta.content === "string" && delta.content) this.onText(delta.content);

        // 工具调用是分片发的：参数会一点点吐出来，必须按 index 累积
        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const fn = tc.function || {};
                const hasIndex = typeof tc.index === "number" && tc.index >= 0;

                // 有些中转站不发 index。这时不能每片都开新槽位，
                // 否则一个调用会被拆成 N 个空参数调用（写操作会被执行 N 次）。
                let index: number;
                if (hasIndex && tc.index <= 32) {
                    index = tc.index;
                } else {
                    // 没 index：如果带了新 id 或新名字，就开新槽；否则续到最后一个
                    const last = this.calls[this.calls.length - 1];
                    const startsNew = Boolean(tc.id) || Boolean(fn.name);
                    index = !last || (startsNew && (last.name || last.argsText)) ? this.calls.length : this.calls.length - 1;
                }

                while (this.calls.length <= index) this.calls.push({ id: "", name: "", argsText: "" });
                const slot = this.calls[index];
                if (tc.id) slot.id = tc.id;
                if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
                if (typeof fn.arguments === "string") slot.argsText += fn.arguments;
            }
        }
    }

    private handleAnthropic(payload: string) {
        const json = parseJson(payload);
        if (!json) return;
        if (json.type === "error") throw new Error(errorText(json.error));

        if (json.type === "content_block_start") {
            const block = json.content_block || {};
            if (block.type === "tool_use") {
                const idx = this.calls.length;
                this.calls.push({ id: block.id || "", name: block.name || "", argsText: "" });
                if (typeof json.index === "number") this.anthropicBlockIndex.set(json.index, idx);
                // 有的实现直接把完整参数放在 input 里。
                // 记一下"已有完整值"，后面如果又来 delta，要覆盖而不是追加。
                if (block.input && Object.keys(block.input).length) {
                    this.calls[idx].argsText = JSON.stringify(block.input);
                    this.anthropicHadFullInput.add(idx);
                }
            }
            return;
        }

        if (json.type !== "content_block_delta") return;
        const d = json.delta || {};

        if (d.type === "thinking_delta" && typeof d.thinking === "string") {
            this.onReasoning(d.thinking);
            return;
        }
        if (d.type === "text_delta" && typeof d.text === "string") {
            this.onText(d.text);
            return;
        }
        if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
            const slot = this.anthropicBlockIndex.get(json.index);
            if (slot !== undefined && this.calls[slot]) {
                // 已经拿到过完整 input 的话，delta 才是真值，要覆盖掉
                if (this.anthropicHadFullInput.has(slot)) {
                    this.calls[slot].argsText = "";
                    this.anthropicHadFullInput.delete(slot);
                }
                this.calls[slot].argsText += d.partial_json;
            }
        }
    }

    private handleGemini(payload: string) {
        const json = parseJson(payload);
        if (!json) return;
        if (json.error) throw new Error(errorText(json.error));
        const parts = json.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
            if (typeof part?.text === "string" && part.text) {
                if (part.thought === true) this.onReasoning(part.text);
                else this.onText(part.text);
                continue;
            }
            const fc = part?.functionCall;
            if (fc && typeof fc.name === "string" && fc.name) {
                this.calls.push({
                    // Gemini 不给调用 id，自己编一个，回灌时要对应
                    id: "gemini-" + ++this.geminiSeq,
                    name: fc.name,
                    argsText: JSON.stringify(fc.args || {}),
                });
            }
        }
    }
}

function parseArgs(text: string): Record<string, unknown> {
    if (!text || !text.trim()) return {};
    try {
        const v = JSON.parse(text);
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
        // 模型偶尔会吐坏参数，宁可当空参数也不让整次请求失败
        return {};
    }
}

function pick(v: unknown): string | undefined {
    return typeof v === "string" && v ? v : undefined;
}

function parseJson(payload: string): any {
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

function errorText(err: any): string {
    if (!err) return "接口报错";
    if (typeof err === "string") return err;
    return err.message || err.msg || JSON.stringify(err);
}
