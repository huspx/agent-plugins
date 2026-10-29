import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { ConnectionConfig, PluginConfig } from './config.ts';
import { sanitizeDiagnostic } from './gateway.ts';
import { readProviderRoot } from './provider.ts';

/** 配置向导只读宿主目录；确认后的核验、持久化和调和由调用方统一负责。 */
export interface SetupServices {
  /** 真实命令传入发起会话的 signal；宿主对话框与异步返回后的保存边界共用它。 */
  signal?: AbortSignal;
  load(cwd: string): Promise<PluginConfig>;
  issue(providerId: string): string | undefined;
  save(ctx: ExtensionContext, connection: ConnectionConfig): Promise<void>;
  output(ctx: ExtensionContext, text: string): void;
}

/** 命令的公开解析结果；没有 provider 的 setup 只允许交互选择或显示用法。 */
export type SetupOptions =
  | { action: 'help' }
  | { action: 'list' }
  | { action: 'setup'; providerId?: string; yes: boolean };

const usage = [
  '/magpie setup：选择已有 provider 并确认用量连接',
  '/magpie setup --list：只列出本机候选与资格诊断，不访问网关',
  '/magpie setup --provider <id>：只预览连接',
  '/magpie setup --provider <id> --yes：核验并保存连接',
  '/magpie help：显示用法；API key 请通过原生 /login 或 omp login 设置',
].join('\n');

