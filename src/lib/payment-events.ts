import { CREDITS_PER_AUDIO_HOUR } from "./pricing";
import type { Stage5ApiBindings } from "../types/env";

export type PaymentRealtimeEvent =
  | {
      type: "credits.updated";
      source: "stripe_webhook";
      deviceId: string;
      checkoutSessionId?: string | null;
      paymentIntentId?: string | null;
      packId?: string | null;
      balanceAfter: number;
      creditsPerHour: number;
      hoursBalance: number;
      updatedAt?: string | null;
      stripeEventId?: string | null;
      stripeEventType: string;
    }
  | {
      type: "entitlements.updated";
      source: "stripe_webhook";
      deviceId: string;
      checkoutSessionId?: string | null;
      paymentIntentId?: string | null;
      entitlement: "byo_openai";
      entitlements: {
        byoOpenAi: boolean;
        byoAnthropic: boolean;
        byoElevenLabs: boolean;
      };
      updatedAt?: string | null;
      stripeEventId?: string | null;
      stripeEventType: string;
    }
  | {
      type: "checkout.failed";
      source: "stripe_webhook";
      deviceId?: string | null;
      checkoutSessionId?: string | null;
      paymentIntentId?: string | null;
      mode?: "credits" | "byo" | null;
      packId?: string | null;
      entitlement?: string | null;
      message?: string | null;
      stripeEventId?: string | null;
      stripeEventType: string;
    };

export function buildCreditPaymentEvent({
  deviceId,
  checkoutSessionId,
  paymentIntentId,
  packId,
  balanceAfter,
  updatedAt,
  stripeEventId,
  stripeEventType,
}: {
  deviceId: string;
  checkoutSessionId?: string | null;
  paymentIntentId?: string | null;
  packId?: string | null;
  balanceAfter: number;
  updatedAt?: string | null;
  stripeEventId?: string | null;
  stripeEventType: string;
}): PaymentRealtimeEvent {
  return {
    type: "credits.updated",
    source: "stripe_webhook",
    deviceId,
    checkoutSessionId,
    paymentIntentId,
    packId,
    balanceAfter,
    creditsPerHour: CREDITS_PER_AUDIO_HOUR,
    hoursBalance: balanceAfter / CREDITS_PER_AUDIO_HOUR,
    updatedAt,
    stripeEventId,
    stripeEventType,
  };
}

export async function notifyDevicePaymentEvent(
  env: Stage5ApiBindings,
  event: PaymentRealtimeEvent
): Promise<void> {
  const deviceId = event.deviceId;
  if (!deviceId || !env.PAYMENT_EVENTS) {
    return;
  }

  try {
    const id = env.PAYMENT_EVENTS.idFromName(deviceId);
    const stub = env.PAYMENT_EVENTS.get(id);
    const response = await stub.fetch("https://payment-events/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      console.warn(
        `[payment-events] Broadcast failed for ${deviceId}: ${response.status}`
      );
    }
  } catch (error) {
    console.warn("[payment-events] Broadcast failed:", error);
  }
}
