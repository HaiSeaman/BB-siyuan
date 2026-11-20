/**
 * 粗估 token 与超长判断。
 * 目的不是精确计数，而是「明显超了就说一声」，别让用户等半天才收到 400。
 */

/** 中文约 1 字 1 token，英文约 4 字符 1 token，取中位数 /2 */
export function estimateTokens(text: string | null | undefined): number {
    if (!text) return 0;
    return Math.ceil(text.length / 2);
}

/**
 * 判断是否超上下文。
 * 要留出输出空间，否则算上回答长度必然爆。
 */
export function isTooLong(inputTokens: number, contextLimit: number, reserveRatio = 0.15): boolean {
    if (!contextLimit || contextLimit <= 0) return false;
    return inputTokens > contextLimit * (1 - reserveRatio);
}

export function tooLongMessage(inputTokens: number, limit: number): string {
    return `这次内容约 ${inputTokens} token，上限约 ${Math.floor(limit * 0.85)} token。请点「新对话」清空历史，或把这次的内容写短一点再试。`;
}