function validProviderId(value: string): boolean {
  return value.length > 0 && !/[\s/\\\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/** 严格解析公开命令参数；错误不包含原始参数，避免误传的凭据进入输出。 */
export function parseSetupArgs(args: string): SetupOptions {
  const words = args.trim().split(/\s+/u).filter(Boolean);
  if (words[0] === 'setup') words.shift();
  if (words.length === 1 && (words[0] === 'help' || words[0] === '--help' || words[0] === '-h')) {
    return { action: 'help' };
  }
  let providerId: string | undefined;
  let yes = false;
  let list = false;
  const seen = new Set<string>();
  for (let index = 0; index < words.length; index++) {
    const flag = words[index]!;
    if (!['--provider', '--yes', '--list'].includes(flag)) {
      throw new Error('omp-magpie: 不支持的参数；请使用 /magpie help');
    }
    if (seen.has(flag)) throw new Error('omp-magpie: 参数不得重复；请使用 /magpie help');
    seen.add(flag);
    if (flag === '--yes') yes = true;
    else if (flag === '--list') list = true;
    else {
      const value = words[++index];
      if (!value || value.startsWith('-')) throw new Error('omp-magpie: --provider 缺少值');
      providerId = value;
    }
  }
  // 列表、预览与显式保存互斥；非交互保存必须同时明确 provider 和确认标记。
  if (list && (providerId !== undefined || yes)) throw new Error('omp-magpie: --list 不能与连接参数或 --yes 同用');
  if (providerId !== undefined && !validProviderId(providerId)) {
    throw new Error('omp-magpie: provider ID 不得包含 slash、空白或控制字符');
  }
  if (providerId === undefined && yes) throw new Error('omp-magpie: --yes 必须同时指定 --provider');
  return list ? { action: 'list' } : { action: 'setup', providerId, yes };
}

/** 展示值只来自当前 OMP provider；连接声明不保存已有 provider 的地址副本。 */
export interface SetupPrefill {
  connection: ConnectionConfig;
  root?: string;
  gatewayIssue?: string;
}

/** providerRoot 已由宿主读取层规范化，合法路径前缀不能再次剥离。 */
export function prefillSetupConnection(
  providerId: string,
  existing: ConnectionConfig | undefined,
  providerRoot: string | undefined,
): SetupPrefill {
  // 创建声明保留启动能力；展示地址仍来自 providerRoot，不用该声明回填缺失 endpoint。
  const connection: ConnectionConfig = existing?.providerId === providerId && existing.createProvider
    ? { ...existing }
    : { providerId, createProvider: false };
  return {
    connection,
    root: providerRoot,
    ...(providerRoot
      ? {}
      : { gatewayIssue: '无法取得有效网关地址，请在 OMP 模型配置中修正 provider 的 endpoint 后重试' }),
  };
}

function authentication(ctx: ExtensionContext, connection: ConnectionConfig): string {
  // 只描述宿主认证来源，不解析配置引用，也不将任何 key 放入确认页。
  const variable = (name: string): string => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '[变量名无效]';
  const source = ctx.modelRegistry.authStorage.keys.source(connection.providerId);
  if (!source) return '继承宿主有效认证或本机无鉴权；确认后核验';
  switch (source.kind) {
    case 'env':
      return source.envVar ? `宿主环境变量 ${variable(source.envVar)}` : '宿主环境变量';
    case 'api_key':
      return '宿主已保存的 API key（不显示值，无需重新输入）';
    case 'oauth':
      return '宿主 OAuth（不符合附加资格）';
    case 'runtime':
      return '宿主运行时认证（不显示值）';
    case 'config':
      return '宿主配置认证（不显示值）';
  }
}

function providerIssue(ctx: ExtensionContext, services: SetupServices, id: string): string | undefined {
  if (!ctx.modelRegistry.hasProvider(id) && !ctx.modelRegistry.getDiscoveryProviderId(id)) {
    return 'provider 不存在，请先在 OMP 模型配置中添加 provider 或使用原生登录创建';
  }
  return services.issue(id);
}

function summary(ctx: ExtensionContext, prefill: SetupPrefill, issue: string | undefined): string {
  return [
    `provider ID：${prefill.connection.providerId}`,
    `网关地址：${prefill.root ?? '[未设置或无效]'}`,
    `认证来源：${authentication(ctx, prefill.connection)}`,
    `资格：${sanitizeDiagnostic(issue ?? '同步检查通过；确认后核验网关身份及 collector 凭据')}`,
    ...(prefill.gatewayIssue ? [prefill.gatewayIssue] : []),
  ].join('\n');
}

/** 合并本机模型、零模型 discovery、当前模型和已有连接；只读认证来源，不读取 key。 */
function candidates(ctx: ExtensionContext, config: PluginConfig): string[] {
  const registry = ctx.modelRegistry;
  const ids = new Set(registry.getAll('all').map(model => model.provider));
  for (const id of registry.getDiscoverableProviders()) ids.add(id);
  if (ctx.model) ids.add(ctx.model.provider);
  for (const connection of config.connections) ids.add(connection.providerId);
  return [...ids].filter(validProviderId).sort();
}

/** 运行已有 provider 配置引导；无 UI 时必须显式 --yes，取消或迟到的确认永不调用 save。 */
export async function runSetup(args: string, ctx: ExtensionContext, services: SetupServices): Promise<void> {
  services.signal?.throwIfAborted();
  let options: SetupOptions;
  try {
    options = parseSetupArgs(args);
  } catch (error) {
    services.output(ctx, error instanceof Error ? error.message : 'omp-magpie: 参数无效，请使用 /magpie help');
    return;
  }
  if (options.action === 'help') {
    services.output(ctx, usage);
    return;
  }
  const config = await services.load(ctx.cwd);
  services.signal?.throwIfAborted();
  const ids = candidates(ctx, config);
  const connections = new Map(config.connections.map(connection => [connection.providerId, connection]));
  const issueFor = (id: string): string | undefined => providerIssue(ctx, services, id);
  if (options.action === 'list') {
    services.output(
      ctx,
      ids.length
        ? ids.map(id => `${id}：${sanitizeDiagnostic(issueFor(id) ?? '同步资格通过；保存时仍需网关及凭据核验')}`).join(
          '\n',
        )
        : 'omp-magpie: 尚无本机候选 provider，可先通过原生登录或模型配置添加',
    );
    return;
  }
  // 交互选择仅确定已有 ID；此阶段不探测网关，也不保存用户设置。
  let id = options.providerId;
  if (!id && ctx.hasUI) {
    const manual = '手动输入 provider ID';
    const selected = await ctx.ui.select('Magpie：选择已有 provider', [
      ...ids.map(providerId => ({
        label: providerId,
        description: sanitizeDiagnostic(issueFor(providerId) ?? '同步资格通过；确认后核验'),
      })),
      manual,
    ], { signal: services.signal });
    services.signal?.throwIfAborted();
    if (selected === undefined) return;
    if (selected === manual) {
      const entered = await ctx.ui.input('已有 provider ID', undefined, { signal: services.signal });
      services.signal?.throwIfAborted();
      if (entered === undefined) return;
      id = entered.trim();
    } else id = selected;
  }
  if (!id) {
    services.output(ctx, `${usage}\n非交互模式请先使用 --list，再指定 --provider 预览；仅 --yes 会保存。`);
    return;
  }
  if (!validProviderId(id)) {
    services.output(ctx, 'omp-magpie: provider ID 无效');
    return;
  }
  const prefill = prefillSetupConnection(id, connections.get(id), readProviderRoot(ctx.modelRegistry, id));
  const issue = issueFor(id);
  // CLI 输出摘要后等待显式 --yes；TUI 必须由确认项进入同一保存边界。
  if (!ctx.hasUI) {
    services.output(ctx, summary(ctx, prefill, issue));
    if (issue || prefill.gatewayIssue) return;
    if (!options.yes) {
      services.output(ctx, '仅预览，未保存。请在同一命令末尾添加 --yes，确认后核验并保存此连接。');
      return;
    }
    await services.save(ctx, prefill.connection);
    return;
  }
  if (issue || prefill.gatewayIssue) {
    services.output(ctx, summary(ctx, prefill, issue));
    return;
  }
  const action = await ctx.ui.select(summary(ctx, prefill, undefined), ['确认连接', '取消'], {
    signal: services.signal,
  });
  // 宿主可能在取消后才返回用户选择，不能只依赖对话框处理 signal。
  services.signal?.throwIfAborted();
  if (action === '确认连接') await services.save(ctx, prefill.connection);
}
