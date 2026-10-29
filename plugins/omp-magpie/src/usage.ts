import type {
  UsageAmount,
  UsageFetchParams,
  UsageLimit,
  UsageProvider,
  UsageReport,
  UsageUnit,
} from '@oh-my-pi/pi-ai/usage';
import { fetchKeyLimits, fetchQuotas, GatewayError, sanitizeDiagnostic } from './gateway.ts';

/** providerId 使用宿主实际 alias；bindingId 是网关 root/provider/key 的指纹，不包含明文 key。 */
export interface UsageIdentity {
  providerId: string;
  bindingId: string;
}
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
const record = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): string => typeof value === 'string' ? sanitizeDiagnostic(value) : '';
const units: Record<string, true | undefined> = {
  percent: true,
  tokens: true,
  requests: true,
  credits: true,
  usd: true,
  minutes: true,
  bytes: true,
  unknown: true,
};
const budgetPeriods: Record<string, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  hours: 'Hours',
  days: 'Days',
  total: 'Total',
};
const nonnegative = (value: unknown): value is number => number(value) && value >= 0;
const integer = (value: unknown): value is number => nonnegative(value) && Number.isInteger(value);
function date(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
/** 有使用比例时以其判断耗尽，否则使用剩余额度；缺少两种读数时不推断账户可用性。 */
function status(amount: UsageAmount): 'ok' | 'exhausted' | 'unknown' {
  if (amount.usedFraction !== undefined) return amount.usedFraction >= 1 ? 'exhausted' : 'ok';
  if (amount.remaining !== undefined) return amount.remaining <= 0 ? 'exhausted' : 'ok';
  return 'unknown';
}
function failure(value: unknown, source: string): string {
  if (value instanceof GatewayError) {
    if (value.status === 403) return `${source}: permission denied`;
    if (value.status === 404) return `${source}: endpoint not supported`;
    if (value.status === 401) return `${source}: gateway authentication failed`;
  }
  return `${source}: unable to read${
    value instanceof Error ? ` (${text(value.message)})` : ' (invalid response format)'
  }`;
}

/**
 * 只映射本次响应或错误，不借用历史报告；fetchedAt 为 Unix 毫秒，部分失败保留可用部分并附诊断。
 * 窗口 used/remaining 为百分数，fraction 才除以 100；amount/limit 保留其原始计量单位。
 * key 的 costLimit/cost/costLeft 是美元总金额，直接映射 usd，不做模型费率的百万倍换算；人民币余额保持未知单位及原文。
 * 账号读取错误时保留服务端读数但标为 unknown；完全无读数仍返回带 unknown 项的报告。
 */
export function normalizeUsage(
  identity: UsageIdentity,
  quotas: unknown,
  keyLimits: unknown,
  fetchedAt: number,
): UsageReport {
  const report: UsageReport = {
    provider: identity.providerId,
    fetchedAt,
    metadata: { accountId: identity.bindingId },
    limits: [],
    notes: [],
  };
  const notes = report.notes!;
  const add = (id: string, label: string, accountId: string, amount: UsageAmount, extra: Partial<UsageLimit> = {}) => {
    report.limits.push({
      id,
      label,
      scope: { provider: identity.providerId, accountId },
      amount,
      status: status(amount),
      ...extra,
    });
  };
  // 订阅接口失败只形成诊断，不阻断后面的 key 预算；账号之间保留各自 scope，不汇总不同额度池。
  if (!record(quotas) || quotas.object !== 'list' || !Array.isArray(quotas.data)) {
    notes.push(failure(quotas, 'Subscription quotas'));
  } else {
    const accounts = new Map<string, number>();
    const labels = new Map<string, number>();
    for (const card of quotas.data) {
      if (!record(card)) {
        notes.push('Subscription quotas: ignored an invalid account card');
        continue;
      }
      // 业务字段区分账号，同字段的重复卡片再以出现次数区分，防止宿主把两个账号读数合并。
      const base = JSON.stringify([
        identity.bindingId,
        card.provider ?? '',
        card.kind ?? '',
        card.user || '',
        card.alias || '',
        card.name || '',
        card.plan || '',
        card.seat || '',
        card.from || '',
      ]);
      const occurrence = accounts.get(base) ?? 0;
      accounts.set(base, occurrence + 1);
      const accountId = occurrence ? JSON.stringify([base, occurrence]) : base;
      const accountLabel =
        [text(card.provider), text(card.alias) || text(card.name) || text(card.user)].filter(Boolean).join(' · ')
        || 'Magpie account';
      const labelOccurrence = labels.get(accountLabel) ?? 0;
      labels.set(accountLabel, labelOccurrence + 1);
      const label = `${accountLabel}${labelOccurrence ? ` #${labelOccurrence + 1}` : ''}`;
      const cardNotes: string[] = [];
      const error = text(card.error);
      if (error) cardNotes.push(`Account read error: ${error}; values may be stale`);
      if (error || card.readDeferred) {
        for (const [key, name] of [['readAt', 'Read at'], ['asOf', 'Data as of']] as const) {
          if (date(card[key]) !== undefined) cardNotes.push(`${name}: ${text(card[key])}`);
        }
      }
      if (card.readDeferred) cardNotes.push('Read deferred');
      // 库存属于 upstream 账号；只说明一次，不合并成宿主 OAuth 的可兑换库存。
      if (record(card.resets)) {
        const resets = card.resets;
        const counts: string[] = [];
        if (resets.byWindow === true) {
          if (integer(resets.fiveHour)) counts.push(`5h ${resets.fiveHour}`);
          if (integer(resets.weekly)) counts.push(`Weekly ${resets.weekly}`);
        } else if (integer(resets.count)) counts.push(`${resets.count}`);
        const expiry = date(resets.until) === undefined ? 'expiry unknown' : `next expiry ${text(resets.until)}`;
        notes.push(
          `${label} · Reset credits${resets.team === true ? ' (team)' : ''}: ${
            counts.join('; ') || 'count unknown'
          }; ${expiry}${cardNotes.length ? `; ${cardNotes.join('; ')}` : ''}`,
        );
      }
      for (const [index, note] of cardNotes.entries()) cardNotes[index] = `${label}: ${note}`;
      // 每个窗口独立映射；同名但不同 pool 或重复出现的窗口也必须有独立 limit ID。
      const windows = Array.isArray(card.windows) ? card.windows : [];
      const names = new Map<string, number>();
      for (const window of windows) {
        if (!record(window)) continue;
        const name = text(window.name);
        // 缺省名称仍沿用既有身份值，面板标签独立使用英文。
        const identityName = name || '配额窗口';
        const pool = text(window.pool);
        const group = JSON.stringify([identityName, pool]);
        const nth = names.get(group) ?? 0;
        names.set(group, nth + 1);
        const id = JSON.stringify([accountId, identityName, pool, nth]);
        const windowLabel = `${label} · ${name || 'Quota window'}${pool ? ` · ${pool}` : ''}${
          nth ? ` #${nth + 1}` : ''
        }`;
        const entryNotes = [...cardNotes];
        const note = (value: string) => entryNotes.push(`${value} (${windowLabel})`);
        const display = text(window.display);
        let amount: UsageAmount = { unit: 'unknown' };
        if (window.text === true) { if (!display) note('Text information, no numeric quota'); }
        else if (window.unlimited !== true) {
          if (number(window.used) || number(window.remaining)) {
            amount = { unit: 'percent', limit: 100 };
            if (number(window.used)) {
              amount.used = window.used;
              amount.usedFraction = window.used / 100;
            }
            if (number(window.remaining)) {
              amount.remaining = window.remaining;
              amount.remainingFraction = window.remaining / 100;
            }
          }
          if (number(window.limit) && window.limit > 0) {
            const rawUnit = typeof window.unit === 'string' ? window.unit.trim().toLowerCase() : '';
            const unit: UsageUnit = Object.hasOwn(units, rawUnit) ? rawUnit as UsageUnit : 'unknown';
            if (number(window.amount)) {
              amount = {
                unit,
                used: window.amount,
                limit: window.limit,
                remaining: window.limit - window.amount,
                ...(amount.usedFraction === undefined ? {} : { usedFraction: amount.usedFraction }),
                ...(amount.remainingFraction === undefined ? {} : { remainingFraction: amount.remainingFraction }),
              };
              note(
                `Used ${window.amount} / ${window.limit} ${rawUnit || 'unknown unit'}${
                  window.amount > window.limit ? `; over by ${window.amount - window.limit}` : ''
                }`,
              );
            } else note(`Limit ${window.limit} ${rawUnit || 'unknown unit'}; usage unknown`);
          }
          if (
            (amount.usedFraction !== undefined && amount.usedFraction > 1)
            || (amount.remainingFraction !== undefined && amount.remainingFraction < 0)
          ) note('Server percentage indicates overage');
        }
        const resetsAt = date(window.resetsAt);
        add(
          id,
          window.text === true
            ? `${display || 'Text information'} · ${windowLabel}`
            : `${windowLabel}${window.unlimited === true ? ' · Unlimited' : ''}`,
          accountId,
          amount,
          {
            window: { id: group, label: name || 'Quota window', ...(resetsAt === undefined ? {} : { resetsAt }) },
            notes: entryNotes,
            status: error || window.text === true ? 'unknown' : window.unlimited === true ? 'ok' : status(amount),
          },
        );
      }
      // 余额按货币片段分别展示，不把 balanceSplit 再加到总额；人民币没有对应宿主单位，保留原文且标 unknown。
      if (typeof card.balance === 'string') {
        const balance = card.balance;
        for (const [index, part] of balance.split(' · ').entries()) {
          const match = /^(\$|USD\s*|¥|CNY\s*|RMB\s*)([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(part.trim());
          const amount: UsageAmount = { unit: 'unknown' };
          if (match && Number.isFinite(Number(match[2]))) {
            amount.unit = match[1] === '$' || match[1]!.startsWith('USD') ? 'usd' : 'unknown';
            amount.remaining = Number(match[2]);
          }
          add(
            JSON.stringify([accountId, 'balance', index]),
            `${label} · Balance${amount.unit === 'usd' ? '' : ` ${text(part)}`}`,
            accountId,
            amount,
            { notes: cardNotes, status: error ? 'unknown' : status(amount) },
          );
        }
      }
      if (!windows.length && typeof card.balance !== 'string') {
        add(JSON.stringify([accountId, 'empty']), card.unlimited === true ? `${label} · Unlimited` : label, accountId, {
          unit: 'unknown',
        }, {
          status: error ? 'unknown' : card.unlimited === true ? 'ok' : 'unknown',
          notes: [...cardNotes, card.unlimited === true ? 'Unlimited' : 'No quota data available'],
        });
      }
    }
  }
  // 无鉴权连接不会读取 key 预算，undefined 因而不报错；显式 limited=false 则优先表达未设置预算。
  if (keyLimits !== undefined) {
    if (keyLimits instanceof Error || !record(keyLimits)) notes.push(failure(keyLimits, 'Key budget'));
    else if (keyLimits.limited === false) {
      add('key-unlimited', 'No budget set for this key', identity.bindingId, { unit: 'unknown' }, { status: 'ok' });
    } else {
      const budgets = keyLimits.limits === undefined
        ? (record(keyLimits.limit) ? [keyLimits.limit] : [])
        : Array.isArray(keyLimits.limits)
        ? keyLimits.limits
        : [];
      if (!budgets.length) notes.push('Key budget: no budget data available');
      for (const [index, budget] of budgets.entries()) {
        if (!record(budget)) continue;
        const windowId = JSON.stringify([
          budget.period ?? '',
          budget.day ?? '',
          budget.week ?? '',
          budget.month ?? '',
          budget.days ?? '',
          budget.hours ?? '',
          index,
        ]);
        const period = text(String(budget.period ?? 'Window'));
        const count = period === 'hours' ? budget.hours : period === 'days' ? budget.days : undefined;
        const counted = number(count) && count > 0;
        const windowLabel = counted
          ? `${count} ${period}`
          : Object.hasOwn(budgetPeriods, period)
          ? budgetPeriods[period]!
          : period;
        // 滚动窗口的小时/天换算成宿主要求的毫秒；其余 period 只保留标签，不猜测日历窗口长度。
        const duration = counted ? count * (period === 'hours' ? 3_600_000 : 86_400_000) : undefined;
        // token 与美元预算分开发布；美元已是总金额，无须价卡的百万倍换算，比例按同单位相除。
        for (
          const [limitKey, usedKey, leftKey, unit] of [['tokenLimit', 'tokens', 'tokensLeft', 'tokens'], [
            'costLimit',
            'cost',
            'costLeft',
            'usd',
          ]] as const
        ) {
          const maximum = budget[limitKey];
          if (!number(maximum) || maximum <= 0) continue;
          const used = number(budget[usedKey]) ? budget[usedKey] : undefined;
          const remaining = number(budget[leftKey]) ? budget[leftKey] : used === undefined ? undefined : maximum - used;
          const amount: UsageAmount = used === undefined && remaining === undefined
            ? { unit: 'unknown' }
            : {
              unit,
              limit: maximum,
              ...(used === undefined ? {} : { used, usedFraction: used / maximum }),
              ...(remaining === undefined ? {} : { remaining, remainingFraction: remaining / maximum }),
            };
          const budgetLabel = `Key ${unit === 'tokens' ? 'Token' : 'USD'} budget`;
          const rowNotes: string[] = [];
          if (used !== undefined) rowNotes.push(`Used ${used} / ${maximum} ${unit}`);
          else if (remaining !== undefined) rowNotes.push(`Remaining ${remaining} / ${maximum} ${unit}`);
          else rowNotes.push(`Limit ${maximum} ${unit}; usage unknown`);
          if (unit === 'tokens') {
            rowNotes.push(
              budget.cacheReads === true
                ? 'includes cache reads'
                : budget.cacheReads === undefined || budget.cacheReads === false
                ? 'excludes cache reads'
                : 'cache read accounting unknown',
            );
          }
          if (unit === 'usd' && integer(budget.unpriced) && budget.unpriced > 0) {
            rowNotes.push(`${budget.unpriced} unpriced requests excluded`);
          }
          const reserved = unit === 'tokens' ? budget.reserved : budget.reservedCost;
          if (nonnegative(reserved) && reserved > 0) rowNotes.push('reservations not deducted');
          const resetsAt = date(budget.reset);
          add(JSON.stringify([identity.bindingId, 'key', windowId, unit]), budgetLabel, identity.bindingId, amount, {
            window: {
              id: windowId,
              label: windowLabel,
              ...(duration !== undefined && Number.isFinite(duration) ? { durationMs: duration } : {}),
              ...(resetsAt === undefined ? {} : { resetsAt }),
            },
            notes: [`${budgetLabel} · ${windowLabel}: ${rowNotes.join('; ')}`],
          });
        }
      }
    }
  }
  // 仍返回未知项使宿主能展示本次诊断，不能把无读数解释成零消耗或沿用上次报告。
  if (!report.limits.length) {
    add('unknown', 'No quota data available', identity.bindingId, { unit: 'unknown' }, {
      notes: ['No quota data available'],
    });
  }
  return report;
}

/**
 * 为实际 provider alias 创建原生 adapter。supports 只允许进入异步核验，true 不代表凭据身份已经验证。
 * fetchUsage 先调用 check，再并行读取账号额度与 key 预算；无鉴权连接只读账号额度。
 * 请求结束以 binding 对象及 signal 判断发布资格，失效返回 null；不使用 previousReport，也不自行保留失败前读数。
 */
export function createUsageProvider(access: UsageBindingAccess): UsageProvider {
  // collector 的本地占位值只允许对应无鉴权 binding；真实 key、provider alias 和取消状态均须匹配。
  const matches = (params: UsageFetchParams, binding: UsageBinding | undefined): binding is UsageBinding =>
    params.provider === access.providerId && params.credential.type === 'api_key' && !!binding
    && binding.identity.providerId === access.providerId && !binding.signal.aborted && !params.signal?.aborted
    && params.credential.apiKey === binding.collectorKey
    && binding.collectorKey === (binding.apiKey || '__omp_magpie_usage_local__');
  return {
    id: access.providerId,
    cacheVersion: 5,
    validatesCredentials: false,
    retainLastGoodOnFailure: false,
    supports(params) {
      // supports 是同步调度入口，允许真实 key 进入异步 check 以调和凭据变化；它不授予 HTTP 发布资格。
      const binding = access.current();
      return params.provider === access.providerId && params.credential.type === 'api_key' && !!binding
        && !binding.signal.aborted && !params.signal?.aborted
        && (params.credential.apiKey !== '__omp_magpie_usage_local__' || !binding.apiKey);
    },
    async fetchUsage(params, context) {
      const binding = await access.check(params);
      if (!matches(params, binding) || access.current() !== binding) return null;
      // 请求取消与共享 binding 撤销任一发生都停止本次读取，单个 owner 的退出不直接取消仍有租约的 binding。
      const signal = params.signal ? AbortSignal.any([params.signal, binding.signal]) : binding.signal;
      const auth = { apiKey: binding.apiKey };
      // 两个管理接口独立结算；无鉴权时跳过只对真实 key 有意义的预算请求。
      const settled = await Promise.allSettled([
        fetchQuotas(binding.root, auth, signal, context.fetch),
        binding.apiKey ? fetchKeyLimits(binding.root, auth, signal, context.fetch) : Promise.resolve(undefined),
      ]);
      // HTTP 可能跨过一次重新绑定；对象身份与 signal 同时约束结果，旧身份即使请求成功也不能发布。
      if (signal.aborted || access.current() !== binding) return null;
      const result = (item: PromiseSettledResult<unknown>): unknown =>
        item.status === 'fulfilled'
          ? item.value
          : item.reason instanceof Error
          ? item.reason
          : new Error(sanitizeDiagnostic(String(item.reason), binding.apiKey));
      const report = normalizeUsage(binding.identity, result(settled[0]!), result(settled[1]!), Date.now());
      if (binding.diagnostic) report.notes!.push(sanitizeDiagnostic(binding.diagnostic, binding.apiKey));
      // 服务端卡片也可能回显凭据，统一在返回宿主前脱敏。
      return binding.apiKey
        ? JSON.parse(
          JSON.stringify(
            report,
            (_key, value: unknown) => typeof value === 'string' ? sanitizeDiagnostic(value, binding.apiKey) : value,
          ),
        ) as UsageReport
        : report;
    },
  };
}
