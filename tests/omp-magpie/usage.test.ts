import type { UsageFetchContext, UsageFetchParams } from '@oh-my-pi/pi-ai/usage';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayError } from '../../plugins/omp-magpie/src/gateway.ts';
import { createUsageProvider, normalizeUsage, type UsageBinding } from '../../plugins/omp-magpie/src/usage.ts';

const identity = { providerId: 'my-magpie', bindingId: 'opaque-binding' };
const params: UsageFetchParams = {
  provider: identity.providerId,
  credential: { type: 'api_key', apiKey: 'gateway-test-key' },
};
function quotas(...data: unknown[]) {
  return { object: 'list', data };
}

function endpointResponse(
  url: string | URL | Request,
  quota: unknown = quotas(),
  budget: unknown = { limited: false },
): Response {
  const path = new URL(String(url)).pathname;
  if (path.endsWith('/quotas')) return Response.json(quota);
  assert.ok(path.endsWith('/limit'), `unexpected usage request: ${path}`);
  return Response.json(budget);
}

test('百分数保留超额及服务端时区，窗口标识不随 reset 变化', () => {
  const card = {
    provider: 'office/codex',
    from: 'remote',
    user: 'fixture-user',
    alias: 'work',
    plan: 'pro',
    windows: [{ name: '5h', pool: 'main', used: 125, remaining: -25, resetsAt: '2026-10-25T12:00:00+08:00' }],
  };
  const report = normalizeUsage(identity, quotas(card), undefined, 12);
  assert.equal(report.provider, identity.providerId);
  assert.deepEqual(report.metadata, { accountId: identity.bindingId });
  const row = report.limits[0]!;
  assert.equal(row.scope.provider, identity.providerId);
  assert.deepEqual(row.amount, {
    unit: 'percent',
    used: 125,
    limit: 100,
    remaining: -25,
    usedFraction: 1.25,
    remainingFraction: -0.25,
  });
  assert.equal(row.status, 'exhausted');
  assert.equal(row.window?.resetsAt, Date.parse('2026-10-25T12:00:00+08:00'));
  const changed = normalizeUsage(
    identity,
    quotas({ ...card, windows: [{ ...card.windows[0], resetsAt: 'bad' }] }),
    undefined,
    13,
  ).limits[0]!;
  assert.equal(changed.id, row.id);
  assert.equal(changed.window?.resetsAt, undefined);
});

test('实际数量保留上游比例，缺省 amount 不伪造零', () => {
  const report = normalizeUsage(
    identity,
    quotas({
      windows: [{ name: 'tokens', used: 20, remaining: 80, limit: 200, amount: 230, unit: 'tokens' }, {
        name: 'custom',
        used: 0,
        remaining: 100,
        limit: 5,
        unit: 'seats',
      }],
    }),
    undefined,
    0,
  );
  assert.deepEqual(report.limits[0]!.amount, {
    unit: 'tokens',
    used: 230,
    limit: 200,
    remaining: -30,
    usedFraction: 0.2,
    remainingFraction: 0.8,
  });
  assert.equal(report.limits[1]!.amount.unit, 'percent');
  assert.equal(report.limits[1]!.amount.limit, 100);
  assert.match(report.limits[1]!.notes!.join(), /seats/);
});

test('余额严格解析完整币种片段，不叠加或伪造百分比', () => {
  const report = normalizeUsage(
    identity,
    quotas({
      balance: '$12.50 · CNY 8 · USD 2 · about $30',
      balanceSplit: '$4 promotional + $8.50 paid',
      windows: null,
    }),
    undefined,
    0,
  );
  assert.equal(report.limits.length, 4);
  assert.deepEqual(report.limits[0]!.amount, { unit: 'usd', remaining: 12.5 });
  assert.deepEqual(report.limits[1]!.amount, { unit: 'unknown', remaining: 8 });
  assert.deepEqual(report.limits[2]!.amount, { unit: 'usd', remaining: 2 });
  assert.deepEqual(report.limits[3]!.amount, { unit: 'unknown' });
  assert.match(report.limits[1]!.label, /CNY/);
});

