import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context for tools that need to know which Telegram chat they're
 * acting in (e.g. to deliver a file). The webhook wraps the tool runner in
 * `runWithToolContext` so handlers can read the active chat id.
 */
export type ToolContext = {
  chatId: number;
  /** Diagnostic-log correlation for the current turn (see telegram-log.ts). */
  turnId?: string;
  telegramUserId?: number;
  username?: string;
  /**
   * Mutated by instrumentTool: name + ok of every tool called during this
   * turn. The webhook reads it after the agent loop to verify that a reply
   * claiming an email was sent is backed by a real send-tool call.
   */
  calledTools?: { name: string; ok: boolean }[];
  /**
   * Mutated by instrumentTool: the raw (stringified) result of every tool
   * call this turn. The UUID grounding guard checks that every ID the reply
   * cites appears here or earlier in the conversation — anything else is
   * fabricated and the reply is blocked.
   */
  toolEvidence?: string[];
};

const toolContext = new AsyncLocalStorage<ToolContext>();

export function runWithToolContext<T>(ctx: ToolContext, fn: () => T): T {
  return toolContext.run(ctx, fn);
}

export function getToolContext(): ToolContext | undefined {
  return toolContext.getStore();
}

export function requireChatId(): number {
  const ctx = toolContext.getStore();
  if (!ctx) {
    throw new Error(
      "No Telegram chat context — this tool must run inside runWithToolContext.",
    );
  }
  return ctx.chatId;
}
