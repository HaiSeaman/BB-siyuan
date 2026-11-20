/**
 * 旧设置迁移测试
 *
 * 三个历史阶段的坑：
 *   1. reasoningEffort → thinking
 *   2. 单份配置 → apis[]（地址/密钥/模型必须原样搬进第一套）
 *   3. 洗掉手改配置里的野值
 */
import { migrateSettings } from "../.test/migrate.js";

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
        console.log("       实际: " + JSON.stringify(actual));
        console.log("       期望: " + JSON.stringify(expected));
    }
}

console.log("空输入：");
check("null 返回 null", migrateSettings(null), null);
check("undefined 返回 null", migrateSettings(undefined), null);
check("字符串返回 null", migrateSettings("abc"), null);

console.log("阶段一的老设置（单份配置 + reasoningEffort）：");
{
    const old = {
        baseURL: "http://192.168.1.8:17864/v1",
        apiKey: "ck_abc",
        model: "glm-5.3",
        temperature: 0.7,
        maxTokens: 4096,
        reasoningEffort: "max",
        contextMessages: 10,
        showReasoning: true,
    };
    const m = migrateSettings(old);
    const api = m.apis[0];
    check("密钥搬进第一套 API", api.apiKey, "ck_abc");
    check("模型搬进第一套 API", api.model, "glm-5.3");
    check("模型也进了清单", api.models, ["glm-5.3"]);
    check("地址搬进第一套 API", api.baseURL, "http://192.168.1.8:17864/v1");
    check("max 迁移成 max", m.thinking, "max");
    check("旧字段被删掉", "reasoningEffort" in m, false);
    check("补上协议默认值", api.protocol, "openai");
    check("当前 API 指向它", m.activeApiId, api.id);
    check("显示思考保住了", m.showReasoning, true);
    check("旧的单份字段清干净", ["baseURL", "apiKey", "model", "protocol"].some((k) => k in m), false);
}

console.log("off 迁移：");
{
    const m = migrateSettings({ reasoningEffort: "off" });
    check("off 迁移成 off", m.thinking, "off");
}

console.log("不认识的老值：");
{
    const m = migrateSettings({ reasoningEffort: "ultra" });
    check("野值退回 high", m.thinking, "high");
}

console.log("已经是新格式：");
{
    const m = migrateSettings({
        thinking: "low",
        apis: [
            {
                id: "x1",
                name: "中转站A",
                protocol: "anthropic",
                baseURL: "https://a/v1",
                apiKey: "k1",
                models: ["claude-x"],
                model: "claude-x",
            },
        ],
        activeApiId: "x1",
    });
    check("thinking 不动", m.thinking, "low");
    check("协议不动", m.apis[0].protocol, "anthropic");
    check("名字不动", m.apis[0].name, "中转站A");
    check("当前 API 不动", m.activeApiId, "x1");
}

console.log("挡住手改的野值：");
{
    const m = migrateSettings({ thinking: "超强" });
    check("思考野值退回 high", m.thinking, "high");

    const m2 = migrateSettings({ protocol: "xyz" });
    check("协议野值退回 openai", m2.apis[0].protocol, "openai");
}

console.log("多套 API 的脏数据：");
{
    const m = migrateSettings({
        apis: [
            { id: "a", name: "好的", protocol: "openai", baseURL: "http://a/v1", models: ["m1"], model: "m1" },
            { id: "a", name: "重复 id", baseURL: "http://b/v1" },
            { name: "没有 id" },
            null,
            "垃圾",
            { id: "c", name: "空的", models: "不是数组" },
        ],
        activeApiId: "不存在的",
    });
    check("只留下有 id 且不重复的", m.apis.length, 2);
    check("留下的是对的那两条", m.apis.map((a) => a.id), ["a", "c"]);
    check("模型不是数组时清空", m.apis[1].models, []);
    check("当前 API 失效时指向第一个", m.activeApiId, "a");
}

console.log("模型名不在清单里时补进去：");
{
    const m = migrateSettings({
        apis: [{ id: "a", name: "x", baseURL: "http://a/v1", models: [], model: "只在 model 里" }],
    });
    check("模型被补进清单", m.apis[0].models, ["只在 model 里"]);
}

console.log("数值越界：");
{
    const m = migrateSettings({ maxTokens: 999999, contextMessages: 999, temperature: 9 });
    check("maxTokens 上限 64000", m.maxTokens, 64000);
    check("contextMessages 上限 50", m.contextMessages, 50);
    check("temperature 上限 2", m.temperature, 2);
}
{
    const m = migrateSettings({ maxTokens: 1, contextMessages: 0, temperature: -5 });
    check("maxTokens 下限 256", m.maxTokens, 256);
    check("contextMessages 下限 1", m.contextMessages, 1);
    check("temperature 下限 0", m.temperature, 0);
}

console.log("不影响其他字段：");
{
    const m = migrateSettings({ baseURL: "http://a/v1", 自定义: "随便" });
    check("地址搬进第一套 API", m.apis[0].baseURL, "http://a/v1");
    check("不删无关字段", m["自定义"], "随便");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
