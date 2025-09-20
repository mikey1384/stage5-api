import { Hono } from "hono";
import { z } from "zod";
import { getStripe } from "../lib/stripe";
import { packs, PACK_IDS } from "../types/packs";

type Bindings = {
  STRIPE_SECRET_KEY: string;
  STRIPE_BYO_UNLOCK_PRICE_ID?: string;
};

const router = new Hono<{ Bindings: Bindings }>();

const createSessionSchema = z.object({
  packId: z.enum(PACK_IDS),
  deviceId: z.string().uuid("Device ID must be a valid UUID"),
});

const createByoUnlockSchema = z.object({
  deviceId: z.string().uuid("Device ID must be a valid UUID"),
});

router.post("/create-session", async (c) => {
  try {
    const body = await c.req.json();
    const { packId, deviceId } = createSessionSchema.parse(body);

    const pack = packs[packId];
    const uiOrigin = "https://stage5.tools";
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: pack.priceId,
          quantity: 1,
        },
      ],
      success_url: `${uiOrigin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${uiOrigin}/checkout/cancelled`,
      metadata: {
        deviceId,
        packId,
        credits: pack.credits.toString(),
      },
      customer_creation: "if_required",
      payment_intent_data: {
        metadata: {
          deviceId,
          packId,
          credits: pack.credits.toString(),
        },
      },
    });

    if (!session.url) {
      throw new Error("Failed to create checkout session");
    }

    return c.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error("Error creating checkout session:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid request data",
          details: error.errors,
        },
        400
      );
    }

    return c.json(
      {
        error: "Failed to create checkout session",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

router.post("/create-byo-unlock", async c => {
  try {
    const body = await c.req.json();
    const { deviceId } = createByoUnlockSchema.parse(body);

    const priceId = c.env.STRIPE_BYO_UNLOCK_PRICE_ID;
    if (!priceId) {
      console.error(
        "STRIPE_BYO_UNLOCK_PRICE_ID is not configured; cannot create BYO checkout"
      );
      return c.json(
        {
          error: "BYO unlock is not available",
          message: "Missing Stripe price configuration",
        },
        500
      );
    }

    const uiOrigin = "https://stage5.tools";
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${uiOrigin}/checkout/success?mode=byo&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${uiOrigin}/checkout/cancelled?mode=byo`,
      metadata: {
        deviceId,
        entitlement: "byo_openai",
      },
      payment_intent_data: {
        metadata: {
          deviceId,
          entitlement: "byo_openai",
        },
      },
    });

    if (!session.url) {
      throw new Error("Failed to create BYO unlock session");
    }

    return c.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error("Error creating BYO unlock session:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid request data",
          details: error.errors,
        },
        400
      );
    }

    return c.json(
      {
        error: "Failed to create BYO unlock session",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// Get available packs
router.get("/packs", async (c) => {
  return c.json({ packs });
});

export default router;
