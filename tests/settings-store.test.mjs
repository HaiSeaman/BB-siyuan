/**
 * 设置 store 的初始化与写入时机。
 *
 * 防的是这一种真实场景：
 *   面板被卸载再挂载（切工作区 / 收起侧栏再打开）时，
 *   如果每次都拿启动时那份 initialSettings 覆盖 store，
 *   用户中途改的地址、Key、模型会瞬间被打回旧值。
 */
import { settings, initSettings, isInitialized, snapshot, activeApi, updateSettings } from "../.test/settings.js";

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

const saved = {
    apis: [
        {
            id: "a1",
            name: "中转站A",
            protocol: "openai",
            baseURL: "http://a/v1",
            apiKey: "k1",
            models: ["m1"],
            model: "m1",
        },
    ],
    activeApiId: "a1",
    thinking: "high",
};

console.log("初始化：");
{
    check("初始化前标记为 false", isInitialized(), false);
    initSettings(saved);
    check("初始化后标记为 true", isInitialized(), true);
    check("带入了磁盘里的地址", activeApi(snapshot()).baseURL, "http://a/v1");
}

console.log("用户改动后，再次挂载不该被旧值覆盖：");
{
    updateSettings(
        {
            apis: [{ ...activeApi(snapshot()), baseURL: "http://改过了/v1" }],
        },
        () => {}
    );
    check("改动生效", activeApi(snapshot()).baseURL, "http://改过了/v1");

    // 模拟面板第二次挂载：此时 isInitialized() 为 true，不该再调 initSettings
    const before = activeApi(snapshot()).baseURL;
    if (!isInitialized()) initSettings(saved);
    check("重新挂载后仍是改过的值", activeApi(snapshot()).baseURL, before);
}

console.log("空配置的兜底：");
{
    initSettings(null);
    check("至少留一套 API", snapshot().apis.length >= 1, true);
    check("当前 API 指向存在的那个", !!activeApi(snapshot()).id, true);
    check("没 id 时不会崩", typeof activeApi(snapshot()).name, "string");
}

console.log("损坏数据：");
{
    initSettings({ apis: [] });
    check("空数组也兜底出一套", snapshot().apis.length, 1);
    initSettings({ apis: "不是数组" });
    check("非数组也兜底", snapshot().apis.length, 1);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
