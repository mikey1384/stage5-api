import { Hono } from "hono";
import { z } from "zod";
import { getEntitlementsRecord } from "../lib/db";

const uuidSchema = z.string().uuid();

type Variables = {
  authDeviceId: string;
};

const router = new Hono<{ Variables: Variables }>();

router.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    uuidSchema.parse(token);
  } catch {
    return c.json({ error: "Invalid Authorization token" }, 400);
  }

  c.set("authDeviceId", token);
  await next();
});

router.get("/:deviceId", async c => {
  const deviceId = c.req.param("deviceId");

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

  const authDeviceId = c.get("authDeviceId");
  if (authDeviceId !== deviceId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const record = await getEntitlementsRecord({ deviceId });
    const byoOpenAi = Boolean(record?.byo_openai);

    return c.json({
      deviceId,
      entitlements: { byoOpenAi },
      unlockedAt: record?.unlocked_at ?? null,
      updatedAt: record?.updated_at ?? null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching entitlements:", error);
    return c.json(
      {
        error: "Failed to fetch entitlements",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;