test('无限额和空数组始终输出无数值行', () => {
  const unlimited = normalizeUsage(
    identity,
    quotas({ windows: [{ name: 'day', unlimited: true, used: 0, remaining: 100 }] }),
    undefined,
    0,
  ).limits[0]!;
  assert.deepEqual(unlimited.amount, { unit: 'unknown' });
  assert.equal(unlimited.status, 'ok');
  for (const payload of [quotas(), quotas({ windows: null })]) {
    const empty = normalizeUsage(identity, payload, undefined, 0).limits[0]!;
    assert.deepEqual(empty.amount, { unit: 'unknown' });
    assert.equal(empty.status, 'unknown');
  }
});

test('多预算优先完整 limits 且 tokens 与美元分别展示', () => {
  const budget = {
    period: 'day',
    day: 1,
    tokenLimit: 100,
    tokens: 120,
    tokensLeft: -20,
    costLimit: 5,
    cost: 2,
    costLeft: 3,
    reset: '2026-10-26T00:00:00Z',
    start: '2026-10-25',
    unpriced: 2,
    inFlight: 1,
    reserved: 9,
    reservedCost: 0.5,
  };
  const report = normalizeUsage(identity, quotas(), {
    limited: true,
    limits: [budget, { period: 'week', tokenLimit: 1000, tokens: 10 }],
    limit: budget,
  }, 0);
  assert.equal(report.limits.length, 3);
  assert.equal(report.limits[0]!.amount.used, 120);
  assert.equal(report.limits[0]!.status, 'exhausted');
  assert.equal(report.limits[1]!.amount.unit, 'usd');
  assert.equal(report.limits[1]!.amount.used, 2);
  assert.equal(report.limits[0]!.window?.resetsAt, Date.parse(budget.reset));
  assert.equal(normalizeUsage(identity, quotas(), { limit: budget }, 0).limits.length, 2);
  assert.deepEqual(normalizeUsage(identity, quotas(), { limited: false }, 0).limits[0]!.amount, { unit: 'unknown' });
});

test('多个小时和天预算保留可区分的长度及服务端 reset', () => {
  const reset = '2031-01-02T03:04:05Z';
  const report = normalizeUsage(identity, quotas(), {
    limited: true,
    limits: [
      { period: 'hours', hours: 5, tokenLimit: 100, reset },
      { period: 'hours', hours: 24, tokenLimit: 200, reset },
      { period: 'days', days: 7, tokenLimit: 300, reset },
    ],
  }, 0);
  assert.deepEqual(report.limits.map(limit => limit.window?.durationMs), [18_000_000, 86_400_000, 604_800_000]);
  assert.equal(new Set(report.limits.map(limit => limit.window?.label)).size, 3);
  for (const row of report.limits) {
    assert.equal(row.window?.resetsAt, Date.parse(reset));
  }
});

test('全部来源失败产生 unknown 诊断，非法额度形状不伪造读数', () => {
  for (const [status, expected] of [[401, /authentication/], [404, /not supported/]] as const) {
    const failed = normalizeUsage(identity, new GatewayError('auth', 'failure', status), new Error('invalid JSON'), 0);
    assert.deepEqual(failed.limits[0]!.amount, { unit: 'unknown' });
    assert.equal(failed.limits[0]!.status, 'unknown');
    assert.match(failed.notes!.join(), expected);
    assert.match(failed.notes!.join(), /invalid JSON/);
  }
  assert.match(normalizeUsage(identity, [], undefined, 0).notes!.join(), /invalid response/);
});

function setup(apiKey: string | undefined = 'gateway-test-key') {
  const controller = new AbortController();
  let current: UsageBinding | undefined = {
    identity,
    root: 'http://127.0.0.1:3425/prefix',
    apiKey,
    collectorKey: apiKey ?? '__omp_magpie_usage_local__',
    signal: controller.signal,
  };
  let check: (input: UsageFetchParams) => Promise<UsageBinding | undefined> = async () => current;
  const provider = createUsageProvider({
    providerId: identity.providerId,
    current: () => current,
    check: input => check(input),
  });
  return {
    controller,
    provider,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
    set check(value: (input: UsageFetchParams) => Promise<UsageBinding | undefined>) {
      check = value;
    },
  };
}

test('supports 同步筛选活动 API-key 绑定，凭据身份留给异步核对', () => {
  const fixture = setup();
  assert.equal(fixture.provider.supports!(params), true);
  assert.equal(
    fixture.provider.supports!({ ...params, credential: { type: 'oauth', apiKey: params.credential.apiKey } }),
    false,
  );
  fixture.controller.abort();
  assert.equal(fixture.provider.supports!(params), false);
  fixture.current = undefined;
  assert.equal(fixture.provider.supports!(params), false);
});

