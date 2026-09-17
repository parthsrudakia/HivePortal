"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type VerifyResult =
  | { ok: true; email: string | null }
  | { ok: false; error: string };

// Pull #access_token/#refresh_token off the invite link, start the session,
// and clean the URL. Fully async so the page paints "Verifying…" first and
// every state update lands in the effect's completion callback.
async function verifyInviteLink(
  supabase: ReturnType<typeof createClient>,
): Promise<VerifyResult> {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  const hashErr = params.get("error_description") || params.get("error");

  if (hashErr) return { ok: false, error: decodeURIComponent(hashErr) };
  if (!access_token || !refresh_token) {
    return {
      ok: false,
      error:
        "This link is missing the session tokens. Open the most recent invite email and click the button again.",
    };
  }

  const { error: setErr } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });
  if (setErr) return { ok: false, error: setErr.message };

  const { data } = await supabase.auth.getUser();
  // Clean the URL so the tokens don't sit in the address bar.
  window.history.replaceState({}, "", "/auth/accept-invite");
  return { ok: true, email: data.user?.email ?? null };
}

export default function AcceptInvitePage() {
  const supabase = createClient();
  const router = useRouter();

  const [phase, setPhase] = useState<
    "verifying" | "ready" | "saving" | "done" | "error"
  >("verifying");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // Supabase's invite link comes back with #access_token=...&refresh_token=...&type=invite
  // We pull those out of the URL hash and log the invitee in.
  useEffect(() => {
    let cancelled = false;
    verifyInviteLink(supabase).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setEmail(res.email);
        setPhase("ready");
      } else {
        setError(res.error);
        setPhase("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPhase("saving");
    const { error: updErr } = await supabase.auth.updateUser({ password });
    if (updErr) {
      setError(updErr.message);
      setPhase("ready");
      return;
    }
    setPhase("done");
    router.replace("/");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-3xl tracking-tight text-ink">
        Welcome to <span className="font-display text-accent-text">Hive Portal</span>
      </h1>

      {phase === "verifying" && (
        <p className="mt-6 text-sm text-muted">Verifying your invite…</p>
      )}

      {phase === "error" && (
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <p className="text-sm text-red-700">{error}</p>
          <p className="mt-3 text-xs text-muted">
            Ask the master user to send a fresh invite.
          </p>
        </div>
      )}

      {(phase === "ready" || phase === "saving") && (
        <form onSubmit={submit} className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <p className="text-sm text-muted">
            Set a password for <span className="text-ink">{email ?? ""}</span>.
          </p>
          <label className="mt-4 flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">
              Password
            </span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              autoFocus
            />
          </label>
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">
              Confirm password
            </span>
            <input
              type="password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={phase === "saving"} aria-busy={phase === "saving"}
            className="mt-5 w-full rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
          >
            {phase === "saving" ? "Saving…" : "Set password & continue"}
          </button>
        </form>
      )}

      {phase === "done" && (
        <p className="mt-6 text-sm text-muted">Signing you in…</p>
      )}
    </div>
  );
}
