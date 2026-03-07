import { Hono } from "hono";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe";
import {
  fulfillByoOpenAiUnlock,
  fulfillCreditPackPurchase,
  isEventProcessed,
  markEventProcessed,
} from "../lib/db";
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
            session,
            eventId: event.id,
            eventType: event.type,
          });
          break;
        }

        case "checkout.session.async_payment_succeeded": {
          const session = event.data.object as Stripe.Checkout.Session;
          await handleCheckoutPaid({
            session,
            eventId: event.id,
            eventType: event.type,
          });
          break;
        }

        case "checkout.session.async_payment_failed": {
          const session = event.data.object as Stripe.Checkout.Session;
          await handleCheckoutAsyncPaymentFailed({ session });
          break;
        }

        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          await handlePaymentSucceeded({ paymentIntent, eventId: event.id });
          break;
        }

        case "payment_intent.payment_failed": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          await handlePaymentFailed({ paymentIntent });
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
  eventId,
  session,
  eventType,
}: {
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
  } catch (error) {
    console.error("Error crediting device:", error);
    throw error;
  }
};

const handleCheckoutAsyncPaymentFailed = async ({
  session,
}: {
  session: Stripe.Checkout.Session;
}) => {
  const { deviceId, packId, entitlement } = session.metadata || {};
  console.warn(
    `Async checkout payment failed for session ${session.id} (deviceId=${deviceId ?? "unknown"}, packId=${packId ?? "none"}, entitlement=${entitlement ?? "none"})`
  );
};

const handlePaymentSucceeded = async ({
  eventId,
  paymentIntent,
}: {
  eventId: string;
  paymentIntent: Stripe.PaymentIntent;
}) => {
  console.log(`Payment succeeded: ${paymentIntent.id}`);
  const { entitlement, deviceId, packId } = paymentIntent.metadata || {};
  if (entitlement === "byo_openai" && deviceId) {
    try {
      const result = await fulfillByoOpenAiUnlock({
        deviceId,
        entitlement: "byo_openai",
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
    } catch (error) {
      console.error("Error crediting device from payment intent:", error);
      throw error;
    }
  }
};

const handlePaymentFailed = async ({
  paymentIntent,
}: {
  paymentIntent: Stripe.PaymentIntent;
}) => {
  console.log(`Payment failed: ${paymentIntent.id}`);
  // Handle failed payments if needed
};

export default router;
