import { Hono } from "hono";
import { creditDevice } from "../lib/db";
import { packs } from "../types/packs";

type Bindings = {
  ADMIN_DEVICE_ID: string;
  DB: D1Database;
};

const router = new Hono<{ Bindings: Bindings }>();

router.post("/reset", async (c) => {
  try {
    const body = await c.req.json<{
      deviceId: string;
      pack: keyof typeof packs;
    }>();
    const { deviceId, pack } = body;

    // Allow exactly one device (you) or future-proof by adding a token check
    if (deviceId !== c.env.ADMIN_DEVICE_ID) {
      return c.json({ error: "not-authorised" }, 403);
    }

    // Validate pack exists
    if (!packs[pack]) {
      return c.json({ error: "invalid-pack" }, 400);
    }

    await creditDevice({ deviceId, packId: pack });

    console.log(
      `Admin reset: Added ${packs[pack].credits} credits to device ${deviceId}`
    );

    return c.json({
      success: true,
      creditsAdded: packs[pack].credits,
      pack: pack,
    });
  } catch (error) {
    console.error("Admin reset error:", error);
    return c.json(
      {
        error: "reset-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;
