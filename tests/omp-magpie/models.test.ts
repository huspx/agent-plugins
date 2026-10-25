import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { mapCatalog } from "../../plugins/omp-magpie/src/models.ts";

const root = "https://gateway.example/prefix";
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const base = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const extended = { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 };
const tier = { above: 100, input: 10, output: 20, cache_read: 1, cache_write: 12.5 };

function catalog(rows: Record<string, unknown>[], retained = new Map<string, Model<Api>["cost"]>()) {
	return mapCatalog({ object: "list", data: rows.map(row => ({ object: "model", id: "model", context_window: 1000, max_output_tokens: 200, ...row })) }, root, retained);
}

test("三种协议按明确端点优先级保留 prefix 与原始模型 ID", () => {
	const result = catalog([
		{ id: "p/claude", native_endpoints: ["/v1/responses", "/v1/messages"], magpie_label: "服务端标签", display_name: "显示名" },
		{ id: "p/responses", native_endpoints: ["/v1/responses"] },
		{ id: "claude-name-without-endpoint" },
	]);
	assert.deepEqual(result.models.map(({ id, api, baseUrl }) => ({ id, api, baseUrl })), [
		{ id: "p/claude", api: "anthropic-messages", baseUrl: `${root}/v1` },
		{ id: "p/responses", api: "openai-responses", baseUrl: `${root}/v1` },
		{ id: "claude-name-without-endpoint", api: "openai-completions", baseUrl: `${root}/v1` },
	]);
	assert.equal(result.models[0]!.name, "服务端标签");
});

test("只保留聊天模型对象与 text/image 输入模态", () => {
	const result = catalog([
		{ id: "default" }, { id: "chat", type: "chat", modalities: { input: ["image", "text", "audio", "image"] } },
		{ id: "image", kind: "image" }, { id: "video", kind: "video" }, { id: "decision", kind: "decision" },
		{ id: "embedding", type: "embedding" }, { id: "wrong-object", object: "not-model" }, { id: "" },
	]);
	assert.deepEqual(result.models.map(model => model.id), ["default", "chat"]);
	assert.deepEqual(result.models[0]!.input, ["text"]);
	assert.deepEqual(result.models[1]!.input, ["image", "text"]);
	assert.match(result.diagnostics.join("\n"), /有效 id/);
});

test("上下文取首个有效正整数，缺必要上限跳过", () => {
	const result = catalog([
		{ id: "fallback", context_window: -1, context_length: 2000 },
		{ id: "missing-context", context_window: undefined },
		{ id: "missing-output", max_output_tokens: undefined },
		{ id: "fraction", context_window: 2.5 },
		{ id: "unsafe", context_window: Number.MAX_SAFE_INTEGER + 1 },
	]);
	assert.deepEqual(result.models.map(model => [model.id, model.contextWindow, model.maxTokens]), [["fallback", 2000, 200]]);
	assert.match(result.diagnostics.join("\n"), /missing-context.*contextWindow/);
	assert.match(result.diagnostics.join("\n"), /missing-output.*maxTokens/);
});

test("OpenAI effort 取交集去重排序，Anthropic 不推断 thinking 模式", () => {
	const result = catalog([
		{ id: "structured", reasoning: true, supported_reasoning_levels: [{ effort: "max" }, { effort: "low" }, { effort: "low" }, { effort: "unknown" }] },
		{ id: "flat", reasoning: true, reasoning_levels: ["xhigh", "minimal", "medium", "high"] },
		{ id: "anthropic", reasoning: true, native_endpoints: ["/v1/messages"], reasoning_levels: ["high"] },
		{ id: "not-boolean", reasoning: "true" },
	]);
	assert.deepEqual(result.models[0]!.thinking, { mode: "effort", efforts: ["low", "max"] });
	assert.deepEqual(result.models[1]!.thinking, { mode: "effort", efforts: ["minimal", "medium", "high", "xhigh"] });
	assert.equal(result.models[2]!.thinking, undefined);
	assert.equal(result.models[2]!.reasoning, true);
	assert.equal(result.models[3]!.reasoning, false);
});