test('collector 已产生新 key 时仍进入 check，核对后用新身份读取', async () => {
  const fixture = setup();
  const next = { ...params, credential: { type: 'api_key' as const, apiKey: 'rotated-key' } };
  fixture.check = async () => {
    fixture.controller.abort();
    fixture.current = {
      ...fixture.current!,
      apiKey: 'rotated-key',
      collectorKey: 'rotated-key',
      signal: new AbortController().signal,
    };
    return fixture.current;
  };
  assert.equal(fixture.provider.supports!(next), true);
  const report = await fixture.provider.fetchUsage(next, {
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer rotated-key');
      return endpointResponse(url, quotas({ windows: [{ name: 'day', used: 20 }] }));
    },
  });
  assert.equal(report!.limits[0]!.amount.used, 20);
});

test('每次读取先 await check，两个来源并发完成后发布报告', async () => {
  const fixture = setup();
  let checked = false;
  fixture.check = async () => {
    await Promise.resolve();
    checked = true;
    return fixture.current;
  };
  let requests = 0;
  // 两路都启动后才能完成，串行实现无法越过屏障。
  const { promise: ready, resolve: finish } = Promise.withResolvers<void>();
  const context: UsageFetchContext = {
    fetch: async (url, init) => {
      assert.equal(checked, true);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer gateway-test-key');
      if (++requests === 2) finish();
      await ready;
      return endpointResponse(url, quotas({ windows: [{ used: 25 }] }), { limit: { costLimit: 5, cost: 1 } });
    },
  };
  const report = await fixture.provider.fetchUsage(params, context);
  assert.deepEqual(report!.limits.map(row => row.amount.used), [25, 1]);
});

test('过期或不匹配的请求身份不发 HTTP', async () => {
  const fixture = setup();
  let requests = 0;
  const context: UsageFetchContext = {
    fetch: async url => {
      requests++;
      return endpointResponse(url);
    },
  };
  fixture.check = async () => undefined;
  assert.equal(await fixture.provider.fetchUsage(params, context), null);
  fixture.check = async () => fixture.current;
  for (
    const input of [
      { ...params, credential: { type: 'api_key' as const, apiKey: 'old-key' } },
      { ...params, provider: 'other-provider' },
    ]
  ) assert.equal(await fixture.provider.fetchUsage(input, context), null);
  fixture.current = { ...fixture.current!, collectorKey: 'inconsistent-key' };
  assert.equal(await fixture.provider.fetchUsage(params, context), null);
  assert.equal(requests, 0);
});

test('keyless marker 只匹配本地绑定且不作为 Bearer，不沿用 previousReport', async () => {
  const fixture = setup();
  fixture.current = { ...fixture.current!, apiKey: undefined, collectorKey: '__omp_magpie_usage_local__' };
  const input = { ...params, credential: { type: 'api_key' as const, apiKey: '__omp_magpie_usage_local__' } };
  assert.equal(fixture.provider.supports!(input), true);
  const paths: string[] = [];
  const report = await fixture.provider.fetchUsage(input, {
    previousReport: normalizeUsage(identity, quotas({ windows: [{ name: 'old', used: 88 }] }), undefined, 0),
    fetch: async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return endpointResponse(url);
    },
  });
  assert.deepEqual(paths, ['/prefix/v1/magpie/quotas']);
  assert.equal(report!.limits[0]!.amount.used, undefined);
  assert.equal(report!.limits[0]!.status, 'unknown');
  assert.equal(setup().provider.supports!(input), false);
});

test('最新凭据已核对时采用新绑定 signal，旧 controller 不会取消新读取', async () => {
  const fixture = setup();
  const oldController = fixture.controller;
  const replacement = new AbortController();
  fixture.current = { ...fixture.current!, signal: replacement.signal };
  oldController.abort();
  const report = await fixture.provider.fetchUsage(params, {
    fetch: async (url, init) => {
      assert.equal(init?.signal?.aborted, false);
      return endpointResponse(url, quotas({ windows: [{ used: 20 }] }));
    },
  });
  assert.equal(report!.limits[0]!.amount.used, 20);
});

