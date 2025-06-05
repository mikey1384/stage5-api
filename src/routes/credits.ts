import { Hono } from "hono";
import { z } from "zod";
import { getCredits, deductCredits } from "../lib/db";

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
        minutesRemaining: 0,
        hasCredits: false,
        updatedAt: null,
      });
    }

    return c.json({
      deviceId: credits.device_id,
      minutesRemaining: credits.minutes_remaining,
      hasCredits: credits.minutes_remaining > 0,
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
  minutes: z.number().min(1).max(1440), // Max 24 hours per request
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
    const { minutes, reason } = deductCreditsSchema.parse(body);

    const success = await deductCredits({ deviceId, minutes });

    if (!success) {
      return c.json(
        {
          error: "Insufficient credits",
          message: `Cannot deduct ${minutes} minutes. Check available credits.`,
        },
        402
      ); // Payment Required
    }

    console.log(
      `Deducted ${minutes} minutes from device ${deviceId}${
        reason ? ` (${reason})` : ""
      }`
    );

    // Return updated credits
    const updatedCredits = await getCredits({ deviceId });

    return c.json({
      success: true,
      deductedMinutes: minutes,
      remainingMinutes: updatedCredits?.minutes_remaining || 0,
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
