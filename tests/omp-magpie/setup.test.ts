import assert from "node:assert/strict";
import test from "node:test";
import type { AuthSource } from "@oh-my-pi/pi-ai/auth-storage";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ConnectionConfig, PluginConfig } from "../../plugins/omp-magpie/src/config.ts";
import { parseSetupArgs, prefillSetupConnection, runSetup, type SetupServices } from "../../plugins/omp-magpie/src/setup.ts";

test("setup 参数区分交互、只读列表、预览与显式确认", () => {
	assert.deepEqual(parseSetupArgs(""), { action: "setup", providerId: undefined, yes: false });
	assert.deepEqual(parseSetupArgs(" setup "), parseSetupArgs(""));
	assert.deepEqual(parseSetupArgs("setup --list"), { action: "list" });
	for (const command of ["help", "--help", "-h", "setup --help"]) assert.deepEqual(parseSetupArgs(command), { action: "help" });
	assert.deepEqual(parseSetupArgs("setup --provider existing"), { action: "setup", providerId: "existing", yes: false });
	assert.deepEqual(parseSetupArgs("setup --yes --provider existing"), { action: "setup", providerId: "existing", yes: true });
});

test("未知参数、缺值和重复参数均被拒绝且不回显误传秘密", () => {
	for (const args of [
		"setup --unknown fixture-secret", "setup --provider", "setup --provider --yes", "setup --yes", "setup --provider a/b",
		"setup --list --yes", "setup --list --provider a", "setup --provider a --provider b", "setup --yes --yes --provider a",
		"help fixture-secret",
	]) {
		assert.throws(() => parseSetupArgs(args), error => error instanceof Error && error.message.startsWith("omp-magpie:") && !error.message.includes("fixture-secret"));
	}
});

test("预填使用当前规范 root，普通附加不复制地址或其他连接的创建声明", () => {
	const unrelated: ConnectionConfig = { providerId: "other", createProvider: true, baseUrl: "http://localhost/other" };
	const result = prefillSetupConnection("existing", unrelated, "http://localhost/proxy/v1");
	assert.deepEqual(result.connection, { providerId: "existing", createProvider: false });
	assert.equal(result.root, "http://localhost/proxy/v1");
	assert.equal(result.gatewayIssue, undefined);
});

test("已有创建声明仍可保存，但 bootstrap root 不能覆盖 provider 摘要或补缺 endpoint", () => {
	const existing: ConnectionConfig = { providerId: "existing", createProvider: true, baseUrl: "https://bootstrap.invalid/old" };
	const result = prefillSetupConnection("existing", existing, "https://current.invalid/proxy/v1");
	assert.deepEqual(result.connection, existing);
	assert.equal(result.root, "https://current.invalid/proxy/v1");
	assert.equal(result.gatewayIssue, undefined);
	const missing = prefillSetupConnection("existing", existing, undefined);
	assert.equal(missing.root, undefined);
	assert.match(missing.gatewayIssue!, /OMP 模型配置.*endpoint/);
	assert.ok(!missing.gatewayIssue!.includes("bootstrap.invalid"));
});

/** 模拟宿主目录与确认界面；认证 getter 会抛错，以保证预览只读来源、不解析密钥。 */
function setupFixture(options: { hasUI?: boolean; connections?: ConnectionConfig[]; answers?: (string | undefined)[] } = {}) {
	const config: PluginConfig = { autoAttach: false, connections: options.connections ?? [] };
	const state = {
		endpoint: "https://current.invalid/proxy/v1/v1" as string | undefined,
		providerExists: true,
		discovery: false,
		source: { kind: "api_key", concrete: true } as AuthSource | undefined,
		issue: undefined as string | undefined,
	};
	const outputs: string[] = [];
	const saved: ConnectionConfig[] = [];
	const prompts: { title: string; choices: unknown[] }[] = [];
	const answers = [...(options.answers ?? [])];
	const models = () => state.providerExists && state.endpoint ? [{ provider: "existing", api: "openai-completions", baseUrl: state.endpoint }] : [];
	const ctx = {
		cwd: "/fixture/project",
		hasUI: options.hasUI ?? false,
		modelRegistry: {
			getAll: models,
			getProviderModels: (id: string) => id === "existing" ? models() : [],
			getDiscoverableProviders: () => state.discovery ? ["existing"] : [],
			getDiscoveryProviderId: (id: string) => id === "existing" && state.discovery ? id : undefined,
			hasProvider: (id: string) => id === "existing" && state.providerExists,
			getProviderBaseUrl: (id: string) => id === "existing" && (state.providerExists || state.discovery) ? state.endpoint : undefined,
			authStorage: {
				keys: {
					source: (id: string) => id === "existing" ? state.source : undefined,
					get get() { throw new Error("setup 不得解析认证密钥"); },
					get peek() { throw new Error("setup 不得预读认证密钥"); },
				},
				get credentials() { throw new Error("setup 不得读取已存凭据"); },
			},
		},
		ui: {
			select: async (title: string, choices: unknown[]) => {
				prompts.push({ title, choices });
				return answers.shift();
			},
			get editor() { throw new Error("setup 不得编辑 OMP 地址"); },
		},
	} as unknown as ExtensionContext;
	const services: SetupServices = {
		load: async () => config,
		issue: () => state.issue,
		save: async (_ctx, connection) => { saved.push(connection); },
		output: (_ctx, text) => { outputs.push(text); },
	};
	return { ctx, services, config, state, outputs, saved, prompts };
}

