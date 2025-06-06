import { Hono } from "hono";
import { z } from "zod";
import { getStripe } from "../lib/stripe";
import { packs, PACK_IDS, type PackId } from "../types/packs";

type Bindings = {
  STRIPE_SECRET_KEY: string;
};

const router = new Hono<{ Bindings: Bindings }>();

const createSessionSchema = z.object({
  packId: z.enum(PACK_IDS),
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
          price: pack.stripePrice,
          quantity: 1,
        },
      ],
      success_url: `${uiOrigin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${uiOrigin}/?cancelled=1`,
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

// Get available packs
router.get("/packs", async (c) => {
  return c.json({ packs: Object.values(packs) });
});

export default router;
