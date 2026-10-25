import { createHash } from "node:crypto";
import type { AuthStorage, CredentialRankingStrategy, UsageFetchParams, UsageProvider } from "@oh-my-pi/pi-ai";
import type { UsageApi } from "@oh-my-pi/pi-ai/auth-storage";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ConnectionConfig, PluginConfig } from "./config.ts";
import { identifyGateway, normalizeGatewayRoot, sanitizeDiagnostic } from "./gateway.ts";
import { readProviderRoot, gatewayIdentity, isCreatedKeyless, isLoopbackGateway, prepareGatewayProvider, registerGatewayProvider, verifyGatewayProvider } from "./provider.ts";
import { createUsageProvider, type UsageBinding } from "./usage.ts";

// 本地 collector 占位标记不是真实网关凭据，不会作为 Bearer 发送。
const LOCAL_USAGE_KEY = "__omp_magpie_usage_local__";
const stores = new WeakMap<AuthStorage, StoreState>();

/** 由入口注入宿主解析能力和受所有权保护的登录入口；本模块只消费这些能力，不另设认证解析或登录注册。 */
export interface HostServices {
  defaultRankingStrategy(provider: string): CredentialRankingStrategy | undefined;
  /** 按宿主规则解析字面值、env 或命令引用；结果可能是明文 key，仅能用于身份核对与 HTTP。 */
  resolveConfigValue(value: string): Promise<string | undefined>;
  login?(providerId: string): ProviderConfig["oauth"];
}

type Claim = { connection: ConnectionConfig; explicit: boolean };
type Candidate = {
  owner: BindingOwner;
  claim: Claim;
  root: string;
  endpoint?: string;
  apiKey?: string;
  collectorKey: string;
  bindingId: string;
  missing: boolean;
};
type Binding = UsageBinding & { controller: AbortController; leases: Array<{ owner: BindingOwner; claim: Claim }> };
/**
 * 同一 AuthStorage/provider 的共享状态。epoch 淘汰旧异步准备，revision 判断失败是否已被新声明取代。
 * 两者约束调和工作；已发布 binding 的共享 HTTP 读取另由自身 signal 和对象身份约束。
 */
type Slot = {
  providerId: string;
  epoch: number;
  revision: number;
  stamp: string;
  adapter?: UsageProvider;
  binding?: Binding;
  pending: boolean;
  running?: Promise<void>;
  diagnostic?: string;
};

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}


function realKey(value: string | undefined): string | undefined {
  return value && value !== "N/A" ? value : undefined;
}

/** 汇合 provider/model header 的认证身份；只接受 Bearer 或专用 key header，同一来源出现不同 key 时拒绝附加。 */
function headerKey(headers: Record<string, string> | undefined): string | undefined {
  const keys = new Set<string>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "authorization") {
      const match = /^Bearer\s+(.+)$/i.exec(value);
      if (!match) throw new Error("Authorization 必须为单一 Bearer key，无法安全读取网关用量");
      const key = realKey(match[1]);
      if (key) keys.add(key);
    } else if (lower === "x-api-key" || lower === "x-goog-api-key") {
      const key = realKey(value);
      if (key) keys.add(key);
    }
  }
  if (keys.size > 1) throw new Error("provider headers 包含互相冲突的认证值");
  return keys.values().next().value;
}

/**
 * 每个 factory 一个稳定 owner；session_switch 更新其引用，相同 AuthStorage 的 owner 共享 slot 与 adapter。
 * owner.signal 只取消本 owner 的身份/模型准备；共享用量读取使用独立租约，不能随某个会话退出一并取消。
 */
export class BindingOwner {
  private state?: StoreState;
  private context?: ExtensionContext;
  private config?: PluginConfig;
  private controller = new AbortController();
  private sessionId?: string;
  readonly claims = new Map<string, Claim>();

  constructor(
    readonly pi: Pick<ExtensionAPI, "registerProvider">,
    private readonly notify: (message: string) => void,
    readonly host: HostServices,
  ) {}

