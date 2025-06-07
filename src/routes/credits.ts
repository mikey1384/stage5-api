import { Hono } from "hono";
import { z } from "zod";
import { getCredits, deductCredits } from "../lib/db";
import { CREDITS_PER_HOUR } from "../types/packs";

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

    if (!credits) {
      return c.json({
        deviceId,
        creditBalance: 0,
        hoursBalance: 0,
        creditsPerHour: CREDITS_PER_HOUR,
        updatedAt: null,
      });
    }

    const hoursBalance = credits.credit_balance / CREDITS_PER_HOUR;

    return c.json({
      deviceId: credits.device_id,
      creditBalance: credits.credit_balance,
      hoursBalance: hoursBalance,
      creditsPerHour: CREDITS_PER_HOUR,
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

// Deduct credits (for internal use by translation service)
const deductCreditsSchema = z.object({
  transcriptionMinutes: z.number().min(0),
  translationInputTokens: z.number().min(0),
  translationOutputTokens: z.number().min(0),
  reason: z.string().optional(),
});

router.post("/:deviceId/deduct", async (c) => {
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
    const body = await c.req.json();
    const {
      transcriptionMinutes,
      translationInputTokens,
      translationOutputTokens,
      reason,
    } = deductCreditsSchema.parse(body);

    const success = await deductCredits({
      deviceId,
      transcriptionMinutes,
      translationInputTokens,
      translationOutputTokens,
    });

    if (!success) {
      return c.json(
        {
          error: "Insufficient credits",
          message: "Failed to deduct credits. Check available balance.",
        },
        402 // Payment Required
      );
    }

    console.log(
      `Deducted credits from device ${deviceId}${
        reason ? ` for ${reason}` : ""
      }`
    );

    // Return updated credits
    const updatedCredits = await getCredits({ deviceId });

    return c.json({
      success: true,
      newBalance: updatedCredits?.credit_balance || 0,
      reason,
    });
  } catch (error) {
    console.error("Error deducting credits:", error);

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
        error: "Failed to deduct credits",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;
