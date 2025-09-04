import { Hono } from "hono";
import { z } from "zod";
import { getCredits, getLedgerEntries } from "../lib/db";
import { CREDITS_PER_AUDIO_HOUR } from "../lib/pricing";

const router = new Hono();

// Get credits for a device
router.get("/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");

  // Validate UUID format
  const uuidSchema = z.string().uuid();

  try {
    uuidSchema.parse(deviceId);
  } catch (error) {
    return c.json(
      {
        error: "Invalid device ID format",
        details: "Device ID must be a valid UUID",
      },
      400
    );
  }

  try {
    const credits = await getCredits({ deviceId });

    // Backward-compatible shape for older clients: include hoursBalance and creditsPerHour
    const perHour = CREDITS_PER_AUDIO_HOUR;

    if (!credits) {
      return c.json({
        deviceId,
        creditBalance: 0,
        hoursBalance: 0,
        creditsPerHour: perHour,
        updatedAt: null,
      });
    }

    const hoursBalance = credits.credit_balance / perHour;
    return c.json({
      deviceId: credits.device_id,
      creditBalance: credits.credit_balance,
      hoursBalance,
      creditsPerHour: perHour,
      updatedAt: credits.updated_at,
    });
  } catch (error) {
    console.error("Error fetching credits:", error);
    return c.json(
      {
        error: "Failed to fetch credits",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// Get ledger entries for a device
router.get("/:deviceId/ledger", async (c) => {
  const deviceId = c.req.param("deviceId");

  // Validate UUID format
  const uuidSchema = z.string().uuid();

  try {
    uuidSchema.parse(deviceId);
  } catch (error) {
    return c.json(
      {
        error: "Invalid device ID format",
        details: "Device ID must be a valid UUID",
      },
      400
    );
  }

  try {
    const rows = await getLedgerEntries({ deviceId });
    return c.json(rows);
  } catch (error) {
    console.error("Error fetching ledger entries:", error);
    return c.json(
      {
        error: "Failed to fetch ledger entries",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;