test('文本优先于不限额与数值，display 在长账号前并完整保留', () => {
  const display = '请重新登录 · ' + '完整说明'.repeat(80);
  for (const unlimited of [false, true]) {
    const row = normalizeUsage(
      identity,
      quotas({
        user: '长账号'.repeat(100),
        windows: [{
          name: 'day',
          text: true,
          unlimited,
          display,
          used: 0,
          remaining: 100,
          amount: 0,
          limit: 20,
          unit: 'usd',
        }],
      }),
      undefined,
      0,
    ).limits[0]!;
    assert.deepEqual(row.amount, { unit: 'unknown' });
    assert.equal(row.status, 'unknown');
    assert.ok(row.label.startsWith(display));
  }
});

test('单位严格规范化且缺失绝对数量仅保留可信百分比或 unknown', () => {
  for (const unit of [' USD ', ' Tokens ', 'constructor', '__proto__', 'CNY']) {
    const row = normalizeUsage(identity, quotas({ windows: [{ unit, amount: 0, limit: 20 }] }), undefined, 0)
      .limits[0]!;
    assert.equal(
      row.amount.unit,
      unit.trim().toLowerCase() === 'usd' ? 'usd' : unit.trim().toLowerCase() === 'tokens' ? 'tokens' : 'unknown',
    );
    assert.equal(row.amount.used, 0);
    assert.equal(row.amount.remaining, 20);
  }
  for (const amount of [undefined, null, NaN, Infinity, '0']) {
    for (const percent of [false, true]) {
      const row = normalizeUsage(
        identity,
        quotas({ windows: [{ limit: 20, unit: 'usd', amount, ...(percent ? { used: 25, remaining: 75 } : {}) }] }),
        undefined,
        0,
      ).limits[0]!;
      assert.deepEqual(
        row.amount,
        percent
          ? { unit: 'percent', used: 25, remaining: 75, limit: 100, usedFraction: 0.25, remainingFraction: 0.75 }
          : { unit: 'unknown' },
      );
    }
  }
});

test('重复账号和 pool 窗口可区分，身份隔离且标识稳定', () => {
  const windows = ['alpha', 'beta', 'alpha'].map(pool => ({ name: 'day', pool, used: 20 }));
  const card = { user: 'same', windows };
  const report = normalizeUsage(identity, quotas(card, card), undefined, 0);
  assert.equal(report.limits.length, 6);
  assert.equal(new Set(report.limits.map(row => row.id)).size, 6);
  assert.equal(new Set(report.limits.map(row => row.label)).size, 6);
  assert.notEqual(report.limits[0]!.scope.accountId, report.limits[3]!.scope.accountId);
  for (const row of report.limits) {
    assert.equal(row.window?.resetsAt, undefined);
    assert.deepEqual(row.amount, { unit: 'percent', used: 20, limit: 100, usedFraction: 0.2 });
  }
  const original = normalizeUsage(identity, quotas({ user: 'same', windows: [windows[0]] }), undefined, 0).limits[0]!;
  assert.equal(report.limits[0]!.id, original.id);
  const other = normalizeUsage({ ...identity, bindingId: 'other' }, quotas(card), undefined, 0);
  assert.notEqual(report.limits[0]!.scope.accountId, other.limits[0]!.scope.accountId);
});

test('预算说明保留缓存口径、预留与未定价，已结算数量不变', () => {
  for (
    const [fields, tokens, cache] of [
      [{}, 125, 'excludes cache reads'],
      [{ cacheReads: false }, 125, 'excludes cache reads'],
      [{ cacheReads: true }, 1125, 'includes cache reads'],
      [{ cacheReads: null }, 125, 'unknown'],
      [{ cacheReads: 'true' }, 125, 'unknown'],
    ] as const
  ) {
    const row = normalizeUsage(identity, quotas(), {
      limit: { tokenLimit: 2000, tokens, tokensLeft: 2000 - tokens, reserved: 500, ...fields },
    }, 0).limits[0]!;
    assert.equal(row.amount.used, tokens);
    assert.equal(row.amount.remaining, 2000 - tokens);
    const notes = row.notes!.join();
    assert.ok(notes.includes(cache));
    assert.match(notes, /reservations/);
  }
  const usd = normalizeUsage(identity, quotas(), {
    limit: { costLimit: 10, cost: 2, costLeft: 8, unpriced: 3, reservedCost: 1 },
  }, 0).limits[0]!;
  assert.equal(usd.amount.used, 2);
  assert.equal(usd.amount.remaining, 8);
  assert.match(usd.notes!.join(), /3.*unpriced/);
  assert.match(usd.notes!.join(), /reservations/);
  assert.doesNotMatch(usd.notes!.join(), /cache reads/);
  for (const unpriced of [undefined, 0, -1, '3']) {
    const row = normalizeUsage(identity, quotas(), { limit: { costLimit: 10, cost: 2, unpriced, reservedCost: 0 } }, 0)
      .limits[0]!;
    assert.doesNotMatch(row.notes!.join(), /unpriced|reservations/);
  }
  const missing = normalizeUsage(identity, quotas(), { limit: { tokenLimit: 100 } }, 0).limits[0]!;
  assert.deepEqual(missing.amount, { unit: 'unknown' });
});

