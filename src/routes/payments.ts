import { Hono } from "hono";
import { z } from "zod";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe";
import { packs, PACK_IDS, type PackId } from "../types/packs";
import {
  getCheckoutSessionRecord,
  getCheckoutSessionRecordByReturnId,
  getUserByApiKey,
  markCheckoutSessionCancelled,
  markEventProcessedIfNew,
  recordCheckoutSessionCreated,
} from "../lib/db";
import {
  checkoutSessionFailureContext,
  sendPaymentAlert,
} from "../lib/payment-alerts";
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
  STRIPE_CHECKOUT_LOCALES.map((locale) => [locale.toLowerCase(), locale]),
);
const DEFAULT_CHECKOUT_UI_ORIGIN = "https://translator.tools";
const BYO_UNLOCK_KRW_AMOUNT = 15_422;
const BYO_UNLOCK_PRODUCT_NAME = "BYO API Keys Unlock";
const KOREAN_CHECKOUT_PAYMENT_METHOD_TYPES: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
  ["card", "kr_card", "kakao_pay", "naver_pay"];

function shouldUseKoreanReliableCheckout(
  checkoutCountry: string | null,
): boolean {
  return checkoutCountry === "KR";
}

function buildCheckoutPaymentMethodTypes(
  checkoutCountry: string | null,
): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] | undefined {
  if (!shouldUseKoreanReliableCheckout(checkoutCountry)) return undefined;

  // Dynamic methods did not reliably surface KR local rails in live Checkout.
  // Keep KR wallets explicit, but use the normal card rail for international cards.
  return [...KOREAN_CHECKOUT_PAYMENT_METHOD_TYPES];
}

function buildCreditLineItem(
  packId: PackId,
  checkoutCountry: string | null,
): Stripe.Checkout.SessionCreateParams.LineItem {
  const pack = packs[packId];

  if (shouldUseKoreanReliableCheckout(checkoutCountry)) {
    return {
      price_data: {
        currency: "krw",
        unit_amount: pack.krw,
        product_data: {
          name: `${packId} - ${pack.credits.toLocaleString("en-US")} AI Credits`,
        },
      },
      quantity: 1,
    };
  }

  return {
    price: pack.priceId,
    quantity: 1,
  };
}

function buildByoUnlockLineItem(
  priceId: string | undefined,
  checkoutCountry: string | null,
): Stripe.Checkout.SessionCreateParams.LineItem {
  if (shouldUseKoreanReliableCheckout(checkoutCountry)) {
    return {
      price_data: {
        currency: "krw",
        unit_amount: BYO_UNLOCK_KRW_AMOUNT,
        product_data: {
          name: BYO_UNLOCK_PRODUCT_NAME,
        },
      },
      quantity: 1,
    };
  }

  if (!priceId) {
    throw new Error("Missing Stripe BYO unlock price configuration");
  }

  return {
    price: priceId,
    quantity: 1,
  };
}