  get ctx(): ExtensionContext | undefined { return this.context; }
  get signal(): AbortSignal { return this.controller.signal; }

  warn(message: string): void {
    if (this.context) this.notify(`omp-magpie: ${sanitizeDiagnostic(message)}`);
  }

  /**
   * 替换本 owner 的会话及完整连接声明，取消旧准备，并将旧、新 provider 都纳入共享调和。
   * slot 失败会转为撤销与诊断，因此 Promise 完成只表示本轮处理结束，不保证每个声明已附加。
   */
  async configure(ctx: ExtensionContext, config: PluginConfig): Promise<void> {
    const previous = this.state;
    const affected = new Set(this.claims.keys());
    // 先取消旧 owner 准备并替换声明，再通知共享 store；旧任务不能以新会话的 context 继续发布。
    this.controller.abort();
    this.controller = new AbortController();
    this.context = ctx;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.config = config;
    this.claims.clear();
    for (const connection of config.connections) this.claims.set(connection.providerId, { connection, explicit: true });
    this.addAutomaticCandidates();
    // AuthStorage 是共享边界；切换 storage 时释放旧租约，同一 storage 的其他 owner 继续持有绑定。
    const auth = ctx.modelRegistry.authStorage;
    let state = stores.get(auth);
    if (!state) {
      state = new StoreState(auth, this.host);
      stores.set(auth, state);
    }
    this.state = state;
    if (previous && previous !== state) previous.release(this);
    state.owners.add(this);
    for (const id of this.claims.keys()) affected.add(id);
    state.claimsChanged(affected);
    await state.reconcileAll();
  }

  /**
   * 按当前宿主状态重新核对绑定；跨 AuthStorage 或 session ID 时重新配置，同会话的新 context facade 只更新引用。
   * 无活动上下文时直接结束；附加成功语义与 configure 相同，不能以 Promise 完成作为资格证明。
   */
  async reconcile(ctx?: ExtensionContext): Promise<void> {
    // storage/session 变化意味着租约身份已变，必须走完整配置；同会话 facade 变化只刷新宿主引用。
    if (ctx && this.config && (ctx.modelRegistry.authStorage !== this.state?.auth || ctx.sessionManager.getSessionId() !== this.sessionId)) {
      await this.configure(ctx, this.config);
      return;
    }
    if (ctx) this.context = ctx;
    if (!this.context || !this.state) return;
    this.addAutomaticCandidates();
    await this.state.reconcileAll();
  }

  /** 返回当前共享 slot 的同步附加资格；只供配置预览，不替代确认后的异步身份核验。 */
  attachmentIssue(providerId: string): string | undefined {
    return this.state ? this.state.eligibilityIssue(providerId) : "会话尚未初始化";
  }

  /** 只核验待确认的连接，不改变声明、凭据或 adapter；返回的实际 key 仅供本次 HTTP，不能显示或持久到设置。 */
  async inspect(connection: ConnectionConfig): Promise<{ root: string; apiKey?: string; missing: boolean }> {
    if (!this.state || !this.context) throw new Error("会话尚未初始化");
    const candidate = await this.state.inspect(this, connection);
    return { root: candidate.root, apiKey: candidate.apiKey, missing: candidate.missing };
  }

  /** 释放自身声明及准备任务；共享资源按剩余 owner 决定是否撤销，不按 provider ID 卸载宿主运行时注册。 */
  close(): void {
    this.controller.abort();
    this.claims.clear();
    const state = this.state;
    this.state = undefined;
    this.context = undefined;
    this.config = undefined;
    state?.release(this);
  }

  /** 自动候选只覆盖当前模型及约定 magpie alias；不覆盖显式声明，最终仍须正向识别网关。 */
  private addAutomaticCandidates(): void {
    if (!this.config?.autoAttach || !this.context) return;
    const registry = this.context.modelRegistry;
    const ids = [this.context.model?.provider, registry.hasProvider("magpie") ? "magpie" : undefined];
    for (const providerId of ids) {
      if (providerId && !this.claims.has(providerId)) {
        this.claims.set(providerId, { connection: { providerId, createProvider: false }, explicit: false });
      }
    }
  }
}

