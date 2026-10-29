import type { ExtensionAPI, ProviderConfig } from '@oh-my-pi/pi-coding-agent';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry';
import { createHash } from 'node:crypto';
import { fetchModels, GatewayError, normalizeGatewayRoot, sanitizeDiagnostic } from './gateway.ts';
import { type MagpieProviderModelConfig, mapCatalog } from './models.ts';

const LOCAL_MODEL_KEY = 'magpie-omp';
const created = new WeakMap<ModelRegistry, Map<string, { pendingRoot?: string; keyless: boolean; login: boolean }>>();

/** root 须已规范化；指纹隔离网关/provider/实际 key，不能用 collector 的本地占位标记代替 key。 */
export function gatewayIdentity(root: string, providerId: string, apiKey?: string): string {
  const key = createHash('sha256').update(apiKey ?? 'keyless').digest('hex');
  return createHash('sha256').update(JSON.stringify([root, providerId, key])).digest('hex');
}

/** 无鉴权管理访问仅允许明确的 loopback 地址，不把普通内网或任意 localhost 后缀视为本机。 */
export function isLoopbackGateway(root: string): boolean {
  const hostname = new URL(root).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** 识别本插件为无鉴权 provider 注册的模型发现标记；管理请求永不使用该标记。 */
export function isCreatedKeyless(registry: ModelRegistry, providerId: string, key?: string): boolean {
  return key === LOCAL_MODEL_KEY && created.get(registry)?.get(providerId)?.keyless === true;
}

/** 返回规范网关 root；无有效地址时返回 undefined，首次目录 materialize 前可读取本次创建的启动地址。 */
export function readProviderRoot(registry: ModelRegistry, providerId: string): string | undefined {
  const endpoint = registry.getProviderBaseUrl(providerId);
  const registration = created.get(registry)?.get(providerId);
  if (!endpoint) return registration?.pendingRoot;
  // 目录生效后宿主是唯一来源；以后移除或改坏 endpoint 不能使旧启动地址复活。
  if (registration) registration.pendingRoot = undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(endpoint)) return undefined;
  // Anthropic 仅剥 /v1，/v1beta 可是代理 prefix；检查全部匹配模型，避免依赖混合目录顺序。
  const preserveBetaPrefix = /\/v1beta\/*$/.test(endpoint)
    && registry.getProviderModels(providerId).some(model =>
      model.baseUrl === endpoint && model.api === 'anthropic-messages'
    );
  try {
    return normalizeGatewayRoot(endpoint, preserveBetaPrefix);
  } catch (error) {
    if (error instanceof GatewayError) return undefined;
    throw error;
  }
}

/** 本插件创建时是否提供了原生登录；不授权覆盖已有宿主 provider。 */
export function hasGatewayLogin(registry: ModelRegistry, providerId: string): boolean {
  return created.get(registry)?.get(providerId)?.login === true;
}

/** 经过预取的内存注册候选；root 已规范化，apiKey 仅用于本次身份核验，不得持久化或输出。 */
export interface PreparedGatewayProvider {
  providerId: string;
  root: string;
  apiKey?: string;
  models: MagpieProviderModelConfig[];
  config: ProviderConfig;
}

/**
 * 预取并校验新 provider 的目录，不注册或持久化；root 已规范化，apiKey 是本次实际 HTTP 凭据。
 * 返回值含内存 key，不得序列化到设置/日志。动态 callback 不捕获准备 signal，按实际 key 隔离已有价卡。
 * keyed provider 的认证由 OMP 存储/配置解析；仅本机无鉴权创建使用内部模型发现标记。
 */
export async function prepareGatewayProvider(options: {
  registry: ModelRegistry;
  providerId: string;
  root: string;
  apiKey?: string;
  signal?: AbortSignal;
  notify(message: string): void;
  oauth?: ProviderConfig['oauth'];
}): Promise<PreparedGatewayProvider> {
  const { registry, providerId, root, apiKey, signal, notify, oauth } = options;
  // 预取负责拒绝缺少必要 limits 的目录；同身份首次注册直接消费这些行，避免再次请求。
  const costs = new Map<string, MagpieProviderModelConfig['cost']>();
  const initial = mapCatalog(await fetchModels(root, { apiKey }, signal), root, costs);
  const warn = (message: string, key = apiKey) => notify(`${providerId}: ${sanitizeDiagnostic(message, key)}`);
  for (const message of initial.diagnostics) warn(message);
  if (!initial.models.length) throw new Error('网关目录没有具备必要 limits 的聊天模型，未注册 provider');
  const initialIdentity = gatewayIdentity(root, providerId, apiKey);
  let warm: MagpieProviderModelConfig[] | undefined = initial.models;
  let priceState = { identity: initialIdentity, costs };
  for (const model of initial.models) costs.set(model.id, model.cost);
  return {
    providerId,
    root,
    apiKey,
    models: initial.models,
    config: {
      api: 'openai-completions',
      ...(!apiKey ? { apiKey: LOCAL_MODEL_KEY } : {}),
      ...(oauth ? { oauth } : {}),
      async fetchDynamicModels(resolvedKey) {
        const currentRoot = readProviderRoot(registry, providerId);
        if (!currentRoot) throw new Error('provider 当前地址不可用，取消模型目录读取');
        // 宿主传入本次有效凭据；仅本插件的本机发现标记可还原为无鉴权，不能发送为 Bearer。
        const requestKey = !apiKey && resolvedKey === LOCAL_MODEL_KEY
          ? undefined
          : resolvedKey && resolvedKey !== 'N/A'
          ? resolvedKey
          : undefined;
        const identity = gatewayIdentity(currentRoot, providerId, requestKey);
        if (warm && identity === initialIdentity) {
          const models = warm;
          warm = undefined;
          return models;
        }
        warm = undefined;
        // root/key 改变即切换价卡空间；不同身份不能通过缺价回退继承旧费率。
        if (!requestKey && !isLoopbackGateway(currentRoot)) throw new Error('远程模型目录需要真实 gateway key');
        if (identity !== priceState.identity) priceState = { identity, costs: new Map() };
        const currentPrices = priceState;
        const payload = await fetchModels(currentRoot, { apiKey: requestKey });
        // 读取期间即使只变更地址，也不能发布旧目录；宿主后续的缓存策略由其自行处理。
        if (priceState !== currentPrices || readProviderRoot(registry, providerId) !== currentRoot) {
          throw new Error('动态目录读取期间地址或凭据已变化，取消旧目录');
        }
        const result = mapCatalog(payload, currentRoot, currentPrices.costs);
        for (const message of result.diagnostics) warn(message, requestKey);
        for (const model of result.models) currentPrices.costs.set(model.id, model.cost);
        return result.models;
      },
    },
  };
}

/** 最后同步检查缺失状态并注册，不能在检查与 registerProvider 之间 await；已有 provider 始终保留。 */
export function registerGatewayProvider(
  pi: Pick<ExtensionAPI, 'registerProvider'>,
  registry: ModelRegistry,
  prepared: PreparedGatewayProvider,
): void {
  if (registry.hasProvider(prepared.providerId) || registry.getDiscoveryProviderId(prepared.providerId)) {
    throw new Error('注册前 provider 已存在，未覆盖现有注册');
  }
  pi.registerProvider(prepared.providerId, prepared.config);
  let registrations = created.get(registry);
  if (!registrations) {
    registrations = new Map();
    created.set(registry, registrations);
  }
  registrations.set(prepared.providerId, {
    pendingRoot: prepared.root,
    keyless: !prepared.apiKey,
    login: prepared.config.oauth !== undefined,
  });
}

/** 只核对最终模型与协议路由；宿主可调整 cost/limits，不能把其差异当作插件创建失败。 */
export function verifyGatewayProvider(registry: ModelRegistry, prepared: PreparedGatewayProvider): void {
  for (const expected of prepared.models) {
    const actual = registry.find(prepared.providerId, expected.id);
    if (!actual || actual.api !== expected.api || actual.baseUrl !== expected.baseUrl) {
      throw new Error(sanitizeDiagnostic(`动态目录最终路由与网关映射不符：${expected.id}`, prepared.apiKey));
    }
  }
}
