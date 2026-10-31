import type Stripe from "stripe";
import { getStripe } from "./stripe";
import {
  listBackstopFulfilledWithoutWebhook,
  listUnsettledCheckoutSessions,
  markCheckoutSessionExpired,
  markEventProcessedIfNew,
} from "./db";
import {
  BACKSTOP_POLL_EVENT_TYPE,
  BACKSTOP_SWEEP_EVENT_TYPE,
  fulfillPaidCheckoutSession,
  isCheckoutSessionPaid,
} from "./checkout-fulfillment";
import {
  checkoutSessionFailureContext,
  sendPaymentAlert,
} from "./payment-alerts";
import type { Stage5ApiBindings } from "../types/env";

export const CHECKOUT_SWEEP_WINDOW_HOURS = 48;
const CHECKOUT_SWEEP_BATCH = 25;
const DEFAULT_UNFULFILLED_ALERT_MINUTES = 10;

export type CheckoutSweepReport = {
  scanned: number;
  fulfilled: number;
  expired: number;
  alerted: number;
  errors: string[];
};

function alertMinutes(env: Stage5ApiBindings): number {
  const parsed = Number.parseInt(
    String(env.CHECKOUT_UNFULFILLED_ALERT_MINUTES || ""),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_UNFULFILLED_ALERT_MINUTES;
}

// When the money moved: the PaymentIntent is created when the buyer confirms,
// so it is a better clock than the session (which may sit open for hours).
function paidAtSeconds(session: Stripe.Checkout.Session): number {
  const pi = session.payment_intent;
  if (pi && typeof pi === "object" && typeof pi.created === "number") {
    return pi.created;
  }
  return typeof session.created === "number" ? session.created : 0;
}

async function alertOnce(
  env: Stage5ApiBindings,
  dedupeKey: string,
  input: Parameters<typeof sendPaymentAlert>[1],
): Promise<boolean> {
  const isNew = await markEventProcessedIfNew({
    eventId: dedupeKey,
    eventType: "payment_alert",
  });
  if (!isNew) return false;
  await sendPaymentAlert(env, input);
  return true;
}

/**
 * Scheduled backstop. For every Translator checkout still 'created' in the last
 * 48 h, ask Stripe: paid -> fulfil (idempotent with the webhook and the poll),
 * expired -> record. A paid session found here more than N minutes after
 * payment means the webhook failed, so it alerts. It also alerts once for
 * sessions the app's poll had to fulfil whose webhook never arrived.
 */
export async function runCheckoutSweep(
  env: Stage5ApiBindings,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): Promise<CheckoutSweepReport> {
  const report: CheckoutSweepReport = {
    scanned: 0,
    fulfilled: 0,
    expired: 0,
    alerted: 0,
    errors: [],
  };
  const minutes = alertMinutes(env);
  const stripe = getStripe(env.STRIPE_SECRET_KEY);

  const rows = await listUnsettledCheckoutSessions({
    sinceHours: CHECKOUT_SWEEP_WINDOW_HOURS,
    limit: CHECKOUT_SWEEP_BATCH,
  });

  for (const row of rows) {
    report.scanned += 1;
    let session: Stripe.Checkout.Session | null = null;
    try {
      session = await stripe.checkout.sessions.retrieve(
        row.checkout_session_id,
        { expand: ["payment_intent"] },
      );

      if (isCheckoutSessionPaid(session.payment_status)) {
        const result = await fulfillPaidCheckoutSession({
          env,
          session,
          stripeEventId: null,
          stripeEventType: BACKSTOP_SWEEP_EVENT_TYPE,
        });
        if (result.outcome === "applied") report.fulfilled += 1;
        const ageMinutes = (nowMs / 1000 - paidAtSeconds(session)) / 60;
        if (result.outcome === "invalid_metadata") {
          throw new Error(`unusable metadata: ${result.reason}`);
        }
        if (result.outcome === "applied" && ageMinutes >= minutes) {
          if (
            await alertOnce(
              env,
              `checkout-unfulfilled-alert:${session.id}`,
              {
                title: `Paid checkout was not fulfilled after ${minutes} minutes`,
                severity: "critical",
                context: {
                  source: BACKSTOP_SWEEP_EVENT_TYPE,
                  action:
                    "The sweep granted it now. The Stripe webhook did not; check the endpoint's deliveries and STRIPE_WEBHOOK_SECRET.",
                  minutesSincePayment: Math.round(ageMinutes),
                  ...checkoutSessionFailureContext(session),
                },
              },
            )
          ) {
            report.alerted += 1;
          }
        }
      } else if (session.status === "expired") {
        if (
          await markCheckoutSessionExpired({
            checkoutSessionId: session.id,
            stripeEventType: "backstop.checkout_sweep_expired",
          })
        ) {
          report.expired += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${row.checkout_session_id}: ${message}`);
      // A paid session we could not fulfil is the worst outcome: alert once
      // per session. Lookup failures (Stripe/D1 hiccups) are logged only and
      // retried on the next run.
      if (session && isCheckoutSessionPaid(session.payment_status)) {
        try {
          if (
            await alertOnce(env, `checkout-unfulfilled-alert:${session.id}`, {
              title: "Paid checkout could not be fulfilled by the sweep",
              severity: "critical",
              context: {
                source: BACKSTOP_SWEEP_EVENT_TYPE,
                errorMessage: message,
                ...checkoutSessionFailureContext(session),
              },
            })
          ) {
            report.alerted += 1;
          }
        } catch (alertError) {
          console.error("[cron/checkout-sweep] alert failed:", alertError);
        }
      }
    }
  }

  // The poll saved the buyer, but the webhook still never came: the endpoint
  // is likely broken for everyone who closes the app before paying.
  const webhookMissing = await listBackstopFulfilledWithoutWebhook({
    stripeEventType: BACKSTOP_POLL_EVENT_TYPE,
    olderThanMinutes: Math.max(minutes, 1),
    sinceHours: CHECKOUT_SWEEP_WINDOW_HOURS,
    limit: CHECKOUT_SWEEP_BATCH,
  });
  for (const row of webhookMissing) {
    if (
      await alertOnce(env, `checkout-webhook-missing-alert:${row.checkout_session_id}`, {
        title: "Stripe webhook never arrived for a paid checkout",
        severity: "warning",
        context: {
          source: BACKSTOP_POLL_EVENT_TYPE,
          action:
            "The app's status poll fulfilled this payment; no webhook followed. Check the endpoint's deliveries and STRIPE_WEBHOOK_SECRET.",
          sessionId: row.checkout_session_id,
          deviceId: row.device_id,
          packId: row.pack_id,
          entitlement: row.entitlement,
          fulfilledAt: row.fulfilled_at,
        },
      })
    ) {
      report.alerted += 1;
    }
  }

  return report;
}