test('预算仅有剩余读数时保留余额和比例，不补造已用量', () => {
  const report = normalizeUsage(identity, quotas(), {
    limit: { tokenLimit: 100, tokensLeft: 25, costLimit: 10, costLeft: 0 },
  }, 0);
  assert.deepEqual(report.limits.map(row => row.amount), [
    { unit: 'tokens', limit: 100, remaining: 25, remainingFraction: 0.25 },
    { unit: 'usd', limit: 10, remaining: 0, remainingFraction: 0 },
  ]);
  assert.deepEqual(report.limits.map(row => row.status), ['ok', 'exhausted']);
});

test('两个来源独立失败时保留成功读数与自然 reset，不回填旧报告', async () => {
  const reset = '2031-01-02T03:04:05Z';
  for (const failedSource of ['quotas', 'limit']) {
    for (const mode of ['403', '404', 'network', 'json', 'shape']) {
      const fixture = setup();
      const previousReport = normalizeUsage(identity, quotas({ windows: [{ name: 'old', used: 88 }] }), {
        limit: { tokenLimit: 100, tokens: 99 },
      }, 0);
      const report = await fixture.provider.fetchUsage(params, {
        previousReport,
        fetch: async url => {
          const name = new URL(String(url)).pathname.split('/').at(-1)!;
          if (name === failedSource) {
            if (mode === 'network') throw new Error('gateway-test-key private transport');
            if (mode === 'shape') return Response.json([]);
            return new Response('<private>', { status: mode === 'json' ? 200 : Number(mode) });
          }
          return endpointResponse(
            url,
            quotas({ windows: [{ name: 'day', used: 25, remaining: 75, resetsAt: reset }] }),
            { limit: { tokenLimit: 10, tokens: 12, reset } },
          );
        },
      });
      assert.equal(report!.limits.length, 1);
      const row = report!.limits[0]!;
      assert.equal(row.amount.used, failedSource === 'quotas' ? 12 : 25);
      assert.equal(row.status, failedSource === 'quotas' ? 'exhausted' : 'ok');
      assert.equal(row.window?.resetsAt, Date.parse(reset));
      assert.ok(
        report!.notes!.some(note => note.includes(failedSource === 'quotas' ? 'Subscription quotas' : 'Key budget')),
      );
      if (mode === '403') assert.match(report!.notes!.join(), /permission/);
      if (mode === '404') assert.match(report!.notes!.join(), /not supported/);
      assert.equal(JSON.stringify(report).includes('private'), false);
      assert.equal(JSON.stringify(report).includes('gateway-test-key'), false);
    }
  }
});

test('额度或预算仍在途时换身份或撤销租约，整份迟到结果丢弃', async () => {
  for (const blockedSource of ['quotas', 'limit']) {
    for (const action of ['binding', 'lease', 'caller']) {
      const fixture = setup();
      const caller = new AbortController();
      const { promise: started, resolve: sourceStarted } = Promise.withResolvers<void>();
      const { promise: waiting, resolve: release } = Promise.withResolvers<void>();
      const pending = fixture.provider.fetchUsage({ ...params, signal: caller.signal }, {
        fetch: async url => {
          if (new URL(String(url)).pathname.endsWith(`/${blockedSource}`)) {
            sourceStarted();
            await waiting;
          }
          return endpointResponse(url, quotas({ resets: { count: 3 }, windows: [{ used: 10 }] }), {
            limit: { tokens: 2, tokenLimit: 10 },
          });
        },
      });
      await started;
      if (action === 'binding') {
        fixture.current = {
          ...fixture.current!,
          root: 'http://other.test',
          apiKey: 'rotated-key',
          collectorKey: 'rotated-key',
          identity: { ...identity, bindingId: 'replacement' },
        };
      } else if (action === 'lease') fixture.controller.abort();
      else caller.abort();
      release();
      assert.equal(await pending, null);
    }
  }
});

