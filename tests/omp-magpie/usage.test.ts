import assert from "node:assert/strict";
import test from "node:test";
import type { UsageFetchParams, UsageFetchContext } from "@oh-my-pi/pi-ai/usage";
import { GatewayError } from "../../plugins/omp-magpie/src/gateway.ts";
import { createUsageProvider, normalizeUsage, type UsageBinding } from "../../plugins/omp-magpie/src/usage.ts";

const identity = { providerId: "my-magpie", bindingId: "opaque-binding" };
const params: UsageFetchParams = { provider: identity.providerId, credential: { type: "api_key", apiKey: "gateway-test-key" } };
function quotas(...data: unknown[]) { return { object: "list", data }; }

test("百分数保留超额及服务端时区，窗口标识不随 reset 变化", () => {
	const card = { provider: "office/codex", from: "remote", user: "fixture-user", alias: "work", plan: "pro", windows: [{ name: "5h", pool: "main", used: 125, remaining: -25, resetsAt: "2026-10-25T12:00:00+08:00" }] };
	const report = normalizeUsage(identity, quotas(card), undefined, 12);
	assert.equal(report.provider, identity.providerId);
	assert.deepEqual(report.metadata, { accountId: identity.bindingId });
	const row = report.limits[0]!;
	assert.equal(row.scope.provider, identity.providerId);
	assert.equal(row.scope.accountId, JSON.stringify([identity.bindingId, "office/codex", "", "fixture-user", "work", "", "pro", "", "remote"]));
	assert.deepEqual(row.amount, { unit: "percent", used: 125, limit: 100, remaining: -25, usedFraction: 1.25, remainingFraction: -0.25 });
	assert.equal(row.status, "exhausted");
	assert.equal(row.window?.resetsAt, Date.parse("2026-10-25T12:00:00+08:00"));
	const changed = normalizeUsage(identity, quotas({ ...card, windows: [{ ...card.windows[0], resetsAt: "bad" }] }), undefined, 13).limits[0]!;
	assert.equal(changed.id, row.id);
	assert.equal(changed.window?.resetsAt, undefined);
	assert.match(row.label, /office\/codex.*remote/);
});

test("实际数量保留百分比，缺省 amount 为零，未知单位注明原值", () => {
	const report = normalizeUsage(identity, quotas({ windows: [{ name: "tokens", used: 20, remaining: 80, limit: 200, amount: 30, unit: "tokens" }, { name: "custom", used: 0, remaining: 100, limit: 5, unit: "seats" }] }), undefined, 0);
	assert.deepEqual(report.limits[0]!.amount, { unit: "tokens", used: 30, limit: 200, remaining: 170, usedFraction: 0.2, remainingFraction: 0.8 });
	assert.equal(report.limits[1]!.amount.used, 0);
	assert.equal(report.limits[1]!.amount.unit, "unknown");
	assert.match(report.limits[1]!.notes!.join(), /seats/);
});

test("相同账号与同名窗口具有不同标识且不同凭据隔离", () => {
	const card = { provider: "office/codex", windows: [{ name: "day", used: 1 }, { name: "day", used: 2 }] };
	const report = normalizeUsage(identity, quotas(card, card), undefined, 0);
	assert.equal(new Set(report.limits.map(row => row.id)).size, 4);
	assert.notEqual(report.limits[0]!.scope.accountId, report.limits[2]!.scope.accountId);
	const other = normalizeUsage({ ...identity, bindingId: "other" }, quotas(card), undefined, 0);
	assert.notEqual(report.limits[0]!.scope.accountId, other.limits[0]!.scope.accountId);
});