/** 创建尚未附加的 owner；先 configure 建立声明，在 session_shutdown 时 close 释放引用。 */
export function createBindingOwner(
  pi: Pick<ExtensionAPI, "registerProvider">,
  notify: (message: string) => void,
  host: HostServices,
): BindingOwner {
  return new BindingOwner(pi, notify, host);
}

/** 按 AuthStorage 共享一次凭据 generation 订阅；adapter 的安装与清理须始终核对实例所有权。 */
class StoreState {
  readonly owners = new Set<BindingOwner>();
  private readonly slots = new Map<string, Slot>();
  private service: UsageApi;
  private readonly unsubscribe: () => void;

  constructor(readonly auth: AuthStorage, private readonly host: HostServices) {
    this.service = auth.usage;
    this.unsubscribe = auth.credentials.onGeneration(() => this.onGeneration());
  }

  /** 同步返回可展示的资格诊断；不解析密钥或进行 HTTP，也不保证后续异步附加仍满足资格。 */
  eligibilityIssue(providerId: string): string | undefined {
    try { this.eligible(this.slots.get(providerId) ?? { providerId }); }
    catch (error) { return sanitizeDiagnostic(error instanceof Error ? error.message : String(error)); }
    return undefined;
  }

  inspect(owner: BindingOwner, connection: ConnectionConfig): Promise<Candidate> {
    return this.resolve(this.slots.get(connection.providerId) ?? { providerId: connection.providerId }, owner, { connection, explicit: true });
  }

  /** 只指纹化本 provider 的凭据内容；不把健康状态或用量写回误判为认证变化。 */
  private stamp(providerId: string): string {
    return fingerprint(JSON.stringify(this.auth.credentials.list(providerId).map(row => [row.id, row.credential])));
  }

  /** 仅相关凭据内容或 UsageApi 实例变化才撤销旧绑定；用量、健康状态等无关 generation 不使读取失效。 */
  private onGeneration(): void {
    const changedService = this.service !== this.auth.usage;
    for (const slot of this.slots.values()) {
      const stamp = this.stamp(slot.providerId);
      if (!changedService && stamp === slot.stamp) continue;
      // 凭据快照变化先同步撤销，不能让旧缓存等异步 key 解析完成。
      this.revoke(slot);
      slot.stamp = stamp;
      void this.request(slot);
    }
    this.service = this.auth.usage;
  }

  /** 声明变化先淘汰旧调和；没有任何原声明继续持有租约时，同步撤销旧 binding，防止异步解析期间发布旧身份。 */
  claimsChanged(ids: Iterable<string>): void {
    for (const id of ids) {
      const slot = this.slots.get(id);
      if (!slot) continue;
      slot.revision++;
      slot.epoch++;
      slot.pending = true;
      if (slot.binding && !this.hasLease(slot)) this.revoke(slot);
    }
  }

  /** 租约须仍持有同一个声明对象；仅 provider ID 相同不能让替换后的声明延续旧身份读取。 */
  private hasLease(slot: Slot): boolean {
    return slot.binding?.leases.some(({ owner, claim }) => this.owners.has(owner) && !!owner.ctx
      && !owner.signal.aborted && owner.claims.get(slot.providerId) === claim) ?? false;
  }

  /** 移除单个 owner 后保留其他声明的共享读取；最后一个 owner 退出才解除凭据订阅及 store 引用。 */
  release(owner: BindingOwner): void {
    this.owners.delete(owner);
    for (const slot of this.slots.values()) {
      slot.epoch++;
      slot.revision++;
      // 剩余声明须实际持有旧 binding 的租约才能继续读；仅有尚待核验的新声明不足以保留它。
      if (this.claimsFor(slot.providerId).length === 0 || !this.hasLease(slot)) this.revoke(slot);
      else void this.request(slot);
    }
    if (this.owners.size === 0) {
      this.unsubscribe();
      stores.delete(this.auth);
    }
  }

