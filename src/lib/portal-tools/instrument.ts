import {
  logTelegramEvent,
  normalizeToolResult,
  okFromResult,
} from "@/lib/telegram-log";
import { getToolContext } from "./context";

/**
 * Wrap a tool's `run` so every invocation is written to the diagnostic activity
 * log: the tool name, its input, the result (or thrown error), whether it
 * reported ok, and how long it took. This is what makes "the bot said it did X
 * but nothing happened" investigable — the raw tool result is captured here,
 * before the model gets a chance to summarize (or misreport) it.
 *
 * Best-effort and non-blocking: logging is fire-and-forget and can never change
 * what the tool returns or throws.
 *
 * NOTE: only index.ts may apply instrumentTool. It mutates `tool.run` in place,
 * so applying it twice would double-log every call.
 */
export function instrumentTool<
  // Tools have heterogeneous, zod-derived run signatures; wrap them generically.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends { name: string; run: (...args: any[]) => any },
>(tool: T): T {
  const original = tool.run.bind(tool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = async (...args: any[]) => {
    const ctx = getToolContext();
    const base = {
      kind: "tool_call" as const,
      chatId: ctx?.chatId ?? 0,
      turnId: ctx?.turnId,
      telegramUserId: ctx?.telegramUserId,
      username: ctx?.username,
      toolName: tool.name,
    };
    const startedAt = Date.now();
    try {
      const result = await original(...args);
      const ok = okFromResult(result) ?? true;
      ctx?.calledTools?.push({ name: tool.name, ok });
      ctx?.toolEvidence?.push(
        typeof result === "string" ? result : JSON.stringify(result),
      );
      void logTelegramEvent({
        ...base,
        ok,
        latencyMs: Date.now() - startedAt,
        detail: { input: args[0], result: normalizeToolResult(result) },
      });
      return result;
    } catch (e) {
      ctx?.calledTools?.push({ name: tool.name, ok: false });
      void logTelegramEvent({
        ...base,
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
        detail: { input: args[0] },
      });
      throw e;
    }
  };
  // Mutate in place so the runnable-tool object keeps its identity/prototype;
  // only the run implementation is swapped for the instrumented one.
  (tool as { run: typeof wrapped }).run = wrapped;
  return tool;
}