test("CLI 列表、预览和无参数用法只读", async () => {
	const fixture = setupFixture();
	await runSetup("--list", fixture.ctx, fixture.services);
	assert.match(fixture.outputs.join("\n"), /existing/);
	await runSetup("--provider existing", fixture.ctx, fixture.services);
	assert.match(fixture.outputs.join("\n"), /https:\/\/current.invalid\/proxy\/v1/);
	await runSetup("", fixture.ctx, fixture.services);
	assert.deepEqual(fixture.saved, []);
});

test("CLI 显式确认提交普通附加连接", async () => {
	const fixture = setupFixture();
	await runSetup("--provider existing --yes", fixture.ctx, fixture.services);
	assert.deepEqual(fixture.saved, [{ providerId: "existing", createProvider: false }]);
});

test("OMP 地址与认证来源变更后摘要立即跟随，保存仍保留原 bootstrap 声明", async () => {
	const bootstrap: ConnectionConfig = { providerId: "existing", createProvider: true, baseUrl: "https://bootstrap.invalid/old" };
	const fixture = setupFixture({ connections: [bootstrap] });
	await runSetup("--provider existing", fixture.ctx, fixture.services);
	assert.match(fixture.outputs.join("\n"), /current.invalid\/proxy\/v1/);
	assert.match(fixture.outputs.join("\n"), /宿主已保存的 API key/);
	fixture.state.endpoint = "https://updated.invalid/new-prefix/v1/v1";
	fixture.state.source = { kind: "env", envVar: "OMP_GATEWAY_KEY", concrete: true };
	fixture.outputs.length = 0;
	await runSetup("--provider existing --yes", fixture.ctx, fixture.services);
	assert.match(fixture.outputs.join("\n"), /https:\/\/updated.invalid\/new-prefix\/v1/);
	assert.match(fixture.outputs.join("\n"), /OMP_GATEWAY_KEY/);
	assert.ok(!fixture.outputs.join("\n").includes("bootstrap.invalid"));
	assert.ok(!fixture.outputs.join("\n").includes("current.invalid"));
	assert.deepEqual(fixture.saved, [bootstrap]);
});

test("未知 provider、缺失或无效 endpoint 和资格异常不能确认保存", async () => {
	for (const hasUI of [false, true]) {
		for (const endpoint of [undefined, "https://user:fixture-secret@localhost/v1", "https://localhost/v1?key=fixture-secret"]) {
			const fixture = setupFixture({ hasUI, answers: ["确认连接"], connections: [{ providerId: "existing", createProvider: true, baseUrl: "https://bootstrap.invalid" }] });
			fixture.state.endpoint = endpoint;
			await runSetup("--provider existing --yes", fixture.ctx, fixture.services);
			assert.match(fixture.outputs.join("\n"), /OMP 模型配置/);
			assert.ok(!fixture.outputs.join("\n").includes("fixture-secret"));
			assert.deepEqual(fixture.saved, []);
			assert.deepEqual(fixture.prompts, []);
		}
		const unknown = setupFixture({ hasUI, answers: ["确认连接"], connections: [{ providerId: "missing", createProvider: true, baseUrl: "https://bootstrap.invalid" }] });
		await runSetup("--provider missing --yes", unknown.ctx, unknown.services);
		assert.match(unknown.outputs.join("\n"), /provider 不存在.*OMP 模型配置/);
		assert.deepEqual(unknown.saved, []);
		const ineligible = setupFixture({ hasUI, answers: ["确认连接"] });
		ineligible.state.issue = "宿主 OAuth 不符合附加资格";
		await runSetup("--provider existing --yes", ineligible.ctx, ineligible.services);
		assert.match(ineligible.outputs.join("\n"), /OAuth/);
		assert.deepEqual(ineligible.saved, []);
	}
});