  /** 为活动声明建立 slot，并等待各 slot 当前调和批次结束；各 provider 独立准备，失败由 request 诊断。 */
  async reconcileAll(): Promise<void> {
    if (this.service !== this.auth.usage) this.onGeneration();
    for (const owner of this.owners) {
      for (const providerId of owner.claims.keys()) {
        if (!this.slots.has(providerId)) {
          this.slots.set(providerId, { providerId, epoch: 0, revision: 0, stamp: this.stamp(providerId), pending: false });
        }
      }
    }
    await Promise.all([...this.slots.values()].map(slot => this.request(slot)));
  }

  private claimsFor(providerId: string): Array<{ owner: BindingOwner; claim: Claim }> {
    const claims: Array<{ owner: BindingOwner; claim: Claim }> = [];
    for (const owner of this.owners) {
      const claim = owner.claims.get(providerId);
      if (claim && owner.ctx && !owner.signal.aborted) claims.push({ owner, claim });
    }
    return claims;
  }

  /** 中止该 binding 的共享读取；只移除新、旧 UsageApi 中仍由本 slot 持有的 adapter，保留外部接管的实例。 */
  private revoke(slot: Slot): void {
    // 先使在途准备和 HTTP 失效，再撤下自己的 adapter；外部接管的 adapter 不能随本插件清理。
    slot.epoch++;
    slot.binding?.controller.abort();
    slot.binding = undefined;
    for (const service of new Set([this.service, this.auth.usage])) {
      if (slot.adapter && service.providerFor(slot.providerId) === slot.adapter) service.removeProvider(slot.providerId);
    }
  }

  /** 同一 slot 的连续相同诊断只通知一次；通知前脱敏，不把实际 HTTP key 暴露给会话。 */
  private warn(slot: Slot, message: string): void {
    const safe = sanitizeDiagnostic(message, slot.binding?.apiKey);
    if (slot.diagnostic === safe) return;
    slot.diagnostic = safe;
    for (const { owner } of this.claimsFor(slot.providerId)) owner.warn(`${slot.providerId}: ${safe}`);
  }

  /** 合并同 slot 的并发请求并追赶 pending 变化；旧声明的失败只重算，当前失败才撤销绑定并通知。 */
  private request(slot: Slot): Promise<void> {
    slot.pending = true;
    if (slot.running) return slot.running;
    slot.running = (async () => {
      do {
        slot.pending = false;
        const revision = slot.revision;
        try {
          await this.reconcileSlot(slot);
        } catch (error) {
          // 异步失败若属于已替换声明，不能据此撤销新声明；让下一轮按最新 revision 重算。
          if (slot.revision !== revision) { slot.pending = true; continue; }
          const secret = slot.binding?.apiKey;
          this.revoke(slot);
          this.warn(slot, sanitizeDiagnostic(error instanceof Error ? error.message : String(error), secret));
        }
      } while (slot.pending && this.owners.size > 0);
    })().finally(() => {
      // 清空运行句柄后仍可能存在后续请求，保留 pending 可防止这类变化丢失调和机会。
      slot.running = undefined;
      if (slot.pending && this.owners.size > 0) void this.request(slot);
    });
    return slot.running;
  }

  /** 同步资格门禁：不接管原生 ranking、其他 adapter 或 OAuth；异步准备后发布前必须再次检查。 */
  private eligible(slot: Pick<Slot, "providerId" | "adapter">): void {
    const id = slot.providerId;
    if (this.host.defaultRankingStrategy(id)) throw new Error("此 provider 有原生 ranking strategy，请配置独立网关 alias");
    const adapter = this.auth.usage.providerFor(id);
    if (adapter && adapter !== slot.adapter) throw new Error("此 provider 已有其他 usage adapter，请配置独立网关 alias");
    if (this.auth.credentials.list(id).some(row => row.credential.type === "oauth") || this.auth.keys.source(id)?.kind === "oauth") {
      throw new Error("此 provider 含 OAuth 凭据，请配置独立网关 alias");
    }
  }

