import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureKeys, startFixture } from './smoke-fixture.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.OMP_MAGPIE_OMP_BIN;
assert(executable && isAbsolute(executable), 'OMP_MAGPIE_OMP_BIN must name an absolute standalone OMP executable');
await access(executable, constants.X_OK);
assert(
  !(await realpath(executable)).includes(`${repository}/node_modules/`),
  'standalone OMP cannot resolve into this repository devDependency',
);
const workspace = await mkdtemp(join(tmpdir(), 'omp-magpie-smoke-'));
const active = new Set();
const fixture = await startFixture();
const pluginId = 'omp-magpie@huspx-agent-plugins';
const runtimeSource = join(workspace, 'runtime-source');
const probe = join(runtimeSource, 'scripts/smoke-probe.ts');
const entry = join(runtimeSource, 'plugins/omp-magpie/src/index.ts');
let assertionCount = 0;
const safe = value => String(value).split(fixtureKeys.A).join('[credential]').split(fixtureKeys.B).join('[credential]');
function passed(name) {
  assertionCount++;
  console.log(`PASS ${name}`);
}

/** 为每种宿主运行模式创建独立 HOME、配置和凭据文件，避免读取或修改开发者个人环境。 */
async function environment(name) {
  const base = join(workspace, name);
  const home = join(base, 'home');
  const cwd = join(base, 'business');
  const agentDir = join(home, '.omp/agent');
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const env = {};
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TMPDIR', 'SYSTEMROOT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    PI_CONFIG_DIR: '.omp',
    OMP_PROFILE: 'default',
    PI_CODING_AGENT_DIR: agentDir,
    NO_COLOR: '1',
    TERM: 'dumb',
    OMP_SMOKE_FIXTURE: fixture.root,
    OMP_SMOKE_KEY_A: fixtureKeys.A,
    OMP_SMOKE_KEY_B: fixtureKeys.B,
    OMP_SMOKE_KEY_FILE: join(base, 'command-key'),
    OMP_SMOKE_SHUTDOWN_FILE: join(base, 'shutdown.json'),
  });
  await writeFile(env.OMP_SMOKE_KEY_FILE, fixtureKeys.A);
  env.OMP_SMOKE_HEADER_HOLD = join(base, 'header-hold');
  env.OMP_SMOKE_HEADER_STARTED = join(base, 'header-started');
  const provider = (path, key, auth = 'apiKey') => ({
    baseUrl: `${fixture.root}${path}/v1`,
    api: 'openai-completions',
    auth,
    ...(key ? { apiKey: key } : {}),
    headers: { 'X-Smoke-Inference': 'preserved' },
    models: [{
      id: 'smoke-static',
      name: 'smoke static model',
      contextWindow: 65536,
      maxTokens: 2048,
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  env.OMP_SMOKE_HEADER_COMMAND = `!if [ -f ${shellQuote(env.OMP_SMOKE_HEADER_HOLD)} ]; then /usr/bin/touch ${
    shellQuote(env.OMP_SMOKE_HEADER_STARTED)
  }; while [ -f ${shellQuote(env.OMP_SMOKE_HEADER_HOLD)} ]; do /bin/sleep 0.02; done; fi; printf preserved`;
  const providers = {
    magpie: provider('/local', undefined, 'none'),
    'smoke-a': {
      ...provider('/prefix/a', 'OMP_SMOKE_KEY_A'),
      models: [{ ...provider('/prefix/a', 'OMP_SMOKE_KEY_A').models[0], compat: { supportsStrictMode: false } }],
    },
    'smoke-b': provider('/prefix/b', 'OMP_SMOKE_KEY_B'),
    'smoke-child': provider('/child', 'OMP_SMOKE_KEY_A'),
    'smoke-ordinary': provider('/ordinary', 'OMP_SMOKE_KEY_A'),
    ...Object.fromEntries(
      ['stored', 'runtime', 'shared', 'generation', 'late'].map(
        id => [`smoke-${id}`, provider(`/smoke-${id}`, 'OMP_SMOKE_KEY_A')],
      ),
    ),
    'smoke-command': provider('/command', `!cat ${shellQuote(env.OMP_SMOKE_KEY_FILE)}`),
    'smoke-literal': provider('/literal', fixtureKeys.A),
    'smoke-lease': {
      ...provider('/lease-a', 'OMP_SMOKE_KEY_A'),
      headers: { 'X-Smoke-Inference': 'preserved', 'X-Smoke-Barrier': env.OMP_SMOKE_HEADER_COMMAND },
    },
  };
  // JSON is a YAML subset, so this exercises the host's actual models.yml loader.
  await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers }));
  return { base, home, cwd, agentDir, env };
}

