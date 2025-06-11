import { Hono } from "hono";
import { creditDevice, resetCreditsToZero } from "../lib/db";
import { packs } from "../types/packs";

type Bindings = {
  ADMIN_DEVICE_ID: string;
  DB: D1Database;
};

const router = new Hono<{ Bindings: Bindings }>();

router.post("/add-credits", async (c) => {
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

    await creditDevice({ deviceId, packId: pack, isAdminReset: true });

    console.log(
      `Admin add credits: Added ${packs[pack].credits} credits to device ${deviceId}`
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
        error: "add-credits-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

router.post("/reset-to-zero", async (c) => {
  try {
    const body = await c.req.json<{
      deviceId: string;
    }>();
    const { deviceId } = body;

    // Allow exactly one device (you) or future-proof by adding a token check
    if (deviceId !== c.env.ADMIN_DEVICE_ID) {
      return c.json({ error: "not-authorised" }, 403);
    }

    await resetCreditsToZero({ deviceId });

    console.log(`Admin reset to zero: Set credits to 0 for device ${deviceId}`);

    return c.json({
      success: true,
    });
  } catch (error) {
    console.error("Admin reset to zero error:", error);
    return c.json(
      {
        error: "reset-to-zero-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;
