import { writable } from "svelte/store";
import type { ThinkingLevel } from "./thinking";
import { createApi, pickActiveApi, type ApiConfig } from "./apis";

/**
 * 设置分两部分：
 *   - apis / activeApiId：多套 API 配置与当前选中的那套
 *   - 其余字段：全局偏好（思考档位、历史条数、温度等），所有 API 共用
 */
export interface Settings {
    apis: ApiConfig[];
    activeApiId: string;
    temperature: number;
    maxTokens: number;
    thinking: ThinkingLevel;
    contextMessages: number;
    showReasoning: boolean;
    /** 模型的上下文上限（token），用来在明显超长时提醒。填 0 表示不检查 */
    contextLimit: number;
    /** 一次生成里最多让模型调用几轮工具，防死循环 */
    maxToolRounds: number;
    /**
     * 上次选中的「能聊天」的模型。
     *
     * 顶栏切到画图模型时，activeApiId/model 指的是画图那套，
     * 但「优化提示词」还得用会写字的模型，所以另外记一份。
     * 格式是 "apiId::modelName"，空字符串表示还没有。
     */
    lastChatModel: string;
    /** 生图的大小档位：1K / 2K / 4K */
    imageSize: string;
    /** 生图的比例，如 16:9 */
    imageRatio: string;
    /** 手动标成"这是画图模型"的模型名（正则认不出来时用它兜底） */
    imageModels: string[];
}

/** 第一次装插件时的默认配置（和以前一样，指向本机中转站） */
function defaultApis(): ApiConfig[] {
    return [
        createApi(
            {
                name: "默认",
                protocol: "openai",
                baseURL: "http://192.168.1.8:17864/v1",
                apiKey: "",
                models: ["glm-5.3"],
                model: "glm-5.3",
            },
            "default"
        ),
    ];
}

export const DEFAULTS: Settings = {
    apis: defaultApis(),
    activeApiId: "default",
    temperature: 0.7,
    maxTokens: 4096,
    thinking: "high",
    contextMessages: 10,
    showReasoning: false,
    contextLimit: 200000,
    maxToolRounds: 8,
    lastChatModel: "",
    imageSize: "2K",
    imageRatio: "16:9",
    imageModels: [],
};

export const settings = writable<Settings>({ ...DEFAULTS });

/** 是否已经用磁盘里的数据初始化过。面板会被反复挂载，靠它避免重复覆盖 */
let initialized = false;

export function isInitialized(): boolean {
    return initialized;
}

let saveTimer: number | undefined;
let persistFn: ((s: Settings) => void) | null = null;

/**
 * 唯一的保存路：400ms 内的连续改动合并成一次写盘。
 *
 * 关键点是「写盘时现取最新状态」，不能把按下那一刻的旧快照排进队列：
 * 以前先把 next 传进定时器，用户接着改了别的字段，0.4 秒后旧快照
 * 会把新改动整份盖掉，表现成「改了又自己变回去」。
 */
function scheduleSave(persist: (s: Settings) => void) {
    persistFn = persist;
    clearTimeout(saveTimer);
    saveTimer = globalThis.setTimeout(() => {
        if (persistFn) persistFn(snapshot());
    }, 400) as unknown as number;
}

export function initSettings(loaded: Partial<Settings> | null | undefined): Settings {
    const merged = { ...DEFAULTS, ...(loaded || {}) };
    // 兜底：洗过的配置可能把 apis 清空（老版本升级或数据损坏），保证至少有一套
    if (!Array.isArray(merged.apis) || !merged.apis.length) {
        merged.apis = defaultApis();
    }
    if (!pickActiveApi(merged.apis, merged.activeApiId)) {
        merged.activeApiId = merged.apis[0].id;
    }
    // 老版本没有这个字段；手改配置也可能写进脏值
    merged.imageModels = Array.isArray(merged.imageModels)
        ? merged.imageModels.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim())
        : [];
    initialized = true;
    settings.set(merged);
    return merged;
}

/** 只读当前值，绝不重置 */
export function snapshot(): Settings {
    let snap: Settings = { ...DEFAULTS };
    const unsub = settings.subscribe((s) => (snap = s));
    unsub();
    return snap;
}

/**
 * 当前生效的那套 API。
 *
 * 正常情况下 initSettings 已经保证了至少有一套；
 * 但界面上删最后一套、或存盘数据被外部改坏时仍可能空。
 * 这时给一个空壳而不是 undefined，面板才不会在 api.model 上崩掉。
 */
export function activeApi(s: Settings): ApiConfig {
    return pickActiveApi(s.apis, s.activeApiId) || createApi({ name: "未配置" }, "empty");
}

/** lastChatModel 的存储格式：apiId::模型名 */
export function packModelRef(apiId: string, model: string): string {
    const id = String(apiId || "").trim();
    const m = String(model || "").trim();
    if (!id || !m) return "";
    return id + "::" + m;
}

/** 拆回 { apiId, model }；拆不出来返回 null */
export function unpackModelRef(ref: string | undefined | null): { apiId: string; model: string } | null {
    const s = String(ref || "");
    const i = s.indexOf("::");
    if (i <= 0) return null;
    const apiId = s.slice(0, i);
    const model = s.slice(i + 2);
    if (!apiId || !model) return null;
    return { apiId, model };
}

/**
 * 该用哪套配置去「优化提示词」。
 *
 * 优先级：
 *   1. 记住的上次聊天模型（还在这套 API 的清单里才算数）
 *   2. 当前选中的模型本身就是聊天模型
 *   3. 所有 API 里第一个能聊天的模型
 *
 * 都没有就返回 null —— 调用方要给主人一句「先去设置里加一个聊天模型」，
 * 而不是拿画图模型去发一句必失败的请求。
 */
export function chatApiFor(
    s: Settings,
    isChat: (model: string) => boolean,
    /** 手动标成画图的名字：这些即使名字不像画图，也不能当聊天模型用 */
    manualImage: string[] = []
): { api: ApiConfig; model: string } | null {
    const usable = (m: string) => isChat(m) && !manualImage.includes(m);

    const remembered = unpackModelRef(s.lastChatModel);
    if (remembered) {
        const api = s.apis.find((a) => a.id === remembered.apiId);
        if (api && api.models.includes(remembered.model) && usable(remembered.model)) {
            return { api, model: remembered.model };
        }
    }

    const current = pickActiveApi(s.apis, s.activeApiId);
    if (current && current.model && usable(current.model)) {
        return { api: current, model: current.model };
    }

    for (const a of s.apis) {
        const m = a.models.find((x) => usable(x));
        if (m) return { api: a, model: m };
    }
    return null;
}

/** 扁平字段的改动（温度、思考档位这些） */
export function updateSettings(patch: Partial<Settings>, persist: (s: Settings) => void) {
    settings.update((s) => {
        const next = { ...s, ...patch };
        scheduleSave(persist);
        return next;
    });
}

/**
 * 改嵌套结构的改动（apis 里的某一张卡）。
 *
 * 必须基于 store 里的最新值改，不能用渲染时的旧快照：
 * 连续输入时后一次会用旧列表覆盖前一次，表现成「打字丢字符」。
 */
export function updateSettingsWith(
    mutate: (s: Settings) => Settings,
    persist: (s: Settings) => void
) {
    settings.update((s) => {
        const next = mutate(s);
        if (next === s) return s;
        scheduleSave(persist);
        return next;
    });
}
