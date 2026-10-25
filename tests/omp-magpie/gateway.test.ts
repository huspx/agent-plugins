import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { fetchKeyLimits, fetchModels, fetchQuotas, GatewayError, identifyGateway, normalizeGatewayRoot, sanitizeDiagnostic } from "../../plugins/omp-magpie/src/gateway.ts";

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (root: string) => Promise<void>): Promise<void> {
	const server = createServer(handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try { await run(`http://127.0.0.1:${address.port}`); } finally {
		server.closeAllConnections();
		const closed = once(server, "close");
		server.close();
		await closed;
	}
}

const json = (response: ServerResponse, payload: unknown, status = 200) => {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(payload));
};

const hasKind = (kind: string, status?: number) => (error: unknown) => error instanceof GatewayError && error.kind === kind && (status === undefined || error.status === status);

test("规范 root 保留 prefix，只移除末尾版本路径", () => {
	assert.equal(normalizeGatewayRoot("http://localhost:3425/team/v1/"), "http://localhost:3425/team");
	assert.equal(normalizeGatewayRoot("https://example.test/team/v1beta"), "https://example.test/team");
	assert.equal(normalizeGatewayRoot("https://example.test/v1/team/"), "https://example.test/v1/team");
	for (const root of ["ftp://example.test", "http://user:pass@example.test", "http://example.test?q=1", "http://example.test#fragment", "http://example.test?", "bad-url"]) assert.throws(() => normalizeGatewayRoot(root), hasKind("protocol"));
});

test("真实 HTTP 保留 prefix、单一 Bearer、请求头与完整响应", async () => {
	const paths: string[] = [];
	const quotas = { object: "list", data: [{ provider: "office/codex", from: "upstream", user: "fixture", windows: [] }] };
	await fixture((request, response) => {
		paths.push(request.url!);
		assert.equal(request.method, "GET");
		assert.equal(request.headers.authorization, "Bearer fixture-key");
		assert.equal(request.headers.accept, "application/json");
		assert.equal(request.headers["user-agent"], "omp-magpie");
		if (request.url === "/team/v1") json(response, { name: "magpie", version: "0.1.fixture" });
		else if (request.url === "/team/v1/magpie/quotas") json(response, quotas);
		else if (request.url === "/team/v1/models") {
			assert.equal(request.headers["x-magpie-prices"], "1");
			json(response, { data: [] });
		} else json(response, { limited: false });
	}, async root => {
		const auth = { apiKey: "fixture-key" };
		assert.deepEqual(await identifyGateway(normalizeGatewayRoot(`${root}/team/v1/`), auth), { name: "magpie", version: "0.1.fixture" });
		assert.deepEqual(await fetchQuotas(`${root}/team`, auth), quotas);
		assert.deepEqual(await fetchKeyLimits(`${root}/team`, auth), { limited: false });
		assert.deepEqual(await fetchModels(`${root}/team`, auth), { data: [] });
	});
	assert.deepEqual(paths, ["/team/v1", "/team/v1/magpie/quotas", "/team/v1/magpie/limit", "/team/v1/models"]);
});

test("规范 root 的代理 prefix 本身以 v1 结尾时不会被再次剥离", async () => {
	await fixture((request, response) => {
		assert.equal(request.url, "/proxy/v1/v1/magpie/quotas");
		json(response, { object: "list", data: [] });
	}, async root => {
		const canonical = normalizeGatewayRoot(`${root}/proxy/v1/v1`);
		await fetchQuotas(canonical, {});
	});
});

test("身份首选失败时在同 prefix fallback，keyless 身份和额度均不发送认证", async () => {
	await fixture((request, response) => {
		assert.equal(request.headers.authorization, undefined);
		if (request.url === "/prefix/v1") { response.writeHead(404); response.end("not found"); }
		else if (request.url === "/prefix/api/hello") json(response, { name: "magpie", version: "fixture" });
		else { assert.equal(request.url, "/prefix/v1/magpie/quotas"); json(response, { object: "list", data: [] }); }
	}, async root => {
		assert.equal((await identifyGateway(`${root}/prefix`, {})).name, "magpie");
		assert.deepEqual(await fetchQuotas(`${root}/prefix`, {}), { object: "list", data: [] });
	});
});