  /** 认证解析与身份 HTTP 必须使用同一 endpoint 快照；缺失 provider 仍允许本次显式创建的启动地址。 */
  private assertEndpoint(candidate: Candidate): void {
    const registry = candidate.owner.ctx?.modelRegistry;
    const id = candidate.claim.connection.providerId;
    if (!registry) throw new Error("会话已结束，取消旧连接准备");
    const missing = !registry.hasProvider(id) && !registry.getDiscoveryProviderId(id);
    const root = missing && candidate.claim.connection.baseUrl
      ? normalizeGatewayRoot(candidate.claim.connection.baseUrl) : readProviderRoot(registry, id);
    if (missing !== candidate.missing || registry.getProviderBaseUrl(id) !== candidate.endpoint || root !== candidate.root) {
      throw new Error("provider 地址已变化，取消旧连接准备");
    }
  }

  /**
   * 解析实际 endpoint、推理/header key 与 collector 身份，要求所有凭据来源一致；仅 loopback 允许无鉴权。
   * 返回候选，不发 Magpie HTTP 或发布绑定；宿主 key/header 解析可异步，调用方仍须检查 epoch 及 owner 存活。
   */
  private async resolve(slot: Pick<Slot, "providerId" | "adapter">, owner: BindingOwner, claim: Claim): Promise<Candidate> {
    const ctx = owner.ctx;
    const signal = owner.signal;
    if (!ctx || signal.aborted) throw new Error("会话已结束");
    const registry = ctx.modelRegistry;
    this.eligible(slot);
    const { connection } = claim;
    const id = slot.providerId;
    const missing = !registry.hasProvider(id) && !registry.getDiscoveryProviderId(id);
    if (missing && !connection.createProvider) throw new Error("provider 不存在；创建时须显式设置 createProvider 和 baseUrl");
    const endpoint = registry.getProviderBaseUrl(id);
    // baseUrl 仅用于缺失 provider 的首次创建；已有 provider 的实际地址始终由 registry 决定。
    const root = missing && connection.baseUrl ? normalizeGatewayRoot(connection.baseUrl) : readProviderRoot(registry, id);
    if (!root) throw new Error("无法取得 provider endpoint，请先在 OMP 中配置网关地址");
    // 推理 key 与 provider/model header 必须指向同一身份，不能用一个 key 推理、另一个 key 读取预算。
    let key = realKey(await registry.getApiKeyForProvider(id, ctx.sessionManager.getSessionId(), { baseUrl: endpoint ?? root, signal }));
    const fromHeaders = headerKey(await registry.getProviderHeaders(id));
    if (signal.aborted || owner.signal !== signal) throw new Error("会话已切换，取消旧绑定准备");
    if (isCreatedKeyless(registry, id, key)) key = undefined;
    if (key && fromHeaders && key !== fromHeaders) throw new Error("有效推理 key 与 provider header 认证冲突");
    key ??= fromHeaders;
    for (const model of registry.getProviderModels(id)) {
      const modelKey = headerKey(await registry.resolveModelHeaders(model, signal));
      if (modelKey && modelKey !== key) throw new Error("模型 header 认证与 provider collector 身份不一致，请配置独立网关 alias");
    }
    if (!key && !isLoopbackGateway(root)) throw new Error("非 loopback 网关需要真实 gateway key，已停止无鉴权管理请求");
    // collector 需要非空标识；无鉴权 loopback 使用本地占位值，HTTP 仍保持 apiKey 为空。
    const collectorKey = key ?? LOCAL_USAGE_KEY;
    const rows = this.auth.credentials.list(id);
    // 存储凭据仍按宿主规则解析；每条都须匹配实际推理 key，避免 collector 轮换到其他账户。
    for (const row of rows) {
      if (row.credential.type !== "api_key") throw new Error("collector 包含 OAuth，需使用独立网关 alias");
      const stored = await this.host.resolveConfigValue(row.credential.key);
      if (!stored || !key || stored !== key) throw new Error("collector 存储凭据与有效推理 key 冲突，已停止附加");
    }
    // 无存储行时核对宿主 runtime key；其他来源使用拟安装 usage key，仍不能绕开身份一致性。
    if (rows.length === 0) {
      const source = this.auth.keys.source(id);
      const actualCollectorKey = source?.kind === "runtime" ? await this.auth.keys.get(id, ctx.sessionManager.getSessionId(), { baseUrl: endpoint ?? root, signal }) : await this.host.resolveConfigValue(collectorKey);
      if (actualCollectorKey !== collectorKey) throw new Error("collector runtime/usage key 与有效推理身份不一致");
    }
    if (signal.aborted || owner.signal !== signal) throw new Error("会话已切换，取消旧凭据解析");
    this.eligible(slot);
    const candidate = { owner, claim, root, endpoint, apiKey: key, collectorKey, bindingId: gatewayIdentity(root, id, key), missing };
    // header/凭据命令可在不改变 owner signal 或认证 generation 时切换地址，不能把新 key 配到旧 root。
    this.assertEndpoint(candidate);
    return candidate;
  }

