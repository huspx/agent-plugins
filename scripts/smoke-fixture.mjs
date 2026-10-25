import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const fixtureKeys = Object.freeze({ A: 'smoke-fixture-credential-a', B: 'smoke-fixture-credential-b' });
export const resetAt = '2031-01-02T03:04:05Z';

/** 三种协议目录供真实路由验收；缺价控制仅服务于插件 callback 的跨源/跨 key 隔离。 */
function catalog() {
  const base = { object: 'model', context_window: 4096, max_output_tokens: 512, modalities: { input: ['text', 'image'] }, reasoning: false };
  const pricing = { prompt: '0.0000003', completion: '0.0000009', input_cache_read: '0.0000001', input_cache_write: '0.0000002' };
  return { object: 'list', data: [
    { ...base, id: 'smoke-anthropic', native_endpoints: ['/v1/messages'], pricing },
    { ...base, id: 'smoke-responses', native_endpoints: ['/v1/responses'], pricing },
    { ...base, id: 'smoke-completions', pricing },
  ] };
}

/** 启动仅监听 loopback 的宿主验收服务，使用显式屏障控制 HTTP 竞态而非依赖响应延时。 */
export async function startFixture() {
  const requests = [];
  const pending = [];
  const tasks = [];
  const taskWaiters = [];
  const results = new Map();
  const resultWaiters = new Map();
  let sequence = 0;
  let holdKey;
  const modelHolds = new Map();
  const missingPrices = new Set();
  const identityFailures = new Set();
  let generationAllowed = false;
  let root;
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, root);
      if (url.pathname === '/__smoke/next') {
        if (tasks.length) json(res, tasks.shift());
        else { taskWaiters.push(res); res.on('close', () => { const index = taskWaiters.indexOf(res); if (index >= 0) taskWaiters.splice(index, 1); }); }
        return;
      }
      if (url.pathname === '/__smoke/result' && req.method === 'POST') {
        let text = '';
        for await (const chunk of req) text += chunk;
        const result = JSON.parse(text);
        results.set(result.id, result);
        resultWaiters.get(result.id)?.(result);
        json(res, { ok: true });
        return;
      }
      if (url.pathname === '/__smoke/state') {
        json(res, { held: pending.filter(item => !item.res.destroyed).length,
          heldRequests: pending.filter(item => !item.res.destroyed).map(({ row }) => ({ path: row.path, credential: row.credential })),
          aborted: requests.filter(row => row.aborted).length,
          generationPosts: requests.filter(row => row.generation).length,
          requests: requests.map(({ path, credential, generation, aborted, priceHeader, marker }) => ({ path, credential, generation, aborted, priceHeader, marker })) });
        return;
      }
      if (url.pathname === '/__smoke/hold') { holdKey = url.searchParams.get('key') || undefined; json(res, { ok: true }); return; }
      if (url.pathname === '/__smoke/hold-models') { modelHolds.set(url.searchParams.get('key') || '*', url.searchParams.get('prefix') || ''); json(res, { ok: true }); return; }
      if (url.pathname === '/__smoke/catalog') {
        const identity = `${url.searchParams.get('prefix') || ''}:${url.searchParams.get('key') || '*'}`;
        if (url.searchParams.get('prices') === 'missing') missingPrices.add(identity); else missingPrices.delete(identity);
        json(res, { ok: true }); return;
      }
      if (url.pathname === '/__smoke/identity') {
        const prefix = url.searchParams.get('prefix');
        if (url.searchParams.get('fail') === 'true') identityFailures.add(prefix); else identityFailures.delete(prefix);
        json(res, { ok: true }); return;
      }
      // 按 key 释放已到达的请求，允许新身份先完成、旧身份后返回，复现过期响应边界。
      if (url.pathname === '/__smoke/release') {
        const key = url.searchParams.get('key');
        if (!key) { holdKey = undefined; modelHolds.clear(); } else modelHolds.delete(key);
        for (let index = pending.length - 1; index >= 0; index--) {
          const item = pending[index];
          if (key && item.row.credential !== key) continue;
          pending.splice(index, 1);
          if (!item.res.destroyed) item.send();
        }
        json(res, { ok: true }); return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const credential = bearer === fixtureKeys.A ? 'A' : bearer === fixtureKeys.B ? 'B' : bearer ? 'unexpected' : 'none';
      const row = { path: url.pathname, credential, generation: req.method === 'POST', marker: bearer === '__omp_magpie_usage_local__', priceHeader: req.headers['x-magpie-prices'] === '1', aborted: false };
      requests.push(row);
      res.on('close', () => { if (!res.writableEnded) row.aborted = true; });
      if (req.method === 'POST') {
        if (!generationAllowed || !url.pathname.endsWith('/chat/completions')) { json(res, { error: { message: 'fixture rejects generation' } }, 405); return; }
        for await (const _chunk of req) { /* Drain the actual host request. */ }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = { id: 'smoke-completion', object: 'chat.completion.chunk', created: 1, model: 'smoke-static', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture complete' }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (row.marker || credential === 'unexpected') { json(res, { error: 'unexpected credential' }, 401); return; }
      if (url.pathname.endsWith('/v1/models')) {
        const prefix = url.pathname.slice(0, -'/v1/models'.length);
        const missing = missingPrices.has(`${prefix}:${credential}`) || missingPrices.has(`${prefix}:*`);
        const payload = catalog();
        if (missing) for (const model of payload.data) delete model.pricing;
        // 在挂起前固定响应内容，让源或 key 切换后返回的仍是旧请求数据。
        const send = () => json(res, payload);
        const heldPrefix = modelHolds.get(credential) ?? modelHolds.get('*');
        if (heldPrefix !== undefined && prefix.startsWith(heldPrefix)) pending.push({ res, send, row }); else send();
        return;
      }
      if (url.pathname.endsWith('/v1') || url.pathname.endsWith('/api/hello')) {
        const prefix = url.pathname.replace(/\/(?:v1|api\/hello)$/, '');
        if (identityFailures.has(prefix)) json(res, { error: 'fixture identity unavailable' }, 503);
        else json(res, { name: 'magpie', version: '0.1.1451' });
        return;
      }
      if (url.pathname.endsWith('/v1/magpie/quotas')) {
        const send = () => {
          if (url.pathname.startsWith('/ordinary')) { json(res, { error: 'subscription forbidden' }, 403); return; }
          json(res, { object: 'list', data: [
            { provider: 'office/codex', kind: 'subscription', user: 'fixture-account', alias: 'fixture-alias', plan: 'fixture-plan', from: 'fixture-upstream', balance: '$12.50', windows: [{ name: 'fixture-exhausted-window', used: 100, remaining: 0, resetsAt: resetAt }] },
            { provider: 'office/other', kind: 'subscription', user: 'fixture-other', windows: [{ name: 'fixture-available-window', used: 20, remaining: 80, resetsAt: resetAt }] },
          ] });
        };
        if (holdKey === credential) pending.push({ res, send, row }); else send();
        return;
      }
      if (url.pathname.endsWith('/v1/magpie/limit')) {
        const tokens = credential === 'B' ? 222 : 111;
        json(res, { limited: true, limits: [{ period: 'day', tokenLimit: 1000, tokens, tokensLeft: 1000 - tokens, costLimit: 10, cost: 1.25, costLeft: 8.75, reset: resetAt, reserved: 3, inFlight: 1 }] });
        return;
      }
      json(res, { error: 'fixture route not found' }, 404);
    } catch { if (!res.headersSent) json(res, { error: 'fixture request failed' }, 500); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address === 'object');
  root = `http://127.0.0.1:${address.port}`;
  return {
    root, requests,
    allowGeneration(value) { generationAllowed = value; },
    async command(action, payload = {}, timeoutMs = 45000) {
      const id = String(++sequence);
      const task = { id, action, ...payload };
      const waiter = taskWaiters.shift();
      if (waiter) json(waiter, task); else tasks.push(task);
      let timer;
      try {
        return await Promise.race([
          results.has(id) ? Promise.resolve(results.get(id)) : new Promise(resolve => resultWaiters.set(id, resolve)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`probe deadline: ${action}`)), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); resultWaiters.delete(id); }
    },
    async close() {
      for (const item of pending.splice(0)) item.res.destroy();
      for (const waiter of taskWaiters.splice(0)) waiter.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
