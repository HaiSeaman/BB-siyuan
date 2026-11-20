/**
 * 网络层：解析器抛错时不能让流悬挂。
 * 用假的 fetch 验证：onDelta 抛错后，onEnd 必须被调用且只调用一次。
 */
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

/** 造一个假的流：依次吐出给定的文本块，然后结束 */
function fakeBody(chunks) {
    let i = 0;
    return {
        getReader() {
            return {
                async read() {
                    if (i >= chunks.length) return { done: true, value: undefined };
                    return { done: false, value: new TextEncoder().encode(chunks[i++]) };
                },
                async cancel() {
                    i = chunks.length;
                },
            };
        },
    };
}

// net.ts 依赖 window，这里造一个最小替代
globalThis.window = { siyuan: { config: { system: { dataDir: "D:/x" } } } };

const { streamChat } = await import("../.test/net.js");

function run(chunks, handlers, fakeOk = true) {
    globalThis.fetch = async () => ({
        ok: fakeOk,
        status: fakeOk ? 200 : 401,
        body: fakeOk ? fakeBody(chunks) : null,
        text: async () => "坏密钥",
    });
    return new Promise((resolve) => {
        const origEnd = handlers.onEnd;
        handlers.onEnd = (e) => {
            origEnd(e);
            resolve(e);
        };
        streamChat({ url: "http://x/v1/chat/completions", headers: {}, body: "{}" }, handlers);
    });
}

console.log("正常流：");
{
    const got = [];
    const err = await run(["a", "b"], { onDelta: (t) => got.push(t), onEnd: () => {} });
    check("收到两段", got, ["a", "b"]);
    check("正常结束没有错误", err, undefined);
}

console.log("解析抛错不能悬挂：");
{
    let endCount = 0;
    let endErr = null;
    const err = await run(
        ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: {"error":{"message":"额度用完了"}}\n\n'],
        {
            onDelta: (t) => {
                // 模拟上层解析器遇到错误
                if (t.includes("额度")) throw new Error("额度用完了");
            },
            onEnd: (e) => {
                endCount++;
                endErr = e;
            },
        }
    );
    check("onEnd 被调用了", endCount >= 1, true);
    check("onEnd 只调用一次", endCount, 1);
    check("错误传出来了", err, "额度用完了");
    check("endErr 一致", endErr, "额度用完了");
}

console.log("HTTP 错误：");
{
    let endCount = 0;
    const err = await run([], { onDelta: () => {}, onEnd: () => {} }, false);
    check("401 被报出来", /401/.test(err), true);
    check("带上响应体", /坏密钥/.test(err), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
