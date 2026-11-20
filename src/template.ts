/**
 * 提示词模板：变量替换。
 *
 * 设计要点：
 *   - 模板正文 = 系统提示
 *   - 小变量（date/time/weekday/doc_title）直接替换成字符串
 *   - 认不出的变量原样保留，绝不吞掉用户写的字
 */

export const VARS = ["date", "time", "weekday", "doc_title"] as const;

export type VarName = (typeof VARS)[number];

export interface TemplateContext {
    date: string;
    time: string;
    weekday: string;
    docTitle?: string;
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 本地时间的日期串，YYYY-MM-DD */
export function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** 本地时间，HH:MM */
export function formatTime(d: Date): string {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export function formatWeekday(d: Date): string {
    return WEEKDAYS[d.getDay()];
}

export function makeContext(docTitle: string, now = new Date()): TemplateContext {
    return {
        date: formatDate(now),
        time: formatTime(now),
        weekday: formatWeekday(now),
        docTitle,
    };
}

/** 匹配 {{xxx}}，允许花括号里有空格 */
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function renderTemplate(text: string, ctx: TemplateContext): string {
    if (!text) return "";

    const values: Record<string, string> = {
        date: ctx.date,
        time: ctx.time,
        weekday: ctx.weekday,
        doc_title: ctx.docTitle ?? "",
    };

    return text.replace(VAR_RE, (whole, name: string) => {
        // 认不出的变量原样返回，别把用户写的东西弄丢
        return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
    });
}

/** 列出模板里用到的变量名（去重，保持出现顺序） */
export function extractVars(text: string): string[] {
    const seen: string[] = [];
    if (!text) return seen;
    VAR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VAR_RE.exec(text)) !== null) {
        if (!seen.includes(m[1])) seen.push(m[1]);
    }
    return seen;
}
