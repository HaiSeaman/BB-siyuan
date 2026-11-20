/**
 * 工具调用循环。
 *
 * 模型可能说「我要调这个工具」，我们执行完把结果塞回去再问它，
 * 它可能又要调，如此往复，直到它给出正文。
 *
 * 三个必须防的坑：
 *   1. 死循环：模型一直要工具 → maxRounds 兜底
 *   2. 工具报错：要把错误当成工具结果回灌，让模型自己想办法，不能整体崩
 *   3. 上层 UI 抛错：不能把循环卡死
 */

export interface ToolSpec {
    type: "function";
    function: { name: string; description: string; parameters: any };
}

export interface ModelToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

export interface ModelReply {
    content: string;
    toolCalls?: ModelToolCall[];
}

export type ChatFn = (
    messages: any[],
    tools: ToolSpec[],
    handlers: {
        onDelta: (d: { content?: string; reasoning?: string }) => void;
        signal?: AbortSignal;
    }
) => Promise<ModelReply>;

export interface ToolLoopOptions {
    chat: ChatFn;
    messages: any[];
    tools: ToolSpec[];
    /** 执行一个工具，返回要回灌给模型的文本 */
    execTool: (name: string, args: Record<string, unknown>) => Promise<string>;
    onText: (t: string) => void;
    onReasoning: (t: string) => void;
    maxRounds: number;
    signal?: AbortSignal;
}

export interface ToolLoopResult {
    text: string;
    stopReason: "done" | "max-rounds" | "aborted";
    toolCallCount: number;
    toolErrors: string[];
}

export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
    const maxRounds = Math.max(1, opts.maxRounds || 8);
    const messages = opts.messages.slice();
    let text = "";
    let toolCallCount = 0;
    const toolErrors: string[] = [];

    for (let round = 0; round < maxRounds; round++) {
        if (opts.signal?.aborted) return { text, stopReason: "aborted", toolCallCount, toolErrors };

        const reply = await opts.chat(messages, opts.tools || [], {
            onDelta: (d) => {
                if (d.reasoning) opts.onReasoning(d.reasoning);
                if (d.content) opts.onText(d.content);
            },
            signal: opts.signal,
        });

        text += reply.content || "";

        const calls = reply.toolCalls || [];
        if (calls.length === 0) {
            return { text, stopReason: "done", toolCallCount, toolErrors };
        }

        // 把这一轮助手的话和工具调用记进上下文
        messages.push({
            role: "assistant",
            content: reply.content || "",
            tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
            })),
        });

        for (const call of calls) {
            if (opts.signal?.aborted) return { text, stopReason: "aborted", toolCallCount, toolErrors };

            toolCallCount++;
            let resultText = "";
            try {
                resultText = await opts.execTool(call.name, call.args || {});
            } catch (e: any) {
                const msg = String(e?.message || e);
                toolErrors.push(msg);
                // 关键：把错误当成结果回给模型，让它自己判断要不要换个办法
                resultText = "[工具执行失败] " + msg;
            }

            messages.push({
                role: "tool",
                tool_call_id: call.id,
                // Gemini 的 functionResponse 只认名字，不认 id，所以两个都带上
                tool_name: call.name,
                content: resultText || "(工具没有返回内容)",
            });
        }
    }

    return { text, stopReason: "max-rounds", toolCallCount, toolErrors };
}