test("余额严格解析完整币种片段，保留构成但不叠加或伪造百分比", () => {
	const report = normalizeUsage(identity, quotas({ balance: "$12.50 · CNY 8 · USD 2 · about $30", balanceSplit: "$4 promotional + $8.50 paid", windows: null }), undefined, 0);
	assert.equal(report.limits.length, 4);
	assert.deepEqual(report.limits[0]!.amount, { unit: "usd", remaining: 12.5 });
	assert.deepEqual(report.limits[1]!.amount, { unit: "unknown", remaining: 8 });
	assert.deepEqual(report.limits[2]!.amount, { unit: "usd", remaining: 2 });
	assert.deepEqual(report.limits[3]!.amount, { unit: "unknown" });
	assert.match(report.limits[0]!.notes!.join(), /不与总额相加/);
	assert.match(report.limits[1]!.label, /CNY/);
});

test("错误旧值保留但标 unknown，并显示读取时间与延迟", () => {
	const report = normalizeUsage(identity, quotas({ error: "upstream unavailable", readAt: "2026-10-24", asOf: "2026-10-23", readDeferred: true, windows: [{ name: "day", used: 40, remaining: 60 }] }), undefined, 0);
	assert.equal(report.limits[0]!.status, "unknown");
	assert.equal(report.limits[0]!.amount.used, 40);
	assert.match(report.limits[0]!.notes!.join(), /旧读数.*readAt.*asOf.*延迟/);
	const noWindows = normalizeUsage(identity, quotas({ error: "offline", windows: null }), undefined, 0);
	assert.equal(noWindows.limits[0]!.status, "unknown");
	assert.match(noWindows.limits[0]!.notes!.join(), /offline/);
});

test("无限额和空数组始终输出无数值行", () => {
	const unlimited = normalizeUsage(identity, quotas({ windows: [{ name: "day", unlimited: true, used: 0, remaining: 100 }] }), undefined, 0).limits[0]!;
	assert.deepEqual(unlimited.amount, { unit: "unknown" });
	assert.equal(unlimited.status, "ok");
	assert.match(unlimited.label, /不限额/);
	for (const payload of [quotas(), quotas({ windows: null })]) {
		const empty = normalizeUsage(identity, payload, undefined, 0).limits[0]!;
		assert.deepEqual(empty.amount, { unit: "unknown" });
		assert.equal(empty.status, "unknown");
		assert.match(empty.notes!.join(), /没有可展示的配额/);
	}
});

test("多预算优先完整 limits 且 tokens 与美元分别展示", () => {
	const budget = { period: "day", day: 1, tokenLimit: 100, tokens: 120, tokensLeft: -20, costLimit: 5, cost: 2, costLeft: 3, reset: "2026-10-26T00:00:00Z", start: "2026-10-25", unpriced: 2, inFlight: 1, reserved: 9, reservedCost: 0.5 };
	const report = normalizeUsage(identity, quotas(), { limited: true, limits: [budget, { period: "week", tokenLimit: 1000, tokens: 10 }], limit: budget }, 0);
	assert.equal(report.limits.length, 3);
	assert.equal(report.limits[0]!.amount.used, 120);
	assert.equal(report.limits[0]!.status, "exhausted");
	assert.equal(report.limits[1]!.amount.unit, "usd");
	assert.equal(report.limits[1]!.amount.used, 2);
	assert.equal(report.limits[0]!.window?.resetsAt, Date.parse(budget.reset));
	assert.match(report.limits[0]!.notes!.join(), /start.*unpriced.*inFlight.*reserved.*reservedCost/);
	assert.equal(normalizeUsage(identity, quotas(), { limit: budget }, 0).limits.length, 2);
	assert.deepEqual(normalizeUsage(identity, quotas(), { limited: false }, 0).limits[0]!.amount, { unit: "unknown" });
	assert.match(normalizeUsage(identity, quotas(), { limited: false }, 0).limits[0]!.label, /当前 key 未设置预算/);
});

