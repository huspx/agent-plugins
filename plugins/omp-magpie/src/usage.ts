import type { UsageAmount, UsageFetchParams, UsageLimit, UsageProvider, UsageReport, UsageUnit } from "@oh-my-pi/pi-ai/usage";
import { fetchKeyLimits, fetchQuotas, GatewayError, sanitizeDiagnostic } from "./gateway.ts";

/** providerId 使用宿主实际 alias；bindingId 是网关 root/provider/key 的指纹，不包含明文 key。 */
export interface UsageIdentity { providerId: string; bindingId: string }
/**
 * 已发布的共享用量身份；signal 属于 binding 的读取租约，不能换成单个 owner 的会话 signal。
 * apiKey 是实际 HTTP 凭据；无鉴权时 collectorKey 仅为宿主占位标记，不能作为 Bearer 发给网关。
 */
export interface UsageBinding {
	identity: UsageIdentity;
	root: string;
	apiKey?: string;
	collectorKey: string;
	signal: AbortSignal;
	diagnostic?: string;
}
/**
 * current 只读取已发布快照；check 异步调和宿主身份，返回可用 binding 或 undefined。
 * check 之后仍须核对请求凭据，并在 HTTP 完成后确认 binding 对象未被替换且 signal 未取消。
 */
export interface UsageBindingAccess {
	providerId: string;
	current(): UsageBinding | undefined;
	check(params: UsageFetchParams): Promise<UsageBinding | undefined>;
}

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): string => typeof value === "string" ? sanitizeDiagnostic(value) : "";
const units: Record<string, true | undefined> = { percent: true, tokens: true, requests: true, credits: true, usd: true, minutes: true, bytes: true, unknown: true };
function date(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}
/** 有使用比例时以其判断耗尽，否则使用剩余额度；缺少两种读数时不推断账户可用性。 */
function status(amount: UsageAmount): "ok" | "exhausted" | "unknown" {
	if (amount.usedFraction !== undefined) return amount.usedFraction >= 1 ? "exhausted" : "ok";
	if (amount.remaining !== undefined) return amount.remaining <= 0 ? "exhausted" : "ok";
	return "unknown";
}
function failure(value: unknown, source: string): string {
	if (value instanceof GatewayError) {
		if (value.status === 403) return `${source}：没有订阅额度查看权限`;
		if (value.status === 404) return `${source}：接口不支持`;
		if (value.status === 401) return `${source}：网关认证失败`;
	}
	return `${source}：本次无法读取${value instanceof Error ? `（${text(value.message)}）` : "（响应格式无效）"}`;
}

/**
 * 只映射本次响应或错误，不借用历史报告；fetchedAt 为 Unix 毫秒，部分失败保留可用部分并附诊断。
 * 窗口 used/remaining 为百分数，fraction 才除以 100；amount/limit 保留其原始计量单位。
 * key 的 costLimit/cost/costLeft 是美元总金额，直接映射 usd，不做模型费率的百万倍换算；人民币余额保持未知单位及原文。
 * 账号读取错误时保留服务端读数但标为 unknown；完全无读数仍返回带 unknown 项的报告。
 */
