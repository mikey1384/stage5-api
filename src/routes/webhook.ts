import { Hono } from "hono";
import type Stripe from "stripe";
import { constructWebhookEvent } from "../lib/stripe";
import { creditDevice } from "../lib/db";
import { isValidPackId, type PackId } from "../types/packs";

const router = new Hono();

router.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    console.error("Missing Stripe signature header");
    return c.json({ error: "Missing signature" }, 400);
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("Missing STRIPE_WEBHOOK_SECRET environment variable");
    return c.json({ error: "Server configuration error" }, 500);
  }

  try {
    // Get raw body as ArrayBuffer
    const rawBody = await c.req.arrayBuffer();
    const bodyBuffer = Buffer.from(rawBody);

    // Construct and verify the webhook event
    const event = constructWebhookEvent({
      payload: bodyBuffer,
      signature,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    console.log(`Received webhook: ${event.type}`);

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
        console.log(`Unhandled event type: ${event.type}`);
    }

    return c.json({ received: true });
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
  const { deviceId, packId } = session.metadata || {};

  if (!deviceId || !packId) {
    console.error("Missing metadata in checkout session:", session.id);
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
