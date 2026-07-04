/**
 * Local verification harness for the agreement email pipeline — the same
 * checks used to validate the 7/4/26 hardening pass, kept runnable.
 *
 * Read-only (default): confirms Gmail SMTP auth, Gmail IMAP access + Sent
 * folder resolution (what verifySent relies on), and the Outlook token mint
 * with the exact scopes real sends use. Sends nothing.
 *
 *   npx tsx --env-file=.env.local scripts/verify-mail.ts
 *
 * Real test sends (one email each, to an address you own) — exercises the
 * full path including Sent-folder verification and prints the diag:
 *
 *   npx tsx --env-file=.env.local scripts/verify-mail.ts --send-outlook you@example.com
 *   npx tsx --env-file=.env.local scripts/verify-mail.ts --send-gmail you@example.com
 */

import { ImapFlow } from "imapflow";
import {
  checkGmailAuth,
  gmailConfigured,
  sendGmailMessage,
} from "../src/lib/google-mail";
import {
  checkOutlookSendAuth,
  outlookConfigured,
  sendOutlookMessage,
} from "../src/lib/graph-mail";

function flagValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function checkGmailImap(): Promise<boolean> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !pass) {
    console.log("Gmail IMAP:   ⚪️ not configured");
    return true;
  }
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 20_000,
  });
  try {
    await client.connect();
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === "\\Sent")?.path;
    await client.logout();
    if (!sent) {
      console.log("Gmail IMAP:   ❌ connected but no \\Sent folder found");
      return false;
    }
    console.log(`Gmail IMAP:   ✅ OK (sent folder: ${sent})`);
    return true;
  } catch (e) {
    client.close();
    console.log(
      `Gmail IMAP:   ❌ ${e instanceof Error ? e.message : String(e)} ` +
        "(is IMAP enabled in the Gmail settings?)",
    );
    return false;
  }
}

async function main() {
  let ok = true;

  // --- Read-only checks -----------------------------------------------------
  if (gmailConfigured()) {
    const g = await checkGmailAuth();
    console.log(g.ok ? "Gmail SMTP:   ✅ OK" : `Gmail SMTP:   ❌ ${g.error}`);
    ok = ok && g.ok;
    ok = (await checkGmailImap()) && ok;
  } else {
    console.log("Gmail:        ⚪️ not configured");
  }

  if (outlookConfigured()) {
    const o = await checkOutlookSendAuth();
    console.log(
      o.ok
        ? "Outlook auth: ✅ OK (Mail.ReadWrite + Mail.Send)"
        : `Outlook auth: ❌ ${o.error}`,
    );
    ok = ok && o.ok;
  } else {
    console.log("Outlook:      ⚪️ not configured");
  }

  // --- Optional real test sends --------------------------------------------
  const outlookTo = flagValue("--send-outlook");
  if (outlookTo) {
    console.log(`\nSending Outlook test email to ${outlookTo} …`);
    const res = await sendOutlookMessage({
      to: outlookTo,
      subject: "HivePortal Outlook send verification test",
      text:
        "Test of the hardened Outlook send path (immutable-id Sent Items " +
        "verification). Safe to delete.",
    });
    console.log(JSON.stringify(res, null, 2));
    ok = ok && res.ok;
  }

  const gmailTo = flagValue("--send-gmail");
  if (gmailTo) {
    console.log(`\nSending Gmail test email to ${gmailTo} …`);
    const res = await sendGmailMessage({
      to: gmailTo,
      subject: "HivePortal Gmail send verification test",
      text:
        "Test of the hardened Gmail send path (IMAP Sent-folder " +
        "verification). Safe to delete.",
      verifySent: true,
    });
    console.log(JSON.stringify(res, null, 2));
    ok = ok && res.ok;
  }

  process.exit(ok ? 0 : 1);
}

main();
