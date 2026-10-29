import type { OAuthLoginCallbacks, OAuthPrompt } from '@oh-my-pi/pi-ai/oauth';
import { createInterface, emitKeypressEvents, type Interface, type Key } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';

function cancelled(): Error {
  return new DOMException('omp-magpie: 登录已取消', 'AbortError');
}

/**
 * TUI 直接使用宿主的 secret 提示；原生 CLI 则在整个 action 期间独占终端输入。
 * CLI 的每个问题使用全新的 readline，秘密输入不回显，也不会进入下一问题的历史或撤销记录。
 * @throws AbortError 表示 Ctrl-C、Escape、EOF 或 signal 取消；不会转发可能含秘密的取消原因。
 */
export async function withLoginPrompts<T>(
  callbacks: Pick<OAuthLoginCallbacks, 'onPrompt' | 'signal'>,
  terminalLogin: boolean,
  action: (prompt: (request: OAuthPrompt) => Promise<string>, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!terminalLogin) {
    // 宿主负责 TUI 输入；独立监听取消，避免未结束的对话框阻塞已取消的登录。
    const signal = callbacks.signal;
    if (signal?.aborted) throw cancelled();
    const result = await action(async request => {
      if (signal?.aborted) throw cancelled();
      if (!signal) return callbacks.onPrompt(request);
      const interrupted = Promise.withResolvers<never>();
      const onAbort = (): void => interrupted.reject(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await Promise.race([callbacks.onPrompt(request), interrupted.promise]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }, signal);
    if (signal?.aborted) throw cancelled();
    return result;
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const stdin = process.stdin;
  const destination = process.stderr.isTTY ? process.stderr : process.stdout;
  // 无提示的 action 仍可运行；只有实际提问时才需要 TTY。
  if (!stdin.isTTY || !destination.isTTY) {
    const onAbort = (): void => controller.abort(cancelled());
    callbacks.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (callbacks.signal?.aborted) onAbort();
      return await action(async () => {
        if (signal.aborted) throw cancelled();
        throw new Error('omp-magpie: 登录提示需要交互终端，请在终端中重新运行原生登录');
      }, signal);
    } finally {
      callbacks.signal?.removeEventListener('abort', onAbort);
    }
  }

  const wasFlowing = stdin.readableFlowing;
  const wasPaused = stdin.isPaused();
  const wasRaw = stdin.isRaw;
  const dataListeners = stdin.rawListeners('data');
  let input: PassThrough | undefined;
  let pending: ((error: Error) => void) | undefined;
  let stopped: Error | undefined;
  let finished = false;
  const interrupted = Promise.withResolvers<never>();

  const stop = (error: Error): void => {
    if (stopped || finished) return;
    stopped = error;
    controller.abort(error);
    pending?.(error);
    interrupted.reject(error);
  };
  const onCancel = (): void => stop(cancelled());
  const onInputError = (): void => stop(new Error('omp-magpie: 无法读取交互终端'));
  const onInputData = (chunk: Buffer | string): void => {
    input?.write(chunk);
  };
  const onInputEnd = (): void => {
    input?.end();
  };
  const onKeypress = (_text: string | undefined, key: Key): void => {
    if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) onCancel();
  };

  // Bun 的 tty.ReadStream 使用阻塞 fs.read，destroy 仍会等待输入；复用宿主可暂停的原生 stdin。
  // 暂停宿主的 data 监听器，避免其 readline 回显秘密或保留输入历史。
  stdin.pause();
  for (const listener of dataListeners) stdin.removeListener('data', listener);
  process.on('SIGINT', onCancel);
  callbacks.signal?.addEventListener('abort', onCancel, { once: true });

  const prompt = async (request: OAuthPrompt): Promise<string> => {
    if (stopped || finished || signal.aborted) throw stopped ?? cancelled();
    if (pending) throw new Error('omp-magpie: 登录提示不能并发执行');
    if (!input) {
      input = new PassThrough();
      emitKeypressEvents(input);
      input.on('keypress', onKeypress);
      input.on('end', onCancel);
      input.on('error', onInputError);
      stdin.on('data', onInputData);
      stdin.on('end', onInputEnd);
      stdin.on('error', onInputError);
      stdin.setRawMode(true);
      stdin.resume();
    }

    const terminal = input;
    const secret = request.secret === true;
    // 包装输出而非修改宿主 stdout/stderr；readline 的光标移动与重绘也全部静音。
    const output = new Writable({
      write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        if (secret) callback();
        else destination.write(chunk, encoding, callback);
      },
    });
    let readline: Interface | undefined;
    let settled = false;
    let answered = false;
    let wrotePrompt = false;
    const answer = Promise.withResolvers<string>();
    const rejectPrompt = (error: Error): void => {
      if (settled) return;
      settled = true;
      answer.reject(error);
    };
    const onClose = (): void => rejectPrompt(cancelled());
    const onOutputError = (): void => rejectPrompt(new Error('omp-magpie: 无法显示登录提示'));
    try {
      pending = rejectPrompt;
      output.on('error', onOutputError);
      readline = createInterface({ input: terminal, output, terminal: true, historySize: 0 });
      readline.on('SIGINT', onCancel);
      readline.on('close', onClose);
      const placeholder = !secret && request.placeholder ? ` (${request.placeholder})` : '';
      const question = `${request.message}${placeholder}: `;
      wrotePrompt = true;
      if (secret) destination.write(question);
      readline.question(secret ? '' : question, value => {
        if (settled) return;
        settled = true;
        answered = true;
        answer.resolve(value);
      });
      return await answer.promise;
    } finally {
      pending = undefined;
      readline?.removeListener('SIGINT', onCancel);
      readline?.removeListener('close', onClose);
      readline?.close();
      output.removeListener('error', onOutputError);
      output.destroy();
      if (wrotePrompt && (secret || !answered)) destination.write('\n');
      // readline.close() 会暂停代理输入；两题之间仍须接收取消键。
      if (!terminal.destroyed) {
        terminal.resume();
      }
    }
  };

  try {
    if (callbacks.signal?.aborted) {
      controller.abort(cancelled());
      throw cancelled();
    }
    return await Promise.race([action(prompt, signal), interrupted.promise]);
  } finally {
    // 先拒绝迟到输入，再拆除自有监听；action 失败也必须恢复宿主的 raw/flow 与监听顺序。
    finished = true;
    pending?.(cancelled());
    callbacks.signal?.removeEventListener('abort', onCancel);
    process.removeListener('SIGINT', onCancel);
    stdin.pause();
    stdin.removeListener('data', onInputData);
    stdin.removeListener('end', onInputEnd);
    stdin.removeListener('error', onInputError);
    try {
      if (input) {
        input.removeListener('keypress', onKeypress);
        input.removeListener('end', onCancel);
        input.removeListener('error', onInputError);
        input.pause();
        input.destroy();
      }
    } finally {
      // rawListeners 保留 once 包装；逆序前置也保留原监听器在新增监听器之前的顺序。
      for (let index = dataListeners.length - 1; index >= 0; index--) {
        stdin.prependListener('data', dataListeners[index]!);
      }
      try {
        stdin.setRawMode(wasRaw);
      } finally {
        if (wasPaused) stdin.pause();
        else if (wasFlowing === true) stdin.resume();
        stdin.readableFlowing = wasFlowing;
      }
    }
  }
}
