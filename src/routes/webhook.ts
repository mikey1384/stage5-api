import { Hono } from "hono";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe";
import {
  fulfillByoOpenAiUnlock,
  fulfillCreditPackPurchase,
  completePilotReservation,
  getCheckoutSessionRecord,
  isEventProcessed,
  markCheckoutSessionExpired,
  markCheckoutSessionFailed,
  markCheckoutSessionFulfilledCredits,
  markCheckoutSessionFulfilledEntitlement,
  markEventProcessed,
  markEventProcessedIfNew,
  recordCheckoutPaymentFailure,
  STAGE5_PILOT_EXPERIMENT_TAG,
  STAGE5_PILOT_OFFER_CODE,
} from "../lib/db";
import {
  checkoutSessionFailureContext,
  paymentIntentFailureContext,
  sendPaymentAlert,
} from "../lib/payment-alerts";
import {
  fulfillPaidCheckoutSession,
  getPaymentIntentIdFromCheckoutSession,
  isCheckoutSessionPaid,
  recordPurchaseAnalytics,
} from "../lib/checkout-fulfillment";
import { flushAnalyticsOutbox } from "../lib/product-analytics";
import { isValidPackId, packs, type PackId } from "../types/packs";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();
const BYO_UNLOCK_USD = 10;

function flushAnalyticsInBackground(c: any): void {
  const flush = flushAnalyticsOutbox(c.env).catch((error) => {
    console.warn("[analytics] Webhook flush failed:", error);
  });
  try {
    c.executionCtx.waitUntil(flush);
  } catch {
    void flush;
  }
}

function getCheckoutCustomField(
  session: Stripe.Checkout.Session,
  key: string,
): string {
  const field = session.custom_fields?.find(
    (candidate) => candidate.key === key,
  );
  if (!field) return "";
  if (field.type === "text") return String(field.text?.value || "").trim();
  if (field.type === "dropdown") {
    return String(field.dropdown?.value || "").trim();
  }
  if (field.type === "numeric")
    return String(field.numeric?.value || "").trim();
  return "";
}

type CheckoutPaymentIntentDetails = {
  checkoutSessionId: string | null;
  checkoutSessionStatus: Stripe.Checkout.Session.Status | null;
  checkoutSessionPaymentStatus: Stripe.Checkout.Session.PaymentStatus | null;
  deviceId: string | null;
  packId: string | null;
  entitlement: string | null;
  mode: "credits" | "byo";
};

async function resolveCheckoutDetailsFromPaymentIntent({
  env,
  paymentIntent,
  logContext,
}: {
  env: Stage5ApiBindings;
  paymentIntent: Stripe.PaymentIntent;
  logContext: string;
}): Promise<CheckoutPaymentIntentDetails> {
  let session: Stripe.Checkout.Session | null = null;

  try {
    const stripe = getStripe(env.STRIPE_SECRET_KEY);
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: paymentIntent.id,
      limit: 1,
    });
    session = sessions.data[0] ?? null;
  } catch (error) {
    console.warn(
      `Could not resolve Checkout session for ${logContext} payment intent ${paymentIntent.id}:`,
      error,
    );
  }

  const metadata = {
    ...(paymentIntent.metadata || {}),
    ...(session?.metadata || {}),
  };
  const entitlement =
    typeof metadata.entitlement === "string" ? metadata.entitlement : null;

  return {
    checkoutSessionId: session?.id ?? null,
    checkoutSessionStatus: session?.status ?? null,
    checkoutSessionPaymentStatus: session?.payment_status ?? null,
    deviceId: typeof metadata.deviceId === "string" ? metadata.deviceId : null,
    packId: typeof metadata.packId === "string" ? metadata.packId : null,
    entitlement,
    mode: entitlement === "byo_openai" ? "byo" : "credits",
  };
}

function paymentErrorFields(
  error: Stripe.PaymentIntent.LastPaymentError | null | undefined,
) {
  return {
    errorCode: error?.code ?? null,
    declineCode: error?.decline_code ?? null,
    errorMessage: error?.message ?? null,
    paymentMethodType: error?.payment_method?.type ?? null,
  };
}

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13);
}