export function normalizeUsage(identity: UsageIdentity, quotas: unknown, keyLimits: unknown, fetchedAt: number): UsageReport {
	const report: UsageReport = { provider: identity.providerId, fetchedAt, metadata: { accountId: identity.bindingId }, limits: [], notes: [] };
	const notes = report.notes!;
	const add = (id: string, label: string, accountId: string, amount: UsageAmount, extra: Partial<UsageLimit> = {}) => {
		report.limits.push({ id, label, scope: { provider: identity.providerId, accountId }, amount, status: status(amount), ...extra });
	};
	// 订阅接口失败只形成诊断，不阻断后面的 key 预算；账号之间保留各自 scope，不汇总不同额度池。
	if (!record(quotas) || quotas.object !== "list" || !Array.isArray(quotas.data)) {
		notes.push(failure(quotas, "订阅额度"));
	} else {
		const accounts = new Map<string, number>();
		for (const card of quotas.data) {
			if (!record(card)) { notes.push("订阅额度：忽略格式无效的账号卡片"); continue; }
			// 业务字段区分账号，同字段的重复卡片再以出现次数区分，防止宿主把两个账号读数合并。
			const base = JSON.stringify([identity.bindingId, card.provider ?? "", card.kind ?? "", card.user || "", card.alias || "", card.name || "", card.plan || "", card.seat || "", card.from || ""]);
			const occurrence = accounts.get(base) ?? 0;
			accounts.set(base, occurrence + 1);
			const accountId = occurrence ? JSON.stringify([base, occurrence]) : base;
			const label = [card.provider, card.kind, card.user, card.alias, card.name, card.plan, card.seat, card.from].map(text).filter(Boolean).join(" · ") || "Magpie 账号";
			const cardNotes: string[] = [];
			const error = text(card.error);
			if (error) cardNotes.push(`账号读取错误：${error}；数值可能为旧读数`);
			for (const key of ["readAt", "asOf"] as const) if (card[key] !== undefined) cardNotes.push(`${key}: ${text(card[key])}`);
			if (card.readDeferred) cardNotes.push("延迟读取（readDeferred）");
			if (card.balanceSplit !== undefined && typeof card.balance !== "string") cardNotes.push(`余额构成：${typeof card.balanceSplit === "string" ? text(card.balanceSplit) : text(JSON.stringify(card.balanceSplit))}`);
			// 每个窗口独立映射；同名但不同 pool 或重复出现的窗口也必须有独立 limit ID。
			const windows = Array.isArray(card.windows) ? card.windows : [];
			const names = new Map<string, number>();
			for (const window of windows) {
				if (!record(window)) continue;
				const name = text(window.name) || "配额窗口";
				const pool = text(window.pool);
				const group = JSON.stringify([name, pool]);
				const nth = names.get(group) ?? 0;
				names.set(group, nth + 1);
				const id = JSON.stringify([accountId, name, pool, nth]);
				const entryNotes = [...cardNotes];
				let amount: UsageAmount = { unit: "unknown" };
				// unlimited 优先于数值字段；有限窗口先接受服务端百分数，fraction 才换算为以 1 表示 100% 的比例。
				if (window.unlimited === true) entryNotes.push("不限额");
				else {
					if (number(window.used) || number(window.remaining)) {
						amount = { unit: "percent", limit: 100 };
						if (number(window.used)) { amount.used = window.used; amount.usedFraction = window.used / 100; }
						if (number(window.remaining)) { amount.remaining = window.remaining; amount.remainingFraction = window.remaining / 100; }
					}
					// 有绝对限额时改用原单位读数，保留服务端比例；不由绝对值重算或钳制比例，以保留超额信息。
					if (number(window.limit) && window.limit > 0 && typeof window.unit === "string" && window.unit) {
						const unit: UsageUnit = units[window.unit] ? window.unit as UsageUnit : "unknown";
						if (unit === "unknown") entryNotes.push(`原始单位：${text(window.unit)}`);
						amount = { unit, used: number(window.amount) ? window.amount : 0, limit: window.limit, usedFraction: amount.usedFraction, remainingFraction: amount.remainingFraction };
						amount.remaining = window.limit - amount.used!;
					}
				}
				const resetsAt = date(window.resetsAt);
				add(id, `${label} · ${name}${pool ? ` · ${pool}` : ""}${window.unlimited === true ? " · 不限额" : ""}`, accountId, amount, {
					window: { id: group, label: name, ...(resetsAt === undefined ? {} : { resetsAt }) },
					notes: entryNotes, status: error ? "unknown" : window.unlimited === true ? "ok" : status(amount),
				});
			}
			// 余额按货币片段分别展示，不把 balanceSplit 再加到总额；人民币没有对应宿主单位，保留原文且标 unknown。
			if (typeof card.balance === "string") {
				const balance = card.balance;
				const balanceNotes = [...cardNotes, `余额：${text(balance)}`];
				if (card.balanceSplit !== undefined) balanceNotes.push(`余额构成（不与总额相加）：${typeof card.balanceSplit === "string" ? text(card.balanceSplit) : text(JSON.stringify(card.balanceSplit))}`);
				for (const [index, part] of balance.split(" · ").entries()) {
					const match = /^(\$|USD\s*|¥|CNY\s*|RMB\s*)([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(part.trim());
					const amount: UsageAmount = { unit: "unknown" };
					if (match && Number.isFinite(Number(match[2]))) {
						amount.unit = match[1] === "$" || match[1]!.startsWith("USD") ? "usd" : "unknown";
						amount.remaining = Number(match[2]);
					}
					add(JSON.stringify([accountId, "balance", index]), `${label} · 余额 ${text(part)}`, accountId, amount, { notes: balanceNotes, status: error ? "unknown" : status(amount) });
				}
			}
			if (!windows.length && typeof card.balance !== "string") add(JSON.stringify([accountId, "empty"]), card.unlimited === true ? `${label} · 不限额` : label, accountId, { unit: "unknown" }, { status: error ? "unknown" : card.unlimited === true ? "ok" : "unknown", notes: [...cardNotes, card.unlimited === true ? "不限额" : "没有可展示的配额"] });
		}
	}
	// 无鉴权连接不会读取 key 预算，undefined 因而不报错；显式 limited=false 则优先表达未设置预算。
	if (keyLimits !== undefined) {
		if (keyLimits instanceof Error || !record(keyLimits)) notes.push(failure(keyLimits, "key 预算"));
		else if (keyLimits.limited === false) add("key-unlimited", "当前 key 未设置预算", identity.bindingId, { unit: "unknown" }, { status: "ok" });
		else {
			const budgets = keyLimits.limits === undefined ? (record(keyLimits.limit) ? [keyLimits.limit] : []) : Array.isArray(keyLimits.limits) ? keyLimits.limits : [];
			if (!budgets.length) notes.push("key 预算：没有可展示的预算");
			for (const [index, budget] of budgets.entries()) {
				if (!record(budget)) continue;
				const windowId = JSON.stringify([budget.period ?? "", budget.day ?? "", budget.week ?? "", budget.month ?? "", budget.days ?? "", budget.hours ?? "", index]);
				const period = text(String(budget.period ?? "窗口"));
				const count = period === "hours" ? budget.hours : period === "days" ? budget.days : undefined;
				const counted = number(count) && count > 0;
				const windowLabel = counted ? `${count} ${period === "hours" ? "小时" : "天"}` : period;
				// 滚动窗口的小时/天换算成宿主要求的毫秒；其余 period 只保留标签，不猜测日历窗口长度。
				const duration = counted ? count * (period === "hours" ? 3_600_000 : 86_400_000) : undefined;
				const budgetNotes: string[] = [];
				for (const key of ["day", "week", "month", "days", "hours", "start", "unpriced", "inFlight", "reserved", "reservedCost"]) if (budget[key] !== undefined) budgetNotes.push(`${key}: ${text(String(budget[key]))}`);
				// token 与美元预算分开发布；美元已是总金额，无须价卡的百万倍换算，比例按同单位相除。
				for (const [limitKey, usedKey, leftKey, unit] of [["tokenLimit", "tokens", "tokensLeft", "tokens"], ["costLimit", "cost", "costLeft", "usd"]] as const) {
					const maximum = budget[limitKey];
					if (!number(maximum) || maximum <= 0) continue;
					const used = number(budget[usedKey]) ? budget[usedKey] : 0;
					// 优先采用服务端余额以保留网关口径；只在缺省时用限额减使用量，不截断负余额或超额比例。
					const remaining = number(budget[leftKey]) ? budget[leftKey] : maximum - used;
					const resetsAt = date(budget.reset);
					add(JSON.stringify([identity.bindingId, "key", windowId, unit]), `key 预算 · ${windowLabel} · ${unit}`, identity.bindingId, { unit, used, limit: maximum, remaining, usedFraction: used / maximum, remainingFraction: remaining / maximum }, { window: { id: windowId, label: windowLabel, ...(duration !== undefined && Number.isFinite(duration) ? { durationMs: duration } : {}), ...(resetsAt === undefined ? {} : { resetsAt }) }, notes: budgetNotes });
				}
			}
		}
	}
	// 仍返回未知项使宿主能展示本次诊断，不能把无读数解释成零消耗或沿用上次报告。
	if (!report.limits.length) add("unknown", "没有可展示的配额", identity.bindingId, { unit: "unknown" }, { notes: ["没有可展示的配额"] });
	return report;
}

/**
 * 为实际 provider alias 创建原生 adapter。supports 只允许进入异步核验，true 不代表凭据身份已经验证。
 * fetchUsage 先调用 check，再并行读取账号额度与 key 预算；无鉴权连接不请求 key 预算，单接口失败不吞掉另一结果。
 * 请求结束以 binding 对象及 signal 判断发布资格，失效返回 null；不使用 previousReport，也不自行保留失败前读数。
 */
export function createUsageProvider(access: UsageBindingAccess): UsageProvider {
	// collector 的本地占位值只允许对应无鉴权 binding；真实 key、provider alias 和取消状态均须匹配。
	const matches = (params: UsageFetchParams, binding: UsageBinding | undefined): binding is UsageBinding =>
		params.provider === access.providerId && params.credential.type === "api_key" && !!binding && binding.identity.providerId === access.providerId && !binding.signal.aborted && !params.signal?.aborted && params.credential.apiKey === binding.collectorKey && binding.collectorKey === (binding.apiKey || "__omp_magpie_usage_local__");
	return {
		id: access.providerId, cacheVersion: 1, validatesCredentials: false, retainLastGoodOnFailure: false,
		supports(params) {
			// supports 是同步调度入口，允许真实 key 进入异步 check 以调和凭据变化；它不授予 HTTP 发布资格。
			const binding = access.current();
			return params.provider === access.providerId && params.credential.type === "api_key" && !!binding
				&& !binding.signal.aborted && !params.signal?.aborted
				&& (params.credential.apiKey !== "__omp_magpie_usage_local__" || !binding.apiKey);
		},
		async fetchUsage(params, context) {
			const binding = await access.check(params);
			if (!matches(params, binding) || access.current() !== binding) return null;
			// 请求取消与共享 binding 撤销任一发生都停止本次读取，单个 owner 的退出不直接取消仍有租约的 binding。
			const signal = params.signal ? AbortSignal.any([params.signal, binding.signal]) : binding.signal;
			const auth = { apiKey: binding.apiKey };
			// 两个管理接口独立结算，保留单边成功；无鉴权时跳过只对真实 key 有意义的预算请求。
			const settled = await Promise.allSettled([
				fetchQuotas(binding.root, auth, signal, context.fetch),
				binding.apiKey ? fetchKeyLimits(binding.root, auth, signal, context.fetch) : Promise.resolve(undefined),
			]);
			// HTTP 可能跨过一次重新绑定；对象身份与 signal 同时约束结果，旧身份即使请求成功也不能发布。
			if (signal.aborted || access.current() !== binding) return null;
			const result = (item: PromiseSettledResult<unknown>): unknown => item.status === "fulfilled" ? item.value : item.reason instanceof Error ? item.reason : new Error(sanitizeDiagnostic(String(item.reason), binding.apiKey));
			const report = normalizeUsage(binding.identity, result(settled[0]!), result(settled[1]!), Date.now());
			if (binding.diagnostic) report.notes!.push(sanitizeDiagnostic(binding.diagnostic, binding.apiKey));
			// 服务端卡片也可能回显凭据，统一在返回宿主前脱敏。
			return binding.apiKey ? JSON.parse(JSON.stringify(report, (_key, value: unknown) => typeof value === "string" ? sanitizeDiagnostic(value, binding.apiKey) : value)) as UsageReport : report;
		},
	};
}