async function cli(isolation, args) {
  const child = spawn(executable, args, { cwd: isolation.cwd, env: isolation.env, stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  child.stdin.end();
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CLI deadline: ${args.slice(0, 3).join(' ')}`)), 45000);
      }),
    ]);
    assert.equal(code, 0, safe(`OMP ${args.slice(0, 3).join(' ')} failed: ${stderr}\n${stdout}`));
    assert(
      !stdout.includes(fixtureKeys.A) && !stdout.includes(fixtureKeys.B) && !stderr.includes(fixtureKeys.A)
        && !stderr.includes(fixtureKeys.B),
      'CLI output must not disclose fixture credentials',
    );
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode !== null || child.signalCode !== null) active.delete(child);
  }
}

/** 驱动真实 RPC 宿主；命令必须同时收到同 ID 完成响应和预期事件才进入后续验收。 */
async function rpc(isolation, { direct = false, strictTools = false } = {}) {
  await rm(isolation.env.OMP_SMOKE_SHUTDOWN_FILE, { force: true });
  const args = [
    '--mode',
    'rpc',
    '--no-session',
    '--no-skills',
    '--no-rules',
    ...(strictTools ? ['--tools', 'task,smoke_strict'] : ['--no-tools']),
    '--no-lsp',
    '--model',
    'magpie/smoke-static',
  ];
  if (direct) args.push('--no-extensions', '-e', entry);
  args.push('-e', probe);
  const child = spawn(executable, args, { cwd: isolation.cwd, env: isolation.env, stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  const messages = [];
  const waiting = new Set();
  let buffer = '', stderr = '', exited = false, exitCode;
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const text = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      messages.push(value);
      for (const waiter of waiting) waiter();
    }
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      exited = true;
      exitCode = code;
      for (const waiter of waiting) waiter();
      resolve(code);
    });
  });
  async function waitFor(predicate, label, timeoutMs = 45000, from = 0) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = messages.slice(from).find(predicate);
      if (value) return value;
      assert(!exited, safe(`RPC exited before ${label}; code=${exitCode}; ${stderr}`));
      assert(Date.now() < deadline, safe(`RPC deadline: ${label}; ${stderr}`));
      await new Promise(resolve => {
        const wake = () => {
          clearTimeout(timer);
          waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(1000, deadline - Date.now()));
        waiting.add(wake);
      });
    }
  }
  let sequence = 0;
  async function send(type, fields = {}) {
    const id = `smoke-${++sequence}`;
    const from = messages.length;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return { id, from };
  }
  async function usage(expected = true, inspectPresentation = false) {
    const generationBefore = fixture.requests.filter(request => request.generation).length;
    const trafficFrom = fixture.requests.length;
    const command = await send('prompt', { message: '/usage' });
    const response = await waitFor(
      value => value.type === 'response' && value.id === command.id,
      'same-id /usage response',
      45000,
      command.from,
    );
    assert.equal(response.success, true, safe(JSON.stringify(response)));
    assert.equal(response.data?.agentInvoked, false, 'builtin /usage must report agentInvoked:false');
    const output = await waitFor(
      value => value.type === 'command_output',
      '/usage command_output',
      10000,
      command.from,
    );
    if (expected) assert.match(output.text, /fixture-alias/, 'installed usage collector remains visible');
    if (inspectPresentation) {
      for (const value of ['fixture text information', 'pool-alpha', 'pool-beta', 'fixture-cny-window']) {
        assert(output.text.includes(value), `/usage text preserves fixture value ${value}`);
      }
      assert.match(
        output.text,
        /fixture-alias[^\n]*Reset credits[^\n]*5h\s*2\b[^\n]*Weekly\s*1\b/,
        'native /usage renders representative account inventory',
      );
      assert.match(
        output.text,
        /fixture-idle[^\n]*Reset credits[^\n]*\b0\b[^\n]*expiry unknown/,
        'native /usage renders windowless zero inventory',
      );
      assert.match(
        output.text,
        /200\s*\/\s*1000\s+cny/i,
        'native /usage retains the actual CNY quantity and original unit',
      );
      assert.match(output.text, /Key Token budget[^\n]*Daily[^\n]*excludes cache reads[^\n]*reservations/);
      assert.match(output.text, /Key Token budget[^\n]*Weekly[^\n]*includes cache reads[^\n]*reservations/);
      assert.match(output.text, /Key USD budget[^\n]*Daily[^\n]*2[^\n]*unpriced[^\n]*reservations/);
      assert.match(output.text, /Key USD budget[^\n]*Weekly[^\n]*5[^\n]*unpriced[^\n]*reservations/);
      assert.doesNotMatch(
        output.text,
        /\p{Script=Han}/u,
        'English fixture retains English panel labels and diagnostics',
      );
      for (const value of ['fixture-plan', 'fixture-upstream']) {
        assert(!output.text.includes(value), `/usage text omits management fixture value ${value}`);
      }
    }
    assert(
      !JSON.stringify(messages.slice(command.from)).includes(fixtureKeys.A)
        && !JSON.stringify(messages.slice(command.from)).includes(fixtureKeys.B),
      'RPC events must not disclose fixture credentials',
    );
    assert.equal(
      fixture.requests.filter(request => request.generation).length,
      generationBefore,
      'each /usage stage must make zero generation POST requests',
    );
    const traffic = fixture.requests.slice(trafficFrom);
    assert(
      traffic.filter(request => request.path.includes('/v1/magpie/')).every(request =>
        /\/v1\/magpie\/(quotas|limit)$/.test(request.path) && !request.generation
      ),
      'native /usage management requests only read quotas and key budgets without redemption or model generation',
    );
    passed('builtin /usage command_output and same-id agentInvoked:false response');
    return output.text;
  }
  async function runProbe(action, fields = {}) {
    let result;
    try {
      result = await fixture.command(action, fields);
    } catch (error) {
      const failures = messages.filter(value => value.type === 'extension_error' || value.type === 'error');
      throw new Error(safe(`${error}; stderr=${stderr}; extension failures=${JSON.stringify(failures)}`));
    }
    assert(result.ok, safe(result.error ?? `probe failed: ${action}`));
    for (const name of result.assertions) passed(name);
  }
  async function promptHook() {
    const command = await send('prompt', { message: 'Reply with fixture complete.' });
    const response = await waitFor(
      value => value.type === 'response' && value.id === command.id,
      'real request hook prompt response',
      45000,
      command.from,
    );
    assert.equal(response.success, true, safe(JSON.stringify(response)));
    await waitFor(value => value.type === 'agent_end', 'real request completion', 45000, command.from);
  }
  async function selectModel(provider, modelId) {
    const command = await send('set_model', { provider, modelId });
    const response = await waitFor(
      value => value.type === 'response' && value.id === command.id,
      'model selection response',
      10000,
      command.from,
    );
    assert.equal(response.success, true, safe(JSON.stringify(response)));
    assert.equal(response.data?.provider, provider, safe(JSON.stringify(response)));
    assert.equal(response.data?.id, modelId, safe(JSON.stringify(response)));
  }
  async function strictTask(api, phase) {
    await selectModel('smoke-created', api === 'responses' ? 'smoke-responses' : 'smoke-completions');
    const start = fixture.requests.length;
    const command = await send('prompt', { message: 'Run the local fixture task.' });
    const response = await waitFor(
      value => value.type === 'response' && value.id === command.id,
      'strict task prompt response',
      45000,
      command.from,
    );
    assert.equal(response.success, true, safe(JSON.stringify(response)));
    const end = await waitFor(
      value => value.type === 'agent_end' && value.willContinue !== true,
      'strict task completion',
      90000,
      command.from,
    );
    const final = end.messages?.findLast(message => message.role === 'assistant');
    assert.equal(final?.stopReason, 'stop', safe(JSON.stringify(final)));
    assert(
      final.content.some(block => block.type === 'text' && block.text.includes('SMOKE_PARENT_RECEIVED_42')),
      safe(`parent did not receive child result: ${JSON.stringify(end)}`),
    );
    const traffic = fixture.requests.slice(start);
    const route = api === 'responses' ? '/created/v1/responses' : '/created/v1/chat/completions';
    const request = traffic.find(row => row.path === route && row.tools?.some(tool => tool.name === 'task'));
    assert(request, `${phase} ${api} sends real task request to ${route}`);
    assert.equal(request.tools.find(tool => tool.name === 'task').strict, false, `${phase} ${api} task strict false`);
    assert.equal(
      request.tools.find(tool => tool.name === 'smoke_strict')?.strict,
      true,
      `${phase} ${api} control strict true`,
    );
    assert(
      traffic.some(row => row.path === '/child/v1/chat/completions' && row.model === 'smoke-static'),
      `${phase} ${api} executes a real local child`,
    );
    passed(`${phase} ${api} sends task false and control true and receives the real child result`);
  }
  async function setup({ cancel = false, expectedRoot = '/prefix/a' } = {}) {
    const generationBefore = fixture.requests.filter(request => request.generation).length;
    const command = await send('prompt', { message: '/magpie setup' });
    const request = (method, from = command.from) =>
      waitFor(
        value => value.type === 'extension_ui_request' && value.method === method,
        `setup ${method}`,
        10000,
        from,
      );
    const answer = (frame, fields) =>
      child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: frame.id, ...fields })}\n`);
    const candidates = await request('select');
    assert.match(candidates.title, /选择已有 provider/);
    assert(candidates.options.includes('smoke-a'), 'real SDK registry provider appears in setup candidates');
    let from = messages.length;
    answer(candidates, { value: 'smoke-a' });
    const summary = await request('select', from);
    assert.deepEqual(summary.options, ['确认连接', '取消']);
    assert(
      summary.title.includes('provider ID：smoke-a') && summary.title.includes(`${fixture.root}${expectedRoot}`)
        && summary.title.includes('认证来源：') && !summary.title.includes('/obsolete-bootstrap'),
      'setup uses the current OMP provider address and non-secret authentication source',
    );
    passed('RPC setup selects actual registry provider and prefills non-secret connection summary');
    answer(summary, { value: cancel ? '取消' : '确认连接' });
    const response = await waitFor(
      value => value.type === 'response' && value.id === command.id,
      'same-id setup response',
      45000,
      command.from,
    );
    assert.equal(response.success, true, safe(JSON.stringify(response)));
    assert.equal(
      fixture.requests.filter(request => request.generation).length,
      generationBefore,
      'setup must not make model generation requests',
    );
    passed(`RPC setup ${cancel ? 'cancellation' : 'confirmation'} completes without invoking the agent`);
  }
  async function nativeLogin() {
    let command = await send('get_login_providers');
    let response = await waitFor(
      value => value.type === 'response' && value.id === command.id,
      'native login provider list',
      10000,
      command.from,
    );
    assert.equal(response.success, true, safe(JSON.stringify(response)));
    const providers = response.data.providers;
    assert(providers.some(provider => provider.id === 'magpie'), 'default Magpie native login is registered');
    assert(providers.some(provider => provider.id === 'smoke-a'), 'configured Magpie alias native login is registered');
    passed('native RPC login registry exposes default magpie and the configured alias');
    command = await send('login', { providerId: 'smoke-a' });
    response = await waitFor(
      value => value.type === 'response' && value.id === command.id,
      'native login existing-provider refusal',
      10000,
      command.from,
    );
    assert.equal(response.success, false, 'native onboarding cannot replace the existing configured provider');
    assert(
      !messages.slice(command.from).some(value => value.type === 'extension_ui_request' && value.method === 'open_url'),
      'API-key onboarding must not fake an OAuth URL',
    );
    passed('native RPC login refuses replacing the configured provider without persisting settings');
  }
  async function close() {
    child.stdin.end();
    let timer;
    try {
      const code = await Promise.race([
        exit,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('RPC stdin EOF did not drain and exit')), 15000);
        }),
      ]);
      assert.equal(code, 0, safe(stderr));
      assert(
        !stderr.includes(fixtureKeys.A) && !stderr.includes(fixtureKeys.B),
        'host diagnostics must not disclose fixture credentials',
      );
      assert(
        !JSON.stringify(messages).includes(fixtureKeys.A) && !JSON.stringify(messages).includes(fixtureKeys.B),
        'host RPC stream must not disclose fixture credentials',
      );
      const shutdown = JSON.parse(await readFile(isolation.env.OMP_SMOKE_SHUTDOWN_FILE, 'utf8'));
      assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
      passed('stdin EOF drains host, awaits all session_shutdown handlers and removes owned adapters');
    } finally {
      clearTimeout(timer);
      if (exited) active.delete(child);
    }
  }
  await waitFor(value => value.type === 'ready', 'RPC ready');
  return { usage, runProbe, promptHook, strictTask, selectModel, setup, nativeLogin, close };
}