// Alerts at most once per key (processed_events doubles as the dedupe log).
// If the dedupe write itself fails (D1 down), alert anyway.
async function sendDedupedPaymentAlert(
  env: Stage5ApiBindings,
  dedupeKey: string,
  input: Parameters<typeof sendPaymentAlert>[1],
): Promise<void> {
  let isNew = true;
  try {
    isNew = await markEventProcessedIfNew({
      eventId: dedupeKey,
      eventType: "payment_alert",
    });
  } catch (error) {
    console.warn(`[payment-alerts] dedupe write failed for ${dedupeKey}:`, error);
  }
  if (isNew) {
    await sendPaymentAlert(env, input);
  }
}

router.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    console.error("Missing Stripe signature header");
    return c.json({ error: "Missing signature" }, 400);
  }

  let event: Stripe.Event;
  try {
    // Get raw body as pristine bytes (no middleware has consumed it now)
    const rawBody = await c.req.arrayBuffer();

    // Get Stripe instance and construct webhook event
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    event = await stripe.webhooks.constructEventAsync(
      new Uint8Array(rawBody) as any, // Zero-copy view, TS types need updating
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    // A rotated or mismatched STRIPE_WEBHOOK_SECRET rejects every real
    // payment event; Stripe retries for ~3 days and then gives up. Alert at
    // most once an hour so a stray bad request cannot flood the inbox.
    await sendDedupedPaymentAlert(
      c.env,
      `webhook-signature-alert:${hourBucket()}`,
      {
        title: "Stripe webhook signature verification failed",
        severity: "warning",
        context: {
          route: "/stripe/webhook",
          errorMessage: error instanceof Error ? error.message : String(error),
          hint: "If real Stripe deliveries are failing, check STRIPE_WEBHOOK_SECRET against the endpoint's signing secret.",
        },
      },
    );
    return c.json({ error: "Invalid signature" }, 400);
  }

  try {
    console.log(`Received webhook: ${event.type}`);

    // Check idempotency - prevent duplicate processing
    if (await isEventProcessed({ eventId: event.id })) {
      console.log(`Event ${event.id} already processed, skipping`);
      return c.json({ received: true, message: "Already processed" });
    }

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutPaid({
          env: c.env,
          session,
          eventId: event.id,
          eventType: event.type,
        });
        break;
      }

      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutAsyncPaymentFailed({
          session,
          eventId: event.id,
          eventType: event.type,
          env: c.env,
        });
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutExpired({
          session,
          eventId: event.id,
          eventType: event.type,
        });
        break;
      }

      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await handlePaymentSucceeded({
          env: c.env,
          paymentIntent,
          eventId: event.id,
        });
        break;
      }

      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await handlePaymentFailed({
          paymentIntent,
          eventId: event.id,
          eventType: event.type,
          env: c.env,
        });
        break;
      }

      default:
        // Unhandled event type - will return success below
        break;
    }

    // Mark event as processed only after successful handling
    await markEventProcessed({ eventId: event.id, eventType: event.type });
    flushAnalyticsInBackground(c);
    return c.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    // Stripe will retry; alert once per event so a paid buyer whose credits
    // could not be written is never silent.
    await sendDedupedPaymentAlert(c.env, `webhook-error-alert:${event.id}`, {
      title: "Stripe webhook processing failed",
      severity: "critical",
      context: {
        eventId: event.id,
        eventType: event.type,
        objectId: (event.data?.object as { id?: string } | undefined)?.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

const handleCheckoutPaid = async ({
  env,
  eventId,
  session,
  eventType,
}: {
  env: Stage5ApiBindings;
  eventId: string;
  session: Stripe.Checkout.Session;
  eventType:
    "checkout.session.completed" | "checkout.session.async_payment_succeeded";
}) => {
  // Delayed methods (for example some local wallets) may complete Checkout with payment_status=unpaid.
  // Fulfillment must wait for checkout.session.async_payment_succeeded in that case.
  // Fully discounted sessions can report payment_status=no_payment_required and should be fulfilled immediately.
  if (!isCheckoutSessionPaid(session.payment_status)) {
    console.log(
      `Deferring fulfillment for ${session.id} (${eventType}): payment_status=${session.payment_status}`,
    );
    return;
  }

  const metadata = session.metadata || {};
  if (
    metadata.experimentTag === STAGE5_PILOT_EXPERIMENT_TAG &&
    metadata.offerCode === STAGE5_PILOT_OFFER_CODE
  ) {
    const customerEmail = String(session.customer_details?.email || "").trim();
    const videoUrl = getCheckoutCustomField(session, "video_url");
    const targetLanguage = getCheckoutCustomField(session, "target_language");
    const rightsConfirmed =
      getCheckoutCustomField(session, "rights_confirmed") === "confirmed";
    if (!customerEmail || !videoUrl || !targetLanguage || !rightsConfirmed) {
      throw new Error(
        `Pilot reservation ${session.id} is missing required intake data`,
      );
    }

    await completePilotReservation({
      checkoutSessionId: session.id,
      customerEmail,
      videoUrl,
      targetLanguage,
      rightsConfirmed,
      stripeEventId: eventId,
      stripeEventType: eventType,
    });
    console.log(`Completed Stage5 pilot reservation ${session.id}`);
    return;
  }

  const result = await fulfillPaidCheckoutSession({
    env,
    session,
    stripeEventId: eventId,
    stripeEventType: eventType,
  });

  switch (result.outcome) {
    case "applied":
    case "duplicate":
      console.log(
        `${result.outcome === "applied" ? "Fulfilled" : "Skipped duplicate"} ${result.mode} checkout ${session.id} for device ${result.deviceId} via ${eventType}`,
      );
      return;
    case "not_translator":
      console.log(
        `Ignoring paid checkout ${session.id}: no Translator deviceId in metadata`,
      );
      return;
    case "invalid_metadata":
      console.error(
        `Paid checkout ${session.id} cannot be fulfilled: ${result.reason}`,
      );
      await sendPaymentAlert(env, {
        title: "Paid checkout has unusable metadata",
        severity: "critical",
        context: {
          eventId,
          eventType,
          reason: result.reason,
          ...checkoutSessionFailureContext(session),
        },
      });
      return;
    case "not_paid":
      return;
  }
};

async function lookupPaymentIntentError(
  env: Stage5ApiBindings,
  paymentIntentId: string | null,
): Promise<Stripe.PaymentIntent.LastPaymentError | null> {
  if (!paymentIntentId) return null;
  try {
    const stripe = getStripe(env.STRIPE_SECRET_KEY);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return paymentIntent.last_payment_error ?? null;
  } catch (error) {
    console.warn(
      `Could not read last payment error for ${paymentIntentId}:`,
      error,
    );
    return null;
  }
}

const handleCheckoutAsyncPaymentFailed = async ({
  env,
  eventId,
  eventType,
  session,
}: {
  env: Stage5ApiBindings;
  eventId: string;
  eventType: "checkout.session.async_payment_failed";
  session: Stripe.Checkout.Session;
}) => {
  const { deviceId, packId, entitlement } = session.metadata || {};
  const tracked = await getCheckoutSessionRecord({
    checkoutSessionId: session.id,
  });
  if (!deviceId && !tracked) {
    console.log(
      `Ignoring async payment failure for non-Translator session ${session.id}`,
    );
    return;
  }

  const paymentIntentId = getPaymentIntentIdFromCheckoutSession(session);
  const lastError = await lookupPaymentIntentError(env, paymentIntentId);
  const fields = paymentErrorFields(lastError);
  const reason =
    fields.declineCode || fields.errorCode
      ? `async payment failed: ${fields.declineCode || fields.errorCode}${fields.errorMessage ? ` (${fields.errorMessage})` : ""}`
      : "async payment failed: Stripe reported checkout.session.async_payment_failed";
  console.warn(
    `Async checkout payment failed for session ${session.id} (deviceId=${deviceId ?? "unknown"}, packId=${packId ?? "none"}, entitlement=${entitlement ?? "none"})`,
  );
  await recordCheckoutPaymentFailure({
    checkoutSessionId: session.id,
    ...fields,
  });
  await markCheckoutSessionFailed({
    checkoutSessionId: session.id,
    deviceId: deviceId || null,
    paymentIntentId,
    stripeEventId: eventId,
    stripeEventType: eventType,
    errorMessage: reason,
  });
  await sendPaymentAlert(env, {
    title: "Stripe async checkout payment failed",
    severity: "critical",
    context: {
      eventId,
      eventType,
      failureCode: fields.errorCode,
      declineCode: fields.declineCode,
      failureMessage: fields.errorMessage,
      paymentMethodType: fields.paymentMethodType,
      ...checkoutSessionFailureContext(session),
    },
  });
};

const handleCheckoutExpired = async ({
  eventId,
  eventType,
  session,
}: {
  eventId: string;
  eventType: "checkout.session.expired";
  session: Stripe.Checkout.Session;
}) => {
  // Only rows Translator created match; other products on the shared Stripe
  // account are no-ops.
  const changed = await markCheckoutSessionExpired({
    checkoutSessionId: session.id,
    stripeEventId: eventId,
    stripeEventType: eventType,
  });
  if (changed) {
    console.log(`Checkout session ${session.id} expired; recorded as cancelled`);
  }
};

const handlePaymentSucceeded = async ({
  env,
  eventId,
  paymentIntent,
}: {
  env: Stage5ApiBindings;
  eventId: string;
  paymentIntent: Stripe.PaymentIntent;
}) => {
  console.log(`Payment succeeded: ${paymentIntent.id}`);
  const checkoutDetails = await resolveCheckoutDetailsFromPaymentIntent({
    env,
    paymentIntent,
    logContext: "succeeded",
  });
  const { checkoutSessionId, entitlement, deviceId, packId } = checkoutDetails;
  if (entitlement === "byo_openai" && deviceId) {
    try {
      const result = await fulfillByoOpenAiUnlock({
        deviceId,
        entitlement: "byo_openai",
        checkoutSessionId,
        paymentIntentId: paymentIntent.id,
        stripeEventId: eventId,
        stripeEventType: "payment_intent.succeeded",
      });
      if (result === "duplicate") {
        console.log(
          `Skipped duplicate BYO OpenAI entitlement (payment_intent) for device ${deviceId}`,
        );
      } else {
        console.log(
          `Granted BYO OpenAI entitlement (payment_intent) to device ${deviceId}`,
        );
      }
      await markCheckoutSessionFulfilledEntitlement({
        deviceId,
        entitlement: "byo_openai",
        checkoutSessionId,
        paymentIntentId: paymentIntent.id,
        stripeEventId: eventId,
        stripeEventType: "payment_intent.succeeded",
      });
      await recordPurchaseAnalytics({
        env,
        deviceId,
        transactionId: paymentIntent.id,
        mode: "byo",
        value:
          typeof paymentIntent.amount_received === "number" &&
          paymentIntent.amount_received > 0
            ? paymentIntent.amount_received / 100
            : BYO_UNLOCK_USD,
        currency: paymentIntent.currency,
      });
    } catch (error) {
      console.error(
        "Error granting BYO entitlement from payment intent:",
        error,
      );
      throw error;
    }
    return;
  }

  if (deviceId && packId && isValidPackId(packId)) {
    try {
      const result = await fulfillCreditPackPurchase({
        deviceId,
        packId: packId as PackId,
        checkoutSessionId,
        paymentIntentId: paymentIntent.id,
        stripeEventId: eventId,
        stripeEventType: "payment_intent.succeeded",
        stripePaymentStatus: paymentIntent.status ?? null,
      });
      if (result === "duplicate") {
        console.log(
          `Skipped duplicate credit fulfillment (payment_intent) for ${packId} to device ${deviceId}`,
        );
      } else {
        console.log(
          `Credited ${packId} to device ${deviceId} via payment_intent.succeeded`,
        );
      }
      await markCheckoutSessionFulfilledCredits({
        deviceId,
        packId,
        checkoutSessionId,
        paymentIntentId: paymentIntent.id,
        stripeEventId: eventId,
        stripeEventType: "payment_intent.succeeded",
      });
      await recordPurchaseAnalytics({
        env,
        deviceId,
        transactionId: paymentIntent.id,
        mode: "credits",
        packId,
        value:
          typeof paymentIntent.amount_received === "number" &&
          paymentIntent.amount_received > 0
            ? paymentIntent.amount_received / 100
            : packs[packId].usd,
        currency: paymentIntent.currency,
      });
    } catch (error) {
      console.error("Error crediting device from payment intent:", error);
      throw error;
    }
  }
};

const handlePaymentFailed = async ({
  env,
  eventId,
  eventType,
  paymentIntent,
}: {
  env: Stage5ApiBindings;
  eventId: string;
  eventType: "payment_intent.payment_failed";
  paymentIntent: Stripe.PaymentIntent;
}) => {
  console.warn(`Payment failed: ${paymentIntent.id}`);
  const fields = paymentErrorFields(paymentIntent.last_payment_error);
  const message =
    fields.errorMessage || "Stripe reported payment_intent.payment_failed";
  const failureDetails = await resolveCheckoutDetailsFromPaymentIntent({
    env,
    paymentIntent,
    logContext: "failed",
  });

  if (!failureDetails.deviceId) {
    // Another product on the shared Stripe account.
    console.info(
      `Ignoring failed payment intent ${paymentIntent.id}: no Translator deviceId`,
    );
    return;
  }

  if (failureDetails.checkoutSessionId) {
    // Keep why this buyer could not pay, whatever happens to the session next.
    await recordCheckoutPaymentFailure({
      checkoutSessionId: failureDetails.checkoutSessionId,
      ...fields,
    });
  }

  if (failureDetails.checkoutSessionStatus === "open") {
    console.info(
      `Payment attempt failed for open Checkout session ${failureDetails.checkoutSessionId} (${fields.declineCode || fields.errorCode || "unknown"}); leaving checkout recoverable.`,
    );
    return;
  }

  if (
    !failureDetails.checkoutSessionId ||
    !failureDetails.checkoutSessionStatus
  ) {
    console.info(
      `Payment intent ${paymentIntent.id} failed, but no terminal Checkout session could be resolved; leaving checkout state recoverable.`,
    );
    await sendPaymentAlert(env, {
      title: "Stripe payment intent failed without resolved Checkout session",
      severity: "warning",
      context: {
        eventId,
        eventType,
        ...paymentIntentFailureContext(paymentIntent),
      },
    });
    return;
  }

  if (isCheckoutSessionPaid(failureDetails.checkoutSessionPaymentStatus)) {
    console.info(
      `Payment attempt failed for already-paid Checkout session ${failureDetails.checkoutSessionId}; ignoring stale failure.`,
    );
    return;
  }

  const checkoutRecord = await getCheckoutSessionRecord({
    checkoutSessionId: failureDetails.checkoutSessionId,
    deviceId: failureDetails.deviceId,
  });
  if (checkoutRecord?.status === "fulfilled") {
    console.info(
      `Payment attempt failed for already-fulfilled tracked checkout ${failureDetails.checkoutSessionId}; ignoring stale failure.`,
    );
    return;
  }

  await markCheckoutSessionFailed({
    checkoutSessionId: failureDetails.checkoutSessionId,
    deviceId: failureDetails.deviceId,
    paymentIntentId: paymentIntent.id,
    stripeEventId: eventId,
    stripeEventType: eventType,
    errorMessage: message,
  });
  await sendPaymentAlert(env, {
    title: "Stripe payment intent failed",
    severity: "critical",
    context: {
      eventId,
      eventType,
      ...paymentIntentFailureContext(paymentIntent),
    },
  });
};

export default router;
