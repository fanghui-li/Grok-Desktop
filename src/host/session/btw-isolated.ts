/**
 * 主 turn busy 时的旁路侧问：独立短会话，避免父上下文劫持答案。
 * 由 DesktopHost.threadsBtw 在 busy 路径调用。
 */
import { randomUUID } from "node:crypto";
import { AcpClient } from "../acp-client.js";
import type { HostLogger } from "../logger.js";

export type SideQuestionIsolatedOpts = {
  command: string;
  agentArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: HostLogger;
  modelId?: string;
  effort?: string | null;
  parentSessionId: string;
  question: string;
};

/**
 * 另起 agent stdio + session/new，只发侧问；用完即关，不写主会话 chat_history。
 */
export async function sideQuestionIsolated(
  opts: SideQuestionIsolatedOpts,
): Promise<string> {
  const ephemeralThreadId = `btw_iso_${randomUUID()}`;
  const client = new AcpClient({
    command: opts.command,
    args: opts.agentArgs,
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
    threadId: ephemeralThreadId,
    allowFs: false,
    onEvent: () => {
      /* 隔离侧问：不把 ephemeral 事件投到主 UI */
    },
  });
  try {
    await client.start();
    await client.createSession({
      cwd: opts.cwd,
      meta: {
        title: "desktop-btw-isolated",
      },
    });
    const modelId = (opts.modelId ?? "").trim();
    if (modelId) {
      try {
        await client.setModel(modelId, {
          effort:
            opts.effort &&
            ["low", "medium", "high", "xhigh"].includes(opts.effort)
              ? opts.effort
              : undefined,
        });
      } catch (err) {
        opts.logger.warn("threads.btw_isolated_set_model_failed", {
          modelId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const framed =
      `【旁路侧问 · 与主对话任务无关】请只根据下面问题直接作答，` +
      `不要复述或续写任何其它话题。\n\n${opts.question}`;
    const answer = await client.sideQuestion(framed);
    opts.logger.info("threads.btw_isolated", {
      parentSessionId: opts.parentSessionId,
      ephemeralSessionId: client.attachedSessionId,
      modelId: modelId || undefined,
      qLen: opts.question.length,
      aLen: answer.length,
    });
    return answer;
  } finally {
    await client.close().catch(() => undefined);
  }
}