test("TUI 摘要只有确认和取消，取消与关闭都不保存", async () => {
	for (const answer of ["取消", undefined, "确认连接"]) {
		const fixture = setupFixture({ hasUI: true, answers: [answer] });
		await runSetup("--provider existing", fixture.ctx, fixture.services);
		assert.equal(fixture.prompts.length, 1);
		assert.deepEqual(fixture.prompts[0]!.choices, ["确认连接", "取消"]);
		assert.match(fixture.prompts[0]!.title, /https:\/\/current.invalid\/proxy\/v1/);
		assert.deepEqual(fixture.saved, answer === "确认连接" ? [{ providerId: "existing", createProvider: false }] : []);
	}
});

test("TUI 选择已有 provider 后仍需确认，退出候选选择不保存", async () => {
	const fixture = setupFixture({ hasUI: true, answers: ["existing", "确认连接"] });
	await runSetup("", fixture.ctx, fixture.services);
	assert.equal(fixture.prompts.length, 2);
	assert.deepEqual(fixture.saved, [{ providerId: "existing", createProvider: false }]);
	const cancelled = setupFixture({ hasUI: true });
	await runSetup("", cancelled.ctx, cancelled.services);
	assert.deepEqual(cancelled.saved, []);
});

test("已有零模型 discovery provider 可确认附加，认证只展示来源", async () => {
	const fixture = setupFixture();
	fixture.state.providerExists = false;
	fixture.state.discovery = true;
	fixture.state.source = { kind: "config", concrete: false };
	await runSetup("--provider existing --yes", fixture.ctx, fixture.services);
	assert.match(fixture.outputs.join("\n"), /认证来源：宿主配置认证/);
	assert.deepEqual(fixture.saved, [{ providerId: "existing", createProvider: false }]);
});

test("配置加载期间取消不会展示新界面或执行显式保存", async () => {
	const fixture = setupFixture();
	const controller = new AbortController();
	const loading = Promise.withResolvers<PluginConfig>();
	fixture.services.signal = controller.signal;
	fixture.services.load = () => loading.promise;
	const pending = runSetup("--provider existing --yes", fixture.ctx, fixture.services);
	controller.abort();
	loading.resolve(fixture.config);
	await assert.rejects(pending, { name: "AbortError" });
	assert.deepEqual(fixture.saved, []);
	assert.deepEqual(fixture.outputs, []);
	assert.deepEqual(fixture.prompts, []);
});

test("确认框忽略取消并迟到返回确认时仍不保存", async () => {
	const fixture = setupFixture({ hasUI: true });
	const controller = new AbortController();
	const presented = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<string>();
	fixture.services.signal = controller.signal;
	fixture.ctx.ui.select = async (_title, _choices, options) => {
		assert.equal(options?.signal, controller.signal);
		presented.resolve();
		return answer.promise;
	};
	const pending = runSetup("--provider existing", fixture.ctx, fixture.services);
	await presented.promise;
	controller.abort();
	answer.resolve("确认连接");
	await assert.rejects(pending, { name: "AbortError" });
	assert.deepEqual(fixture.saved, []);
	assert.deepEqual(fixture.outputs, []);
});

test("候选选择或手动输入迟到返回时取消流程不再进入确认", async () => {
	for (const stage of ["select", "input"] as const) {
		const fixture = setupFixture({ hasUI: true });
		const controller = new AbortController();
		const presented = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<string>();
		let selections = 0;
		fixture.services.signal = controller.signal;
		fixture.ctx.ui.select = async (_title, _choices, options) => {
			assert.equal(options?.signal, controller.signal);
			selections++;
			assert.equal(selections, 1, "取消后不应继续展示确认框");
			if (stage === "input") return "手动输入 provider ID";
			presented.resolve();
			return answer.promise;
		};
		fixture.ctx.ui.input = async (_title, _placeholder, options) => {
			assert.equal(stage, "input");
			assert.equal(options?.signal, controller.signal);
			presented.resolve();
			return answer.promise;
		};
		const pending = runSetup("", fixture.ctx, fixture.services);
		await presented.promise;
		controller.abort();
		answer.resolve("existing");
		await assert.rejects(pending, { name: "AbortError" });
		assert.equal(selections, 1);
		assert.deepEqual(fixture.saved, []);
	}
});
