// Minimal read-only IMAP client for test inboxes that aren't Google / Microsoft
// sign-ins: a personal Gmail with an app password, or a mailbox at a regular
// host (cPanel and the like, common with Gulf SMEs). It only logs in, finds a
// message by its Message-ID in INBOX or the junk folder, and logs out.
import tls from "node:tls";
import type { FoundMessage } from "./types";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

const quote = (s: string) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function session<T>(cfg: ImapConfig, fn: (cmd: (text: string) => Promise<string[]>) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, val?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* closed */
      }
      if (err) reject(err);
      else resolve(val as T);
    };
    const timer = setTimeout(() => finish(new Error(`IMAP ${cfg.host}: timed out`)), 25_000);
    const sock = tls.connect({ host: cfg.host, port: cfg.port || 993, servername: cfg.host });
    let buf = Buffer.alloc(0);
    let literal = 0;
    let current = "";
    let greeted = false;
    let n = 0;
    let waiting: { tag: string; lines: string[]; resolve: (l: string[]) => void; reject: (e: Error) => void } | null = null;

    const emit = (line: string) => {
      if (!greeted) {
        greeted = true;
        if (!/^\* (OK|PREAUTH)/i.test(line)) return finish(new Error(`IMAP ${cfg.host}: ${line.slice(0, 200)}`));
        run();
        return;
      }
      if (waiting && line.startsWith(`${waiting.tag} `)) {
        const w = waiting;
        waiting = null;
        if (/^\S+ OK/i.test(line)) w.resolve(w.lines);
        else w.reject(new Error(line.replace(/^\S+ /, "").slice(0, 200)));
      } else waiting?.lines.push(line);
    };
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (literal > 0) {
          if (buf.length < literal) return;
          current += buf.subarray(0, literal).toString("utf8");
          buf = buf.subarray(literal);
          literal = 0;
          continue;
        }
        const idx = buf.indexOf("\r\n");
        if (idx < 0) return;
        const line = buf.subarray(0, idx).toString("utf8");
        buf = buf.subarray(idx + 2);
        const lit = line.match(/\{(\d+)\}$/);
        if (lit) {
          current += `${line}\r\n`;
          literal = Number(lit[1]);
          continue;
        }
        current += line;
        const full = current;
        current = "";
        emit(full);
      }
    });
    sock.on("error", (e) => finish(new Error(`IMAP ${cfg.host}: ${e.message}`)));
    sock.on("close", () => finish(new Error(`IMAP ${cfg.host}: connection closed`)));

    const cmd = (text: string) =>
      new Promise<string[]>((res, rej) => {
        const tag = `A${++n}`;
        waiting = { tag, lines: [], resolve: res, reject: rej };
        sock.write(`${tag} ${text}\r\n`);
      });

    const run = async () => {
      try {
        await cmd(`LOGIN ${quote(cfg.user)} ${quote(cfg.pass)}`);
        const out = await fn(cmd);
        await cmd("LOGOUT").catch(() => {});
        finish(null, out);
      } catch (e: any) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    };
  });
}

function junkFolder(listLines: string[]): string | null {
  const boxes: { name: string; flags: string }[] = [];
  for (const l of listLines) {
    const m = l.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) ([\s\S]+)$/i);
    if (!m) continue;
    let name = m[2].trim();
    if (name.includes("\r\n")) name = name.split("\r\n").pop() || "";
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    boxes.push({ name, flags: m[1] });
  }
  const special = boxes.find((b) => /\\Junk/i.test(b.flags));
  if (special) return special.name;
  const named = boxes.find((b) => /(^|[/.])(junk|spam|junk e-?mail|bulk mail)$/i.test(b.name));
  return named?.name || null;
}

export async function imapTest(cfg: ImapConfig): Promise<{ junk: string | null }> {
  return session(cfg, async (cmd) => ({ junk: junkFolder(await cmd(`LIST "" "*"`)) }));
}

export async function imapFind(cfg: ImapConfig, messageId: string): Promise<FoundMessage> {
  return session(cfg, async (cmd) => {
    const junk = junkFolder(await cmd(`LIST "" "*"`));
    const boxes: [string, FoundMessage["folder"]][] = [["INBOX", "inbox"]];
    if (junk) boxes.push([junk, "spam"]);
    for (const [box, folder] of boxes) {
      await cmd(`EXAMINE ${quote(box)}`);
      const lines = await cmd(`UID SEARCH HEADER Message-ID ${quote(messageId)}`);
      const hit = lines.map((l) => l.match(/^\* SEARCH\s+(\d+)/i)).find(Boolean);
      if (hit) return { found: true, folder, ref: `${box}:${hit[1]}` };
    }
    return { found: false, folder: null, ref: null };
  });
}
