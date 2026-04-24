import type Stripe from "stripe";
import type { Stage5ApiBindings } from "../types/env";

type PaymentAlertInput = {
  title: string;
  severity?: "warning" | "critical";
  context: Record<string, unknown>;
};

const DEFAULT_SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const MAX_CONTEXT_VALUE_LENGTH = 1_000;

function normalizeEmailList(raw: unknown): string[] {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAlertRecipients(env: Stage5ApiBindings): string[] {
  return normalizeEmailList(env.PAYMENT_ALERT_EMAIL_TO || env.ALERT_EMAIL_TO);
}

function resolveAlertSender(env: Stage5ApiBindings): string {
  return String(
    env.PAYMENT_ALERT_EMAIL_FROM ||
      env.ALERT_EMAIL_FROM ||
      env.EMAIL_SENDER ||
      ""
  ).trim();
}

function isPaymentAlertsEnabled(env: Stage5ApiBindings): boolean {
  return String(env.PAYMENT_ALERTS_ENABLED || "1").trim() !== "0";
}

function formatContextValue(value: unknown): string {
  let rendered: string;
  if (value === null || value === undefined) {
    rendered = "";
  } else if (typeof value === "object") {
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = String(value);
    }
  } else {
    rendered = String(value);
  }

  if (rendered.length <= MAX_CONTEXT_VALUE_LENGTH) {
    return rendered;
  }
  return `${rendered.slice(0, MAX_CONTEXT_VALUE_LENGTH)}...`;
}

function formatAlertText(input: PaymentAlertInput): string {
  const lines = [
    input.title,
    "",
    `Severity: ${input.severity || "warning"}`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "Context:",
  ];

  for (const [key, value] of Object.entries(input.context).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(`- ${key}: ${formatContextValue(value)}`);
  }

  return lines.join("\n");
}

async function sendSendGridEmail({
  env,
  subject,
  text,
}: {
  env: Stage5ApiBindings;
  subject: string;
  text: string;
}): Promise<void> {
  const apiKey = String(env.SENDGRID_API_KEY || "").trim();
  const from = resolveAlertSender(env);
  const to = resolveAlertRecipients(env);

  if (!apiKey || !from || to.length === 0) {
    throw new Error(
      "Payment alert email is not configured. Set SENDGRID_API_KEY, PAYMENT_ALERT_EMAIL_TO, and PAYMENT_ALERT_EMAIL_FROM."
    );
  }

  const response = await fetch(
    String(env.SENDGRID_API_URL || DEFAULT_SENDGRID_API_URL),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: to.map((email) => ({ email })),
            subject,
          },
        ],
        from: { email: from },
        content: [{ type: "text/plain", value: text }],
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`SendGrid HTTP ${response.status}: ${detail}`);
  }
}

export async function sendPaymentAlert(
  env: Stage5ApiBindings,
  input: PaymentAlertInput
): Promise<boolean> {
  console.error(
    `[PAYMENT ALERT][${input.severity || "warning"}] ${input.title}`,
    JSON.stringify(input.context)
  );

  if (!isPaymentAlertsEnabled(env)) {
    console.warn("[payment-alerts] Payment alert email is disabled.");
    return false;
  }

  try {
    await sendSendGridEmail({
      env,
      subject: `[Stage5 payment] ${input.title}`,
      text: formatAlertText(input),
    });
    return true;
  } catch (error) {
    console.error("[payment-alerts] Failed to send payment alert email:", error);
    return false;
  }
}

export function paymentIntentFailureContext(
  paymentIntent: Stripe.PaymentIntent
): Record<string, unknown> {
  const lastError = paymentIntent.last_payment_error;
  const metadata = paymentIntent.metadata || {};

  return {
    stripeObject: "payment_intent",
    paymentIntentId: paymentIntent.id,
    status: paymentIntent.status,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    deviceId: metadata.deviceId,
    packId: metadata.packId,
    entitlement: metadata.entitlement,
    failureType: lastError?.type,
    failureCode: lastError?.code,
    declineCode: lastError?.decline_code,
    failureMessage: lastError?.message,
    paymentMethodType: lastError?.payment_method?.type,
  };
}

export function checkoutSessionFailureContext(
  session: Stripe.Checkout.Session
): Record<string, unknown> {
  const metadata = session.metadata || {};
  const paymentIntent = session.payment_intent;

  return {
    stripeObject: "checkout_session",
    sessionId: session.id,
    status: session.status,
    paymentStatus: session.payment_status,
    paymentIntentId:
      typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id,
    mode: session.mode,
    deviceId: metadata.deviceId,
    packId: metadata.packId,
    entitlement: metadata.entitlement,
    amountTotal: session.amount_total,
    currency: session.currency,
    customerEmail: session.customer_details?.email,
  };
}
