"use client";

import { useEffect, useRef, useState } from "react";
import { NavIcon } from "./nav-icons";

type ChatMsg = { role: "user" | "assistant"; text: string };

// The bot already emits the Telegram HTML subset — <b> <i> <code> <pre> with
// literal &, <, > escaped as entities. Render that safely: protect those four
// (attribute-less) tags, escape every OTHER angle bracket so no arbitrary tag
// (<script>, <img onerror>, <b onclick>) can reach innerHTML, then restore the
// protected tags. Ampersands are left as-is so the bot's &amp; renders as "&".
const SENTINEL = "\u0000"; // NUL — never present in the bot's text.
function renderHtml(text: string): string {
  const holders: string[] = [];
  let s = text.replace(/<\/?(?:b|i|code|pre)>/g, (m) => {
    holders.push(m);
    return `${SENTINEL}${holders.length - 1}${SENTINEL}`;
  });
  s = s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"), (_, i) =>
    holders[Number(i)],
  );
  return s.replace(/\n/g, "<br>");
}

// Event name the header launcher dispatches to toggle the bottom-left panel.
const TOGGLE_EVENT = "hive:toggle-assistant";

/** Icon button for the header, beside the Developers link. */
export function AssistantLauncher() {
  return (
    <button
      type="button"
      aria-label="Assistant"
      title="Assistant — chat with the Hive bot"
      onClick={() => window.dispatchEvent(new Event(TOGGLE_EVENT))}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-ink transition hover:bg-warm hover:text-accent-text"
    >
      <NavIcon name="assistant" />
    </button>
  );
}

export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const loadedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The header launcher toggles the panel via a window event. Toggling always
  // brings it up expanded (never re-opens straight into a minimized bar).
  useEffect(() => {
    const toggle = () =>
      setOpen((o) => {
        if (!o) setMinimized(false);
        return !o;
      });
    window.addEventListener(TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_EVENT, toggle);
  }, []);

  // Session scope: the conversation survives refreshes but resets when the
  // window/tab is closed. sessionStorage persists across reloads within a tab
  // and is cleared on close — so a missing marker means a fresh window, and we
  // wipe the server-side history to start clean. A refresh keeps the marker and
  // the prior conversation loads normally.
  useEffect(() => {
    const KEY = "hive_assistant_session";
    if (sessionStorage.getItem(KEY)) return; // refresh within the same tab
    sessionStorage.setItem(KEY, "1");
    loadedRef.current = true; // fresh window — nothing to load
    fetch("/api/assistant", { method: "DELETE" }).catch(() => {});
  }, []);

  // Load prior conversation the first time the panel opens (async setState in
  // the fetch callback — the ref guard keeps the effect body side-effect-free).
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    fetch("/api/assistant")
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d) => setMessages(d.messages ?? []))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, pending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = async () => {
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setPending(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      setMessages((m) => [
        ...m,
        { role: "assistant", text: data.reply ?? data.error ?? "No reply." },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "Network error — try again." },
      ]);
    } finally {
      setPending(false);
    }
  };

  if (!open) return null;

  // Minimized: just the title bar, click it to expand again. The panel stays
  // mounted so the conversation and any draft are preserved.
  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-5 left-5 z-40 flex w-[22rem] max-w-[calc(100vw-2.5rem)] items-center justify-between rounded-xl border border-stone/60 bg-cream px-4 py-3 shadow-lg transition hover:bg-warm"
      >
        <span className="text-sm font-medium text-ink">Hive Assistant</span>
        <span className="text-muted">▴</span>
      </button>
    );
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-5 left-5 z-40 flex h-[32rem] max-h-[75vh] w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-stone/60 bg-white shadow-2xl">
          <header className="flex items-center justify-between border-b border-stone/40 bg-cream px-4 py-3">
            <p className="text-sm font-medium text-ink">Hive Assistant</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMinimized(true)}
                aria-label="Minimize assistant"
                title="Minimize"
                className="flex h-7 w-7 items-center justify-center text-ink transition hover:text-accent-text"
              >
                <span className="block h-1 w-3.5 rounded-full bg-current" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                title="Close"
                className="flex h-7 w-7 items-center justify-center text-2xl font-bold leading-none text-ink transition hover:text-accent-text"
              >
                ✕
              </button>
            </div>
          </header>

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
          >
            {messages.length === 0 && !pending && (
              <p className="mt-6 text-center text-xs text-muted">
                Ask about tenants, rent, bills, cleaning — or anything that
                needs a quick lookup.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-accent text-white"
                      : "bg-warm/60 text-ink"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <span
                      className="[&_code]:rounded [&_code]:bg-ink/10 [&_code]:px-1 [&_pre]:whitespace-pre-wrap"
                      dangerouslySetInnerHTML={{ __html: renderHtml(m.text) }}
                    />
                  ) : (
                    m.text
                  )}
                </div>
              </div>
            ))}
            {pending && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-warm/60 px-3 py-2 text-sm text-muted">
                  <span className="inline-flex gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-stone/40 p-3">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="Message the assistant…"
                disabled={pending}
                className="max-h-28 flex-1 resize-none rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={send}
                disabled={pending || input.trim().length === 0}
                className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