test("HTTP 状态优先于响应格式，诊断脱敏且预算仍可读取", async () => {
	for (const [status, kind] of [[401, "auth"], [403, "permission"], [404, "not-found"], [200, "protocol"]] as const) {
		await fixture((request, response) => {
			if (request.url?.endsWith("/limit")) json(response, { limited: true, limits: [{ tokenLimit: 100 }] });
			else if (status === 401) json(response, { error: { code: "fixture-key\nCODE", message: "fixture-key" } }, status);
			else { response.writeHead(status); response.end("<html>private body</html>"); }
		}, async root => {
			await assert.rejects(fetchQuotas(root, { apiKey: "fixture-key" }), error => {
				assert.ok(error instanceof GatewayError);
				assert.equal(error.kind, kind);
				if (status !== 200) assert.equal(error.status, status);
				assert.doesNotMatch(error.message, /fixture-key|private body/);
				if (status === 401) {
					assert.match(error.code!, /CODE/);
					assert.doesNotMatch(error.code!, /fixture-key|[\r\n]/);
				}
				return true;
			});
			if (status === 403) assert.deepEqual(await fetchKeyLimits(root, { apiKey: "fixture-key" }), { limited: true, limits: [{ tokenLimit: 100 }] });
		});
	}
});

test("HTML 与错误身份拒绝识别，并保留 fallback 诊断", async () => {
	await fixture((request, response) => {
		if (request.url === "/v1") { response.end("<html>fixture</html>"); }
		else json(response, { name: "other", version: "1" });
	}, async root => {
		await assert.rejects(identifyGateway(root, {}), error => error instanceof GatewayError && error.kind === "protocol" && error.message.includes("/v1") && error.message.includes("/api/hello"));
	});
});

test("不跟随真实重定向，不向目标转发 key", async () => {
	let redirected = false;
	await fixture((request, response) => {
		if (request.url === "/target") { redirected = true; json(response, {}); }
		else { response.writeHead(302, { Location: "/target" }); response.end(); }
	}, async root => {
		await assert.rejects(fetchQuotas(root, { apiKey: "fixture-key" }), hasKind("network"));
	});
	assert.equal(redirected, false);
});

test("caller 取消真实 HTTP 请求，身份请求有独立两秒超时", async () => {
	await fixture((_request, _response) => {}, async root => {
		const controller = new AbortController();
		const pending = fetchQuotas(root, {}, controller.signal);
		controller.abort();
		await assert.rejects(pending, error => error instanceof GatewayError && error.kind === "network" && error.message.includes("cancelled"));
		await assert.rejects(identifyGateway(root, {}), error => error instanceof GatewayError && error.kind === "network" && error.message.includes("timed out"));
	});
});

test("宿主传输失败保留网络分类但不暴露原始异常中的凭据或私有内容", async () => {
	await assert.rejects(fetchQuotas("http://localhost", { apiKey: "fixture-key" }, undefined, async () => {
		throw new Error("fixture-key private-transport-detail");
	}), error => error instanceof GatewayError && error.kind === "network"
		&& !error.message.includes("fixture-key") && !error.message.includes("private-transport-detail"));
});

test("诊断去除控制字符与有效 key", () => {
	const redacted = sanitizeDiagnostic("bad\nfixture-key\u001b", "fixture-key");
	assert.match(redacted, /^bad/);
	assert.doesNotMatch(redacted, /fixture-key|[\u0000-\u001f\u007f-\u009f]/);
	assert.doesNotMatch(sanitizeDiagnostic("fix\nture-key", "fixture-key"), /fixture-key|[\u0000-\u001f\u007f-\u009f]/);
	assert.equal(sanitizeDiagnostic("bad\r\nvalue"), "badvalue");
});
