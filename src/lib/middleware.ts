import { Context, Next } from "hono";
import { API_ERRORS } from "./constants";
import { getUserByApiKey } from "./db";

/**
 * Shared user variables type for authenticated routes
 */
export type AuthVariables = {
  user: {
    deviceId: string;
    creditBalance: number;
  };
};

/**
 * Bearer token authentication middleware.
 * Validates the Authorization header and sets user context.
 * Skips paths that start with /webhook (relay callbacks use X-Relay-Secret instead).
 *
 * Usage:
 *   router.use("*", bearerAuth());
 */
export function bearerAuth() {
  return async (c: Context, next: Next) => {
    // Skip bearer auth for relay-authenticated routes (they use X-Relay-Secret)
    const path = new URL(c.req.url).pathname;
    if (
      path.includes("/webhook/") ||
      path.endsWith("/authorize") ||
      path.endsWith("/deduct")
    ) {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        { error: API_ERRORS.UNAUTHORIZED, message: "Missing API key" },
        401
      );
    }

    const apiKey = authHeader.substring(7);
    const user = await getUserByApiKey({ apiKey });

    if (!user) {
      return c.json(
        { error: API_ERRORS.UNAUTHORIZED, message: "Invalid API key" },
        401
      );
    }

    c.set("user", {
      deviceId: user.device_id,
      creditBalance: user.credit_balance,
    });

    await next();
  };
}

/**
 * Extract error message from unknown error type.
 * Provides consistent error message extraction across all routes.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}
