import { Hono } from "hono";
import { getEntitlementsRecord } from "../lib/db";
import { uuidSchema } from "../lib/schemas";
import {
  bearerAuth,
  getErrorMessage,
  type AuthVariables,
} from "../lib/middleware";

const router = new Hono<{ Variables: AuthVariables }>();

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

    return c.json({
      deviceId,
      entitlements: { byoOpenAi, byoAnthropic, byoElevenLabs },
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
