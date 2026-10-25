import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { Model, Api, UsageReport, UsageProvider } from "@oh-my-pi/pi-ai";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";
import { normalizeAnthropicBaseUrl } from "@oh-my-pi/pi-ai/providers/anthropic";
import { invalidateCommandConfig, resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { getPluginSettings, PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { MagpieOnboarding } from "../plugins/omp-magpie/src/onboarding.ts";
import { createBindingOwner, type BindingOwner } from "../plugins/omp-magpie/src/bindings.ts";
import { parseConfig, type PluginConfig } from "../plugins/omp-magpie/src/config.ts";
import { readProviderRoot } from "../plugins/omp-magpie/src/provider.ts";

type Owner = BindingOwner;
interface Task { id: string; action: string; installed?: boolean; expectedPrefix?: string }
interface State { held: number; heldRequests: { path: string; credential: string }[]; aborted: number; generationPosts: number; requests: { path: string; query: string; credential: string; generation: boolean; aborted: boolean; marker: boolean; priceHeader: boolean }[] }
const root = process.env.OMP_SMOKE_FIXTURE!;
const keyA = process.env.OMP_SMOKE_KEY_A!;
const keyB = process.env.OMP_SMOKE_KEY_B!;
const keyFile = process.env.OMP_SMOKE_KEY_FILE!;
const shutdownFile = process.env.OMP_SMOKE_SHUTDOWN_FILE!;
const modelDefaults: Omit<ProviderModelConfig, "id"> = { name: "fixture model", contextWindow: 4096, maxTokens: 512, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const lifetime = new AbortController();
const assertions: string[] = [];
const owners = new Set<Owner>();
const notifications: string[] = [];
let ctx: ExtensionContext;
let baselineModels: string;
let baselineKey: string | undefined;
let baselineHeaders: string;
let pendingOld: Promise<UsageReport[] | null> | undefined;
let oldAccount: string | undefined;
let generationBefore: number;
let abortedBefore = 0;
let shutdownSeen = false;
let foreign: UsageProvider | undefined;
let setupBefore: { models: string; headers: string; key?: string; credentials: string; generation: number } | undefined;

function check(name: string, condition: unknown): asserts condition {
  assert.ok(condition, name);
  assertions.push(name);
}
function model(provider: string, id = "smoke-static"): Model<Api> {
  const value = ctx.modelRegistry.find(provider, id);
  assert.ok(value, `registry model exists: ${provider}/${id}`);
  return value;
}
function config(ids: string[], options: { autoAttach?: boolean } = {}): PluginConfig {
  return parseConfig({ autoAttach: options.autoAttach ?? false, connections: JSON.stringify(ids.map(providerId => ({ providerId }))) });
}
function owner(pi: Pick<ExtensionAPI, "registerProvider">): Owner {
  const value = createBindingOwner(pi, message => notifications.push(message), { defaultRankingStrategy, resolveConfigValue });
  owners.add(value);
  return value;
}
function close(value: Owner): void { value.close(); owners.delete(value); }
async function state(): Promise<State> { return await (await fetch(`${root}/__smoke/state`, { signal: lifetime.signal })).json() as State; }
async function control(path: string): Promise<void> { await fetch(`${root}/__smoke/${path}`, { signal: lifetime.signal }); }
/** 等待真实宿主与 HTTP 状态收敛；只在可观测条件满足后进入下一阶段，避免以固定延时冒充完成。 */
async function eventually(name: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  // 宿主失败冷却为 10s ±25%；deadline 必须覆盖其最大值及一次实际读取。
  const until = Date.now() + 20_000;
  while (!(await predicate())) { assert.ok(Date.now() < until, name); await delay(20, undefined, { signal: lifetime.signal }); }
  check(name, true);
}
async function createConfig(providerId: string, prefix: string): Promise<PluginConfig> {
  await ctx.modelRegistry.authStorage.credentials.set(providerId, { type: "api_key", key: keyA });
  return parseConfig({ autoAttach: false, connections: JSON.stringify([{ providerId, baseUrl: `${root}${prefix}`, createProvider: true }]) });
}
function heldAt(snapshot: State, path: string, credential = "A"): boolean {
  return snapshot.heldRequests.some(request => request.path === path && request.credential === credential);
}
async function reports(provider?: string): Promise<UsageReport[]> {
  const usage = ctx.modelRegistry.authStorage.usage;
  await usage.invalidate(provider);
  const result = await usage.reports({ baseUrlResolver: id => ctx.modelRegistry.getProviderBaseUrl(id), signal: lifetime.signal });
  return (result ?? []).filter(report => !provider || report.provider === provider);
}
function tokenBudget(rows: UsageReport[], expected: number): boolean {
  return rows.some(report => report.limits.some(limit => limit.window?.label === "Daily" && limit.amount.unit === "tokens" && limit.amount.limit === 1000 && limit.amount.used === expected));
}

/** 在独立 OMP 进程验证插件的路由、身份和所有权；模型价格只在动态回调输出处检查隔离。 */
async function run(task: Task, pi: ExtensionAPI): Promise<void> {
  const registry = ctx.modelRegistry;
  const auth = registry.authStorage;
  switch (task.action) {
    case "audit": {
      const present = !!auth.usage.providerFor("magpie");
      check("marketplace automatic discovery matches enabled state", present === task.installed);
      check("restart preserves original provider", !!registry.find("magpie", "smoke-static"));
      check("restart preserves original inference credential", await registry.getApiKey(model("magpie")) === baselineKey);
      check("runtime-created provider does not survive restart", !registry.hasProvider("smoke-created"));
      break;
    }
    case "seed-created": {
      await auth.credentials.set("smoke-created", { type: "api_key", key: keyA });
      break;
    }
    case "setup-provider-change": {
      pi.registerProvider("smoke-a", {
        api: "openai-completions", baseUrl: `${root}/prefix/changed/v1`, apiKey: "OMP_SMOKE_KEY_A",
        headers: { "X-Smoke-Inference": "preserved" },
      });
      check("provider address update is visible in the real registry", registry.getProviderBaseUrl("smoke-a") === `${root}/prefix/changed/v1`);
      break;
    }
    case "setup-baseline": {
      setupBefore = {
        models: JSON.stringify(registry.getProviderModels("smoke-a")),
        headers: JSON.stringify(await registry.getProviderHeaders("smoke-a")),
        key: await registry.getApiKey(model("smoke-a")),
        credentials: JSON.stringify(auth.credentials.all()),
        generation: auth.credentials.generation,
      };
      check("onboarding snapshot reads the real existing provider and effective A credential", !!registry.find("smoke-a", "smoke-static") && setupBefore.key === keyA);
      break;
    }
    case "setup-audit": {
      assert.ok(setupBefore, "setup audit requires an actual SDK state snapshot");
      check("setup preserves the existing registry model catalog", JSON.stringify(registry.getProviderModels("smoke-a")) === setupBefore.models);
      check("setup preserves effective inference authentication and provider headers", await registry.getApiKey(model("smoke-a")) === setupBefore.key && JSON.stringify(await registry.getProviderHeaders("smoke-a")) === setupBefore.headers);
      check("setup and rejected native login leave native auth rows and generation unchanged", JSON.stringify(auth.credentials.all()) === setupBefore.credentials && auth.credentials.generation === setupBefore.generation);
      const before = (await state()).requests.length;
      check("confirmed setup attaches a real SDK usage collector", !!auth.usage.providerFor("smoke-a") && tokenBudget(await reports("smoke-a"), 111));
      const traffic = (await state()).requests.slice(before);
      check("confirmed setup sends the effective A credential to its exact configured prefix", traffic.some(request => request.path === `${task.expectedPrefix ?? "/prefix/a"}/v1/magpie/limit` && request.credential === "A"));
      check("setup collection never generates a model request", !traffic.some(request => request.generation));
      break;
    }
    case "baseline": {
      check("usage leaves original model catalog unchanged", JSON.stringify(registry.getProviderModels("magpie")) === baselineModels);
      check("usage leaves keyless inference sentinel unchanged", await registry.getApiKey(model("magpie")) === baselineKey);
      check("usage leaves original provider headers unchanged", JSON.stringify(await registry.getProviderHeaders("magpie")) === baselineHeaders);
      const rows = await reports("magpie");
      check("keyless zero-account collector has real windows", rows.some(report => report.limits.some(limit => limit.label?.includes("fixture-exhausted-window"))));
      check("keyless provider retains configured no-auth sentinel", baselineKey === "N/A");
      check("upstream exhausted window remains exhausted", rows.some(report => report.limits.some(limit => limit.status === "exhausted")));
      check("sibling remaining quota remains visible", rows.some(report => report.limits.some(limit => limit.amount.remainingFraction === 0.8)));
      const health = await auth.health.model("magpie", { modelId: "smoke-static", baseUrl: model("magpie").baseUrl, reserveFraction: 0.1 });
      check("independent provider health remains unknown", health.state === "unknown");
      check("keyless HTTP never sends usage marker", !(await state()).requests.some(request => request.marker));
      break;
    }
    case "literal": {
      check("OMP resolves a configured literal key without a plugin auth copy", await registry.getApiKey(model("smoke-literal")) === keyA);
      check("literal-key usage follows the native inference identity", tokenBudget(await reports("smoke-literal"), 111)
        && (await state()).requests.some(request => request.path === "/literal/v1/magpie/limit" && request.credential === "A"));
      break;
    }
    case "provider-root": {
      const id = "smoke-provider-root";
      const value = owner(pi);
      try {
        await value.configure(ctx, await createConfig(id, "/native-source/v1/v1"));
        check("materialized mixed-protocol provider preserves a root ending in v1", readProviderRoot(registry, id) === `${root}/native-source/v1`);
        check("provider-derived root reaches its actual nested prefix", tokenBudget(await reports(id), 111)
          && (await state()).requests.some(request => request.path === "/native-source/v1/v1/magpie/limit" && request.credential === "A"));
        pi.unregisterProvider(id);
        check("removed provider endpoint cannot revive its old bootstrap root", readProviderRoot(registry, id) === undefined);
      } finally {
        close(value);
        await auth.credentials.remove(id);
      }
      break;
    }
    case "anthropic-roots": {
      const id = "smoke-anthropic-roots";
      const value = owner(pi);
      try {
        for (const path of ["/anthropic-proxy", "/anthropic-proxy/v1", "/anthropic-proxy/v1/v1", "/anthropic-proxy/v1beta"]) {
          const endpoint = `${root}${path}`;
          const expectedRoot = normalizeAnthropicBaseUrl(endpoint)!;
          pi.registerProvider(id, { api: "anthropic-messages", baseUrl: endpoint, apiKey: "OMP_SMOKE_KEY_A", models: [{ ...modelDefaults, id: "a", api: "anthropic-messages" }] });
          await value.configure(ctx, config([id]));
          check(`Anthropic ${path} uses its native request root`, readProviderRoot(registry, id) === expectedRoot);
          const from = (await state()).requests.length;
          check(`Anthropic ${path} collects its actual key budget`, tokenBudget(await reports(id), 111)
            && (await state()).requests.slice(from).some(request => request.path === `${new URL(expectedRoot).pathname}/v1/magpie/limit` && request.credential === "A"));
          // beta 后缀在混合协议目录中仍属合法 prefix；只在此歧义边界检查顺序独立性。
          if (path === "/anthropic-proxy/v1beta") {
            for (const first of ["openai-completions", "anthropic-messages"] as const) {
              pi.registerProvider(id, { api: "openai-completions", baseUrl: endpoint, apiKey: "OMP_SMOKE_KEY_A", models: [{ ...modelDefaults, id: "a", api: first }, { ...modelDefaults, id: "b", api: first === "anthropic-messages" ? "openai-completions" : "anthropic-messages" }] });
              const before = (await state()).requests.length;
              check(`mixed ${first} first preserves the actual beta-prefix budget route`, tokenBudget(await reports(id), 111)
                && (await state()).requests.slice(before).some(request => request.path === `${new URL(expectedRoot).pathname}/v1/magpie/limit` && request.credential === "A"));
            }
          }
        }
      } finally {
        close(value);
        pi.unregisterProvider(id);
      }
      break;
    }
    case "dynamic-root": {
      const id = "smoke-dynamic-root";
      const file = join(process.env.PI_CODING_AGENT_DIR!, "models.yml");
      const original = await readFile(file, "utf8");
      let dynamic: ProviderConfig["fetchDynamicModels"];
      const value = owner({ registerProvider(providerId, registration) {
        if (providerId === id) dynamic = registration.fetchDynamicModels;
        pi.registerProvider(providerId, registration);
      } });
      try {
        await value.configure(ctx, await createConfig(id, "/dynamic-root-a"));
        assert.ok(dynamic);
        await auth.credentials.remove(id);
        const settings = JSON.parse(original);
        settings.providers[id] = { baseUrl: `${root}/dynamic-root-b/v1`, apiKey: "OMP_SMOKE_KEY_B" };
        await writeFile(file, JSON.stringify(settings));
        // 从原生配置刷新，验证新 key 只发往当前源；不以 callback mock 替代实际 HTTP 路由。
        const from = (await state()).requests.length;
        await registry.refreshProvider(id, "online");
        const requests = (await state()).requests.slice(from);
        check("online callback follows native models.yml endpoint and key update", requests.some(request => request.path === "/dynamic-root-b/v1/models" && request.credential === "B"));
        check("new native key never reaches bootstrap model directory", !requests.some(request => request.path === "/dynamic-root-a/v1/models" && request.credential === "B"));
        await value.reconcile(ctx);
        check("updated native provider collects B budget", tokenBudget(await reports(id), 222));
        // 请求在 B 源发出后切到 C 源；旧响应必须失效，即使实际 key 没有变化。
        await control("hold-models?prefix=/dynamic-root-b&key=B");
        const stale = dynamic(keyB).then(() => false, () => true);
        await eventually("model directory B read is held before endpoint changes", async () => heldAt(await state(), "/dynamic-root-b/v1/models", "B"));
        await control("catalog?prefix=/dynamic-root-c&key=B&prices=missing");
        pi.registerProvider(id, { api: "openai-completions", baseUrl: `${root}/dynamic-root-c/v1`, apiKey: "OMP_SMOKE_KEY_B" });
        await control("release");
        check("endpoint change alone rejects old in-flight model rows", await stale);
        const current = await dynamic(keyB);
        check("new root callback cannot inherit the previous root's price card", current.length > 0 && current.every(row => row.cost?.input === 0 && row.cost.output === 0 && row.cost.cacheRead === 0 && row.cost.cacheWrite === 0));
        await registry.refreshDiscoverableProviders([id], "online");
        check("refreshed protocol models use the current provider endpoint", ["smoke-anthropic", "smoke-responses", "smoke-completions"].every(name => model(id, name).baseUrl === `${root}/dynamic-root-c/v1`));
      } finally {
        close(value);
        await control("release");
        pi.unregisterProvider(id);
        await auth.credentials.remove(id);
        await writeFile(file, original);
        await registry.refreshProvider(id, "offline");
      }
      break;
    }
    case "model-headers": {
      const id = "smoke-model-headers";
      const value = owner(pi);
      const register = (reference: string) => pi.registerProvider(id, {
        api: "openai-completions", baseUrl: `${root}/model-headers/v1`, apiKey: "OMP_SMOKE_KEY_A",
        models: [{ ...modelDefaults, id: "header-model", headers: { Authorization: reference } }],
      });
      try {
        register("!printf 'Bearer %s' \"$OMP_SMOKE_KEY_B\"");
        const current = model(id, "header-model");
        const headers = await registry.resolveModelHeaders(current);
        check("native model header resolves its command to B", headers?.Authorization === `Bearer ${keyB}`);
        await value.configure(ctx, config([id]));
        check("model credential B cannot attach provider A budget", !auth.usage.providerFor(id));
        check("model credential conflict publishes no provider A report", (await reports(id)).length === 0);
        register("!printf 'Bearer %s' \"$OMP_SMOKE_KEY_A\"");
        await value.reconcile(ctx);
        check("matching model header A permits actual A budget", tokenBudget(await reports(id), 111));
      } finally {
        close(value);
        pi.unregisterProvider(id);
      }
      break;
    }
    case "prefix": {
      check("same-host key A budget is isolated", tokenBudget(await reports("smoke-a"), 111));
      check("same-host key B budget is isolated", tokenBudget(await reports("smoke-b"), 222));
      const ordinary = await reports("smoke-ordinary");
      check("quota 403 preserves valid key budget", tokenBudget(ordinary, 111));
      check("quota 403 retains native permission diagnosis", ordinary.some(report => report.notes?.some(note => /Subscription quotas/.test(note) && /permission/.test(note))));
      const a = (await reports("smoke-a"))[0];
      const b = (await reports("smoke-b"))[0];
      check("same-host key reports have distinct metadata", !!a?.metadata?.accountId && a.metadata.accountId !== b?.metadata?.accountId);
      const traffic = (await state()).requests;
      check("management requests preserve remote prefix", traffic.some(request => request.path === "/prefix/a/v1/magpie/limit" && request.credential === "A") && traffic.some(request => request.path === "/prefix/b/v1/magpie/limit" && request.credential === "B"));
      check("exhausted upstream does not replace gateway inference key", await registry.getApiKey(model("smoke-a")) === keyA);
      check("key-backed independent alias health remains unknown", (await auth.health.model("smoke-a", { modelId: "smoke-static", baseUrl: model("smoke-a").baseUrl, reserveFraction: 0.1 })).state === "unknown");
      break;
    }
    case "inventory": {
      const from = (await state()).requests.length;
      const report = (await reports("smoke-a"))[0];
      assert.ok(report);
      const inventory = report.notes?.filter(note => note.includes("Reset credits")) ?? [];
      const account = (name: string): string => {
        const matching = inventory.filter(note => note.includes(name));
        assert.equal(matching.length, 1, `one inventory note for ${name}`);
        return matching[0]!;
      };
      const primary = account("fixture-alias");
      check("primary inventory preserves window counts, team and expiry", /5h\s*2\b/.test(primary) && /Weekly\s*1\b/.test(primary) && primary.includes("(team)") && primary.includes("2032-01-01") && !/\b3\b/.test(primary));
      const other = account("fixture-other");
      check("sibling inventory retains its own count and expiry", /\b7\b/.test(other) && other.includes("2033-03-04") && !other.includes("2032-01-01") && !primary.includes("2033-03-04"));
      const idle = account("fixture-idle");
      check("windowless zero inventory remains visible with unknown expiry", /\b0\b/.test(idle) && idle.includes("expiry unknown"));
      const stale = account("fixture-stale");
      check("stale inventory retains account reading diagnostics", /\b4\b/.test(stale) && stale.includes("2034-04-05") && stale.includes("fixture-read-error") && stale.includes("2031-05-06") && stale.includes("2031-05-05") && stale.includes("deferred"));
      check("stale window retains its actual reading with unknown status", report.limits.some(limit => limit.label?.includes("fixture-stale-window") && limit.amount.used === 30 && limit.status === "unknown"));
      check("inventory stays in account notes without SDK redemption credits", inventory.length === 4 && report.resetCredits === undefined);
      check("SDK limit IDs stay distinct across windows and budgets", new Set(report.limits.map(limit => limit.id)).size === report.limits.length);
      const text = report.limits.find(limit => limit.label?.includes("fixture-text-window"));
      check("SDK preserves a text window without inventing numeric usage", text?.label?.includes("fixture text information") && text.status === "unknown" && text.amount.unit === "unknown" && text.amount.used === undefined);
      const cny = report.limits.find(limit => limit.label?.includes("fixture-cny-window"));
      check("SDK preserves CNY quantities and explains the original unit", cny?.amount.unit === "unknown" && cny.amount.used === 200 && cny.amount.limit === 1000 && cny.amount.remaining === 800 && cny.amount.usedFraction === 0.2 && !!cny.notes?.some(note => /200\s*\/\s*1000/.test(note) && /cny/i.test(note) && note.includes("fixture-cny-window")));
      for (const [period, tokens, tokenLimit, cost, costLimit, unpriced, cache] of [
        ["Daily", 111, 1000, 1.25, 10, 2, "excludes cache reads"],
        ["Weekly", 333, 7000, 4.5, 70, 5, "includes cache reads"],
      ] as const) {
        const token = report.limits.find(limit => limit.amount.unit === "tokens" && limit.window?.label === period);
        const usd = report.limits.find(limit => limit.amount.unit === "usd" && limit.window?.label === period);
        check(`${period} SDK budget keeps server quantities and natural reset`, token?.amount.used === tokens && token.amount.limit === tokenLimit && token.amount.remaining === tokenLimit - tokens && usd?.amount.used === cost && usd.amount.limit === costLimit && usd.amount.remaining === costLimit - cost && token.window?.resetsAt === Date.parse("2031-01-02T03:04:05Z") && usd.window?.resetsAt === token.window.resetsAt);
        check(`${period} token notes own their cache and reservation explanations`, !!token?.notes?.some(note => note.includes("Token") && note.includes(period) && note.includes(cache) && note.includes("reservations")));
        check(`${period} USD notes own their unpriced and reservation explanations`, !!usd?.notes?.some(note => note.includes("USD") && note.includes(period) && note.includes(String(unpriced)) && note.includes("unpriced") && note.includes("reservations") && !note.includes("cache reads")));
      }
      const pools = report.limits.filter(limit => limit.label?.includes("fixture-pool-window"));
      check("same-name SDK windows retain their pool identity", pools.length === 2 && pools.some(limit => limit.label?.includes("pool-alpha") && limit.amount.used === 10) && pools.some(limit => limit.label?.includes("pool-beta") && limit.amount.used === 20));
      const serialized = JSON.stringify(report);
      check("SDK report redacts echoed credentials and control characters", !serialized.includes(keyA) && !serialized.includes(keyB) && !serialized.includes("\\u001b"));
      await reports("magpie");
      const traffic = (await state()).requests.slice(from);
      check("keyless collection reads quotas without budget or bearer", traffic.some(request => request.path === "/local/v1/magpie/quotas" && request.credential === "none") && !traffic.some(request => request.path === "/local/v1/magpie/limit"));
      check("SDK management traffic only reads quotas and key budgets without redemption or generation", traffic.length > 0 && traffic.every(request => !request.generation && /\/v1\/magpie\/(quotas|limit)$/.test(request.path) && request.query === ""));
      break;
    }
    case "usage-barriers": {
      const value = owner(pi);
      const id = "smoke-usage-barriers";
      const register = (prefix: string) => pi.registerProvider(id, { api: "openai-completions", baseUrl: `${root}${prefix}/v1`, apiKey: "OMP_SMOKE_KEY_A", models: [{ ...modelDefaults, id: "smoke-static" }] });
      try {
        register("/usage-root-a");
        await value.configure(ctx, config([id]));
        const account = (await reports(id))[0]?.metadata?.accountId;
        const aborted = (await state()).aborted;
        await control("hold?key=A&endpoint=quotas&prefix=/usage-root-a");
        await auth.usage.invalidate(id);
        const stale = auth.usage.reports({ baseUrlResolver: provider => registry.getProviderBaseUrl(provider), signal: lifetime.signal });
        await eventually("quota read is blocked before root switch", async () => heldAt(await state(), "/usage-root-a/v1/magpie/quotas"));
        register("/usage-root-b");
        await value.reconcile(ctx);
        await control("release");
        check("root switch discards old-identity results", !(await stale ?? []).some(report => report.provider === id && report.metadata?.accountId === account));
        const current = (await reports(id))[0];
        assert.ok(current);
        check("root B publishes its actual key budget", tokenBudget([current], 111));
        check("root-only identity change aborts the held old quota read", current.metadata?.accountId !== account && (await state()).aborted > aborted);
        const controller = new AbortController();
        await control("hold?key=A&prefix=/usage-root-b");
        await auth.usage.invalidate(id);
        const canceled = auth.usage.reports({ baseUrlResolver: provider => registry.getProviderBaseUrl(provider), signal: controller.signal }).then(rows => rows, () => null);
        await eventually("both actual management endpoints reach the cancellation barrier", async () => {
          const snapshot = await state();
          return ["quotas", "limit"].every(endpoint => heldAt(snapshot, `/usage-root-b/v1/magpie/${endpoint}`));
        });
        controller.abort();
        const result = await canceled;
        check("explicit cancellation publishes no partial old report", !(result ?? []).some(report => report.provider === id));
        await eventually("cancellation aborts quota and budget HTTP requests", async () => {
          const snapshot = await state();
          return ["quotas", "limit"].every(endpoint => snapshot.requests.some(request => request.path === `/usage-root-b/v1/magpie/${endpoint}` && request.aborted));
        });
        await control("release");
        const fresh = (await reports(id))[0];
        assert.ok(fresh);
        check("post-cancel read publishes fresh budget and inventory", tokenBudget([fresh], 111) && !!fresh.notes?.some(note => note.includes("fixture-idle") && /\b0\b/.test(note)));
      } finally { await control("release"); close(value); pi.unregisterProvider(id); }
      break;
    }
    case "stored": {
      const value = owner(pi);
      await auth.credentials.set("smoke-stored", { type: "api_key", key: keyB });
      const before = (await state()).requests.length;
      await value.configure(ctx, config(["smoke-stored"]));
      check("stored B cannot attach to inference A", !auth.usage.providerFor("smoke-stored"));
      check("stored conflict leaves original inference A", await registry.getApiKey(model("smoke-stored")) === keyA);
      await reports("smoke-stored");
      check("collector conflict does not request B budget", !(await state()).requests.slice(before).some(request => request.path.includes("/smoke-stored/") && request.credential === "B"));
      check("collector conflict produces diagnosis", notifications.some(message => /凭据|冲突/.test(message)));
      await auth.credentials.set("smoke-stored", { type: "api_key", key: keyA });
      await eventually("single stored matching A recovers attachment", () => !!auth.usage.providerFor("smoke-stored"));
      check("matching stored A collects real budget", tokenBudget(await reports("smoke-stored"), 111));
      await auth.credentials.set("smoke-stored", [{ type: "api_key", key: "OMP_SMOKE_KEY_A" }, { type: "api_key", key: keyA }]);
      await eventually("multiple same-value credential references attach", () => !!auth.usage.providerFor("smoke-stored"));
      check("multiple matching references collect gateway budget", tokenBudget(await reports("smoke-stored"), 111));
      await auth.credentials.remove("smoke-stored");
      close(value);
      const runtime = owner(pi);
      auth.keys.setRuntime("smoke-runtime", keyB);
      await runtime.configure(ctx, config(["smoke-runtime"]));
      check("zero stored-row runtime precedence is honored", await registry.getApiKey(model("smoke-runtime")) === keyB && tokenBudget(await reports("smoke-runtime"), 222));
      close(runtime);
      auth.keys.removeRuntime("smoke-runtime");
      break;
    }
    case "models": {
      check("new provider never auto-switches current model", ctx.model?.provider !== "smoke-created");
      await registry.refreshDiscoverableProviders(["smoke-created"], "online");
      const expected = [["smoke-anthropic", "anthropic-messages", `${root}/created/v1`], ["smoke-responses", "openai-responses", `${root}/created/v1`], ["smoke-completions", "openai-completions", `${root}/created/v1`]];
      for (const [id, api, baseUrl] of expected) {
        const value = model("smoke-created", id);
        check(`final registry ${api} uses exact protocol URL`, value.api === api && value.baseUrl === baseUrl);
      }
      check("model discovery sends compatibility price header", (await state()).requests.some(request => request.path === "/created/v1/models" && request.priceHeader));
      break;
    }
    case "aliases": {
      check("explicit startup alias is available before selection", !!auth.usage.providerFor("smoke-a"));
      check("undeclared alias has no early usage attachment", !auth.usage.providerFor("smoke-late"));
      check("native model switch selects explicit alias", await pi.setModel(model("smoke-a")));
      check("explicit alias reads usage without generation", tokenBudget(await reports("smoke-a"), 111));
      break;
    }
    case "select-late": {
      check("native model switch selects undeclared alias", await pi.setModel(model("smoke-late")));
      break;
    }
    case "late": {
      check("real request hook attaches undeclared current alias", !!auth.usage.providerFor("smoke-late"));
      check("late alias has actual gateway budget", tokenBudget(await reports("smoke-late"), 111));
      check("native model switch selects command alias", await pi.setModel(model("smoke-command")));
      break;
    }
    case "prepare-race": {
      const account = (await reports("smoke-command"))[0]?.metadata?.accountId;
      check("command binding account identity is non-secret string", typeof account === "string" && !account.includes(keyA));
      oldAccount = account;
      check("command A report starts with A budget", tokenBudget(await reports("smoke-command"), 111));
      generationBefore = auth.credentials.generation;
      abortedBefore = (await state()).aborted;
      await control("hold?key=A&endpoint=limit&prefix=/command");
      await auth.usage.invalidate("smoke-command");
      pendingOld = auth.usage.reports({ baseUrlResolver: id => registry.getProviderBaseUrl(id), signal: lifetime.signal });
      await eventually("old A key budget is actually in flight", async () => heldAt(await state(), "/command/v1/magpie/limit"));
      await writeFile(keyFile, keyB);
      await registry.refreshProvider("smoke-command", "online", { refreshCommandCredentials: true });
      check("native command refresh resolves B", await registry.getApiKey(model("smoke-command")) === keyB);
      check("command key update does not emit generation", auth.credentials.generation === generationBefore);
      break;
    }
    case "rotation": {
      await control("release");
      const stale = await pendingOld;
      check("old A request cannot return old account report", !(stale ?? []).some(report => report.provider === "smoke-command" && report.metadata?.accountId === oldAccount));
      const rows = await reports("smoke-command");
      check("collector after hook uses new B key budget", tokenBudget(rows, 222));
      check("new B report has fresh identity metadata", !!rows[0]?.metadata?.accountId && rows[0].metadata.accountId !== oldAccount);
      assert.ok(rows[0]);
      check("same-root native B identity retains account inventory", !!rows[0].notes?.some(note => note.includes("fixture-other") && /\b7\b/.test(note)));
      check("rotation terminates old key budget HTTP request", (await state()).aborted > abortedBefore && (await state()).requests.some(request => request.path === "/command/v1/magpie/limit" && request.credential === "A" && request.aborted));
      check("rotation retains actual native B inference key", await registry.getApiKey(model("smoke-command")) === keyB);
      break;
    }
    case "usage-rotation": {
      const before = auth.credentials.generation;
      const priorIdentity = (await reports("smoke-command"))[0]?.metadata?.accountId;
      await writeFile(keyFile, keyA);
      await registry.refreshProvider("smoke-command", "online", { refreshCommandCredentials: true });
      check("usage-only command rotation has no generation event", auth.credentials.generation === before);
      const transition = await reports("smoke-command");
      check("stale collector cannot publish old identity after key refresh", !transition.some(report => report.metadata?.accountId === priorIdentity));
      await eventually("actual usage fetch reconciles command key without request hook", async () => tokenBudget(await reports("smoke-command"), 111));
      const current = (await reports("smoke-command"))[0];
      assert.ok(current);
      check("usage-only native A identity retains windowless inventory", !!current.notes?.some(note => note.includes("fixture-idle") && /\b0\b/.test(note)));
      check("usage-only rotation keeps native inference A", await registry.getApiKey(model("smoke-command")) === keyA);
      break;
    }
    case "owners": {
      const first = owner(pi);
      const second = owner(pi);
      const settings = config(["smoke-shared"]);
      await first.configure(ctx, settings);
      await second.configure(ctx, settings);
      const adapter = auth.usage.providerFor("smoke-shared");
      check("two real owners share one SDK attachment", !!adapter);
      // 两个 owner 对同一绑定共享读取；仅减少引用不能撤销仍被另一 owner 使用的 HTTP。
      await control("hold?key=A");
      await auth.usage.invalidate("smoke-shared");
      const inflight = auth.usage.reports({ baseUrlResolver: id => registry.getProviderBaseUrl(id), signal: lifetime.signal });
      await eventually("shared owners start an actual held usage request", async () => heldAt(await state(), "/smoke-shared/v1/magpie/quotas"));
      const originalContext = first.ctx;
      const nextContext: ExtensionContext = Object.create(ctx);
      check("distinct SDK context facades retain the same session and registry", nextContext !== originalContext && nextContext.modelRegistry === originalContext?.modelRegistry && nextContext.sessionManager.getSessionId() === originalContext?.sessionManager.getSessionId());
      const beforeReconcile = (await state()).aborted;
      await first.reconcile(nextContext);
      await second.reconcile(Object.create(ctx));
      check("same-session new hook contexts preserve shared adapter", auth.usage.providerFor("smoke-shared") === adapter);
      check("same-session new hook contexts keep real HTTP in flight", heldAt(await state(), "/smoke-shared/v1/magpie/quotas") && (await state()).aborted === beforeReconcile);
      close(first);
      check("closing one owner preserves shared adapter", auth.usage.providerFor("smoke-shared") === adapter);
      check("closing one owner keeps another owner's real HTTP in flight", heldAt(await state(), "/smoke-shared/v1/magpie/quotas") && (await state()).aborted === beforeReconcile);
      await control("release");
      check("remaining owner receives the original shared in-flight report", tokenBudget((await inflight ?? []).filter(report => report.provider === "smoke-shared"), 111));
      check("remaining owner still reads actual budget", tokenBudget(await reports("smoke-shared"), 111));
      const third = owner(pi);
      await third.configure(ctx, settings);
      auth.keys.setRuntime("smoke-shared", keyB);
      await Promise.all([second.reconcile(ctx), third.reconcile(ctx)]);
      check("compatible owners preserve legal key rotation", tokenBudget(await reports("smoke-shared"), 222));
      close(second);
      check("rotated binding survives one owner close", tokenBudget(await reports("smoke-shared"), 222));
      foreign = { id: "smoke-shared", cacheVersion: 1, supports: () => false, fetchUsage: async () => null };
      auth.usage.setProvider("smoke-shared", foreign);
      close(third);
      check("last owner never removes foreign takeover adapter", auth.usage.providerFor("smoke-shared") === foreign);
      auth.keys.removeRuntime("smoke-shared");
      break;
    }
    case "onboarding-lifecycle": {
      const originalSetter = PluginManager.prototype.setPluginSetting;
      const previous = await getPluginSettings("omp-magpie", ctx.cwd);
      for (const phase of ["setup-after-write", "login-before-write", "login-after-write"]) {
        const id = `smoke-${phase}`;
        const value = owner(pi);
        const facade: ExtensionContext = Object.create(ctx);
        Object.defineProperty(facade, "hasUI", { value: false });
        const onboarding = new MagpieOnboarding(pi, value, { defaultRankingStrategy, resolveConfigValue }, () => facade);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let holdRead = false;
        const originalLoad = onboarding.load.bind(onboarding);
        // 在真实设置写入前后设置屏障，确保关闭流程后迟到的确认无法恢复 provider 或凭据。
        onboarding.load = async cwd => {
          const result = await originalLoad(cwd);
          if (holdRead) { holdRead = false; entered.resolve(); await release.promise; }
          return result;
        };
        PluginManager.prototype.setPluginSetting = async function(...args: Parameters<typeof originalSetter>) {
          const result = await originalSetter.apply(this, args);
          if (phase.endsWith("after-write") && args[0] === "omp-magpie" && args[1] === "connections") {
            entered.resolve();
            await release.promise;
          }
          return result;
        };
        try {
          let operation: Promise<unknown>;
          if (phase.startsWith("setup")) {
            pi.registerProvider(id, {
              api: "openai-completions", baseUrl: `${root}/${id}/v1`, apiKey: "OMP_SMOKE_KEY_A",
              models: [{ id: "smoke-static", name: "lifecycle fixture", contextWindow: 4096, maxTokens: 512, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
            });
            await value.configure(facade, config([id]));
            operation = onboarding.command(`setup --provider ${id} --yes`, facade);
          } else {
            onboarding.login(id);
            const answers = [`${root}/${id}`, "OMP_SMOKE_KEY_A", "yes"];
            operation = auth.oauth.login(id, {
              onAuth: () => { throw new Error("API-key login must not request OAuth authorization"); },
              onPrompt: async () => {
                const answer = answers.shift();
                assert.notEqual(answer, undefined, "unexpected native login prompt");
                if (answer === "yes" && phase === "login-before-write") holdRead = true;
                return answer!;
              },
            });
          }
          const outcome = operation.then(() => ({ ok: true, error: "" }), error => ({ ok: false, error: String(error) }));
          await Promise.race([entered.promise, outcome.then(result => { throw new Error(`flow ended before persistence barrier: ${result.error}`); })]);
          onboarding.close();
          close(value);
          release.resolve();
          const result = await outcome;
          check(`${phase}: obsolete confirmation rejects after lifecycle change`, !result.ok);
          check(`${phase}: closed owner cannot restore its usage adapter`, !value.ctx && !auth.usage.providerFor(id));
          if (phase.startsWith("login")) {
            check(`${phase}: stale native login never saves a credential or registers models`, !auth.credentials.list(id).length && !registry.hasProvider(id) && !registry.getDiscoveryProviderId(id));
          }
          if (phase === "login-before-write") {
            check("cancellation after config read prevents settings write", (await getPluginSettings("omp-magpie", ctx.cwd)).connections === previous.connections);
          }
        } finally {
          release.resolve();
          PluginManager.prototype.setPluginSetting = originalSetter;
          onboarding.close();
          close(value);
          await originalSetter.call(new PluginManager(ctx.cwd), "omp-magpie", "connections", previous.connections ?? "[]");
          await auth.credentials.remove(id);
        }
      }
      break;
    }
    case "login-references": {
      const previous = await getPluginSettings("omp-magpie", ctx.cwd);
      const variable = "OMP_SMOKE_LOGIN_REFERENCE";
      const previousEnvironment = process.env[variable];
      const commandFile = `${keyFile}.login`;
      const command = `!cat '${commandFile.replaceAll("'", "'\\''")}'`;
      try {
        for (const kind of ["literal", "env", "command"] as const) {
          const id = `smoke-login-${kind}`;
          process.env[variable] = keyA;
          await writeFile(commandFile, keyA);
          invalidateCommandConfig(command);
          const reference = kind === "literal" ? keyA : kind === "env" ? variable : command;
          const value = owner(pi);
          const facade: ExtensionContext = Object.create(ctx);
          Object.defineProperty(facade, "hasUI", { value: false });
          const onboarding = new MagpieOnboarding(pi, value, { defaultRankingStrategy, resolveConfigValue }, () => facade);
          const displayed: string[] = [];
          const answers = [`${root}/${id}`, reference, "yes"];
          try {
            onboarding.login(id);
            const result = await auth.oauth.login(id, {
              onAuth: () => { throw new Error("API-key login must not request OAuth authorization"); },
              onPrompt: async request => { displayed.push(request.message); const answer = answers.shift(); assert.notEqual(answer, undefined); return answer!; },
              onProgress: message => displayed.push(message),
            });
            check(`${kind} apiKey input stores its original native reference`, result?.type === "api_key" && auth.credentials.list(id).some(row => row.credential.type === "api_key" && row.credential.key === reference));
            await registry.refreshDiscoverableProviders([id], "online");
            await value.reconcile(facade);
            check(`${kind} native reference resolves the actual inference key and budget`, await registry.getApiKey(model(id, "smoke-completions")) === keyA && tokenBudget(await reports(id), 111));
            const settings = await getPluginSettings("omp-magpie", ctx.cwd);
            check(`${kind} login keeps credential references out of plugin settings and summaries`, !JSON.stringify(settings).includes(reference) && !displayed.join("\n").includes(reference) && !displayed.join("\n").includes(keyA));
            if (kind !== "literal") {
              const generation = auth.credentials.generation;
              if (kind === "env") process.env[variable] = keyB;
              else {
                await writeFile(commandFile, keyB);
                // 原生全量显式刷新会清除命令缓存；不在插件中另建刷新或执行逻辑。
                check("command login reference retains native cached output", await registry.getApiKey(model(id, "smoke-completions")) === keyA);
                await registry.refresh("online", { refreshCommandCredentials: true });
              }
              await value.reconcile(facade);
              check(`${kind} reference changes effective identity without another login`, auth.credentials.generation === generation && auth.credentials.list(id).some(row => row.credential.type === "api_key" && row.credential.key === reference)
                && await registry.getApiKey(model(id, "smoke-completions")) === keyB && tokenBudget(await reports(id), 222));
            }
          } finally {
            onboarding.close();
            close(value);
            pi.unregisterProvider(id);
            await auth.credentials.remove(id);
          }
        }
      } finally {
        if (previousEnvironment === undefined) delete process.env[variable]; else process.env[variable] = previousEnvironment;
        invalidateCommandConfig(command);
        await rm(commandFile, { force: true });
        await new PluginManager(ctx.cwd).setPluginSetting("omp-magpie", "connections", previous.connections ?? "[]");
      }
      break;
    }
    case "login-repeat": {
      const id = "smoke-login-repeat";
      const previous = await getPluginSettings("omp-magpie", ctx.cwd);
      const value = owner(pi);
      const facade: ExtensionContext = Object.create(ctx);
      Object.defineProperty(facade, "hasUI", { value: false });
      const onboarding = new MagpieOnboarding(pi, value, { defaultRankingStrategy, resolveConfigValue }, () => facade);
      const login = () => {
        const answers = registry.hasProvider(id) ? ["OMP_SMOKE_KEY_A", "yes"] : [`${root}/${id}`, "OMP_SMOKE_KEY_A", "yes"];
        return auth.oauth.login(id, {
          onAuth: () => { throw new Error("API-key login must not request OAuth authorization"); },
          onPrompt: async () => { const answer = answers.shift(); assert.notEqual(answer, undefined); return answer!; },
        });
      };
      try {
        onboarding.login(id);
        check("first native login returns API-key identity", (await login())?.type === "api_key");
        await registry.refreshDiscoverableProviders([id], "online");
        await value.reconcile(facade);
        check("first native login reads the real key budget", tokenBudget(await reports(id), 111));
        const second = await login().catch(() => undefined);
        check("same-key native re-login succeeds without cancelling its own activation", second?.type === "api_key");
        await value.reconcile(facade);
        check("same-reference re-login preserves native config and effective inference identity", auth.credentials.list(id).every(row => row.credential.type === "api_key" && row.credential.key === "OMP_SMOKE_KEY_A") && await registry.getApiKey(model(id, "smoke-completions")) === keyA);
        check("same-key native re-login keeps actual gateway budget available", tokenBudget(await reports(id), 111));
      } finally {
        onboarding.close();
        close(value);
        await new PluginManager(ctx.cwd).setPluginSetting("omp-magpie", "connections", previous.connections ?? "[]");
        await auth.credentials.remove(id);
      }
      break;
    }
    case "header-root-snapshot": {
      const id = "smoke-header-root-snapshot";
      const value = owner(pi);
      const file = join(process.env.PI_CODING_AGENT_DIR!, "models.yml");
      const original = await readFile(file, "utf8");
      const settings = JSON.parse(original);
      const hold = process.env.OMP_SMOKE_HEADER_HOLD!;
      const started = process.env.OMP_SMOKE_HEADER_STARTED!;
      const originalCommand = process.env.OMP_SMOKE_HEADER_COMMAND!;
      const command = originalCommand.replace(/printf preserved$/, "printf 'Bearer %s' \"$OMP_SMOKE_KEY_B\"");
      assert.notEqual(command, originalCommand, "fixture command must expose the synthetic B authorization");
      // header-only 认证使用原生 models.yml；静态配置允许 auth=none，实际请求认证由 header 决定。
      const register = async (prefix: string): Promise<void> => {
        settings.providers[id] = {
          api: "openai-completions", baseUrl: `${root}${prefix}/v1`, auth: "none", headers: { Authorization: command },
          models: [{ ...modelDefaults, id: "smoke-static" }],
        };
        await writeFile(file, JSON.stringify(settings));
        await registry.refreshProvider(id, "offline");
      };
      let preparing: Promise<void> | undefined;
      try {
        await rm(started, { force: true });
        await writeFile(hold, "hold");
        invalidateCommandConfig(command);
        await register("/header-snapshot-a");
        check("header snapshot provider has no stored authentication row", auth.credentials.list(id).length === 0);
        const from = (await state()).requests.length;
        preparing = value.configure(ctx, config([id]));
        await eventually("authentication header reaches the real SDK command barrier", () => existsSync(started));
        const signal = value.signal;
        const generation = auth.credentials.generation;
        // 仅 registry 地址改变，保留同一 owner/signal 和认证 generation，复现旧 root 与迟到 key 混配。
        await register("/header-snapshot-b");
        check("endpoint update leaves owner signal and credential generation unchanged", value.signal === signal && !signal.aborted && auth.credentials.generation === generation);
        await rm(hold, { force: true });
        await preparing;
        check("late header key B never reaches the old root A", !(await state()).requests.slice(from).some(request => request.path.startsWith("/header-snapshot-a/") && request.credential === "B"));
        await value.reconcile(ctx);
        check("subsequent reconcile collects the actual root B key B budget", tokenBudget(await reports(id), 222));
        const traffic = (await state()).requests.slice(from).filter(request => request.path.startsWith("/header-snapshot-"));
        check("snapshot recovery sends management traffic only to current root B", traffic.length > 0 && traffic.every(request => request.path.startsWith("/header-snapshot-b/") && request.credential === "B")
          && traffic.some(request => request.path === "/header-snapshot-b/v1/magpie/limit"));
      } finally {
        await rm(hold, { force: true });
        await preparing;
        close(value);
        invalidateCommandConfig(command);
        await rm(started, { force: true });
        await writeFile(file, original);
        await registry.refreshProvider(id, "offline");
      }
      break;
    }
    case "relogin-root-snapshot": {
      const id = "smoke-relogin-root-snapshot";
      const previous = await getPluginSettings("omp-magpie", ctx.cwd);
      const value = owner(pi);
      const facade: ExtensionContext = Object.create(ctx);
      Object.defineProperty(facade, "hasUI", { value: false });
      const onboarding = new MagpieOnboarding(pi, value, { defaultRankingStrategy, resolveConfigValue }, () => facade);
      const login = (variable: string) => {
        const answers = registry.hasProvider(id) ? [variable, "yes"] : [`${root}/relogin-snapshot-a`, variable, "yes"];
        return auth.oauth.login(id, {
          onAuth: () => { throw new Error("API-key login must not request OAuth authorization"); },
          onPrompt: async () => { const answer = answers.shift(); assert.notEqual(answer, undefined); return answer!; },
        });
      };
      let outcome: Promise<{ ok: boolean; error: string }> | undefined;
      try {
        onboarding.login(id);
        check("root snapshot fixture creates its provider through native login", (await login("OMP_SMOKE_KEY_A"))?.type === "api_key");
        await registry.refreshDiscoverableProviders([id], "online");
        await value.reconcile(facade);
        check("created provider A has a real native credential and budget", tokenBudget(await reports(id), 111));
        const settings = (await getPluginSettings("omp-magpie", ctx.cwd)).connections;
        const credentials = JSON.stringify(auth.credentials.list(id));
        const signal = value.signal;
        const claim = value.claims.get(id);
        await control("hold-models?key=B&prefix=/relogin-snapshot-a");
        outcome = login("OMP_SMOKE_KEY_B").then(() => ({ ok: true, error: "" }), error => ({ ok: false, error: String(error) }));
        await eventually("native re-login model prefetch reaches the actual A endpoint barrier", async () => heldAt(await state(), "/relogin-snapshot-a/v1/models", "B"));
        // 本插件已创建的 provider 仍可重新登录，但旧目录返回后不能把 A 的确认提交给新 B 地址。
        pi.registerProvider(id, { baseUrl: `${root}/relogin-snapshot-b/v1` });
        await control("release");
        const result = await outcome;
        check("endpoint change during native re-login rejects the obsolete confirmation", !result.ok && /provider 地址已变化/.test(result.error));
        check("rejected native re-login preserves connection settings", (await getPluginSettings("omp-magpie", ctx.cwd)).connections === settings);
        check("rejected native re-login preserves host credential rows", JSON.stringify(auth.credentials.list(id)) === credentials);
        check("rejected native re-login cannot reactivate or replace owner claims", value.signal === signal && !signal.aborted && value.claims.get(id) === claim);
        check("rejected native re-login preserves the current registry endpoint", readProviderRoot(registry, id) === `${root}/relogin-snapshot-b`);
      } finally {
        await control("release");
        await outcome;
        onboarding.close();
        close(value);
        pi.unregisterProvider(id);
        await new PluginManager(ctx.cwd).setPluginSetting("omp-magpie", "connections", previous.connections ?? "[]");
        await auth.credentials.remove(id);
      }
      break;
    }
    case "setup-session-snapshot": {
      const id = "smoke-setup-session-snapshot";
      const previous = await getPluginSettings("omp-magpie", ctx.cwd);
      const value = owner(pi);
      const facade: ExtensionContext = Object.create(ctx);
      let sessionId = ctx.sessionManager.getSessionId();
      const manager = Object.create(ctx.sessionManager);
      Object.defineProperty(manager, "getSessionId", { value: () => sessionId });
      Object.defineProperty(facade, "sessionManager", { value: manager });
      Object.defineProperty(facade, "hasUI", { value: true });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const ui = Object.create(ctx.ui);
      Object.defineProperty(ui, "select", { value: async () => { entered.resolve(); await release.promise; return "确认连接"; } });
      Object.defineProperty(facade, "ui", { value: ui });
      const onboarding = new MagpieOnboarding(pi, value, { defaultRankingStrategy, resolveConfigValue }, () => facade);
      let outcome: Promise<{ ok: boolean; error: string }> | undefined;
      try {
        pi.registerProvider(id, {
          api: "openai-completions", baseUrl: `${root}/setup-session-snapshot/v1`, apiKey: "OMP_SMOKE_KEY_A",
          models: [{ ...modelDefaults, id: "smoke-static" }],
        });
        await value.configure(facade, config([]));
        const credentials = JSON.stringify(auth.credentials.all());
        const from = (await state()).requests.length;
        outcome = onboarding.command(`setup --provider ${id}`, facade).then(() => ({ ok: true, error: "" }), error => ({ ok: false, error: String(error) }));
        await Promise.race([entered.promise, outcome.then(result => { throw new Error(`setup ended before confirmation barrier: ${result.error}`); })]);
        // 同一 context 和 manager 对象切换会话；迟到确认不能在 save 入口重新捕获新身份。
        sessionId = `${sessionId}-snapshot-switched`;
        await value.configure(facade, config([]));
        const signal = value.signal;
        check("setup race retains the exact mutable manager and context facades", value.ctx === facade && value.ctx.sessionManager === manager);
        release.resolve();
        const result = await outcome;
        check("late setup confirmation rejects after the mutable session switches", !result.ok);
        check("late setup confirmation cannot persist connection settings", (await getPluginSettings("omp-magpie", ctx.cwd)).connections === previous.connections);
        check("late setup confirmation cannot mutate native credentials", JSON.stringify(auth.credentials.all()) === credentials);
        check("late setup confirmation cannot reconfigure the new owner session", value.signal === signal && !signal.aborted && value.claims.size === 0 && !auth.usage.providerFor(id));
        check("late setup confirmation sends no management HTTP", !(await state()).requests.slice(from).some(request => request.path.startsWith("/setup-session-snapshot/")));
      } finally {
        release.resolve();
        await outcome;
        onboarding.close();
        close(value);
        pi.unregisterProvider(id);
        await new PluginManager(ctx.cwd).setPluginSetting("omp-magpie", "connections", previous.connections ?? "[]");
      }
      break;
    }
    case "claim-leases": {
      const id = "smoke-lease";
      const notificationStart = notifications.length;
      const first = owner(pi);
      const settings = config([id]);
      const hold = process.env.OMP_SMOKE_HEADER_HOLD!;
      const started = process.env.OMP_SMOKE_HEADER_STARTED!;
      await first.configure(ctx, settings);
      const accountA = (await reports(id))[0]?.metadata?.accountId;
      check("root lease begins with a real A account", typeof accountA === "string" && tokenBudget(await reports(id), 111));
      await control("hold?key=A");
      await auth.usage.invalidate(id);
      const oldRead = auth.usage.reports({ baseUrlResolver: provider => registry.getProviderBaseUrl(provider), signal: lifetime.signal });
      await eventually("root A lease HTTP is actually held", async () => heldAt(await state(), "/lease-a/v1/magpie/quotas"));
      await writeFile(hold, "hold");
      invalidateCommandConfig(process.env.OMP_SMOKE_HEADER_COMMAND);
      pi.registerProvider(id, {
        api: "openai-completions", baseUrl: `${root}/lease-b/v1`, apiKey: "OMP_SMOKE_KEY_A",
        headers: { "X-Smoke-Inference": "preserved", "X-Smoke-Barrier": process.env.OMP_SMOKE_HEADER_COMMAND! },
      });
      const changing = first.configure(Object.create(ctx), settings);
      try {
        check("replacing the only claim synchronously revokes its adapter", !auth.usage.providerFor(id));
        await eventually("root B reconciliation reaches the actual SDK command-header barrier", () => existsSync(started));
        await control("release");
        const stale = await oldRead;
        check("old root A account cannot publish while root B headers remain unresolved", !(stale ?? []).some(report => report.provider === id && report.metadata?.accountId === accountA));
        check("blocked root B header resolution cannot reuse the old adapter", !auth.usage.providerFor(id) && existsSync(hold));
      } finally {
        await rm(hold, { force: true });
        await changing;
        await control("release");
      }
      let rowsB: UsageReport[] = [];
      let accountB: string | undefined;
      // provider 的实际 endpoint 已从 A 切到 B；等待完整的新源预算与身份，不依赖旧源缓存。
      try {
        await eventually("replacement root B lease collects real usage with a fresh identity", async () => {
          rowsB = await reports(id);
          const fresh = rowsB.find(report => typeof report.metadata?.accountId === "string" && report.metadata.accountId !== accountA && tokenBudget([report], 111));
          accountB = typeof fresh?.metadata?.accountId === "string" ? fresh.metadata.accountId : undefined;
          const snapshot = await state();
          return !!auth.usage.providerFor(id) && !!accountB
            && ["/lease-b/v1/magpie/quotas", "/lease-b/v1/magpie/limit"].every(path => snapshot.requests.some(request => request.path === path && request.credential === "A" && !request.aborted));
        });
      } catch (error) {
        const snapshot = await state();
        throw new Error(`${String(error)}; lease recovery: ${JSON.stringify({
          attached: !!auth.usage.providerFor(id),
          reports: rowsB.map(report => ({ accountId: report.metadata?.accountId, limits: report.limits.map(limit => ({ amount: limit.amount, status: limit.status })), notes: report.notes })),
          notifications: notifications.slice(notificationStart),
          requests: snapshot.requests.filter(request => request.path.startsWith("/lease-")),
        })}`);
      }
      const adapter = auth.usage.providerFor(id);
      await control("hold?key=A");
      await auth.usage.invalidate(id);
      const sharedRead = auth.usage.reports({ baseUrlResolver: provider => registry.getProviderBaseUrl(provider), signal: lifetime.signal });
      await eventually("root B single-owner HTTP is actually held before another owner joins", async () => heldAt(await state(), "/lease-b/v1/magpie/quotas"));
      const second = owner(pi);
      await second.configure(Object.create(ctx), settings);
      const beforeClose = (await state()).aborted;
      close(first);
      check("a newly verified compatible owner retains the existing adapter lease", auth.usage.providerFor(id) === adapter);
      check("closing the original owner does not abort the compatible owner's held HTTP", heldAt(await state(), "/lease-b/v1/magpie/quotas") && (await state()).aborted === beforeClose);
      await control("release");
      check("new compatible owner receives the original in-flight account", (await sharedRead ?? []).some(report => report.provider === id && report.metadata?.accountId === accountB));
      check("new compatible owner continues to read real budget", tokenBudget(await reports(id), 111));
      close(second);
      const diagnosticFirst = owner(pi);
      const diagnosticSecond = owner(pi);
      await control("identity?prefix=/lease-b&fail=true");
      try {
        await diagnosticFirst.configure(ctx, settings);
        const diagnosticAdapter = auth.usage.providerFor(id);
        check("identity failure preserves explicit quota access", !!diagnosticAdapter && tokenBudget(await reports(id), 111));
        await diagnosticSecond.configure(Object.create(ctx), settings);
        check("compatible diagnostic owner retains the adapter before reads", auth.usage.providerFor(id) === diagnosticAdapter);
        await control("hold?key=A&prefix=/lease-b");
        await auth.usage.invalidate(id);
        const diagnosticRead = auth.usage.reports({ baseUrlResolver: provider => registry.getProviderBaseUrl(provider), signal: lifetime.signal });
        await eventually("diagnostic lease holds both target management requests", async () => {
          const snapshot = await state();
          return ["quotas", "limit"].every(endpoint => heldAt(snapshot, `/lease-b/v1/magpie/${endpoint}`));
        });
        close(diagnosticFirst);
        check("compatible diagnostic owner retains the adapter after original owner closes", auth.usage.providerFor(id) === diagnosticAdapter);
        const snapshot = await state();
        check("diagnostic owner close preserves both in-flight requests", ["quotas", "limit"].every(endpoint => heldAt(snapshot, `/lease-b/v1/magpie/${endpoint}`)));
        await control("release");
        check("diagnostic owner receives the original in-flight budget", tokenBudget(await diagnosticRead ?? [], 111));
        check("diagnostic owner continues reading fresh usage", tokenBudget(await reports(id), 111));
      } finally {
        await control("release");
        await control("identity?prefix=/lease-b&fail=false");
        close(diagnosticFirst);
        close(diagnosticSecond);
      }
      break;
    }
    case "create-conflict": {
      const id = "smoke-prefetch-conflict";
      const first = owner(pi);
      const second = owner(pi);
      check("prefetch race starts with a genuinely missing provider", !registry.hasProvider(id) && !registry.getDiscoveryProviderId(id));
      // 目录预取仍在进行时加入不兼容声明，最终提交前必须重新核对所有 owner。
      await control("hold-models?key=A&prefix=/prefetch-a");
      const preparing = first.configure(ctx, await createConfig(id, "/prefetch-a"));
      await eventually("owner A model prefetch is actually held", async () => heldAt(await state(), "/prefetch-a/v1/models"));
      const conflicting = second.configure(Object.create(ctx), await createConfig(id, "/prefetch-b"));
      await control("release");
      await Promise.all([preparing, conflicting]);
      check("incompatible owner added during prefetch prevents provider registration", !registry.hasProvider(id) && !registry.getDiscoveryProviderId(id));
      check("incompatible owner added during prefetch prevents usage attachment", !auth.usage.providerFor(id));
      close(second);
      await first.reconcile(Object.create(ctx));
      check("removing conflicting owner restores actual provider registration", registry.hasProvider(id) && !!registry.find(id, "smoke-completions"));
      check("removing conflicting owner restores real usage collection", tokenBudget(await reports(id), 111));
      close(first);
      const compatibleId = "smoke-prefetch-compatible";
      const compatibleFirst = owner(pi);
      const compatibleSecond = owner(pi);
      const settings = await createConfig(compatibleId, "/prefetch-compatible");
      await control("hold-models?key=A&prefix=/prefetch-compatible");
      const firstReady = compatibleFirst.configure(ctx, settings);
      await eventually("compatible first owner model prefetch is actually held", async () => heldAt(await state(), "/prefetch-compatible/v1/models"));
      const secondReady = compatibleSecond.configure(Object.create(ctx), settings);
      await control("release");
      await Promise.all([firstReady, secondReady]);
      check("compatible creating owners share actual registered models immediately", !!registry.find(compatibleId, "smoke-completions"));
      check("compatible creating owners attach usage without another reconcile", !!auth.usage.providerFor(compatibleId));
      check("compatible creating owners immediately collect real gateway budget", tokenBudget(await reports(compatibleId), 111));
      close(compatibleFirst);
      close(compatibleSecond);
      break;
    }
    case "identity-recovery": {
      const id = "smoke-identity-recovery";
      const value = owner(pi);
      await control("identity?prefix=/identity-recovery&fail=true");
      await value.configure(ctx, await createConfig(id, "/identity-recovery"));
      check("failed first identity leaves requested provider missing", !registry.hasProvider(id) && !registry.getDiscoveryProviderId(id));
      check("failed first identity attaches diagnostic usage binding", !!auth.usage.providerFor(id));
      const failed = await reports(id);
      check("failed identity diagnostic reaches real SDK usage reports", failed.some(report => report.notes?.some(note => note.includes("HTTP 503"))));
      await control("identity?prefix=/identity-recovery&fail=false");
      await value.reconcile(Object.create(ctx));
      check("reconcile after identity recovery creates real provider", registry.hasProvider(id) && !!registry.find(id, "smoke-completions"));
      check("identity recovery restores usage attachment", !!auth.usage.providerFor(id));
      const recovered = await reports(id);
      check("recovered provider collects actual gateway budget", tokenBudget(recovered, 111));
      check("identity recovery clears old diagnostic from real usage reports", !recovered.some(report => report.notes?.some(note => note.includes("HTTP 503"))));
      close(value);
      break;
    }
    case "dynamic-isolation": {
      const id = "smoke-dynamic-isolation";
      let dynamic: ProviderConfig["fetchDynamicModels"];
      const value = owner({ registerProvider(providerId, registration) {
        if (providerId === id) dynamic = registration.fetchDynamicModels;
        pi.registerProvider(providerId, registration);
      } });
      await value.configure(ctx, await createConfig(id, "/dynamic-isolation"));
      assert.ok(dynamic, "production registration supplies the real dynamic callback");
      // 两个 key 都返回缺价目录；B 不能继承 A 的保留价卡，迟到的 A 也不能覆盖 B 的身份。
      await control("catalog?prefix=/dynamic-isolation&key=A&prices=missing");
      await control("catalog?prefix=/dynamic-isolation&key=B&prices=missing");
      await control("hold-models?prefix=/dynamic-isolation&key=A");
      const stale = dynamic(keyA).then(rows => ({ rows, error: undefined }), error => ({ rows: undefined, error }));
      await eventually("dynamic A missing-price catalog is actually held", async () => heldAt(await state(), "/dynamic-isolation/v1/models"));
      const fresh = await dynamic(keyB);
      const freshModel = fresh.find(row => row.id === "smoke-completions");
      check("concurrent B missing-price callback cannot inherit A rates", freshModel?.cost?.input === 0 && freshModel.cost.output === 0 && freshModel.cost.cacheRead === 0 && freshModel.cost.cacheWrite === 0);
      await control("release");
      check("stale concurrent A callback cannot publish into B identity", (await stale).error !== undefined);
      auth.keys.setRuntime(id, keyB);
      // 只检查本次原生刷新新增的请求，避免被前面直接调用 callback 的历史记录提前满足。
      const beforeRefresh = (await state()).requests.length;
      await registry.refreshDiscoverableProviders([id], "online");
      check("real SDK dynamic refresh actually requests B catalog", (await state()).requests.slice(beforeRefresh).some(request => request.path === "/dynamic-isolation/v1/models" && request.credential === "B" && request.priceHeader));
      close(value);
      auth.keys.removeRuntime(id);
      break;
    }
    case "generation": {
      const value = owner(pi);
      await value.configure(ctx, config(["smoke-generation"]));
      check("generation scenario starts attached", tokenBudget(await reports("smoke-generation"), 111));
      const oauthFrom = (await state()).requests.length;
      await control("hold?key=A&prefix=/smoke-generation");
      await auth.usage.invalidate("smoke-generation");
      const inflight = auth.usage.reports({ baseUrlResolver: id => registry.getProviderBaseUrl(id), signal: lifetime.signal });
      await eventually("OAuth scenario holds both target management requests", async () => {
        const snapshot = await state();
        return ["quotas", "limit"].every(endpoint => heldAt(snapshot, `/smoke-generation/v1/magpie/${endpoint}`));
      });
      await auth.credentials.set("smoke-generation", { type: "oauth", access: "fixture-oauth-access", refresh: "fixture-oauth-refresh", expires: Date.now() + 3600000 });
      check("OAuth generation synchronously revokes adapter", !auth.usage.providerFor("smoke-generation"));
      await eventually("OAuth generation aborts both target requests", async () => {
        const snapshot = await state();
        return ["quotas", "limit"].every(endpoint => snapshot.requests.slice(oauthFrom).some(request => request.path === `/smoke-generation/v1/magpie/${endpoint}` && request.credential === "A" && request.aborted));
      });
      await control("release");
      const result = await inflight;
      check("OAuth generation prevents stale usage publication", !(result ?? []).some(report => report.provider === "smoke-generation"));
      await auth.credentials.remove("smoke-generation");
      await eventually("live generation subscription recovers after OAuth removal", () => !!auth.usage.providerFor("smoke-generation"));
      await eventually("recovered OAuth-free binding reads actual budget", async () => tokenBudget(await reports("smoke-generation"), 111));
      const conflictFrom = (await state()).requests.length;
      await control("hold?key=A&prefix=/smoke-generation");
      await auth.usage.invalidate("smoke-generation");
      const conflictingRead = auth.usage.reports({ baseUrlResolver: id => registry.getProviderBaseUrl(id), signal: lifetime.signal });
      await eventually("stored-conflict scenario holds both target management requests", async () => {
        const snapshot = await state();
        return ["quotas", "limit"].every(endpoint => heldAt(snapshot, `/smoke-generation/v1/magpie/${endpoint}`));
      });
      await auth.credentials.set("smoke-generation", { type: "api_key", key: keyB });
      check("conflicting API-key generation synchronously revokes adapter", !auth.usage.providerFor("smoke-generation"));
      await eventually("stored conflict aborts both target requests", async () => {
        const snapshot = await state();
        return ["quotas", "limit"].every(endpoint => snapshot.requests.slice(conflictFrom).some(request => request.path === `/smoke-generation/v1/magpie/${endpoint}` && request.credential === "A" && request.aborted));
      });
      await control("release");
      check("stored conflict aborts in-flight report publication", !(await conflictingRead ?? []).some(report => report.provider === "smoke-generation"));
      check("conflicting generation cannot replay cached report", (await reports("smoke-generation")).length === 0);
      await auth.credentials.remove("smoke-generation");
      await eventually("live subscription recovers after stored conflict removal", () => !!auth.usage.providerFor("smoke-generation"));
      await eventually("recovered conflict-free binding reads actual budget", async () => tokenBudget(await reports("smoke-generation"), 111));
      const replacementFrom = (await state()).requests.length;
      await control("hold?key=A&prefix=/smoke-generation");
      await auth.usage.invalidate("smoke-generation");
      const replacedRead = auth.usage.reports({ baseUrlResolver: id => registry.getProviderBaseUrl(id), signal: lifetime.signal });
      await eventually("store replacement holds both target management requests", async () => {
        const snapshot = await state();
        return ["quotas", "limit"].every(endpoint => heldAt(snapshot, `/smoke-generation/v1/magpie/${endpoint}`));
      });
      const nextStore = await SqliteAuthCredentialStore.open(join(process.env.PI_CODING_AGENT_DIR!, "replacement.db"));
      await auth.replaceStore(nextStore);
      check("store replacement immediately revokes carried adapter", !auth.usage.providerFor("smoke-generation"));
      await eventually("store replacement aborts both target requests", async () => {
        const snapshot = await state();
        return ["quotas", "limit"].every(endpoint => snapshot.requests.slice(replacementFrom).some(request => request.path === `/smoke-generation/v1/magpie/${endpoint}` && request.credential === "A" && request.aborted));
      });
      await control("release");
      check("store replacement aborts old-store report publication", !(await replacedRead ?? []).some(report => report.provider === "smoke-generation"));
      await eventually("store replacement restores live owner attachment", () => !!auth.usage.providerFor("smoke-generation"));
      await eventually("replacement store collects fresh gateway report", async () => tokenBudget(await reports("smoke-generation"), 111));
      close(value);
      check("last owner removes own adapter", !auth.usage.providerFor("smoke-generation"));
      await auth.credentials.set("smoke-generation", { type: "api_key", key: keyA });
      await delay(60);
      check("closed final owner cannot resurrect on generation", !auth.usage.providerFor("smoke-generation"));
      await auth.credentials.remove("smoke-generation");
      break;
    }
    default: throw new Error("unknown smoke probe task");
  }
}

export default function smokeProbe(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, current) => {
    ctx = current;
    baselineModels = JSON.stringify(ctx.modelRegistry.getProviderModels("magpie"));
    baselineKey = await ctx.modelRegistry.getApiKey(model("magpie"));
    baselineHeaders = JSON.stringify(await ctx.modelRegistry.getProviderHeaders("magpie"));
    // The parent only enqueues checks after consuming /usage command_output and
    // the same-id successful response. Handler registration order is irrelevant.
    void (async () => {
      while (!lifetime.signal.aborted) {
        const task = await (await fetch(`${root}/__smoke/next`, { signal: lifetime.signal })).json() as Task;
        const start = assertions.length;
        let error: string | undefined;
        try { await run(task, pi); }
        catch (cause) { error = String(cause).split(keyA).join("[credential]").split(keyB).join("[credential]"); }
        await fetch(`${root}/__smoke/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: task.id, ok: !error, assertions: assertions.slice(start), ...(error ? { error } : {}) }), signal: lifetime.signal });
      }
    })().catch(error => { if (!lifetime.signal.aborted) { writeFileSync(shutdownFile, JSON.stringify({ ok: false, error: "probe control loop failed" })); ctx.shutdown(); } });
  });
  pi.on("before_agent_start", (_event, current) => { ctx = current; });
  pi.on("before_provider_request", (_event, current) => { ctx = current; });
  pi.on("session_shutdown", () => {
    shutdownSeen = true;
    lifetime.abort();
    for (const value of owners) value.close();
    owners.clear();
  });
  // exit runs after the host has awaited every shutdown hook; the hook itself
  // only does synchronous cleanup, within the host's two-second budget.
  process.once("exit", () => {
    if (!ctx) return;
    const usage = ctx.modelRegistry.authStorage.usage;
    const ownAdaptersGone = ["magpie", "smoke-a", "smoke-b", "smoke-command", "smoke-lease", "smoke-created", "smoke-generation", "smoke-stored", "smoke-runtime", "smoke-prefetch-conflict", "smoke-prefetch-compatible", "smoke-identity-recovery", "smoke-dynamic-isolation", "smoke-header-root-snapshot", "smoke-relogin-root-snapshot", "smoke-setup-session-snapshot"].every(id => !usage.providerFor(id));
    const foreignPreserved = !foreign || usage.providerFor("smoke-shared") === foreign;
    writeFileSync(shutdownFile, JSON.stringify({ ok: shutdownSeen && ownAdaptersGone && foreignPreserved, shutdownSeen, ownAdaptersGone, foreignPreserved }));
  });
}