  /** 预取后重新核验身份与 epoch，再同步注册；共享 builder 同时服务原生登录创建，路由核对不阻断宿主估价策略。 */
  private async createProvider(slot: Slot, candidate: Candidate, epoch: number): Promise<void> {
    const { owner, claim, root, apiKey } = candidate;
    const ctx = owner.ctx;
    const signal = owner.signal;
    if (!ctx) return;
    const registry = ctx.modelRegistry;
    const prepared = await prepareGatewayProvider({
      registry, providerId: claim.connection.providerId, root, apiKey, signal, notify: message => owner.warn(message),
      oauth: owner.host.login?.(slot.providerId),
    });
    // 目录预取期间地址、key 或声明可能变化；重新解析后才同步注册，避免把旧目录安装到新身份。
    const latest = await this.resolve(slot, owner, claim);
    if (latest.bindingId !== candidate.bindingId || slot.epoch !== epoch || signal.aborted || owner.signal !== signal) throw new Error("注册前连接已变化，取消旧模型目录");
    this.eligible(slot);
    registerGatewayProvider(owner.pi, registry, prepared);
    // 先让宿主 materialize 动态目录，再只验证路由；宿主对 cost/limits 的构造不作为失败条件。
    await registry.refreshDiscoverableProviders([slot.providerId], "online");
    verifyGatewayProvider(registry, prepared);
  }

