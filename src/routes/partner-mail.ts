import { Hono } from "hono";
import type { Stage5ApiBindings } from "../types/env";

/**
 * Transactional email for partner apps that run on Stage5 infrastructure
 * (first user: the MOMENTIK booking app, Worker "seoul-snap").
 *
 * It reuses Stage5's SendGrid account so a partner app doesn't need its own
 * key. Temporary by design: when a partner gets its own SendGrid key, it should
 * send directly and this route can be removed.
 *
 * Disabled (404) unless PARTNER_MAIL_SECRET is set. One recipient per call.
 */

const DEFAULT_SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const MAX_SUBJECT = 200;
const MAX_TEXT = 20_000;
const MAX_HTML = 100_000;
const MAX_NAME = 80;

type PartnerMailBody = {
  to?: unknown;
  toName?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  replyTo?: unknown;
  fromName?: unknown;
  partner?: unknown;
  sandbox?: unknown;
};

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value: string, max: number): string {
  // No header injection via names/subjects.
  return value.replace(/[\r\n]+/g, " ").slice(0, max);
}

function resolveFrom(env: Stage5ApiBindings): string {
  return String(
    env.PARTNER_MAIL_FROM ||
      env.ALERT_EMAIL_FROM ||
      env.PAYMENT_ALERT_EMAIL_FROM ||
      env.EMAIL_SENDER ||
      ""
  ).trim();
}

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

router.post("/send", async (c) => {
  const secret = String(c.env.PARTNER_MAIL_SECRET || "").trim();
  if (!secret) return c.json({ error: "not_found" }, 404);

  const given = String(c.req.header("x-partner-mail-secret") || "");
  if (!given || !timingSafeEqual(given, secret)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: PartnerMailBody;
  try {
    body = (await c.req.json()) as PartnerMailBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const to = str(body.to).toLowerCase();
  const replyTo = str(body.replyTo).toLowerCase();
  const subject = clean(str(body.subject), MAX_SUBJECT);
  const text = typeof body.text === "string" ? body.text : "";
  const html = typeof body.html === "string" ? body.html : "";
  const fromName = clean(str(body.fromName), MAX_NAME);
  const toName = clean(str(body.toName), MAX_NAME);
  const partner = clean(str(body.partner), 40).replace(/[^a-z0-9-]/gi, "") || "partner";

  if (!EMAIL_RE.test(to)) return c.json({ error: "invalid_to" }, 400);
  if (replyTo && !EMAIL_RE.test(replyTo)) {
    return c.json({ error: "invalid_reply_to" }, 400);
  }
  if (!subject) return c.json({ error: "missing_subject" }, 400);
  if (!text.trim()) return c.json({ error: "missing_text" }, 400);
  if (text.length > MAX_TEXT || html.length > MAX_HTML) {
    return c.json({ error: "too_large" }, 413);
  }

  const apiKey = String(c.env.SENDGRID_API_KEY || "").trim();
  const from = resolveFrom(c.env);
  if (!apiKey || !from) {
    return c.json({ error: "mail_not_configured" }, 503);
  }

  const content: Array<{ type: string; value: string }> = [
    { type: "text/plain", value: text },
  ];
  if (html.trim()) content.push({ type: "text/html", value: html });

  const response = await fetch(
    String(c.env.SENDGRID_API_URL || DEFAULT_SENDGRID_API_URL),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [
          { to: [toName ? { email: to, name: toName } : { email: to }] },
        ],
        from: fromName ? { email: from, name: fromName } : { email: from },
        ...(replyTo ? { reply_to: { email: replyTo } } : {}),
        subject,
        content,
        categories: ["partner-mail", partner],
        // sandbox: SendGrid validates the request (key, sender, payload) without delivering.
        ...(body.sandbox === true
          ? { mail_settings: { sandbox_mode: { enable: true } } }
          : {}),
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
        },
      }),
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    console.error(`[partner-mail] SendGrid HTTP ${response.status} (${partner}): ${detail}`);
    return c.json({ error: "send_failed", status: response.status }, 502);
  }

  console.log(`[partner-mail] sent (${partner})`);
  return c.json(
    { ok: true, messageId: response.headers.get("x-message-id") || null },
    202
  );
});

export default router;
