import { isDeepStrictEqual } from "node:util";
import {
  getOAuthProvider, getOAuthProviders, registerOAuthProvider, unregisterOAuthProvider,
} from "@oh-my-pi/pi-ai";
import type { AuthStorage, OAuthLoginCallbacks, OAuthProviderInterface } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings, PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import type { BindingOwner, HostServices } from "./bindings.ts";
import { parseConfig, upsertConnection, type ConnectionConfig, type PluginConfig } from "./config.ts";
import { identifyGateway, normalizeGatewayRoot, sanitizeDiagnostic } from "./gateway.ts";
import { readProviderRoot, hasGatewayLogin, prepareGatewayProvider, registerGatewayProvider } from "./provider.ts";
import { withLoginPrompts } from "./prompts.ts";
import { runSetup } from "./setup.ts";

const PLUGIN_NAME = "omp-magpie";
type LoginEntry = { definition: OAuthProviderInterface; owners: Set<MagpieOnboarding> };
const logins = new Map<string, LoginEntry>();

/** 原始认证引用也可能直接包含 secret；先遮蔽较长值，避免较短引用打断实际 key 的匹配。 */
function safeDiagnostic(message: string, key?: string, reference?: string): string {
  return (reference?.length ?? 0) > (key?.length ?? 0)
    ? sanitizeDiagnostic(sanitizeDiagnostic(message, reference), key)
    : sanitizeDiagnostic(sanitizeDiagnostic(message, key), reference);
}

function failure(error: unknown, key?: string, reference?: string): Error {
  return new Error(safeDiagnostic(error instanceof Error ? error.message : "Magpie 配置失败", key, reference));
}

/**
 * 登录与配置的协调层：只保存非密钥连接设置，原生 login 将返回的认证引用交给宿主存储。
 * 登录入口按 factory 引用共享，独立于模型注册；不能为展示 /login 项而夺取已有 provider 的模型所有权。
 */