  /**
   * 合并活动 owner 的声明；身份冲突暂停附加，自动候选须正向识别 Magpie，显式声明可发布带诊断的绑定。
   * 所有异步准备后再核对 epoch、身份及同步资格，最后安装共享 adapter；绑定租约独立于任一 owner。
   */
  private async reconcileSlot(slot: Slot): Promise<void> {
    const claims = this.claimsFor(slot.providerId);
    if (claims.length === 0) { this.revoke(slot); return; }
    // 所有 owner 先独立解析，再以 epoch 丢弃过期结果；共享绑定只能代表一致的 root/provider/key。
    const startEpoch = slot.epoch;
    const candidates = await Promise.all(claims.map(({ owner, claim }) => this.resolve(slot, owner, claim)));
    if (slot.epoch !== startEpoch || candidates.some(candidate => !this.owners.has(candidate.owner) || candidate.owner.signal.aborted)) { slot.pending = true; return; }
    const candidate = candidates[0]!;
    if (candidates.some(other => other.bindingId !== candidate.bindingId)) {
      throw new Error("多个活动 owner 声明互斥网关连接，已暂停此 provider 的 usage attachment");
    }
    // 已发布且无诊断的同一身份只更新租约，保留其他 owner 正在使用的 HTTP signal 和宿主缓存。
    if (!candidates.some(value => value.missing) && !slot.binding?.diagnostic && slot.binding?.identity.bindingId === candidate.bindingId && this.auth.usage.providerFor(slot.providerId) === slot.adapter && !slot.binding.signal.aborted) {
      slot.stamp = this.stamp(slot.providerId);
      slot.binding.leases = claims;
      return;
    }
    // 身份切换须在身份 HTTP 前撤销旧读取；同一身份的临时探测失败仍可保留原绑定并附诊断。
    const previous = slot.binding;
    if (previous?.identity.bindingId !== candidate.bindingId) this.revoke(slot);
    const epoch = slot.epoch;
    let diagnostic: string | undefined;
    // 各 owner 的解析完成时间不同；首次认证 HTTP 前同步复核，防止较早完成的候选已被改址。
    for (const current of candidates) this.assertEndpoint(current);
    try {
      await identifyGateway(candidate.root, { apiKey: candidate.apiKey }, candidate.owner.signal);
    } catch (error) {
      diagnostic = sanitizeDiagnostic(error instanceof Error ? error.message : String(error), candidate.apiKey);
      // 自动发现不能仅凭地址猜测 Magpie；显式声明允许保留探测诊断，继续由实际额度请求给出结果。
      if (!claims.some(({ claim }) => claim.explicit)) { this.warn(slot, diagnostic); return; }
    }
    if (!diagnostic) {
      // 只有身份正向识别后才创建 provider；多个 owner 共享 registry 时只注册一次。
      const created = new Set<ModelRegistry>();
      for (const current of candidates) {
        const registry = current.owner.ctx?.modelRegistry;
        if (current.missing && registry && !created.has(registry)) {
          await this.createProvider(slot, current, epoch);
          created.add(registry);
        }
      }
    }
    if (slot.epoch !== epoch || candidate.owner.signal.aborted || !this.owners.has(candidate.owner)) return;
    // 发布前再次解析身份；所有 await 都在最后同步资格检查之前。
    const current = await Promise.all(claims.map(({ owner, claim }) => this.resolve(slot, owner, claim)));
    if (slot.epoch !== epoch || current.some(value => value.bindingId !== candidate.bindingId || value.owner.signal.aborted)) { slot.pending = true; return; }
    this.eligible(slot);
    if (diagnostic && previous && slot.binding === previous && this.auth.usage.providerFor(slot.providerId) === slot.adapter) {
      previous.leases = claims;
      previous.diagnostic = diagnostic;
      slot.stamp = this.stamp(slot.providerId);
      this.warn(slot, diagnostic);
      return;
    }
    // 从撤销旧租约到安装 adapter 之间不再 await；先发布完整 binding，宿主安装时才能读到一致快照。
    if (slot.binding) this.revoke(slot);
    const controller = new AbortController();
    slot.binding = { identity: { providerId: slot.providerId, bindingId: candidate.bindingId }, root: candidate.root, apiKey: candidate.apiKey, collectorKey: candidate.collectorKey, signal: controller.signal, controller, diagnostic, leases: claims };
    slot.adapter ??= createUsageProvider({
      providerId: slot.providerId,
      current: () => slot.binding,
      check: async (params: UsageFetchParams) => {
        await this.request(slot);
        const binding = slot.binding;
        if (!binding || binding.signal.aborted || params.credential.type !== "api_key" || params.credential.apiKey !== binding.collectorKey) return undefined;
        return binding;
      },
    });
    this.auth.usage.setProvider(slot.providerId, slot.adapter, candidate.collectorKey);
    slot.stamp = this.stamp(slot.providerId);
    slot.diagnostic = undefined;
    if (diagnostic) this.warn(slot, diagnostic);
  }
}
