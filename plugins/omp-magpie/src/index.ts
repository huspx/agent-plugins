import { defaultRankingStrategy } from '@oh-my-pi/pi-ai/usage/registry';
import { VERSION } from '@oh-my-pi/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { resolveConfigValue } from '@oh-my-pi/pi-coding-agent/config/resolve-config-value';
import { getPluginSettings } from '@oh-my-pi/pi-coding-agent/extensibility/plugins';
import { createBindingOwner, type HostServices } from './bindings.ts';
import { isSupportedHostVersion, MIN_OMP_VERSION } from './compatibility.ts';
import { parseConfig } from './config.ts';
import { sanitizeDiagnostic } from './gateway.ts';
import { MagpieOnboarding } from './onboarding.ts';

/** 最低版本门禁仅表达允许加载范围；factory 注册登录与命令，会话 hooks 持有独立 usage owner。 */
export default async function ompMagpie(pi: ExtensionAPI): Promise<void> {
  if (!isSupportedHostVersion(VERSION)) {
    pi.on('session_start', (_event, ctx) => {
      ctx.ui.notify(`omp-magpie: 需要 OMP >=${MIN_OMP_VERSION} 的稳定版本，当前为 ${VERSION}；插件已停止注册`, 'error');
    });
    return;
  }

  let current: ExtensionContext | undefined;
  let onboarding: MagpieOnboarding;
  const host: HostServices = {
    defaultRankingStrategy,
    resolveConfigValue,
    login: providerId => onboarding.login(providerId),
  };
  const owner = createBindingOwner(pi, message => current?.ui.notify(message, 'warning'), host);
  onboarding = new MagpieOnboarding(pi, owner, host, () => current);
  const configure = async (ctx: ExtensionContext): Promise<void> => {
    current = ctx;
    try {
      const config = parseConfig(await getPluginSettings('omp-magpie', ctx.cwd));
      await owner.configure(ctx, config);
    } catch (error) {
      // 无效的新配置使旧声明失去授权，不能继续展示上一连接的缓存用量。
      owner.close();
      ctx.ui.notify(sanitizeDiagnostic(error instanceof Error ? error.message : String(error)), 'error');
    }
  };

  pi.registerCommand('magpie', {
    description: '配置 Magpie 用量连接；setup 选择已有 provider，help 查看 CLI 用法',
    async handler(args, ctx) {
      current = ctx;
      try {
        await onboarding.command(args, ctx);
      } catch (error) {
        const message = sanitizeDiagnostic(error instanceof Error ? error.message : 'Magpie 配置失败');
        if (ctx.hasUI) ctx.ui.notify(message, 'error');
        else throw new Error(message);
      }
    },
  });
  // 会话进入时完整加载声明；真实请求前复核宿主的地址与认证，避免用旧身份发起管理请求。
  pi.on('session_start', async (_event, ctx) => {
    await configure(ctx);
  });
  pi.on('session_switch', async (_event, ctx) => {
    await configure(ctx);
  });
  pi.on('before_agent_start', async (_event, ctx) => {
    current = ctx;
    await owner.reconcile(ctx);
  });
  pi.on('before_provider_request', async (_event, ctx) => {
    current = ctx;
    await owner.reconcile(ctx);
  });
  pi.on('session_shutdown', () => {
    onboarding.close();
    owner.close();
    current = undefined;
  });
  await onboarding.initialize();
}