test('多账号库存保留各自数量和到期，无窗口账号也可见', () => {
  const report = normalizeUsage(
    identity,
    quotas(
      {
        provider: 'office/codex',
        alias: 'work',
        resets: { count: 3, until: '2031-01-02T03:04:05+08:00' },
        windows: [{ name: '5h', used: 25 }, { name: 'weekly', used: 10 }],
      },
      { provider: 'office/codex', alias: 'personal', resets: { count: 7, until: '2032-06-09' }, windows: [] },
    ),
    undefined,
    0,
  );
  assert.equal(report.notes!.length, 2);
  const work = report.notes!.find(note => note.includes('work'))!;
  const personal = report.notes!.find(note => note.includes('personal'))!;
  assert.match(work, /office\/codex/);
  assert.match(work, /\b3\b/);
  assert.match(work, /2031-01-02/);
  assert.doesNotMatch(work, /personal|2032-06-09/);
  assert.match(personal, /\b7\b/);
  assert.match(personal, /2032-06-09/);
  assert.doesNotMatch(personal, /work|2031-01-02/);
  assert.ok(report.limits.every(row => !row.notes?.some(note => /Reset credits/.test(note))));
  assert.equal(report.resetCredits, undefined);
});

test('按窗口与团队库存分别归属，忽略通用数量且不求和', () => {
  const report = normalizeUsage(
    identity,
    quotas(
      {
        alias: 'team-account',
        resets: { byWindow: true, fiveHour: 2, weekly: 5, count: 999, team: true },
        windows: [],
      },
      {
        alias: 'personal-account',
        resets: { byWindow: true, fiveHour: 0, weekly: 8, count: 999, team: false },
        windows: [],
      },
    ),
    undefined,
    0,
  );
  assert.equal(report.notes!.length, 2);
  const team = report.notes!.find(note => note.includes('team-account'))!;
  const personal = report.notes!.find(note => note.includes('personal-account'))!;
  assert.match(team, /\(team\)/);
  assert.match(team, /5h\s*2\b/);
  assert.match(team, /Weekly\s*5\b/);
  assert.doesNotMatch(team, /\b999\b|\b7\b/);
  assert.match(personal, /5h\s*0\b/);
  assert.match(personal, /Weekly\s*8\b/);
  assert.doesNotMatch(personal, /\(team\)|\b999\b/);
  assert.equal(report.resetCredits, undefined);
});

test('零库存保留，缺失或非法到期不承诺永不过期', () => {
  for (const until of [undefined, null, 'invalid-expiry', '']) {
    const report = normalizeUsage(identity, quotas({ resets: { count: 0, until }, windows: [] }), undefined, 0);
    assert.equal(report.notes!.length, 1);
    assert.match(report.notes![0]!, /\b0\b/);
    assert.match(report.notes![0]!, /expiry.*unknown/);
    assert.doesNotMatch(report.notes![0]!, /never|invalid-expiry|null|undefined/);
  }
  for (const resets of [undefined, null, [], 'invalid']) {
    assert.deepEqual(normalizeUsage(identity, quotas({ resets, windows: [] }), undefined, 0).notes, []);
  }
});

test('通用和分窗库存复用整数边界，非法数量不补零或隐藏有效窗口', () => {
  for (const invalid of [undefined, null, -1, 1.5, NaN, Infinity, '0', true]) {
    const report = normalizeUsage(
      identity,
      quotas(
        { alias: 'general', resets: { count: invalid } },
        { alias: 'missing-five', resets: { byWindow: true, count: 999, fiveHour: invalid, weekly: 4 } },
        { alias: 'missing-week', resets: { byWindow: true, count: 999, fiveHour: 4, weekly: invalid } },
      ),
      undefined,
      0,
    );
    assert.equal(report.notes!.length, 3);
    const [general, missingFive, missingWeek] = report.notes!;
    assert.match(general!, /count.*unknown/);
    assert.match(missingFive!, /Weekly\s*4\b/);
    assert.match(missingWeek!, /5h\s*4\b/);
    assert.doesNotMatch(missingFive!, /5h/);
    assert.doesNotMatch(missingWeek!, /Weekly/);
    assert.doesNotMatch(report.notes!.join(), /\b0\b|\b999\b/);
  }
});