test("多个小时和天预算保留可区分的长度及服务端 reset", () => {
	const reset = "2031-01-02T03:04:05Z";
	const report = normalizeUsage(identity, quotas(), { limited: true, limits: [
		{ period: "hours", hours: 5, tokenLimit: 100, reset },
		{ period: "hours", hours: 24, tokenLimit: 200, reset },
		{ period: "days", days: 7, tokenLimit: 300, reset },
	] }, 0);
	assert.deepEqual(report.limits.map(limit => limit.window?.durationMs), [18_000_000, 86_400_000, 604_800_000]);
	assert.equal(new Set(report.limits.map(limit => limit.window?.label)).size, 3);
	for (const [index, count] of [5, 24, 7].entries()) {
		assert.ok(report.limits[index]!.label.includes(String(count)));
		assert.equal(report.limits[index]!.window?.resetsAt, Date.parse(reset));
	}
});

test("quota 403 保留预算，所有失败也产生具体 unknown 报告", () => {
	const report = normalizeUsage(identity, new GatewayError("permission", "denied", 403), { limit: { tokenLimit: 10, tokens: 2 } }, 0);
	assert.equal(report.limits[0]!.amount.used, 2);
	assert.match(report.notes!.join(), /没有订阅额度查看权限/);
	for (const [status, expected] of [[401, /网关认证失败/], [404, /接口不支持/]] as const) {
		const failed = normalizeUsage(identity, new GatewayError("auth", "failure", status), new Error("invalid JSON"), 0);
		assert.equal(failed.limits[0]!.status, "unknown");
		assert.match(failed.notes!.join(), expected);
		assert.match(failed.notes!.join(), /invalid JSON/);
	}
	assert.match(normalizeUsage(identity, [], undefined, 0).notes!.join(), /响应格式无效/);
});

function setup(apiKey: string | undefined = "gateway-test-key") {
	const controller = new AbortController();
	let current: UsageBinding | undefined = { identity, root: "http://127.0.0.1:3425/prefix", apiKey, collectorKey: apiKey ?? "__omp_magpie_usage_local__", signal: controller.signal };
	let check: (input: UsageFetchParams) => Promise<UsageBinding | undefined> = async () => current;
	const provider = createUsageProvider({ providerId: identity.providerId, current: () => current, check: input => check(input) });
	return { controller, provider, get current() { return current; }, set current(value) { current = value; }, set check(value: (input: UsageFetchParams) => Promise<UsageBinding | undefined>) { check = value; } };
}

test("supports 同步筛选活动 API-key 绑定，凭据身份留给异步核对", () => {
	const fixture = setup();
	assert.equal(fixture.provider.supports!(params), true);
	assert.equal(fixture.provider.supports!({ ...params, credential: { type: "oauth", apiKey: params.credential.apiKey } }), false);
	fixture.controller.abort();
	assert.equal(fixture.provider.supports!(params), false);
	fixture.current = undefined;
	assert.equal(fixture.provider.supports!(params), false);
});

test("collector 已产生新 key 时仍进入 check，核对后用新身份读取", async () => {
	const fixture = setup();
	const next = { ...params, credential: { type: "api_key" as const, apiKey: "rotated-key" } };
	fixture.check = async () => {
		fixture.controller.abort();
		fixture.current = { ...fixture.current!, apiKey: "rotated-key", collectorKey: "rotated-key", signal: new AbortController().signal };
		return fixture.current;
	};
	assert.equal(fixture.provider.supports!(next), true);
	const report = await fixture.provider.fetchUsage(next, { fetch: async (_url, init) => {
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-key");
		return Response.json(quotas({ windows: [{ name: "day", used: 20 }] }));
	} });
	assert.equal(report!.limits[0]!.amount.used, 20);
});

