import { Hono } from "hono";
import { getEntitlementsRecord } from "../lib/db";
import { uuidSchema } from "../lib/schemas";
import {
  bearerAuth,
  getErrorMessage,
  type AuthVariables,
} from "../lib/middleware";
import {
  fetchRelayCapabilities,
  getCachedRelayCapabilities,
} from "../lib/relay-capabilities";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{
  Bindings: Stage5ApiBindings;
  Variables: AuthVariables;
}>();

router.use("*", bearerAuth());

router.get("/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");
  const user = c.get("user");

  try {
    uuidSchema.parse(deviceId);
  } catch {
    return c.json(
      {
        error: "Invalid device ID format",
        details: "Device ID must be a valid UUID",
      },
      400
    );
  }

  if (user.deviceId !== deviceId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const record = await getEntitlementsRecord({ deviceId });
    const byoOpenAi = Boolean(record?.byo_openai);
    const byoAnthropic = Boolean(record?.byo_anthropic) || byoOpenAi;
    const byoElevenLabs = byoOpenAi;
    let stage5AnthropicReviewAvailable = false;

    try {
      const relayCapabilities = await fetchRelayCapabilities({
        relaySecret: c.env.RELAY_SECRET,
        workerAnthropicAvailable: Boolean(c.env.ANTHROPIC_API_KEY),
      });
      stage5AnthropicReviewAvailable =
        relayCapabilities.stage5AnthropicReviewAvailable;
    } catch (error) {
      const cachedRelayCapabilities = getCachedRelayCapabilities();
      if (cachedRelayCapabilities) {
        stage5AnthropicReviewAvailable =
          cachedRelayCapabilities.stage5AnthropicReviewAvailable;
      }
      console.warn(
        "[entitlements] Failed to fetch relay capabilities:",
        getErrorMessage(error),
      );
    }

    return c.json({
      deviceId,
      entitlements: { byoOpenAi, byoAnthropic, byoElevenLabs },
      capabilities: {
        stage5AnthropicReviewAvailable,
      },
      unlockedAt: record?.unlocked_at ?? null,
      updatedAt: record?.updated_at ?? null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching entitlements:", error);
    return c.json(
      {
        error: "Failed to fetch entitlements",
        message: getErrorMessage(error),
      },
      500
    );
  }
});

export default router;
