import { Hono } from "hono";
import { z } from "zod";
import { getStripe } from "../lib/stripe";
import { packs, PACK_IDS } from "../types/packs";
import { getUserByApiKey } from "../lib/db";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

const STRIPE_CHECKOUT_LOCALES = [
  "auto",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "en-GB",
  "es",
  "es-419",
  "et",
  "fi",
  "fil",
  "fr",
  "fr-CA",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "ms",
  "mt",
  "nb",
  "nl",
  "pl",
  "pt",
  "pt-BR",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "th",
  "tr",
  "vi",
  "zh",
  "zh-HK",
  "zh-TW",
] as const;

type StripeCheckoutLocale = (typeof STRIPE_CHECKOUT_LOCALES)[number];

const STRIPE_CHECKOUT_LOCALE_MAP = new Map<string, StripeCheckoutLocale>(
  STRIPE_CHECKOUT_LOCALES.map(locale => [locale.toLowerCase(), locale])
);
const DEFAULT_CHECKOUT_UI_ORIGIN = "https://translator.tools";

function resolveCheckoutUiOrigin(rawOrigin: string | undefined): string {
  const normalized = String(rawOrigin || "").trim();
  const origin = normalized || DEFAULT_CHECKOUT_UI_ORIGIN;
  return origin.replace(/\/+$/, "");
}

function resolveStripeCheckoutLocale(
  rawLocale: string | undefined
): StripeCheckoutLocale {
  if (!rawLocale) return "en";

  const normalized = rawLocale.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) return "en";

  const aliases: Record<string, StripeCheckoutLocale> = {
    "en-us": "en",
    "en-ca": "en",
    "en-au": "en",
    "es-mx": "es-419",
    "pt-pt": "pt",
    "zh-cn": "zh",
    "zh-sg": "zh",
    "zh-hans": "zh",
    "zh-hant": "zh-TW",
    "zh-mo": "zh-HK",
    "fil-ph": "fil",
  };

  const alias = aliases[normalized];
  if (alias) return alias;

  const exact = STRIPE_CHECKOUT_LOCALE_MAP.get(normalized);
  if (exact) return exact;

  const base = normalized.split("-")[0];
  const baseMatch = STRIPE_CHECKOUT_LOCALE_MAP.get(base);
  return baseMatch ?? "en";
}

const createSessionSchema = z.object({
  packId: z.enum(PACK_IDS),
  deviceId: z.string().uuid("Device ID must be a valid UUID"),
  locale: z.string().trim().min(1).max(24).optional(),
});

const createByoUnlockSchema = z.object({
  deviceId: z.string().uuid("Device ID must be a valid UUID"),
  locale: z.string().trim().min(1).max(24).optional(),
});

const checkoutSessionIdSchema = z
  .string()
  .trim()
  .regex(/^cs_[a-zA-Z0-9_]+$/, "Invalid checkout session ID");

async function getAuthenticatedDeviceId(c: any): Promise<string | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  const user = await getUserByApiKey({ apiKey: token });
  return user?.device_id ?? null;
}

async function requireAuthorizedDeviceId(
  c: any,
  requestedDeviceId: string
): Promise<Response | null> {
  const authDeviceId = await getAuthenticatedDeviceId(c);
  if (!authDeviceId) {
    return c.json(
      {
        error: "Missing authorization",
        message: "Authorization header with a valid API token is required",
      },
      401
    );
  }

  if (authDeviceId !== requestedDeviceId) {
    return c.json(
      {
        error: "Forbidden",
        message: "Checkout session does not belong to this device",
      },
      403
    );
  }

  return null;
}

router.post("/create-session", async (c) => {
  try {
    const body = await c.req.json();
    const { packId, deviceId, locale } = createSessionSchema.parse(body);
    const notAuthorized = await requireAuthorizedDeviceId(c, deviceId);
    if (notAuthorized) {
      return notAuthorized;
    }

    const pack = packs[packId];
    const uiOrigin = resolveCheckoutUiOrigin(c.env.UI_ORIGIN);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const checkoutLocale = resolveStripeCheckoutLocale(locale);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true,
      locale: checkoutLocale,
      payment_method_types: ["card"],
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
    const { deviceId, locale } = createByoUnlockSchema.parse(body);
    const notAuthorized = await requireAuthorizedDeviceId(c, deviceId);
    if (notAuthorized) {
      return notAuthorized;
    }

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

    const uiOrigin = resolveCheckoutUiOrigin(c.env.UI_ORIGIN);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const checkoutLocale = resolveStripeCheckoutLocale(locale);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true,
      locale: checkoutLocale,
      payment_method_types: ["card"],
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

router.get("/session/:sessionId", async c => {
  try {
    const authDeviceId = await getAuthenticatedDeviceId(c);
    if (!authDeviceId) {
      return c.json(
        {
          error: "Missing authorization",
          message: "Authorization header with a valid API token is required",
        },
        401
      );
    }

    const parsedSessionId = checkoutSessionIdSchema.safeParse(
      c.req.param("sessionId")
    );
    if (!parsedSessionId.success) {
      return c.json(
        {
          error: "Invalid session ID",
          details: parsedSessionId.error.errors,
        },
        400
      );
    }

    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(parsedSessionId.data);

    const sessionDeviceId = session.metadata?.deviceId;
    if (!sessionDeviceId) {
      return c.json(
        {
          error: "Session metadata missing device ID",
          message: "Checkout session is not associated with a device",
        },
        404
      );
    }

    if (sessionDeviceId !== authDeviceId) {
      return c.json(
        {
          error: "Forbidden",
          message: "Session does not belong to this device",
        },
        403
      );
    }

    return c.json({
      sessionId: session.id,
      status: session.status,
      paymentStatus: session.payment_status,
      mode: session.mode,
      packId: session.metadata?.packId ?? null,
      entitlement: session.metadata?.entitlement ?? null,
      created: session.created ?? null,
    });
  } catch (error: any) {
    if (error?.type === "StripeInvalidRequestError") {
      return c.json(
        {
          error: "Checkout session not found",
          message: error?.message || "Invalid checkout session ID",
        },
        404
      );
    }

    console.error("Error retrieving checkout session:", error);
    return c.json(
      {
        error: "Failed to retrieve checkout session",
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
