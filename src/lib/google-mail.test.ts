import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real nodemailer, pointed at a scripted SMTP server on localhost, so the
// hand-over boundary is the library's actual behaviour rather than a mock.
const smtp = vi.hoisted(() => ({
  port: 0,
  /** One script per connection, in order; missing entries behave normally. */
  scripts: [] as Array<{ dropOn?: string; auth?: string; rcpt?: string; afterData?: string }>,
  connections: 0,
  messages: 0,
}));

vi.mock("nodemailer", async (importOriginal) => {
  const real = ((await importOriginal()) as { default: typeof import("nodemailer") }).default;
  return {
    default: {
      ...real,
      createTransport: (opts: Record<string, unknown>) =>
        real.createTransport({ ...opts, host: "127.0.0.1", port: smtp.port, secure: false, ignoreTLS: true }),
    },
  };
});

// Same retry decisions, minus the real waits and the shared budget.
vi.mock("./send-retry", async (importOriginal) => {
  const real = await importOriginal<typeof import("./send-retry")>();
  return {
    ...real,
    withSendRetry: <T>(fn: () => Promise<T>, opts: Parameters<typeof real.withSendRetry>[1]) =>
      real.withSendRetry(fn, { ...opts, budget: { reserve: () => true }, sleep: async () => {} }),
  };
});

import { sendGmailMessage } from "./google-mail";

let server: net.Server;

beforeAll(async () => {
  server = net.createServer((socket) => {
    const script = smtp.scripts[smtp.connections++] ?? {};
    socket.on("error", () => {});
    socket.write("220 fake.smtp ESMTP\r\n");
    let buf = "";
    let inData = false;
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        buf = buf.slice(end + 5);
        inData = false;
        smtp.messages++;
        if (script.afterData === "drop") return void socket.destroy();
        socket.write(`${script.afterData ?? "250 2.0.0 OK queued"}\r\n`);
      }
      let nl: number;
      while (!inData && (nl = buf.indexOf("\r\n")) >= 0) {
        const verb = buf.slice(0, nl).split(" ")[0].toUpperCase();
        buf = buf.slice(nl + 2);
        if (script.dropOn === verb) return void socket.destroy();
        if (verb === "EHLO") socket.write("250-fake.smtp\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (verb === "AUTH") socket.write(`${script.auth ?? "235 2.7.0 Accepted"}\r\n`);
        else if (verb === "RCPT") socket.write(`${script.rcpt ?? "250 2.1.5 OK"}\r\n`);
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 Go ahead\r\n");
        } else if (verb === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  smtp.port = (server.address() as net.AddressInfo).port;
  process.env.GMAIL_USER = "vineet@example.com";
  process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  smtp.scripts = [];
  smtp.connections = 0;
  smtp.messages = 0;
});

const send = () => sendGmailMessage({ to: "tenant@example.com", subject: "Rent", text: "Hi" });

describe("sendGmailMessage retries", () => {
  it("does not retry a refused login (535): the app password is dead", async () => {
    smtp.scripts = [{ auth: "535 5.7.8 Username and Password not accepted" }];
    const r = await send();
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(r.ok || r.error).toMatch(/^Invalid login: 535/);
    expect(smtp.connections).toBe(1);
    expect(smtp.messages).toBe(0);
  });

  it("does not retry a 4xx refusal at login either", async () => {
    smtp.scripts = [{ auth: "454 4.7.0 Too many login attempts, please try again later" }];
    const r = await send();
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(smtp.connections).toBe(1);
  });

  it("still retries the same 4xx outside the login", async () => {
    smtp.scripts = [{ rcpt: "454 4.7.0 Temporary server error" }];
    const r = await send();
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(smtp.messages).toBe(1);
  });

  it("retries a connection dropped before the message was handed over", async () => {
    smtp.scripts = [{ dropOn: "EHLO" }];
    const r = await send();
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(smtp.messages).toBe(1);
  });

  it("retries when Gmail explicitly refuses the message with a 4xx", async () => {
    smtp.scripts = [{ afterData: "451 4.3.0 Try again later" }];
    const r = await send();
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(smtp.messages).toBe(2); // the first copy was refused, not delivered
  });

  it("does not retry a permanent refusal", async () => {
    smtp.scripts = [{ rcpt: "550 5.1.1 No such user" }];
    const r = await send();
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(smtp.connections).toBe(1);
    expect(smtp.messages).toBe(0);
  });

  it("never resends when the connection drops after the message was handed over", async () => {
    // Gmail may have accepted it; a retry could email the tenant twice.
    smtp.scripts = [{ afterData: "drop" }];
    const r = await send();
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(smtp.connections).toBe(1);
    expect(smtp.messages).toBe(1);
  });
});