function resolveCheckoutCountry(
  rawCountry: string | undefined,
  requestCountry: string | null,
  rawLocale: string | undefined,
): string | null {
  const normalizedLocale = String(rawLocale || "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();

  // Korean UI locale is the product signal for the KR reliable-payment route.
  // Machine/IP regions can be TH/US/etc. while the user still needs Korean rails.
  if (normalizedLocale === "ko" || normalizedLocale.startsWith("ko-")) {
    return "KR";
  }

  const candidates = [requestCountry, rawCountry];

  for (const candidate of candidates) {
    const normalized = String(candidate || "")
      .trim()
      .toUpperCase();
    if (/^[A-Z]{2}$/.test(normalized)) {
      return normalized;
    }
  }

  return null;
}

function getRequestCountry(c: any): string | null {
  const cfCountry = (c.req.raw?.cf as { country?: string | null } | undefined)
    ?.country;
  if (typeof cfCountry === "string" && cfCountry.trim().length > 0) {
    return cfCountry;
  }

  const headerCountry = c.req.header("CF-IPCountry");
  return typeof headerCountry === "string" && headerCountry.trim().length > 0
    ? headerCountry
    : null;
}

function resolveCheckoutUiOrigin(rawOrigin: string | undefined): string {
  const normalized = String(rawOrigin || "").trim();
  const origin = normalized || DEFAULT_CHECKOUT_UI_ORIGIN;
  return origin.replace(/\/+$/, "");
}

function createCheckoutReturnId(): string {
  return crypto.randomUUID();
}

function buildCheckoutReturnPageUrl({
  uiOrigin,
  status,
  mode,
  checkoutReturnId,
  includeCheckoutSessionPlaceholder,
}: {
  uiOrigin: string;
  status: "success" | "cancelled";
  mode?: "byo" | null;
  checkoutReturnId: string;
  includeCheckoutSessionPlaceholder?: boolean;
}): string {
  const url = new URL(`/checkout/${status}`, uiOrigin);
  if (mode === "byo") {
    url.searchParams.set("mode", "byo");
  }
  url.searchParams.set("return_id", checkoutReturnId);

  const base = url.toString();
  if (!includeCheckoutSessionPlaceholder) {
    return base;
  }

  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}session_id={CHECKOUT_SESSION_ID}`;
}

function resolveStripeCheckoutLocale(
  rawLocale: string | undefined,
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
  country: z.string().trim().min(2).max(2).optional(),
});

const createByoUnlockSchema = z.object({
  deviceId: z.string().uuid("Device ID must be a valid UUID"),
  locale: z.string().trim().min(1).max(24).optional(),
  country: z.string().trim().min(2).max(2).optional(),
});

const checkoutSessionIdSchema = z
  .string()
  .trim()
  .regex(/^cs_[a-zA-Z0-9_]+$/, "Invalid checkout session ID");
const checkoutReturnIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid checkout return ID");
const deviceIdParamSchema = z.string().uuid("Device ID must be a valid UUID");

const checkoutClientEventTypes = [
  "embedded_cancel_redirect",
  "embedded_load_failure",
  "embedded_manual_close_unpaid",
  "embedded_manual_close_pending_timeout",
  "external_settlement_cancelled",
  "external_settlement_pending_timeout",
  "external_reconciliation_failed",
  "open_external_failed",
] as const;

const checkoutClientEventSchema = z.object({
  sessionId: checkoutSessionIdSchema,
  eventType: z.enum(checkoutClientEventTypes),
  mode: z.enum(["credits", "byo"]).optional(),
  packId: z.enum(PACK_IDS).optional(),
  entitlement: z.string().trim().max(64).optional(),
  message: z.string().trim().max(500).optional(),
});

function isTerminalCheckoutClientCancellation(
  eventType: (typeof checkoutClientEventTypes)[number],
): boolean {
  return (
    eventType === "embedded_cancel_redirect" ||
    eventType === "embedded_load_failure" ||
    eventType === "embedded_manual_close_unpaid" ||
    eventType === "external_settlement_cancelled" ||
    eventType === "open_external_failed"
  );
}

async function recordCheckoutSessionCreatedOrThrow(
  c: any,
  {
    alertTitle,
    alertContext,
    ...record
  }: {
    alertTitle: string;
    alertContext: Record<string, unknown>;
    checkoutSessionId: string;
    checkoutReturnId?: string | null;
    deviceId: string;
    kind: "credits" | "entitlement";
    packId?: string | null;
    entitlement?: string | null;
    creditsDelta?: number | null;
  },
): Promise<void> {
  try {
    await recordCheckoutSessionCreated(record);
  } catch (error) {
    console.error("Failed to persist checkout session record:", error);
    await sendPaymentAlert(c.env, {
      title: alertTitle,
      severity: "critical",
      context: {
        ...alertContext,
        checkoutSessionId: record.checkoutSessionId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

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
  requestedDeviceId: string,
): Promise<Response | null> {
  const authDeviceId = await getAuthenticatedDeviceId(c);
  if (!authDeviceId) {
    return c.json(
      {
        error: "Missing authorization",
        message: "Authorization header with a valid API token is required",
      },
      401,
    );
  }

  if (authDeviceId !== requestedDeviceId) {
    return c.json(
      {
        error: "Forbidden",
        message: "Checkout session does not belong to this device",
      },
      403,
    );
  }

  return null;
}

function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === "SyntaxError")
  );
}

router.post("/create-session", async (c) => {
  let alertContext: Record<string, unknown> = {
    route: "/payments/create-session",
  };
  try {
    const body = await c.req.json();
    const { packId, deviceId, locale, country } =
      createSessionSchema.parse(body);
    const checkoutCountry = resolveCheckoutCountry(
      country,
      getRequestCountry(c),
      locale,
    );
    alertContext = {
      route: "/payments/create-session",
      packId,
      deviceId,
      locale,
      country: checkoutCountry,
    };
    const notAuthorized = await requireAuthorizedDeviceId(c, deviceId);
    if (notAuthorized) {
      return notAuthorized;
    }

    const pack = packs[packId];
    const uiOrigin = resolveCheckoutUiOrigin(c.env.UI_ORIGIN);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const checkoutLocale = resolveStripeCheckoutLocale(locale);
    const paymentMethodTypes = buildCheckoutPaymentMethodTypes(checkoutCountry);
    const checkoutReturnId = createCheckoutReturnId();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true,
      locale: checkoutLocale,
      ...(paymentMethodTypes
        ? { payment_method_types: paymentMethodTypes }
        : {}),
      line_items: [buildCreditLineItem(packId, checkoutCountry)],
      success_url: buildCheckoutReturnPageUrl({
        uiOrigin,
        status: "success",
        checkoutReturnId,
        includeCheckoutSessionPlaceholder: true,
      }),
      cancel_url: buildCheckoutReturnPageUrl({
        uiOrigin,
        status: "cancelled",
        checkoutReturnId,
      }),
      metadata: {
        deviceId,
        packId,
        credits: pack.credits.toString(),
        checkoutReturnId,
      },
      customer_creation: "if_required",
      payment_intent_data: {
        metadata: {
          deviceId,
          packId,
          credits: pack.credits.toString(),
          checkoutReturnId,
        },
      },
    });

    if (!session.url) {
      throw new Error("Failed to create checkout session");
    }

    await recordCheckoutSessionCreatedOrThrow(c, {
      alertTitle: "Checkout tracking write failed",
      alertContext,
      checkoutSessionId: session.id,
      checkoutReturnId,
      deviceId,
      kind: "credits",
      packId,
      creditsDelta: pack.credits,
    });

    return c.json({
      url: session.url,
      sessionId: session.id,
      returnId: checkoutReturnId,
    });
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json(
        {
          error: "Invalid JSON body",
          message: "Request body must be valid JSON",
        },
        400,
      );
    }

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid request data",
          details: error.errors,
        },
        400,
      );
    }

    console.error("Error creating checkout session:", error);

    await sendPaymentAlert(c.env, {
      title: "Checkout session creation failed",
      severity: "critical",
      context: {
        ...alertContext,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });

    return c.json(
      {
        error: "Failed to create checkout session",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

router.post("/create-byo-unlock", async (c) => {
  let alertContext: Record<string, unknown> = {
    route: "/payments/create-byo-unlock",
  };
  try {
    const body = await c.req.json();
    const { deviceId, locale, country } = createByoUnlockSchema.parse(body);
    const checkoutCountry = resolveCheckoutCountry(
      country,
      getRequestCountry(c),
      locale,
    );
    alertContext = {
      route: "/payments/create-byo-unlock",
      deviceId,
      locale,
      country: checkoutCountry,
      entitlement: "byo_openai",
    };
    const notAuthorized = await requireAuthorizedDeviceId(c, deviceId);
    if (notAuthorized) {
      return notAuthorized;
    }

    const priceId = c.env.STRIPE_BYO_UNLOCK_PRICE_ID;
    if (!priceId && !shouldUseKoreanReliableCheckout(checkoutCountry)) {
      console.error(
        "STRIPE_BYO_UNLOCK_PRICE_ID is not configured; cannot create BYO checkout",
      );
      await sendPaymentAlert(c.env, {
        title: "BYO checkout price is not configured",
        severity: "critical",
        context: alertContext,
      });
      return c.json(
        {
          error: "BYO unlock is not available",
          message: "Missing Stripe price configuration",
        },
        500,
      );
    }

    const uiOrigin = resolveCheckoutUiOrigin(c.env.UI_ORIGIN);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const checkoutLocale = resolveStripeCheckoutLocale(locale);
    const paymentMethodTypes = buildCheckoutPaymentMethodTypes(checkoutCountry);
    const checkoutReturnId = createCheckoutReturnId();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true,
      locale: checkoutLocale,
      ...(paymentMethodTypes
        ? { payment_method_types: paymentMethodTypes }
        : {}),
      line_items: [buildByoUnlockLineItem(priceId, checkoutCountry)],
      success_url: buildCheckoutReturnPageUrl({
        uiOrigin,
        status: "success",
        mode: "byo",
        checkoutReturnId,
        includeCheckoutSessionPlaceholder: true,
      }),
      cancel_url: buildCheckoutReturnPageUrl({
        uiOrigin,
        status: "cancelled",
        mode: "byo",
        checkoutReturnId,
      }),
      metadata: {
        deviceId,
        entitlement: "byo_openai",
        checkoutReturnId,
      },
      payment_intent_data: {
        metadata: {
          deviceId,
          entitlement: "byo_openai",
          checkoutReturnId,
        },
      },
    });

    if (!session.url) {
      throw new Error("Failed to create BYO unlock session");
    }

    await recordCheckoutSessionCreatedOrThrow(c, {
      alertTitle: "BYO checkout tracking write failed",
      alertContext,
      checkoutSessionId: session.id,
      checkoutReturnId,
      deviceId,
      kind: "entitlement",
      entitlement: "byo_openai",
    });

    return c.json({
      url: session.url,
      sessionId: session.id,
      returnId: checkoutReturnId,
    });
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json(
        {
          error: "Invalid JSON body",
          message: "Request body must be valid JSON",
        },
        400,
      );
    }

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid request data",
          details: error.errors,
        },
        400,
      );
    }

    console.error("Error creating BYO unlock session:", error);

    await sendPaymentAlert(c.env, {
      title: "BYO checkout session creation failed",
      severity: "critical",
      context: {
        ...alertContext,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });

    return c.json(
      {
        error: "Failed to create BYO unlock session",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

router.post("/checkout-event", async (c) => {
  try {
    const authDeviceId = await getAuthenticatedDeviceId(c);
    if (!authDeviceId) {
      return c.json(
        {
          error: "Missing authorization",
          message: "Authorization header with a valid API token is required",
        },
        401,
      );
    }

    const body = await c.req.json();
    const event = checkoutClientEventSchema.parse(body);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(event.sessionId);

    const sessionDeviceId = session.metadata?.deviceId;
    if (!sessionDeviceId) {
      return c.json(
        {
          error: "Session metadata missing device ID",
          message: "Checkout session is not associated with a device",
        },
        404,
      );
    }

    if (sessionDeviceId !== authDeviceId) {
      return c.json(
        {
          error: "Forbidden",
          message: "Session does not belong to this device",
        },
        403,
      );
    }

    const dedupeKey = `checkout-client-event:${event.sessionId}:${event.eventType}`;
    if (isTerminalCheckoutClientCancellation(event.eventType)) {
      await markCheckoutSessionCancelled({
        checkoutSessionId: event.sessionId,
        deviceId: authDeviceId,
        stripeEventId: dedupeKey,
        stripeEventType: `checkout_client.${event.eventType}`,
        errorMessage: event.message || `Translator reported ${event.eventType}`,
      });
    }

    const isNewAlertEvent = await markEventProcessedIfNew({
      eventId: dedupeKey,
      eventType: `checkout_client.${event.eventType}`,
    });
    if (!isNewAlertEvent) {
      return c.json({ ok: true, duplicate: true });
    }

    await sendPaymentAlert(c.env, {
      title: `Translator checkout client event: ${event.eventType}`,
      severity:
        event.eventType === "external_settlement_pending_timeout" ||
        event.eventType === "external_reconciliation_failed" ||
        event.eventType === "embedded_load_failure"
          ? "critical"
          : "warning",
      context: {
        eventType: event.eventType,
        clientMode: event.mode,
        clientPackId: event.packId,
        clientEntitlement: event.entitlement,
        clientMessage: event.message,
        clientAppVersion: c.req.header("X-Stage5-App-Version") ?? undefined,
        ...checkoutSessionFailureContext(session),
      },
    });

    return c.json({ ok: true });
  } catch (error: any) {
    console.error("Error recording checkout client event:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid request data",
          details: error.errors,
        },
        400,
      );
    }

    if (error?.type === "StripeInvalidRequestError") {
      return c.json(
        {
          error: "Checkout session not found",
          message: error?.message || "Invalid checkout session ID",
        },
        404,
      );
    }

    return c.json(
      {
        error: "Failed to record checkout client event",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

router.get("/checkout-return/:returnId", async (c) => {
  try {
    const authDeviceId = await getAuthenticatedDeviceId(c);
    if (!authDeviceId) {
      return c.json(
        {
          error: "Missing authorization",
          message: "Authorization header with a valid API token is required",
        },
        401,
      );
    }

    const parsedReturnId = checkoutReturnIdSchema.safeParse(
      c.req.param("returnId"),
    );
    if (!parsedReturnId.success) {
      return c.json(
        {
          error: "Invalid checkout return ID",
          details: parsedReturnId.error.errors,
        },
        400,
      );
    }

    const localCheckout = await getCheckoutSessionRecordByReturnId({
      checkoutReturnId: parsedReturnId.data,
      deviceId: authDeviceId,
    });
    if (!localCheckout) {
      return c.json(
        {
          error: "Checkout return not found",
          message: "Checkout return ID is not associated with this device",
        },
        404,
      );
    }

    return c.json({
      sessionId: localCheckout.checkout_session_id,
      mode: localCheckout.kind === "entitlement" ? "byo" : "credits",
      fulfillmentStatus: localCheckout.status,
      packId: localCheckout.pack_id,
      entitlement: localCheckout.entitlement,
    });
  } catch (error) {
    console.error("Error resolving checkout return:", error);

    return c.json(
      {
        error: "Failed to resolve checkout return",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

router.get("/events/:deviceId", async (c) => {
  const parsedDeviceId = deviceIdParamSchema.safeParse(c.req.param("deviceId"));
  if (!parsedDeviceId.success) {
    return c.json(
      {
        error: "Invalid device ID",
        details: parsedDeviceId.error.errors,
      },
      400,
    );
  }

  const notAuthorized = await requireAuthorizedDeviceId(c, parsedDeviceId.data);
  if (notAuthorized) {
    return notAuthorized;
  }

  if (!c.env.PAYMENT_EVENTS) {
    return c.json(
      {
        error: "Payment event stream unavailable",
        message: "Server push is not configured for this environment",
      },
      503,
    );
  }

  const id = c.env.PAYMENT_EVENTS.idFromName(parsedDeviceId.data);
  const stub = c.env.PAYMENT_EVENTS.get(id);
  return stub.fetch("https://payment-events/stream", {
    headers: {
      accept: "text/event-stream",
    },
  });
});

router.get("/session/:sessionId", async (c) => {
  try {
    const authDeviceId = await getAuthenticatedDeviceId(c);
    if (!authDeviceId) {
      return c.json(
        {
          error: "Missing authorization",
          message: "Authorization header with a valid API token is required",
        },
        401,
      );
    }

    const parsedSessionId = checkoutSessionIdSchema.safeParse(
      c.req.param("sessionId"),
    );
    if (!parsedSessionId.success) {
      return c.json(
        {
          error: "Invalid session ID",
          details: parsedSessionId.error.errors,
        },
        400,
      );
    }

    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(
      parsedSessionId.data,
    );

    const sessionDeviceId = session.metadata?.deviceId;
    if (!sessionDeviceId) {
      return c.json(
        {
          error: "Session metadata missing device ID",
          message: "Checkout session is not associated with a device",
        },
        404,
      );
    }

    if (sessionDeviceId !== authDeviceId) {
      return c.json(
        {
          error: "Forbidden",
          message: "Session does not belong to this device",
        },
        403,
      );
    }

    const localCheckout = await getCheckoutSessionRecord({
      checkoutSessionId: session.id,
      deviceId: authDeviceId,
    });

    return c.json({
      sessionId: session.id,
      status: session.status,
      paymentStatus: session.payment_status,
      mode: session.mode,
      packId: session.metadata?.packId ?? null,
      entitlement: session.metadata?.entitlement ?? null,
      created: session.created ?? null,
      fulfillmentStatus: localCheckout?.status ?? null,
      balanceAfter: localCheckout?.credit_balance_after ?? null,
      entitlements:
        localCheckout?.entitlements_json &&
        localCheckout.entitlements_json.trim()
          ? JSON.parse(localCheckout.entitlements_json)
          : null,
    });
  } catch (error: any) {
    if (error?.type === "StripeInvalidRequestError") {
      return c.json(
        {
          error: "Checkout session not found",
          message: error?.message || "Invalid checkout session ID",
        },
        404,
      );
    }

    console.error("Error retrieving checkout session:", error);
    return c.json(
      {
        error: "Failed to retrieve checkout session",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get available packs
router.get("/packs", async (c) => {
  return c.json({ packs });
});

export default router;