async function installedPackage(home, version) {
  const matches = [];
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('marketplace install contains symlink');
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        assert(item.name !== 'node_modules', 'production install must not contain node_modules');
        await visit(path);
      } else if (item.name === 'package.json') {
        try {
          const value = JSON.parse(await readFile(path, 'utf8'));
          if (value.name === 'omp-magpie' && value.version === version) matches.push(dirname(path));
        } catch { /* Other host package metadata is irrelevant. */ }
      }
    }
  }
  await visit(join(home, '.omp/plugins/cache/plugins'));
  assert.equal(matches.length, 1, `one actual cached plugin package at ${version}`);
  const source = matches[0];
  const allowed = new Set(['src', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  assert(
    (await readdir(source)).every(name => allowed.has(name)),
    'actual installed copy contains only production files',
  );
  await access(join(source, 'src/index.ts'));
  passed(`marketplace cache contains the real self-contained ${version} package`);
  return source;
}

try {
  // 运行时扩展也放在无 node_modules 的隔离树，避免 SDK 开发副本参与宿主模块解析。
  await mkdir(join(runtimeSource, 'scripts'), { recursive: true });
  await cp(join(repository, 'scripts/smoke-probe.ts'), probe);
  await cp(join(repository, 'plugins/omp-magpie'), join(runtimeSource, 'plugins/omp-magpie'), { recursive: true });
  const market = await environment('marketplace');
  const version = (await cli(market, ['--version'])).trim();
  assert.match(version, /^(?:omp[\/\s])?v?18\.12\.6$/, 'standalone OMP version must be exactly 18.12.6');
  console.log(`Standalone OMP: ${executable}; version: 18.12.6; isolated PATH has no Bun installation requirement`);
  const source = join(workspace, 'marketplace-source');
  await mkdir(join(source, '.omp-plugin'), { recursive: true });
  await cp(join(repository, '.omp-plugin/marketplace.json'), join(source, '.omp-plugin/marketplace.json'));
  await cp(join(repository, 'plugins/omp-magpie'), join(source, 'plugins/omp-magpie'), { recursive: true });
  const releasePackage = JSON.parse(await readFile(join(source, 'plugins/omp-magpie/package.json'), 'utf8'));
  const releaseVersion = releasePackage.version;
  const [major, minor, patch] = releaseVersion.split('.').map(Number);
  const upgradeVersion = `${major}.${minor}.${patch + 1}`;
  await cli(market, ['plugin', 'marketplace', 'add', source]);
  await cli(market, ['plugin', 'install', pluginId, '--scope', 'user']);
  assert.match(await cli(market, ['plugin', 'list']), /omp-magpie/);
  await cli(market, ['plugin', 'config', 'set', 'omp-magpie', 'autoAttach', 'false']);
  const marketConnections = [{ providerId: 'magpie' }, { providerId: 'smoke-a' }];
  await cli(market, ['plugin', 'config', 'set', 'omp-magpie', 'connections', JSON.stringify(marketConnections)]);
  await installedPackage(market.home, releaseVersion);
  const beforeGeneration = fixture.requests.filter(request => request.generation).length;
  let client = await rpc(market);
  await client.usage(true, true);
  await client.runProbe('audit', { installed: true });
  await client.close();
  assert.equal(
    fixture.requests.filter(request => request.generation).length,
    beforeGeneration,
    'marketplace /usage must make zero generation POST requests',
  );
  passed('marketplace add/install/list/config and discovered builtin /usage make zero generation POSTs');

  const catalogPath = join(source, '.omp-plugin/marketplace.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.plugins.find(plugin => plugin.name === 'omp-magpie').version = upgradeVersion;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const packagePath = join(source, 'plugins/omp-magpie/package.json');
  const packageData = JSON.parse(await readFile(packagePath, 'utf8'));
  packageData.version = upgradeVersion;
  await writeFile(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
  const changelog = join(source, 'plugins/omp-magpie/CHANGELOG.md');
  await writeFile(changelog, `# ${upgradeVersion} smoke upgrade fixture\n\n${await readFile(changelog, 'utf8')}`);
  await cli(market, ['plugin', 'marketplace', 'update', 'huspx-agent-plugins']);
  await cli(market, ['plugin', 'upgrade', pluginId, '--scope', 'user']);
  const cached = await installedPackage(market.home, upgradeVersion);
  assert((await readFile(join(cached, 'CHANGELOG.md'), 'utf8')).includes(`${upgradeVersion} smoke upgrade fixture`));
  const upgradeStart = fixture.requests.length;
  client = await rpc(market);
  await client.usage();
  await client.runProbe('audit', { installed: true });
  // Every declared alias has one effective collection per endpoint after a
  // full restart; keyless aliases must never request a key budget.
  for (const prefix of ['/local', '/prefix/a']) {
    for (const endpoint of ['quotas', ...(prefix === '/local' ? [] : ['limit'])]) {
      assert.equal(
        fixture.requests.slice(upgradeStart).filter(request => request.path === `${prefix}/v1/magpie/${endpoint}`)
          .length,
        1,
        `upgrade has one effective ${endpoint} attachment per alias`,
      );
    }
  }
  await client.close();
  passed(`temporary local marketplace update/upgrade loads ${releaseVersion} then ${upgradeVersion} exactly once`);
  await cli(market, ['plugin', 'disable', pluginId]);
  client = await rpc(market);
  await client.usage(false);
  await client.runProbe('audit', { installed: false });
  await client.close();
  await cli(market, ['plugin', 'uninstall', pluginId, '--scope', 'user']);
  client = await rpc(market);
  await client.usage(false);
  await client.runProbe('audit', { installed: false });
  await client.close();
  passed('disable and uninstall each survive a real host restart');

  const onboarding = await environment('onboarding');
  await cli(onboarding, ['plugin', 'marketplace', 'add', source]);
  await cli(onboarding, ['plugin', 'install', pluginId, '--scope', 'user']);
  await cli(onboarding, ['plugin', 'config', 'set', 'omp-magpie', 'autoAttach', 'false']);
  const otherConnection = { providerId: 'smoke-b', createProvider: false };
  await cli(onboarding, ['plugin', 'config', 'set', 'omp-magpie', 'connections', JSON.stringify([otherConnection])]);
  const settings = async () =>
    JSON.parse(await cli(onboarding, ['plugin', 'config', 'list', 'omp-magpie', '--json'])).settings;
  const printSetup = command =>
    cli(onboarding, [
      '--no-session',
      '--no-skills',
      '--no-rules',
      '--no-tools',
      '--no-lsp',
      '--model',
      'magpie/smoke-static',
      '-p',
      command,
    ]);
  const onboardingTraffic = fixture.requests.length;
  await printSetup('/magpie setup --provider smoke-a --yes');
  const cliSettings = await settings();
  const cliConnections = JSON.parse(cliSettings.connections);
  assert.equal(cliSettings.autoAttach, false, 'confirmed setup preserves autoAttach');
  assert.equal(cliConnections.length, 2, 'confirmed setup appends one connection');
  assert.deepEqual(cliConnections[0], otherConnection, 'confirmed CLI setup preserves the other connection');
  assert.equal(cliConnections[1].providerId, 'smoke-a');
  assert.equal(cliConnections[1].createProvider, false, 'existing provider setup does not grant provider creation');
  assert(
    !JSON.stringify(cliSettings).includes(fixtureKeys.A) && !JSON.stringify(cliSettings).includes(fixtureKeys.B),
    'settings never contain credential values',
  );
  passed('real CLI --yes persists one existing-provider attachment while preserving unrelated settings');
  const richConnection = {
    providerId: 'smoke-a',
    baseUrl: `${fixture.root}/obsolete-bootstrap/v1`,
    createProvider: true,
  };
  await cli(onboarding, [
    'plugin',
    'config',
    'set',
    'omp-magpie',
    'connections',
    JSON.stringify([otherConnection, richConnection]),
  ]);
  const richSettings = await settings();
  client = await rpc(onboarding);
  await client.runProbe('setup-baseline');
  await client.nativeLogin();
  assert.deepEqual(await settings(), richSettings, 'native RPC login rejection cannot persist settings');
  await client.setup({ cancel: true });
  assert.deepEqual(await settings(), richSettings, 'RPC cancel cannot persist settings');
  await client.setup();
  const confirmedSettings = await settings();
  assert.equal(confirmedSettings.autoAttach, richSettings.autoAttach);
  assert.deepEqual(
    JSON.parse(confirmedSettings.connections),
    JSON.parse(richSettings.connections),
    'RPC confirmation preserves all prefilled connection values and all other connections',
  );
  await client.runProbe('setup-audit');
  await client.runProbe('setup-provider-change');
  await client.runProbe('setup-baseline');
  await client.setup({ expectedRoot: '/prefix/changed' });
  assert.deepEqual(
    await settings(),
    confirmedSettings,
    'provider address update does not create a second address source in plugin settings',
  );
  await client.runProbe('setup-audit', { expectedPrefix: '/prefix/changed' });
  await client.close();
  assert(
    !fixture.requests.slice(onboardingTraffic).some(request => request.generation),
    'CLI and RPC onboarding must make zero generation POSTs',
  );
  assert(
    !fixture.requests.slice(onboardingTraffic).some(request => request.path.startsWith('/obsolete-bootstrap')),
    'existing provider never uses the stale bootstrap address',
  );
  passed('real setup follows OMP provider updates, preserves settings and avoids generation');

  const sdk = await environment('sdk');
  // 强制同步 task 和 structured yield，避免异步完成唤醒与前一轮 RPC 事件混淆。
  await writeFile(
    join(sdk.agentDir, 'config.yml'),
    JSON.stringify({ async: { enabled: false }, task: { structured: true, batch: false } }),
  );
  const connections = [
    { providerId: 'magpie' },
    { providerId: 'smoke-a' },
    { providerId: 'smoke-b' },
    { providerId: 'smoke-ordinary' },
    { providerId: 'smoke-command' },
    { providerId: 'smoke-literal' },
    { providerId: 'smoke-created', baseUrl: `${fixture.root}/created`, createProvider: true },
  ];
  // Direct extension mode still reads the public plugin settings helper. Use
  // the same CLI settings route as marketplace installation, then load only
  // the two explicitly authorized extensions.
  await cli(sdk, ['plugin', 'marketplace', 'add', source]);
  await cli(sdk, ['plugin', 'install', pluginId, '--scope', 'user']);
  await cli(sdk, ['plugin', 'config', 'set', 'omp-magpie', 'autoAttach', 'true']);
  client = await rpc(sdk, { direct: true });
  await client.usage(false);
  await client.runProbe('seed-created');
  await client.close();
  await cli(sdk, ['plugin', 'config', 'set', 'omp-magpie', 'connections', JSON.stringify(connections)]);
  fixture.allowGeneration(true);
  client = await rpc(sdk, { direct: true, strictTools: true });
  await client.usage();
  for (const phase of ['initial', 'refresh', 'cache']) {
    await client.runProbe(`strict-${phase}`);
    for (const api of ['responses', 'completions']) await client.strictTask(api, phase);
  }
  await client.selectModel('magpie', 'smoke-static');
  for (
    const action of [
      'baseline',
      'prefix',
      'inventory',
      'usage-barriers',
      'literal',
      'provider-root',
      'anthropic-roots',
      'model-headers',
      'stored',
      'models',
      'aliases',
    ]
  ) await client.runProbe(action);
  await client.usage();
  await client.runProbe('select-late');
  await client.promptHook();
  await client.runProbe('late');
  await client.runProbe('prepare-race');
  await client.promptHook();
  await client.runProbe('rotation');
  await client.runProbe('usage-rotation');
  await client.runProbe('owners');
  await client.runProbe('onboarding-lifecycle');
  await client.runProbe('login-repeat');
  await client.runProbe('login-references');
  await client.runProbe('claim-leases');
  for (
    const action of [
      'create-conflict',
      'identity-recovery',
      'dynamic-isolation',
      'dynamic-root',
      'header-root-snapshot',
      'relogin-root-snapshot',
      'setup-session-snapshot',
    ]
  ) await client.runProbe(action);
  await client.runProbe('generation');
  await client.close();
  fixture.allowGeneration(false);
  await cli(sdk, ['plugin', 'disable', pluginId]);
  client = await rpc(sdk);
  await client.usage(false);
  await client.runProbe('audit', { installed: false });
  await client.close();
  passed('created runtime provider disappears after disabled-plugin restart');
  assert(
    !fixture.requests.some(request => request.marker || request.credential === 'unexpected'),
    'all HTTP credentials must belong to the fixture and exclude internal marker',
  );
  assert(
    fixture.requests.filter(request => request.path.includes('/v1/magpie/')).every(request =>
      /\/v1\/magpie\/(quotas|limit)$/.test(request.path) && request.query === '' && !request.generation
    ),
    'all management traffic is read-only quotas or key budgets',
  );
  assert(
    !fixture.requests.some(request => /redeem|exchange|reset-credit|reset_credit/i.test(request.path)),
    'inventory display never redeems reset credits',
  );
  passed('all HTTP traffic uses loopback fixture with non-secret credential classifications');
  console.log(
    `Smoke passed: ${assertionCount} assertions; TUI and future published HTTPS source are separate acceptance steps.`,
  );
} finally {
  for (const child of active) {
    child.stdin.end();
    child.kill('SIGTERM');
  }
  await Promise.all([...active].map(child =>
    child.exitCode !== null ? Promise.resolve() : new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    })
  ));
  await fixture.close();
  await rm(workspace, { recursive: true, force: true });
}