test('仅严格 byWindow=true 使用分窗数量，无有效窗口不回退 count', () => {
  const report = normalizeUsage(
    identity,
    quotas({ alias: 'inventory', resets: { byWindow: true, count: 999 }, windows: [] }),
    undefined,
    0,
  );
  assert.match(report.notes![0]!, /count.*unknown/);
  assert.doesNotMatch(report.notes![0]!, /\b999\b|\b0\b/);
  for (const byWindow of [false, undefined, 'true', 1]) {
    const report = normalizeUsage(
      identity,
      quotas({ alias: 'inventory', resets: { byWindow, count: 3, fiveHour: 777, weekly: 888 }, windows: [] }),
      undefined,
      0,
    );
    assert.match(report.notes![0]!, /\b3\b/);
    assert.doesNotMatch(report.notes![0]!, /\b777\b|\b888\b/);
  }
});

test('错误或延迟库存保留旧值诊断并在返回前脱敏', async () => {
  for (
    const { error, readDeferred, windows } of [
      {
        error: 'gate\nway-test-key upstream-offline',
        readDeferred: false,
        windows: [{ name: 'day', used: 40, remaining: 60 }],
      },
      { error: undefined, readDeferred: true, windows: [{ name: 'day', used: 40, remaining: 60 }] },
      { error: 'gate\nway-test-key upstream-offline', readDeferred: true, windows: [] },
    ]
  ) {
    const fixture = setup();
    const report = await fixture.provider.fetchUsage(params, {
      fetch: async url =>
        endpointResponse(
          url,
          quotas({
            alias: 'stale-account',
            error,
            readDeferred,
            readAt: '2030-10-24',
            asOf: '2030-10-23',
            resets: { count: 6, until: '2031-02-03' },
            windows,
          }),
        ),
    });
    const inventoryNotes = report!.notes!.filter(note => /Reset credits/.test(note));
    assert.equal(inventoryNotes.length, 1);
    const note = inventoryNotes[0]!;
    assert.match(note, /stale-account/);
    assert.match(note, /\b6\b/);
    assert.match(note, /2031-02-03/);
    if (error) {
      assert.match(note, /upstream-offline/);
      assert.match(note, /stale|error/);
    }
    if (readDeferred) assert.match(note, /deferred/);
    assert.match(note, /2030-10-24/);
    assert.match(note, /2030-10-23/);
    assert.equal(report!.limits[0]!.status, error || !windows.length ? 'unknown' : 'ok');
    if (windows.length) assert.equal(report!.limits[0]!.amount.used, 40);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('gateway-test-key'), false);
    assert.equal(serialized.includes('gate\\nway-test-key'), false);
  }
});

test('券到期与管理资料不替代额度和预算的自然 reset', () => {
  const quotaReset = '2031-01-02T03:04:05Z';
  const budgetReset = '2031-01-03T03:04:05Z';
  const report = normalizeUsage(
    identity,
    quotas({
      alias: 'inventory',
      until: 'private-plan-expiry',
      renew: 'private-renew',
      resets: { count: 3, until: '2032-06-09' },
      resetsUsed: [{ at: 'private-history', why: 'private-history' }],
      windows: [
        { name: 'day', used: 25, resetsAt: quotaReset, holdsWhy: 'private-holds' },
        { name: 'weekly', used: 10 },
      ],
    }),
    { limit: { tokenLimit: 100, tokens: 20, reset: budgetReset } },
    0,
  );
  assert.deepEqual(report.limits.map(row => row.window?.resetsAt), [
    Date.parse(quotaReset),
    undefined,
    Date.parse(budgetReset),
  ]);
  assert.equal(report.notes!.filter(note => /Reset credits/.test(note)).length, 1);
  assert.match(report.notes!.join(), /2032-06-09/);
  assert.equal(JSON.stringify(report).includes('private-'), false);
  assert.equal(report.resetCredits, undefined);
});
