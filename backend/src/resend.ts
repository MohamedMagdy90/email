import { getSetting } from "./db";

export async function getResendKey(): Promise<string | null> {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  return await getSetting("resend_api_key");
}

export interface SendArgs {
  from: string;
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
  dryRun?: boolean;
}

// Sends via the Resend REST API. If no key is set (e.g. in preview),
// it runs in "dry-run" mode so the whole app is testable without sending.
export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const key = await getResendKey();
  if (!key) {
    return { ok: true, dryRun: true, id: "dry_" + crypto.randomUUID().slice(0, 8) };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: args.from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        headers: args.headers,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.message || `Resend HTTP ${res.status}` };
    return { ok: true, id: data?.id };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
