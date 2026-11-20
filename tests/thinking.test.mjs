/**
 * 阶段二：多协议 + 思考档位
 * 每个测试都对应一个真实会出错的行为。
 */
import { THINKING_LEVELS, supportsThinking, effortFor, anthropicEffort } from "../.test/thinking.js";

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

console.log("思考档位：");
check("六档齐全且顺序正确", THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "max"]);

console.log("哪些模型能思考：");
check("glm-5.3 能", supportsThinking("glm-5.3"), true);
check("带前缀的 glm 也能", supportsThinking("pool/glm-5.3"), true);
check("GLM 大写也能", supportsThinking("GLM-5.3"), true);
check("deepseek-reasoner 能", supportsThinking("deepseek-reasoner"), true);
check("kimi 能", supportsThinking("kimi-k3"), true);
check("claude 能", supportsThinking("claude-sonnet-4-5"), true);
check("gpt-5 能", supportsThinking("gpt-5.4"), true);
check("未知模型不能", supportsThinking("some-random-model"), false);

console.log("发给 OpenAI 兼容接口的档位：");
check("off 必须降级成 low（这个中转站关不掉）", effortFor("glm-5.3", "off"), "low");
check("minimal 也给 low（glm 只有 low/high/max）", effortFor("glm-5.3", "minimal"), "low");
check("low 原样", effortFor("glm-5.3", "low"), "low");
check("medium 升到 high（glm 没有 medium）", effortFor("glm-5.3", "medium"), "high");
check("high 原样", effortFor("glm-5.3", "high"), "high");
check("max 原样", effortFor("glm-5.3", "max"), "max");

check("deepseek 只有 high/max，low 升到 high", effortFor("deepseek-reasoner", "low"), "high");
check("deepseek medium 升到 high", effortFor("deepseek-reasoner", "medium"), "high");

check("未知模型不发档位", effortFor("some-random-model", "high"), undefined);

console.log("发给 Claude 原生接口的档位：");
check("off 不发", anthropicEffort("off"), undefined);
check("low 给 low", anthropicEffort("low"), "low");
check("medium 给 medium", anthropicEffort("medium"), "medium");
check("high 给 high", anthropicEffort("high"), "high");
check("max 给 max", anthropicEffort("max"), "max");

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