test("每次读取先 await check，独立并发请求并保留 quota 403 的预算", async () => {
	const fixture = setup();
	let checked = false;
	fixture.check = async () => { await Promise.resolve(); checked = true; return fixture.current; };
	const paths: string[] = [];
	// quota 只有在预算请求也发出后才返回，避免串行实现仍被立即完成的 mock 放行。
	const { promise: quotaReady, resolve: finishQuota } = Promise.withResolvers<void>();
	const context: UsageFetchContext = { fetch: async (url, init) => {
		assert.equal(checked, true);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gateway-test-key");
		paths.push(String(url));
		if (String(url).endsWith("/quotas")) { await quotaReady; return new Response("{}", { status: 403 }); }
		finishQuota();
		return Response.json({ limit: { costLimit: 5, cost: 1 } });
	} };
	const report = await fixture.provider.fetchUsage(params, context);
	assert.equal(paths.length, 2);
	assert.ok(paths.every(path => path.includes("/prefix/v1/magpie/")));
	assert.equal(report?.limits[0]!.amount.used, 1);
	assert.match(report!.notes!.join(), /没有订阅额度查看权限/);
});

test("过期请求身份不发 HTTP，读取期间换绑定或取消丢弃结果", async () => {
	const fixture = setup();
	fixture.check = async () => undefined;
	const context: UsageFetchContext = { fetch: async () => { throw new Error("不应调用"); } };
	assert.equal(await fixture.provider.fetchUsage(params, context), null);
	fixture.check = async () => fixture.current;
	// 挂起 HTTP 后换身份，明确验证迟到响应被丢弃，而不是只检查一次入口状态。
	const { promise: waiting, resolve: release } = Promise.withResolvers<void>();
	const inflight = fixture.provider.fetchUsage(params, { fetch: async () => { await waiting; return Response.json(quotas()); } });
	await Promise.resolve();
	fixture.current = { ...fixture.current!, identity: { ...identity, bindingId: "new" } };
	release();
	assert.equal(await inflight, null);
	const cancel = new AbortController();
	const cancelled = fixture.provider.fetchUsage({ ...params, signal: cancel.signal }, { fetch: async () => { cancel.abort(); return Response.json(quotas()); } });
	assert.equal(await cancelled, null);
});

test("keyless marker 只匹配本地绑定且不作为 Bearer，不沿用 previousReport", async () => {
	const fixture = setup();
	fixture.current = { ...fixture.current!, apiKey: undefined, collectorKey: "__omp_magpie_usage_local__" };
	const input = { ...params, credential: { type: "api_key" as const, apiKey: "__omp_magpie_usage_local__" } };
	assert.equal(fixture.provider.supports!(input), true);
	const report = await fixture.provider.fetchUsage(input, { previousReport: normalizeUsage(identity, quotas({ windows: [{ name: "old", used: 88 }] }), undefined, 0), fetch: async (url, init) => {
		assert.ok(String(url).endsWith("/quotas"));
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		return Response.json(quotas());
	} });
	assert.equal(report!.limits[0]!.amount.used, undefined);
	assert.equal(report!.limits[0]!.status, "unknown");
	assert.equal(setup().provider.supports!(input), false);
});

test("预算失败保留订阅窗口，服务端回显密钥在返回前脱敏", async () => {
	const fixture = setup();
	const report = await fixture.provider.fetchUsage(params, { fetch: async url => {
		if (String(url).endsWith("/limit")) return new Response("{}", { status: 404 });
		return Response.json(quotas({ user: "gateway-test-key", windows: [{ name: "day", used: 15, remaining: 85 }] }));
	} });
	assert.equal(report!.limits[0]!.amount.used, 15);
	assert.equal(report!.limits[0]!.status, "ok");
	assert.match(report!.notes!.join(), /接口不支持/);
	assert.equal(JSON.stringify(report).includes("gateway-test-key"), false);
});

test("最新凭据已核对时采用新绑定 signal，旧 controller 不会取消新读取", async () => {
	const fixture = setup();
	const oldController = fixture.controller;
	const replacement = new AbortController();
	fixture.current = { ...fixture.current!, signal: replacement.signal };
	oldController.abort();
	const report = await fixture.provider.fetchUsage(params, { fetch: async (_url, init) => {
		assert.equal(init?.signal?.aborted, false);
		return Response.json(quotas());
	} });
	assert.ok(report);
});
