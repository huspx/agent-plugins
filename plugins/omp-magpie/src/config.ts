/**
 * 连接声明只负责选择 provider。baseUrl 仅是显式创建缺失 provider 的启动输入；
 * 已有 provider 的地址与认证均读取 OMP registry，不在插件设置中维护副本。
 */
export interface ConnectionConfig {
	providerId: string;
	baseUrl?: string;
	createProvider: boolean;
}

export interface PluginConfig {
	autoAttach: boolean;
	connections: ConnectionConfig[];
}

function invalid(message: string): never {
	throw new Error(`omp-magpie: 配置无效：${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${path} 必须是对象`);
	return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${path} 包含未知字段`);
}

function nonemptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") invalid(`${path} 必须是非空字符串`);
	return value;
}

/**
 * 将宿主设置解析为完整配置；connections 必须是 JSON 数组字符串，未知字段或任一无效条目会拒绝整份配置。
 * 不读取或解析认证；环境变量、命令和字面 key 的处理交由 OMP。
 * @throws 配置错误，带可展示的字段说明；调用方须停止使用该 owner 的旧配置。
 */
export function parseConfig(raw: Record<string, unknown>): PluginConfig {
	const settings = record(raw, "设置");
	fields(settings, ["autoAttach", "connections"], "设置");
	if ("autoAttach" in settings && typeof settings.autoAttach !== "boolean") invalid("autoAttach 必须是 boolean");
	// 宿主 setting 以字符串承载连接列表；先完成解码，再逐项验证，任一失败都拒绝整份声明。
	let connections: unknown = [];
	if ("connections" in settings) {
		if (typeof settings.connections !== "string") invalid("connections 必须是 JSON 数组字符串");
		try { connections = JSON.parse(settings.connections); } catch { invalid("connections 不是合法 JSON"); }
	}
	if (!Array.isArray(connections)) invalid("connections 必须是 JSON 数组");
	const ids = new Set<string>();
	return {
		autoAttach: settings.autoAttach !== false,
		connections: connections.map((rawConnection: unknown) => {
			const value = record(rawConnection, "connection");
			fields(value, ["providerId", "baseUrl", "createProvider"], "connection");
			const providerId = nonemptyString(value.providerId, "providerId");
			if (/[\s/\\]/u.test(providerId)) invalid("providerId 不得包含 slash 或空白");
			if (ids.has(providerId)) invalid("providerId 重复");
			ids.add(providerId);
			if ("createProvider" in value && typeof value.createProvider !== "boolean") invalid("createProvider 必须是 boolean");
			const result: ConnectionConfig = { providerId, createProvider: value.createProvider === true };
			if ("baseUrl" in value) result.baseUrl = nonemptyString(value.baseUrl, "baseUrl");
			// 创建声明提供启动地址；普通附加只引用 ID，避免与宿主当前配置形成双源。
			if (result.createProvider && (!/^[a-z][a-z0-9-]*$/.test(providerId) || !result.baseUrl)) invalid("创建 provider 需要小写合法 ID 和 baseUrl");
			if (!result.createProvider && result.baseUrl) invalid("已有 provider 的地址请在 OMP 中配置，附加连接不接受 baseUrl");
			return result;
		}),
	};
}

/** 替换同 ID 连接或追加新连接，保留其他连接及列表顺序；调用方在确认后保存，不能将明文 key 放入 connection。 */
export function upsertConnection(config: PluginConfig, connection: ConnectionConfig): PluginConfig {
	const index = config.connections.findIndex(value => value.providerId === connection.providerId);
	const connections = config.connections.slice();
	if (index < 0) connections.push(connection);
	else connections[index] = connection;
	return { autoAttach: config.autoAttach, connections };
}
