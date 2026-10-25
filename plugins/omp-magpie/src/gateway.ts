export interface GatewayAuth { apiKey?: string }
export interface MagpieIdentity { name: "magpie"; version: string }
export type GatewayErrorKind = "network" | "auth" | "permission" | "not-found" | "protocol";
type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 管理接口的分类错误；status/code 可缺省，message 不携带原始 fetch 异常或完整响应。 */
export class GatewayError extends Error {
	readonly kind: GatewayErrorKind;
	readonly status?: number;
	readonly code?: string;

	constructor(kind: GatewayErrorKind, message: string, status?: number, code?: string) {
		super(sanitizeDiagnostic(message));
		this.name = "GatewayError";
		this.kind = kind;
		this.status = status;
		this.code = code;
	}
}

/** 清除终端控制字符并遮蔽已知 key；调用方须传入实际凭据，本方法不会自动识别任意 secret。 */
export function sanitizeDiagnostic(message: string, apiKey?: string): string {
	let clean = apiKey ? message.split(apiKey).join("[已隐藏]") : message;
	clean = clean.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	// 同时处理被终端控制字符拆开的凭据。
	const cleanKey = apiKey?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	return cleanKey ? clean.split(cleanKey).join("[已隐藏]") : clean;
}

function gatewayUrl(input: string): URL {
	let url: URL;
	try { url = new URL(input); } catch { throw new GatewayError("protocol", "网关地址必须是有效 HTTP/HTTPS URL"); }
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || input.includes("?") || input.includes("#")) {
		throw new GatewayError("protocol", "网关地址只接受不含 query、fragment 或 userinfo 的 HTTP/HTTPS root");
	}
	return url;
}

/**
 * 保留代理路径前缀，剥去一层版本后缀；结果不能重复归一化，已有 Anthropic endpoint 须显式保留 /v1beta。
 * @throws GatewayError 地址无效，或包含非 HTTP(S) 协议、userinfo、query、fragment。
 */
export function normalizeGatewayRoot(input: string, preserveBetaPrefix = false): string {
	const url = gatewayUrl(input);
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path.replace(preserveBetaPrefix ? /\/v1$/ : /\/(?:v1|v1beta)$/, "")}`;
}

/** 使用单一 Bearer 发起管理 GET，禁止重定向；timeout 为毫秒，与调用方取消信号合并，失败统一转为 GatewayError。 */
async function requestJson(root: string, path: string, auth: GatewayAuth, timeout: number, signal?: AbortSignal, fetchImpl: FetchImpl = globalThis.fetch, prices = false): Promise<unknown> {
	// root 已由连接层规范化；再推导一次会吃掉以 /v1 结尾的合法代理 prefix。
	const endpoint = `${gatewayUrl(root).href.replace(/\/+$/, "")}${path}`;
	const timeoutSignal = AbortSignal.timeout(timeout);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "omp-magpie" };
	if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
	if (prices) headers["X-Magpie-Prices"] = "1";
	try {
		combined.throwIfAborted();
		const response = await fetchImpl(endpoint, { method: "GET", headers, redirect: "error", signal: combined });
		if (!response.ok) {
			// 分类供上层分别展示账号权限与 key 预算；只提取安全错误码，不输出服务端原始响应。
			const kind = response.status === 401 ? "auth" : response.status === 403 ? "permission" : response.status === 404 ? "not-found" : "protocol";
			const description = kind === "auth" ? "网关认证失败" : kind === "permission" ? "没有访问权限" : kind === "not-found" ? "接口不支持" : "网关 HTTP 错误";
			let code: string | undefined;
			try {
				const payload: unknown = await response.json();
				if (typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "object" && payload.error !== null && "code" in payload.error && typeof payload.error.code === "string") code = sanitizeDiagnostic(payload.error.code, auth.apiKey);
			} catch { /* HTTP 状态优先于错误响应的 JSON 格式。 */ }
			throw new GatewayError(kind, `${path}：${description}（HTTP ${response.status}）`, response.status, code);
		}
		try { return await response.json(); } catch {
			if (combined.aborted) throw combined.reason;
			throw new GatewayError("protocol", `${path}：响应不是有效 JSON`, response.status);
		}
	} catch (error) {
		if (error instanceof GatewayError) throw error;
		const detail = timeoutSignal.aborted && !signal?.aborted ? "请求超时" : signal?.aborted ? "请求已取消" : "网络请求失败";
		// 不转发 fetch 原始异常；其中可能包含地址、headers 或凭据。
		throw new GatewayError("network", `${path}：${detail}`);
	}
}

/**
 * 在已规范化 root 下依次探测 /v1、/api/hello，每次限时 2 秒；仅 name=magpie 且 version 非空视为成功。
 * 两次失败抛出合并诊断，优先保留非 404 分类；识别成功只证明网关产品身份，不代替 collector 凭据核验。
 */
export async function identifyGateway(root: string, auth: GatewayAuth, signal?: AbortSignal, fetchImpl?: FetchImpl): Promise<MagpieIdentity> {
	const failures: GatewayError[] = [];
	// 两个固定接口是产品身份识别协议的顺序回退，不对同一请求额外重试。
	for (const path of ["/v1", "/api/hello"]) {
		if (signal?.aborted) throw new GatewayError("network", "网关身份识别已取消");
		try {
			const payload = await requestJson(root, path, auth, 2_000, signal, fetchImpl);
			if (typeof payload === "object" && payload !== null && "name" in payload && payload.name === "magpie" && "version" in payload && typeof payload.version === "string" && payload.version.trim()) {
				const version = sanitizeDiagnostic(payload.version, auth.apiKey).trim();
				if (version) return { name: "magpie", version };
			}
			throw new GatewayError("protocol", `${path}：响应缺少 Magpie name/version 身份`);
		} catch (error) {
			if (!(error instanceof GatewayError)) throw error;
			failures.push(error);
		}
	}
	// 常见的探测接口 404 不应掩盖另一个接口返回的认证、权限或协议错误。
	const primary = failures.find(error => error.kind !== "not-found") ?? failures[0]!;
	throw new GatewayError(primary.kind, failures.map(error => error.message).join("；"), primary.status, primary.code);
}

/** 读取完整账号额度，不带 kept=1，避免远程转发的账号卡被过滤；沿用管理请求的 8 秒超时。 */
export function fetchQuotas(root: string, auth: GatewayAuth, signal?: AbortSignal, fetchImpl?: FetchImpl): Promise<unknown> {
	return requestJson(root, "/v1/magpie/quotas", auth, 8_000, signal, fetchImpl);
}

/** 独立读取当前实际 key 的预算原文；金额字段为美元总额，超时或权限错误由调用方与账号额度分别处理。 */
export function fetchKeyLimits(root: string, auth: GatewayAuth, signal?: AbortSignal, fetchImpl?: FetchImpl): Promise<unknown> {
	return requestJson(root, "/v1/magpie/limit", auth, 8_000, signal, fetchImpl);
}

/** 读取模型目录并请求 Magpie 扩展价卡；标准 pricing 不依赖扩展 header，HTTP 限时 8 秒。 */
export function fetchModels(root: string, auth: GatewayAuth, signal?: AbortSignal, fetchImpl?: FetchImpl): Promise<unknown> {
	return requestJson(root, "/v1/models", auth, 8_000, signal, fetchImpl, true);
}
