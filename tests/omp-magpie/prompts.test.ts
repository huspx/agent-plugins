import assert from "node:assert/strict";
import test from "node:test";
import { withLoginPrompts } from "../../plugins/omp-magpie/src/prompts.ts";

const isSafeAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError" && !error.message.includes("private-cancel-reason");

test("TUI 登录信号已取消时不打开新提示，也不提交登录结果", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private-cancel-reason"));
  let prompted = false;
  let committed = false;
  const flow = withLoginPrompts({ signal: controller.signal, onPrompt: async () => { prompted = true; return "confirmed"; } }, false, async prompt => {
    const value = await prompt({ message: "apiKey", secret: true });
    committed = true;
    return value;
  });
  await assert.rejects(flow, isSafeAbort);
  assert.equal(prompted, false);
  assert.equal(committed, false);
});

test("TUI 提示等待中取消会立即终止登录，不继续下一题或提交", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<string>();
  let committed = false;
  let nextPrompt = false;
  const flow = withLoginPrompts({
    signal: controller.signal,
    onPrompt: async request => {
      if (request.message === "确认连接") nextPrompt = true;
      entered.resolve();
      return answer.promise;
    },
  }, false, async prompt => {
    await prompt({ message: "gateway key", secret: true });
    await prompt({ message: "确认连接" });
    committed = true;
  });
  await entered.promise;
  controller.abort(new Error("private-cancel-reason"));
  await assert.rejects(flow, isSafeAbort);
  answer.resolve("late input");
  await Promise.resolve();
  assert.equal(nextPrompt, false);
  assert.equal(committed, false);
});
