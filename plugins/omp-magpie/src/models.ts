import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/** 提交给宿主的单模型声明：baseUrl 与 api 配对，cost 为 USD/百万 tokens；最终元数据由 OMP 构造。 */
export type MagpieProviderModelConfig = ProviderModelConfig & {
	baseUrl?: string;
	cost: Model<Api>["cost"];
};

/** 诊断仅描述本次映射；调用方须自行决定空 models 是否允许发布。 */
export interface CatalogResult {
	models: MagpieProviderModelConfig[];
	diagnostics: string[];
}

type Cost = Model<Api>["cost"];
type BaseCost = Pick<Cost, "input" | "output" | "cacheRead" | "cacheWrite">;
const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const costFields = ["input", "output", "cacheRead", "cacheWrite"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function rate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 仅接受非负十进制 USD/token 字符串；一次指数换算为 USD/百万 tokens，溢出时拒绝报价。 */
function perMillion(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return undefined;
	// 十进制字符串先移动指数再转换，避免先解析再乘导致二次舍入。
	const converted = Number(`${value}e6`);
	return Number.isFinite(converted) ? converted : undefined;
}

/**
 * 统一基础价卡为 USD/百万 tokens：standard 读取 pricing 的 USD/token 十进制字符串，扩展读取同输出单位的数字。
 * 输入、输出费率必须同时有效；缺省缓存费率为零，任一已给出的费率无效则整张报价返回 undefined。
 */
function readPrice(value: unknown, standard: boolean): BaseCost | undefined {
	const row = record(value);
	if (!row) return undefined;
	const parse = standard ? perMillion : rate;
	const input = parse(row[standard ? "prompt" : "input"]);
	const output = parse(row[standard ? "completion" : "output"]);
	const read = row[standard ? "input_cache_read" : "cache_read"];
	const write = row[standard ? "input_cache_write" : "cache_write"];
	// 缓存价缺省可按零价表达；显式给出但无效的缓存价则不能悄悄当零，须丢弃整张报价。
	const cacheRead = read === undefined ? 0 : parse(read);
	const cacheWrite = write === undefined ? 0 : parse(write);
	return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
		? undefined : { input, output, cacheRead, cacheWrite };
}

/** OMP 只能表达一个长上下文阶梯；1 小时缓存写入及无法完整映射的阶梯只记诊断，保留可表达的价格。 */
function addExtensions(cost: Cost, extension: Record<string, unknown>, note: (message: string) => void): Cost {
	if (extension.cache_write_1h !== undefined && extension.cache_write_1h !== 0) {
		note("1 小时缓存写入价格无法完整映射，成本仅估算普通缓存写入");
	}
	if (extension.tiers === undefined) return cost;
	if (!Array.isArray(extension.tiers)) {
		note("magpie_price.tiers 无效，成本仅估算基础价格");
		return cost;
	}
	if (extension.tiers.length === 0) return cost;
	// 宿主只有一个 longContext 阈值，不能选择性套用多个阶梯中的某一个，以免误报适用价格。
	if (extension.tiers.length !== 1) {
		note("多阶梯价格无法完整映射，成本仅估算基础价格");
		return cost;
	}
	const tier = record(extension.tiers[0]);
	// above 按输入 token 数映射为宿主阈值；阶梯费率仍是 USD/百万 tokens，不按阈值倍乘。
	const threshold = positiveInteger(tier?.above);
	const tierCost = readPrice(tier, false);
	if (!tier || threshold === undefined || !tierCost) {
		note("magpie_price 单阶梯价格无效，成本仅估算基础价格");
		return cost;
	}
	if (tier.cache_write_1h !== undefined && tier.cache_write_1h !== 0) {
		note("阶梯的 1 小时缓存写入价格无法完整映射，成本仅估算普通缓存写入");
	}
	return { ...cost, longContext: { inputThreshold: threshold, ...tierCost } };
}

/**
 * 整张价卡按 pricing、magpie_price、当前绑定已有价卡的顺序选择，不混拼不同来源的费率。
 * 仅在基础报价一致时合并扩展阶梯；仍无报价时返回宿主要求的零价结构并注明未知。
 */
function mapCost(row: Record<string, unknown>, retained: Cost | undefined,
	note: (message: string) => void): Cost {
	const standard = readPrice(row.pricing, true);
	const extended = readPrice(row.magpie_price, false);
	if (row.pricing !== undefined && !standard) note("pricing 价格无效，已丢弃该报价");
	if (row.magpie_price !== undefined && !extended) note("magpie_price 基础价格无效，已丢弃该报价");
	let cost: Cost | undefined = standard ?? extended;
	if (cost && extended) {
		// USD/token 转换与直接百万 token 报价可能有浮点尾差；四倍相对 epsilon 内才视为同一基础价卡。
		if (!standard || costFields.every(field => Math.abs(standard[field] - extended[field]) <= Number.EPSILON * Math.max(standard[field], extended[field]) * 4)) {
			cost = addExtensions(cost, record(row.magpie_price)!, note);
		} else {
			note("pricing 与 magpie_price 基础价格不一致，未合并扩展阶梯；成本仅估算 pricing 基础价格");
		}
	}
	// 只有当前响应两种报价都不可用时才保留调用方传入的同身份旧价，不能用旧字段补拼一张新报价。
	if (!cost && retained && costFields.every(field => rate(retained[field]) !== undefined)) {
		cost = retained;
		note("本次缺少有效报价，保留当前绑定的已有价格");
	}
	// 宿主要求完整数字价卡；没有有效来源时以零结构满足契约，同时诊断未知，不能当作已知免费模型。
	if (!cost) {
		note("缺少已知价格，原生成本状态为未知");
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	if (costFields.every(field => cost[field] === 0)) note("Magpie 报告零费率；原生成本状态可能显示未知");
	return cost;
}

/**
 * 将 Magpie 聊天目录映射为宿主声明；root 须已规范化，缺少必要 token 上限的模型跳过并返回诊断。
 * retainedCosts 必须由调用者按当前网关 root、provider 和实际 key 身份隔离，再按模型 ID 取价；本方法不维护缓存。
 * 无效目录返回空 models 与诊断；输出价格不保证在宿主动态构造后原样保留。
 */
export function mapCatalog(payload: unknown, root: string,
	retainedCosts: ReadonlyMap<string, Cost>): CatalogResult {
	const result: CatalogResult = { models: [], diagnostics: [] };
	const envelope = record(payload);
	if (envelope?.object !== "list" || !Array.isArray(envelope.data)) {
		result.diagnostics.push("omp-magpie: 模型目录无效：需要 object=list 与 data 数组");
		return result;
	}
	// 先筛选聊天模型与必要标识，再构造宿主声明；其他目录对象不参与价卡保留或协议选择。
	for (const value of envelope.data) {
		const row = record(value);
		if (!row || row.object !== "model" || (row.type !== undefined && row.type !== "model" && row.type !== "chat")
			|| (row.kind !== undefined && row.kind !== "chat")) continue;
		if (typeof row.id !== "string" || row.id.trim() === "") {
			result.diagnostics.push("omp-magpie: 跳过缺少有效 id 的模型");
			continue;
		}
		const id = row.id;
		const note = (message: string) => result.diagnostics.push(`omp-magpie: 模型 ${id}：${message}`);
		// 上下文上限按服务端字段优先级取正整数，输出上限必须独立存在；不借宿主默认值猜测缺失 limits。
		const contextWindow = positiveInteger(row.context_window)
			?? positiveInteger(row.context_length) ?? positiveInteger(row.max_input_tokens);
		const maxTokens = positiveInteger(row.max_output_tokens);
		if (contextWindow === undefined || maxTokens === undefined) {
			note(`跳过模型，缺少有效 ${[contextWindow === undefined ? "contextWindow（context_window/context_length/max_input_tokens）" : "",
				maxTokens === undefined ? "maxTokens（max_output_tokens）" : ""].filter(Boolean).join("、")}`);
			continue;
		}
		// 多个原生协议并存时优先 messages，再 responses；未声明支持这两者时沿用 chat completions。
		const endpoints = Array.isArray(row.native_endpoints) ? row.native_endpoints : [];
		const api = endpoints.includes("/v1/messages") ? "anthropic-messages"
			: endpoints.includes("/v1/responses") ? "openai-responses" : "openai-completions";
		// 仅投影宿主可表达的输入模态；结构化 reasoning levels 一旦非空即优先，避免与旧字段混拼能力。
		const inputValues = record(row.modalities)?.input;
		const input: ("text" | "image")[] = Array.isArray(inputValues)
			? [...new Set(inputValues.filter((item): item is "text" | "image" => item === "text" || item === "image"))] : ["text"];
		const structuredLevels = Array.isArray(row.supported_reasoning_levels)
			? row.supported_reasoning_levels.map(level => record(level)?.effort) : [];
		const levels = structuredLevels.length > 0 ? structuredLevels : Array.isArray(row.reasoning_levels) ? row.reasoning_levels : [];
		const supported = efforts.filter(effort => levels.includes(effort))
			.map(effort => effort as NonNullable<Model<Api>["thinking"]>["efforts"][number]);
		const name = [row.magpie_label, row.display_name].find((label): label is string => typeof label === "string" && label.trim() !== "") ?? id;
		result.models.push({
			// OMP 的 Anthropic transport 自行去掉末尾 /v1；统一版本化 endpoint 可保留本身以 /v1 结尾的代理 prefix。
			id, name, api, baseUrl: `${root}/v1`,
			reasoning: row.reasoning === true,
			...(api !== "anthropic-messages" && supported.length > 0 ? { thinking: { mode: "effort" as const, efforts: supported } } : {}),
			input, contextWindow, maxTokens,
			cost: mapCost(row, retainedCosts.get(id), note),
		});
	}
	return result;
}
