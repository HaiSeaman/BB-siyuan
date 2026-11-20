/**
 * 模板的增删改查与内置示例
 */
import {
    BUILTIN_TEMPLATES,
    createTemplate,
    normalizeTemplates,
    addTemplate,
    updateTemplate,
    removeTemplate,
    moveTemplate,
    findTemplate,
} from "../.test/templates-store.js";

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

console.log("内置示例：");
check("内置 3 个", BUILTIN_TEMPLATES.length, 3);
check("每个都有名字", BUILTIN_TEMPLATES.every((t) => t.name.length > 0), true);
check("每个都有正文", BUILTIN_TEMPLATES.every((t) => t.content.length > 0), true);
check("内置的 id 互不相同", new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size, 3);
check("内置模板不再使用 {{content}}", BUILTIN_TEMPLATES.every((t) => !t.content.includes("{{content}}")), true);

console.log("新建：");
{
    const t = createTemplate("我的模板", "正文", () => "fixed-id", () => 1);
    check("有 id", t.id, "fixed-id");
    check("有名字", t.name, "我的模板");
    check("有正文", t.content, "正文");
    check("有顺序", t.order, 1);
}
{
    const t = createTemplate("  前后有空格  ", "  正文  ", () => "x", () => 0);
    check("名字去掉首尾空格", t.name, "前后有空格");
    check("正文保留原样（里面有换行不能动）", t.content, "  正文  ");
}

console.log("清洗外部数据：");
check("null 得到内置示例", normalizeTemplates(null).length, 3);
check("空数组得到内置示例（不能出现空列表没法用）", normalizeTemplates([]).length, 3);
check("字符串输入也兜住", normalizeTemplates("abc").length, 3);
{
    const dirty = [
        { id: "a", name: "好的", content: "正文", order: 1, 多余字段: 1 },
        { name: "没有 id" },
        null,
        { id: "b", name: "", content: "x" },
    ];
    const clean = normalizeTemplates(dirty);
    check("脏数据被过滤，只剩一条", clean.length, 1);
    check("多余字段被丢掉", "多余字段" in clean[0], false);
    check("保留合法那条", clean[0].id, "a");
}

console.log("新增：");
{
    const list = normalizeTemplates([{ id: "a", name: "A", content: "1", order: 0 }]);
    const next = addTemplate(list, createTemplate("B", "2", () => "b", () => 0));
    check("数量加一", next.length, 2);
    check("新加的在最后", next[1].id, "b");
    check("order 自动排好", next.map((t) => t.order), [0, 1]);
}

console.log("更新：");
{
    const list = normalizeTemplates([{ id: "a", name: "A", content: "1", order: 0 }]);
    const next = updateTemplate(list, "a", { name: "改过的" });
    check("名字变了", next[0].name, "改过的");
    check("正文没动", next[0].content, "1");
    check("id 没变", next[0].id, "a");
    check("原数组没被改", list[0].name, "A");
}
{
    const list = normalizeTemplates([{ id: "a", name: "A", content: "1", order: 0 }]);
    const next = updateTemplate(list, "不存在", { name: "x" });
    check("改不存在的 id 不崩", next.length, 1);
}

console.log("删除：");
{
    const list = normalizeTemplates([
        { id: "a", name: "A", content: "1", order: 0 },
        { id: "b", name: "B", content: "2", order: 1 },
    ]);
    const next = removeTemplate(list, "a");
    check("删掉一条", next.length, 1);
    check("剩下的是 b", next[0].id, "b");
    check("顺序重排了", next[0].order, 0);
}

console.log("排序：");
{
    const list = normalizeTemplates([
        { id: "a", name: "A", content: "1", order: 0 },
        { id: "b", name: "B", content: "2", order: 1 },
        { id: "c", name: "C", content: "3", order: 2 },
    ]);
    const up = moveTemplate(list, "b", -1);
    check("b 上移后顺序", up.map((t) => t.id), ["b", "a", "c"]);
    const down = moveTemplate(list, "c", -1);
    check("c 上移后顺序", down.map((t) => t.id), ["a", "c", "b"]);
    const top = moveTemplate(list, "a", -1);
    check("第一条再上移不动", top.map((t) => t.id), ["a", "b", "c"]);
    const bottom = moveTemplate(list, "c", 1);
    check("最后一条再下移不动", bottom.map((t) => t.id), ["a", "b", "c"]);
}

console.log("查找：");
{
    const list = normalizeTemplates([{ id: "a", name: "A", content: "1", order: 0 }]);
    check("能找到", findTemplate(list, "a").name, "A");
    check("找不到返回 undefined", findTemplate(list, "zzz"), undefined);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
