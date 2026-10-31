import type Stripe from "stripe";
import {
  fulfillByoOpenAiUnlock,
  fulfillCreditPackPurchase,
  markCheckoutSessionFulfilledCredits,
  markCheckoutSessionFulfilledEntitlement,
} from "./db";
import {
  enqueueAnalyticsEventSafely,
  type AnalyticsItem,
} from "./product-analytics";
import { isValidPackId, packs, type PackId } from "../types/packs";
import type { Stage5ApiBindings } from "../types/env";

const BYO_UNLOCK_USD = 10;

// Fulfilment paths that are not a Stripe webhook. Recorded as
// checkout_sessions.stripe_event_type so a later webhook (which overwrites it)
// proves delivery, and the sweep can alert when it never comes.
export const BACKSTOP_POLL_EVENT_TYPE = "backstop.session_poll";
export const BACKSTOP_SWEEP_EVENT_TYPE = "backstop.checkout_sweep";

export type CheckoutFulfillmentResult =
  | { outcome: "applied" | "duplicate"; mode: "credits" | "byo"; deviceId: string }
  | { outcome: "not_paid" }
  | { outcome: "not_translator" }
  | { outcome: "invalid_metadata"; reason: string; deviceId: string };

export function isCheckoutSessionPaid(
  paymentStatus: Stripe.Checkout.Session.PaymentStatus | null | undefined,
): boolean {
  return paymentStatus === "paid" || paymentStatus === "no_payment_required";
}

export function getPaymentIntentIdFromCheckoutSession(
  session: Pick<Stripe.Checkout.Session, "payment_intent">,
): string | null {
  const paymentIntent = session.payment_intent;
  if (!paymentIntent) return null;
  if (typeof paymentIntent === "string") return paymentIntent;
  return paymentIntent.id ?? null;
}

export function purchaseItem({
  mode,
  packId,
  value,
}: {
  mode: "credits" | "byo";
  packId?: PackId | null;
  value: number;
}): AnalyticsItem {
  if (mode === "byo") {
    return {
      item_id: "byo_ai_unlock",
      item_name: "Translator BYO AI unlock",
      item_category: "entitlement",
      price: value,
      quantity: 1,
    };
  }
  return {
    item_id: `credit_pack_${String(packId || "unknown").toLowerCase()}`,
    item_name: `Translator ${packId || "unknown"} credit pack`,
    item_category: "credits",
    price: value,
    quantity: 1,
  };
}

export async function recordPurchaseAnalytics({
  env,
  deviceId,
  transactionId,
  mode,
  packId,
  value,
  currency,
}: {
  env: Stage5ApiBindings;
  deviceId: string;
  transactionId: string;
  mode: "credits" | "byo";
  packId?: PackId | null;
  value: number;
  currency?: string | null;
}): Promise<void> {
  await enqueueAnalyticsEventSafely(env, {
    eventId: `purchase:${transactionId}`,
    eventName: "purchase",
    subjectKey: `translator-device:${deviceId}`,
    params: {
      transaction_id: transactionId,
      affiliation: "Translator desktop",
      currency: String(currency || "usd").toUpperCase(),
      value,
      checkout_mode: mode,
      commerce_surface: "translator_desktop",
      attribution_scope: "server_settlement",
      items: [purchaseItem({ mode, packId, value })],
      engagement_time_msec: 1,
    },
  });
}

// USD value for analytics. With Adaptive Pricing the session's own amount and
// currency are the USD base (presentment_details carries the local amount).
function sessionUsdValue(
  session: Stripe.Checkout.Session,
  fallbackUsd: number,
): number {
  if (
    typeof session.amount_total === "number" &&
    String(session.currency || "usd").toLowerCase() === "usd"
  ) {
    return session.amount_total / 100;
  }
  return fallbackUsd;
}

/**
 * Grants what a paid Translator Checkout session bought. Safe to call from
 * every path (webhook, status poll, scheduled sweep) and concurrently: the
 * grant and its stripe_fulfillments row are written in one batch keyed by the
 * PaymentIntent id (session id when there is none), so exactly one call
 * applies and the rest report "duplicate".
 */
export async function fulfillPaidCheckoutSession({
  env,
  session,
  stripeEventId,
  stripeEventType,
}: {
  env: Stage5ApiBindings;
  session: Stripe.Checkout.Session;
  stripeEventId: string | null;
  stripeEventType: string;
}): Promise<CheckoutFulfillmentResult> {
  if (!isCheckoutSessionPaid(session.payment_status)) {
    return { outcome: "not_paid" };
  }

  const metadata = session.metadata || {};
  const { deviceId, packId, entitlement } = metadata;
  if (!deviceId) {
    // The Stripe account is shared; sessions without a Translator device are
    // not ours to fulfil.
    return { outcome: "not_translator" };
  }

  const paymentIntentId = getPaymentIntentIdFromCheckoutSession(session);
  const transactionId = paymentIntentId || session.id;

  if (entitlement === "byo_openai") {
    const result = await fulfillByoOpenAiUnlock({
      deviceId,
      entitlement: "byo_openai",
      checkoutSessionId: session.id,
      paymentIntentId,
      stripeEventId,
      stripeEventType,
    });
    await markCheckoutSessionFulfilledEntitlement({
      deviceId,
      entitlement: "byo_openai",
      checkoutSessionId: session.id,
      paymentIntentId,
      stripeEventId,
      stripeEventType,
    });
    await recordPurchaseAnalytics({
      env,
      deviceId,
      transactionId,
      mode: "byo",
      value: sessionUsdValue(session, BYO_UNLOCK_USD),
      currency: "usd",
    });
    return { outcome: result, mode: "byo", deviceId };
  }

  if (!packId) {
    return { outcome: "invalid_metadata", reason: "missing packId", deviceId };
  }
  if (!isValidPackId(packId)) {
    return {
      outcome: "invalid_metadata",
      reason: `invalid packId ${packId}`,
      deviceId,
    };
  }

  const result = await fulfillCreditPackPurchase({
    deviceId,
    packId: packId as PackId,
    checkoutSessionId: session.id,
    paymentIntentId,
    stripeEventId,
    stripeEventType,
    stripePaymentStatus: session.payment_status ?? null,
  });
  await markCheckoutSessionFulfilledCredits({
    deviceId,
    packId,
    checkoutSessionId: session.id,
    paymentIntentId,
    stripeEventId,
    stripeEventType,
  });
  await recordPurchaseAnalytics({
    env,
    deviceId,
    transactionId,
    mode: "credits",
    packId: packId as PackId,
    value: sessionUsdValue(session, packs[packId as PackId].usd),
    currency: "usd",
  });
  return { outcome: result, mode: "credits", deviceId };
}
