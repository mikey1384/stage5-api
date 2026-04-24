import { Hono } from "hono";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe";
import {
  fulfillByoOpenAiUnlock,
  fulfillCreditPackPurchase,
  getCheckoutSessionRecord,
  isEventProcessed,
  markCheckoutSessionFailed,
  markCheckoutSessionFulfilledCredits,
  markCheckoutSessionFulfilledEntitlement,
  markEventProcessed,
} from "../lib/db";
import {
  checkoutSessionFailureContext,
  paymentIntentFailureContext,
  sendPaymentAlert,
} from "../lib/payment-alerts";
import {
  buildCreditPaymentEvent,
  notifyDevicePaymentEvent,
} from "../lib/payment-events";
import { isValidPackId, type PackId } from "../types/packs";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

const isCheckoutSessionFulfilled = (
  paymentStatus: Stripe.Checkout.Session.PaymentStatus | null
): boolean => {
  return paymentStatus === "paid" || paymentStatus === "no_payment_required";
};

function getPaymentIntentIdFromCheckoutSession(
  session: Stripe.Checkout.Session
): string | null {
  const paymentIntent = session.payment_intent;
  if (!paymentIntent) {
    return null;
  }

  if (typeof paymentIntent === "string") {
    return paymentIntent;
  }

  return paymentIntent.id ?? null;
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
      error
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

router.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    console.error("Missing Stripe signature header");
    return c.json({ error: "Missing signature" }, 400);
  }

  try {
    // Get raw body as pristine bytes (no middleware has consumed it now)
    const rawBody = await c.req.arrayBuffer();

    // Get Stripe instance and construct webhook event
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const event = await stripe.webhooks.constructEventAsync(
      new Uint8Array(rawBody) as any, // Zero-copy view, TS types need updating
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );

    console.log(`Received webhook: ${event.type}`);

    // Check idempotency - prevent duplicate processing
    if (await isEventProcessed({ eventId: event.id })) {
      console.log(`Event ${event.id} already processed, skipping`);
      return c.json({ received: true, message: "Already processed" });
    }

    let processed = false;

    try {
      // Handle different event types
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          await handleCheckoutPaid({
            env: c.env,
            session,
            eventId: event.id,
            eventType: event.type,
          });
          break;
        }

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

      processed = true;
      return c.json({ received: true });
    } finally {
      // Mark event as processed only after successful handling
      if (processed) {
        await markEventProcessed({ eventId: event.id, eventType: event.type });
      }
    }
  } catch (error) {
    console.error("Webhook error:", error);

    if (error instanceof Error && error.message.includes("signature")) {
      return c.json({ error: "Invalid signature" }, 400);
    }

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
    | "checkout.session.completed"
    | "checkout.session.async_payment_succeeded";
}) => {
  const { deviceId, packId, entitlement } = session.metadata || {};

  if (!deviceId) {
    console.error("Missing deviceId in checkout session metadata:", session.id);
    return;
  }

  // Delayed methods (for example some local wallets) may complete Checkout with payment_status=unpaid.
  // Fulfillment must wait for checkout.session.async_payment_succeeded in that case.
  // Fully discounted sessions can report payment_status=no_payment_required and should be fulfilled immediately.
  if (
    eventType === "checkout.session.completed" &&
    !isCheckoutSessionFulfilled(session.payment_status)
  ) {
    console.log(
      `Deferring fulfillment for ${session.id}: payment_status=${session.payment_status}`
    );
    return;
  }

  const paymentIntentId = getPaymentIntentIdFromCheckoutSession(session);

  if (entitlement === "byo_openai") {
    try {
      const result = await fulfillByoOpenAiUnlock({
        deviceId,
        entitlement: "byo_openai",
        checkoutSessionId: session.id,
        paymentIntentId,
        stripeEventId: eventId,
        stripeEventType: eventType,
      });
      if (result === "duplicate") {
        console.log(
          `Skipped duplicate BYO OpenAI fulfillment for device ${deviceId} via ${eventType}`
        );
      } else {
        console.log(
          `Granted BYO OpenAI entitlement to device ${deviceId} via ${eventType}`
        );
      }
      const { entitlements, updatedAt } =
        await markCheckoutSessionFulfilledEntitlement({
          deviceId,
          entitlement: "byo_openai",
          checkoutSessionId: session.id,
          paymentIntentId,
          stripeEventId: eventId,
          stripeEventType: eventType,
        });
      await notifyDevicePaymentEvent(env, {
        type: "entitlements.updated",
        source: "stripe_webhook",
        deviceId,
        checkoutSessionId: session.id,
        paymentIntentId,
        entitlement: "byo_openai",
        entitlements,
        updatedAt,
        stripeEventId: eventId,
        stripeEventType: eventType,
      });
    } catch (error) {
      console.error("Error granting BYO entitlement:", error);
      throw error;
    }
    return;
  }

  if (!packId) {
    console.error("Missing packId in checkout session metadata:", session.id);
    return;
  }

  if (!isValidPackId(packId)) {
    console.error("Invalid pack ID in checkout session:", packId);
    return;
  }

  try {
    const result = await fulfillCreditPackPurchase({
      deviceId,
      packId: packId as PackId,
      checkoutSessionId: session.id,
      paymentIntentId,
      stripeEventId: eventId,
      stripeEventType: eventType,
      stripePaymentStatus: session.payment_status ?? null,
    });
    if (result === "duplicate") {
      console.log(
        `Skipped duplicate credit fulfillment for ${packId} to device ${deviceId} via ${eventType}`
      );
    } else {
      console.log(
        `Successfully credited ${packId} to device ${deviceId} via ${eventType}`
      );
    }
    const { balanceAfter, updatedAt } =
      await markCheckoutSessionFulfilledCredits({
        deviceId,
        packId,
        checkoutSessionId: session.id,
        paymentIntentId,
        stripeEventId: eventId,
        stripeEventType: eventType,
      });
    await notifyDevicePaymentEvent(
      env,
      buildCreditPaymentEvent({
        deviceId,
        checkoutSessionId: session.id,
        paymentIntentId,
        packId,
        balanceAfter,
        updatedAt,
        stripeEventId: eventId,
        stripeEventType: eventType,
      })
    );
  } catch (error) {
    console.error("Error crediting device:", error);
    throw error;
  }
};

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
  const paymentIntentId = getPaymentIntentIdFromCheckoutSession(session);
  const message =
    "Stripe reported checkout.session.async_payment_failed for this session";
  console.warn(
    `Async checkout payment failed for session ${session.id} (deviceId=${deviceId ?? "unknown"}, packId=${packId ?? "none"}, entitlement=${entitlement ?? "none"})`
  );
  await markCheckoutSessionFailed({
    checkoutSessionId: session.id,
    deviceId: deviceId || null,
    paymentIntentId,
    stripeEventId: eventId,
    stripeEventType: eventType,
    errorMessage: message,
  });
  await notifyDevicePaymentEvent(env, {
    type: "checkout.failed",
    source: "stripe_webhook",
    deviceId: deviceId || null,
    checkoutSessionId: session.id,
    paymentIntentId,
    mode: entitlement === "byo_openai" ? "byo" : "credits",
    packId: packId || null,
    entitlement: entitlement || null,
    message,
    stripeEventId: eventId,
    stripeEventType: eventType,
  });
  await sendPaymentAlert(env, {
    title: "Stripe async checkout payment failed",
    severity: "critical",
    context: {
      eventId,
      eventType,
      ...checkoutSessionFailureContext(session),
    },
  });
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
  const {
    checkoutSessionId,
    entitlement,
    deviceId,
    packId,
  } = checkoutDetails;
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
          `Skipped duplicate BYO OpenAI entitlement (payment_intent) for device ${deviceId}`
        );
      } else {
        console.log(
          `Granted BYO OpenAI entitlement (payment_intent) to device ${deviceId}`
        );
      }
      const { entitlements, updatedAt } =
        await markCheckoutSessionFulfilledEntitlement({
          deviceId,
          entitlement: "byo_openai",
          checkoutSessionId,
          paymentIntentId: paymentIntent.id,
          stripeEventId: eventId,
          stripeEventType: "payment_intent.succeeded",
        });
      await notifyDevicePaymentEvent(env, {
        type: "entitlements.updated",
        source: "stripe_webhook",
        deviceId,
        checkoutSessionId,
        paymentIntentId: paymentIntent.id,
        entitlement: "byo_openai",
        entitlements,
        updatedAt,
        stripeEventId: eventId,
        stripeEventType: "payment_intent.succeeded",
      });
    } catch (error) {
      console.error("Error granting BYO entitlement from payment intent:", error);
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
          `Skipped duplicate credit fulfillment (payment_intent) for ${packId} to device ${deviceId}`
        );
      } else {
        console.log(
          `Credited ${packId} to device ${deviceId} via payment_intent.succeeded`
        );
      }
      const { balanceAfter, updatedAt } =
        await markCheckoutSessionFulfilledCredits({
          deviceId,
          packId,
          checkoutSessionId,
          paymentIntentId: paymentIntent.id,
          stripeEventId: eventId,
          stripeEventType: "payment_intent.succeeded",
        });
      await notifyDevicePaymentEvent(
        env,
        buildCreditPaymentEvent({
          deviceId,
          checkoutSessionId,
          paymentIntentId: paymentIntent.id,
          packId,
          balanceAfter,
          updatedAt,
          stripeEventId: eventId,
          stripeEventType: "payment_intent.succeeded",
        })
      );
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
  const message =
    paymentIntent.last_payment_error?.message ||
    "Stripe reported payment_intent.payment_failed";
  const failureDetails = await resolveCheckoutDetailsFromPaymentIntent({
    env,
    paymentIntent,
    logContext: "failed",
  });

  if (failureDetails.checkoutSessionStatus === "open") {
    console.info(
      `Payment attempt failed for open Checkout session ${failureDetails.checkoutSessionId}; leaving checkout recoverable.`
    );
    return;
  }

  if (
    !failureDetails.checkoutSessionId ||
    !failureDetails.checkoutSessionStatus
  ) {
    console.info(
      `Payment intent ${paymentIntent.id} failed, but no terminal Checkout session could be resolved; leaving checkout state recoverable.`
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

  if (
    isCheckoutSessionFulfilled(failureDetails.checkoutSessionPaymentStatus)
  ) {
    console.info(
      `Payment attempt failed for already-paid Checkout session ${failureDetails.checkoutSessionId}; ignoring stale failure.`
    );
    return;
  }

  const checkoutRecord = await getCheckoutSessionRecord({
    checkoutSessionId: failureDetails.checkoutSessionId,
    deviceId: failureDetails.deviceId,
  });
  if (checkoutRecord?.status === "fulfilled") {
    console.info(
      `Payment attempt failed for already-fulfilled tracked checkout ${failureDetails.checkoutSessionId}; ignoring stale failure.`
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
  await notifyDevicePaymentEvent(env, {
    type: "checkout.failed",
    source: "stripe_webhook",
    deviceId: failureDetails.deviceId,
    checkoutSessionId: failureDetails.checkoutSessionId,
    paymentIntentId: paymentIntent.id,
    mode: failureDetails.mode,
    packId: failureDetails.packId,
    entitlement: failureDetails.entitlement,
    message,
    stripeEventId: eventId,
    stripeEventType: eventType,
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
