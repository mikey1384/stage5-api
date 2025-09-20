import { Hono } from "hono";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe";
import {
  creditDevice,
  grantByoOpenAiEntitlement,
  isEventProcessed,
  markEventProcessed,
} from "../lib/db";
import { isValidPackId, type PackId } from "../types/packs";

type Bindings = {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
};

const router = new Hono<{ Bindings: Bindings }>();

router.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    console.error("Missing Stripe signature header");
    return c.json({ error: "Missing signature" }, 400);
  }

  try {
    // Get raw body as pristine bytes (no middleware has consumed it now)
    const rawBody = await c.req.arrayBuffer();

    // TEMP - verify webhook secret (remove after confirmation)
    console.log(
      "Using webhook secret prefix:",
      c.env.STRIPE_WEBHOOK_SECRET.slice(0, 8)
    );

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
          await handleCheckoutCompleted({ session });
          break;
        }

        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          await handlePaymentSucceeded({ paymentIntent });
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

const handleCheckoutCompleted = async ({
  session,
}: {
  session: Stripe.Checkout.Session;
}) => {
  const { deviceId, packId, entitlement } = session.metadata || {};

  if (!deviceId || !packId) {
    console.error("Missing metadata in checkout session:", session.id);
    return;
  }

  if (entitlement === "byo_openai") {
    try {
      await grantByoOpenAiEntitlement({ deviceId });
      console.log(`Granted BYO OpenAI entitlement to device ${deviceId}`);
    } catch (error) {
      console.error("Error granting BYO entitlement:", error);
      throw error;
    }
    return;
  }

  if (!isValidPackId(packId)) {
    console.error("Invalid pack ID in checkout session:", packId);
    return;
  }

  try {
    await creditDevice({ deviceId, packId: packId as PackId });
    console.log(`Successfully credited ${packId} to device ${deviceId}`);
  } catch (error) {
    console.error("Error crediting device:", error);
    throw error;
  }
};

const handlePaymentSucceeded = async ({
  paymentIntent,
}: {
  paymentIntent: Stripe.PaymentIntent;
}) => {
  console.log(`Payment succeeded: ${paymentIntent.id}`);
  const { entitlement, deviceId } = paymentIntent.metadata || {};
  if (entitlement === "byo_openai" && deviceId) {
    try {
      await grantByoOpenAiEntitlement({ deviceId });
      console.log(
        `Granted BYO OpenAI entitlement (payment_intent) to device ${deviceId}`
      );
    } catch (error) {
      console.error("Error granting BYO entitlement from payment intent:", error);
      throw error;
    }
  }
  // Additional success handling if needed
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
