import { z } from "zod";

/**
 * Shared validation schemas for use across all routes.
 * Centralizes schema definitions to ensure consistency.
 */

/** UUID validation schema (v4 format) */
export const uuidSchema = z.string().uuid();

/** Device ID schema (alias for UUID) */
export const deviceIdSchema = uuidSchema;

/**
 * Validates that a number is finite and optionally within bounds.
 * Use for duration, credits, and other numeric values from API requests.
 */
export const finiteNumberSchema = z.number().refine(
  (val) => Number.isFinite(val),
  { message: "Value must be a finite number" }
);

/** Positive finite number (greater than 0) */
export const positiveNumberSchema = finiteNumberSchema.refine(
  (val) => val > 0,
  { message: "Value must be greater than 0" }
);

/** Non-negative finite number (>= 0) */
export const nonNegativeNumberSchema = finiteNumberSchema.refine(
  (val) => val >= 0,
  { message: "Value must be non-negative" }
);

/**
 * Duration in seconds schema - must be finite and positive.
 */
export const durationSecondsSchema = z
  .union([z.string(), z.number()])
  .transform((val) => {
    const num = typeof val === "string" ? parseFloat(val) : val;
    return num;
  })
  .refine(
    (val) => Number.isFinite(val) && val > 0,
    { message: "Duration must be a positive finite number" }
  );
