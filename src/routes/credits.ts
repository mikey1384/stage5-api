import { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  CreditTransferError,
  createTransferCode,
  getCredits,
  getLedgerEntries,
  grantWelcomeCredits,
  redeemTransferCode,
} from "../lib/db";
import { CREDITS_PER_AUDIO_HOUR } from "../lib/pricing";
import { uuidSchema } from "../lib/schemas";
import { bearerAuth, getErrorMessage, type AuthVariables } from "../lib/middleware";

const router = new Hono<{ Variables: AuthVariables }>();

// The welcome grant is capped per client IP; only a truncated hash is stored.
function clientIpHash(ip: string | undefined): string | null {
  const value = String(ip || "").trim();
  if (!value) return null;
  return createHash("sha256").update(`welcome:${value}`).digest("hex").slice(0, 16);
}

router.use("*", bearerAuth());

// Get credits for a device
router.get("/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");
  const user = c.get("user");

  // Validate UUID format
  const parsed = uuidSchema.safeParse(deviceId);
  if (!parsed.success) {
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
    // A device that has never had credits gets its one-time welcome grant here,
    // on the balance check every client makes at launch.
    const credits =
      (await getCredits({ deviceId })) ??
      (await grantWelcomeCredits({
        deviceId,
        ipHash: clientIpHash(c.req.header("CF-Connecting-IP")),
      }));

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
        message: getErrorMessage(error),
      },
      500
    );
  }
});

// Moving purchased credits to another computer: the old device asks for a
// one-time code, the new device redeems it. See lib/db/credit-transfers.ts.
const TRANSFER_MESSAGES: Record<string, { status: 400 | 409 | 429; message: string }> = {
  nothing_to_transfer: { status: 409, message: "There are no purchased credits or unlocks on this device to move." },
  too_many_codes: { status: 429, message: "Too many transfer codes this hour. Try again later." },
  jobs_running: { status: 409, message: "A transcription or translation is still running. Try again when it finishes." },
  invalid_code: { status: 400, message: "That code is wrong, already used or expired. Make a new one on the old computer." },
  same_device: { status: 400, message: "Enter the code on the other computer, not the one that made it." },
};

function transferFailure(c: any, error: unknown) {
  if (error instanceof CreditTransferError) {
    const known = TRANSFER_MESSAGES[error.code];
    return c.json({ error: error.code, message: known.message }, known.status);
  }
  console.error("Credit transfer failed:", error);
  return c.json({ error: "transfer_failed", message: getErrorMessage(error) }, 500);
}

router.post("/:deviceId/transfer-code", async (c) => {
  const deviceId = c.req.param("deviceId");
  if (!uuidSchema.safeParse(deviceId).success) return c.json({ error: "Invalid device ID format" }, 400);
  if (c.get("user").deviceId !== deviceId) return c.json({ error: "Forbidden" }, 403);
  try {
    return c.json(await createTransferCode(deviceId));
  } catch (error) {
    return transferFailure(c, error);
  }
});

router.post("/:deviceId/redeem-transfer", async (c) => {
  const deviceId = c.req.param("deviceId");
  if (!uuidSchema.safeParse(deviceId).success) return c.json({ error: "Invalid device ID format" }, 400);
  if (c.get("user").deviceId !== deviceId) return c.json({ error: "Forbidden" }, 403);
  try {
    const body = await c.req.json<{ code?: string }>().catch(() => ({} as { code?: string }));
    return c.json(await redeemTransferCode({ code: String(body.code || ""), toDeviceId: deviceId }));
  } catch (error) {
    return transferFailure(c, error);
  }
});

// Get ledger entries for a device
router.get("/:deviceId/ledger", async (c) => {
  const deviceId = c.req.param("deviceId");
  const user = c.get("user");

  // Validate UUID format
  const parsed = uuidSchema.safeParse(deviceId);
  if (!parsed.success) {
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
    const rows = await getLedgerEntries({ deviceId });
    return c.json(rows);
  } catch (error) {
    console.error("Error fetching ledger entries:", error);
    return c.json(
      {
        error: "Failed to fetch ledger entries",
        message: getErrorMessage(error),
      },
      500
    );
  }
});

export default router;