test("标准 pricing 由 USD/token 转换成每百万费率并优先于扩展", () => {
	const result = catalog([{ pricing: { prompt: "0.0000003", completion: "0.000002", input_cache_read: "0", input_cache_write: "0.0000001" }, magpie_price: extended }]);
	assert.deepEqual(result.models[0]!.cost, { input: 0.3, output: 2, cacheRead: 0, cacheWrite: 0.1 });
	assert.match(result.diagnostics.join("\n"), /不一致/);
	assert.deepEqual(catalog([{ pricing: { prompt: "0", completion: "0" }, magpie_price: extended }]).models[0]!.cost, zero);
});

test("缺价或无效价格保留模型并输出未知价卡，不伪造有效报价", () => {
	assert.deepEqual(catalog([{}]).models[0]!.cost, zero);
	for (const invalid of ["", " ", "1USD", "-1", "NaN", "Infinity", "1e-6", "0x10", 0, null, "9".repeat(310), "9".repeat(305)]) {
		const result = catalog([{ pricing: { prompt: invalid, completion: "0" } }]);
		assert.equal(result.models.length, 1);
		assert.deepEqual(result.models[0]!.cost, zero);
		assert.match(result.diagnostics.join("\n"), /pricing 价格无效/);
		assert.match(result.diagnostics.join("\n"), /未知/);
	}
	for (const pricing of [{ prompt: "0" }, { completion: "0" }, { prompt: "0", completion: "0", input_cache_read: "bad" }]) {
		assert.match(catalog([{ pricing }]).diagnostics.join("\n"), /pricing 价格无效/);
	}
});

test("无效标准报价回退完整扩展，扩展无效再回退当前绑定保留价卡", () => {
	assert.deepEqual(catalog([{ pricing: { prompt: "bad" }, magpie_price: extended }]).models[0]!.cost, base);
	// 保留值只来自当前绑定；完整新报价必须替换旧阶梯和时段价，避免拼出不同报价的混合价卡。
	const retained = { ...base, longContext: { inputThreshold: 100, ...zero }, timeBased: { offPeakMultiplier: 0.5, peakWindows: [] } };
	const result = catalog([{ magpie_price: { input: -1, output: 2 } }], new Map([["model", retained]]));
	assert.deepEqual(result.models[0]!.cost, retained);
	assert.match(result.diagnostics.join("\n"), /保留当前绑定/);
	assert.deepEqual(catalog([{ magpie_price: { input: 3, output: 4 } }], new Map([["model", retained]])).models[0]!.cost,
		{ input: 3, output: 4, cacheRead: 0, cacheWrite: 0 });
});

test("同报价单阶梯映射严格大于阈值，标准报价本身不臆造阶梯", () => {
	const result = catalog([{ pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001", input_cache_write: "0.00000125" }, magpie_price: { ...extended, tiers: [tier] } }]);
	assert.deepEqual(result.models[0]!.cost, { ...base, longContext: { inputThreshold: 100, input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 } });
	assert.equal(catalog([{ pricing: { prompt: "0.000001", completion: "0.000002" } }]).models[0]!.cost.longContext, undefined);
});

test("多阶梯、非法阶梯与一小时缓存保留基础估价并诊断范围", () => {
	for (const tiers of [[tier, { ...tier, above: 200 }], [{ ...tier, above: 0 }], [{ ...tier, input: -1 }], "invalid"]) {
		const result = catalog([{ magpie_price: { ...extended, tiers } }]);
		assert.deepEqual(result.models[0]!.cost, base);
		assert.match(result.diagnostics.join("\n"), /基础价格/);
	}
	const result = catalog([{ magpie_price: { ...extended, cache_write_1h: 2, tiers: [{ ...tier, cache_write_1h: 20 }] } }]);
	assert.equal(result.models[0]!.cost.longContext!.input, 10);
	assert.match(result.diagnostics.join("\n"), /1 小时缓存/);
});

test("目录结构错误返回诊断和空模型数组", () => {
	for (const payload of [null, [], {}, { data: [] }, { object: "list", data: null }]) {
		const result = mapCatalog(payload, root, new Map());
		assert.deepEqual(result.models, []);
		assert.match(result.diagnostics.join("\n"), /模型目录无效/);
	}
});