export class MagpieOnboarding {
  private readonly loginIds = new Set<string>();
  private readonly activations = new Map<string, () => void>();
  private closed = false;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "registerProvider">,
    private readonly owner: BindingOwner,
    private readonly host: HostServices,
    private readonly context: () => ExtensionContext | undefined,
  ) {}

  /** factory 阶段即可注册登录；不探测网关、不创建模型，也不要求 session_start 已执行。 */
  async initialize(cwd = getProjectDir()): Promise<void> {
    this.login("magpie");
    const config = await this.load(cwd);
    for (const connection of config.connections) if (connection.createProvider) this.login(connection.providerId);
  }

  /** 只读连接声明；认证引用和实际凭据均由 OMP 管理。 */
  async load(cwd: string): Promise<PluginConfig> {
    return parseConfig(await getPluginSettings(PLUGIN_NAME, cwd));
  }

  /** 返回本插件持有的登录定义；已有外部或内建登录不覆盖，宿主包装后的同一 login 函数仍视为本入口。 */
  login(providerId: string): ProviderConfig["oauth"] {
    let entry = logins.get(providerId);
    const current = getOAuthProvider(providerId);
    // 宿主可能包装登录定义，因此按 login 函数识别所有权；被外部接管后停止复用。
    if (entry && current && current.login !== entry.definition.login) return undefined;
    if (!entry) {
      if (getOAuthProviders().some(provider => provider.id === providerId)) return undefined;
      const created: LoginEntry = {
        owners: new Set(),
        definition: {
          id: providerId,
          name: providerId === "magpie" ? "Magpie" : `Magpie · ${providerId}`,
          async login(callbacks) {
            let selected: MagpieOnboarding | undefined;
            // 多 factory 共用一个登录定义，优先交给仍有交互 UI 的活动会话。
            for (const candidate of created.owners) {
              if (candidate.closed) continue;
              selected = candidate;
              if (candidate.context()?.hasUI) break;
            }
            if (!selected) throw new Error("omp-magpie: 登录入口已关闭，请重启会话");
            return selected.performLogin(providerId, callbacks);
          },
        },
      };
      entry = created;
      logins.set(providerId, entry);
    }
    entry.owners.add(this);
    this.loginIds.add(providerId);
    if (!current) registerOAuthProvider(entry.definition);
    return entry.definition;
  }

  /** 配置命令在首次等待前固定发起会话；迟到的确认不能借用新会话的 ID 或 owner signal。 */
  async command(args: string, ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const signal = this.owner.signal;
    const check = (): void => {
      if (!this.currentSession(ctx, sessionId, signal)) throw new DOMException("omp-magpie: 会话或连接已变化，取消旧配置", "AbortError");
    };
    await runSetup(args, ctx, {
      signal,
      load: cwd => this.load(cwd),
      issue: providerId => this.owner.attachmentIssue(providerId),
      save: (context, connection) => this.saveAttachment(context, connection, signal, check),
      output: (context, text) => this.output(context, text),
    });
  }

  /** CLI 输出是显式请求的命令结果；UI 通知与输出都只能接收已清理、不含凭据的摘要。 */
  private output(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else process.stdout.write(`${text}\n`);
  }

  /** 在确认时读取最新连接列表，保留其他连接；公开 setter 写用户级设置，项目覆盖仍由宿主决定。 */
  private async persist(cwd: string, connection: ConnectionConfig, check: () => void): Promise<PluginConfig> {
    check();
    const latest = await this.load(cwd);
    check();
    const next = upsertConnection(latest, connection);
    parseConfig({ autoAttach: next.autoAttach, connections: JSON.stringify(next.connections) });
    // setter 写用户层；重读最终合并结果，防止把仍被项目覆盖的声明误报为生效。
    await new PluginManager(cwd).setPluginSetting(PLUGIN_NAME, "connections", JSON.stringify(next.connections));
    check();
    const effective = await this.load(cwd);
    check();
    const saved = effective.connections.find(value => value.providerId === connection.providerId);
    if (!isDeepStrictEqual(saved, connection)) {
      throw new Error("omp-magpie: 用户设置已写入，但项目覆盖仍在生效，请检查项目的插件覆盖配置");
    }
    return effective;
  }

  /** 确认后核验所选网关；沿用命令发起时的会话快照，失效流程不得写入或重新激活 owner。 */
  private async saveAttachment(ctx: ExtensionContext, connection: ConnectionConfig, signal: AbortSignal, check: () => void): Promise<void> {
    let key: string | undefined;
    try {
      check();
      const snapshot = await this.owner.inspect(connection);
      // inspect 不发布绑定，确认后的网络核验仍须受发起会话的取消信号约束。
      check();
      key = snapshot.apiKey;
      await identifyGateway(snapshot.root, { apiKey: key }, signal);
      const config = await this.persist(ctx.cwd, connection, check);
      check();
      await this.owner.configure(ctx, config);
      this.output(ctx, `omp-magpie: 已保存 ${connection.providerId} 的用量连接`);
    } catch (error) { throw failure(error, key); }
  }

  private currentSession(ctx: ExtensionContext, sessionId: string, signal?: AbortSignal): boolean {
    const current = this.context();
    return !this.closed && current?.modelRegistry.authStorage === ctx.modelRegistry.authStorage
      && current.sessionManager.getSessionId() === sessionId && (!signal || (!signal.aborted && this.owner.signal === signal));
  }

  /**
   * 原生宿主在 login 返回后才保存认证引用；按存储引用的 generation 激活，实际凭据继续由宿主解析。
   * 监听属于此 factory，成功、重入和 shutdown 都释放；不轮询、不依赖延时猜测模型刷新完成。
   */
  private activateAfterLogin(ctx: ExtensionContext, config: PluginConfig, providerId: string, reference: string, key: string, sessionId: string, signal?: AbortSignal): void {
    this.activations.get(providerId)?.();
    const activate = () => {
      if (!ctx.modelRegistry.authStorage.credentials.list(providerId).some(row => row.credential.type === "api_key" && row.credential.key === reference)) return;
      unsubscribe();
      this.activations.delete(providerId);
      if (!this.currentSession(ctx, sessionId, signal)) return;
      // 存储出现本次引用且发起会话仍活动时，再由 configure 解析当前实际 key 并调和绑定。
      void this.owner.configure(ctx, config).catch(error => ctx.ui.notify(failure(error, key, reference).message, "error"));
    };
    const unsubscribe = ctx.modelRegistry.authStorage.credentials.onGeneration(activate);
    this.activations.set(providerId, unsubscribe);
    activate();
  }

  /**
   * 登录 ID 已固定。新建连接先确认、识别和预取，再保存设置；返回原始认证引用，由宿主持久化和解析。
   * CLI 没有 session context，临时 registry 只用于检查现有配置；模型在下一次会话启动创建，不篡改原生 CLI 生命周期。
   */
  private async performLogin(providerId: string, callbacks: OAuthLoginCallbacks): Promise<string> {
    const ctx = this.context();
    const cwd = ctx?.cwd ?? getProjectDir();
    const sessionId = ctx?.sessionManager.getSessionId() ?? "";
    const ownerSignal = ctx && this.owner.ctx ? this.owner.signal : undefined;
    const signal = callbacks.signal && ownerSignal ? AbortSignal.any([callbacks.signal, ownerSignal]) : callbacks.signal ?? ownerSignal;
    let ownedAuth: AuthStorage | undefined;
    let key: string | undefined;
    let reference: string | undefined;
    try {
      const config = await this.load(cwd);
      const previous = config.connections.find(value => value.providerId === providerId);
      // 有会话时复用 registry；独立 CLI login 用临时 registry 检查配置，退出时关闭自有认证句柄。
      const registry = ctx?.modelRegistry ?? new ModelRegistry(ownedAuth = await discoverAuthStorage(undefined, { cwd }));
      const auth = registry.authStorage;
      // 已有原生配置保留其模型所有权；本入口仅重新登录本插件创建的 provider。
      const exists = registry.hasProvider(providerId) || !!registry.getDiscoveryProviderId(providerId);
      if (exists && !hasGatewayLogin(registry, providerId)) {
        throw new Error(`omp-magpie: ${providerId} 已有宿主配置，请使用 /magpie setup 选择它；登录不会覆盖现有 provider`);
      }
      if (this.host.defaultRankingStrategy(providerId) || auth.credentials.hasOAuth(providerId) || auth.keys.source(providerId)?.kind === "oauth") {
        throw new Error("omp-magpie: 此 provider 有原生 ranking 或 OAuth，请使用独立网关 ID");
      }
      if (ctx && this.owner.ctx) {
        const issue = this.owner.attachmentIssue(providerId);
        if (issue) throw new Error(issue);
      } else if (auth.usage.providerFor(providerId)) {
        throw new Error("omp-magpie: 此 provider 已有其他 usage adapter，请使用独立网关 ID");
      }
      const providerRoot = readProviderRoot(registry, providerId);
      const preset = providerRoot ?? previous?.baseUrl ?? "http://127.0.0.1:3425";
      // CLI login 无 ExtensionContext；TUI/首次设置沿用宿主的 secret prompt，不能因 hasUI 缺省而误接管其终端。
      const terminalLogin = !ctx && process.argv.slice(1).includes("login");
      const check = (operationSignal = signal): void => {
        if (this.closed || operationSignal?.aborted || (ctx && !this.currentSession(ctx, sessionId, ownerSignal))) {
          throw new DOMException("omp-magpie: 会话或连接已变化，取消旧登录", "AbortError");
        }
        // 重新登录的确认绑定发起时的地址；网络或设置等待期间切址也不能提交旧网关的 key。
        if (exists && readProviderRoot(registry, providerId) !== providerRoot) throw new Error("omp-magpie: provider 地址已变化，请重新登录");
      };
      let activate: (() => void) | undefined;
      const result = await withLoginPrompts({ ...callbacks, signal }, terminalLogin, async (prompt, signal) => {
        check(signal);
        if (exists && !providerRoot) throw new Error("omp-magpie: 无法取得 provider 地址，请先在 OMP 中配置");
        const baseUrl = exists ? previous?.baseUrl ?? `${providerRoot}/v1`
          : (await prompt({ message: `Magpie 网关地址 [${preset}]`, allowEmpty: true })).trim() || preset;
        const root = exists ? providerRoot! : normalizeGatewayRoot(baseUrl);
        reference = await prompt({ message: "Magpie gateway API key（支持环境变量名、!command 或字面值）", secret: true });
        // 保留输入原文给原生存储；解析与命令缓存完全遵循宿主，只用本次实际值核验 HTTP 身份。
        key = await this.host.resolveConfigValue(reference);
        if (!key?.trim() || key === "N/A") throw new Error("omp-magpie: API key 缺失或为空");
        const actualKey = key;
        const originalReference = reference;
        const confirmed = await prompt({
          message: safeDiagnostic(`确认连接：provider ID=${providerId}；网关=${root}；认证=由宿主管理。输入 yes 保存`, actualKey, originalReference),
        });
        if (confirmed.trim().toLowerCase() !== "yes") throw new DOMException("omp-magpie: 登录已取消，未保存连接", "AbortError");
        check(signal);
        const connection: ConnectionConfig = { providerId, baseUrl, createProvider: true };
        // 确认后才识别并预取；成功前不写连接，原生认证存储在返回引用后提交。
        await identifyGateway(root, { apiKey: actualKey }, signal);
        check(signal);
        const oauth = this.login(providerId);
        if (!oauth) throw new Error("omp-magpie: 登录入口已由其他实现接管，取消旧登录准备");
        const prepared = await prepareGatewayProvider({
          registry, providerId, root, apiKey: actualKey, signal, oauth,
          notify: message => callbacks.onProgress?.(safeDiagnostic(message, actualKey, originalReference)),
        });
        check(signal);
        const saved = await this.persist(cwd, connection, () => check(signal));
        check(signal);
        if (ctx) {
          if (!exists) registerGatewayProvider(this.pi, registry, prepared);
          activate = () => this.activateAfterLogin(ctx, saved, providerId, originalReference, actualKey, sessionId, ownerSignal);
        }
        return originalReference;
      });
      check();
      // 同一引用的激活会同步替换 owner signal，必须等提示驱动完成最后一次取消检查。
      activate?.();
      return result;
    } catch (error) { throw failure(error, key, reference); }
    finally { ownedAuth?.close(); }
  }

  /** 只撤销本 factory 的登录引用和等待；外部接管的 login 及其他 owner 继续保留。 */
  close(): void {
    this.closed = true;
    for (const unsubscribe of this.activations.values()) unsubscribe();
    this.activations.clear();
    for (const id of this.loginIds) {
      const entry = logins.get(id);
      if (!entry) continue;
      entry.owners.delete(this);
      if (entry.owners.size) continue;
      if (getOAuthProvider(id)?.login === entry.definition.login) unregisterOAuthProvider(id);
      logins.delete(id);
    }
    this.loginIds.clear();
  }
}
