export const PACK_IDS = ["MICRO", "STARTER", "STANDARD", "PRO"] as const;
export type PackId = (typeof PACK_IDS)[number];

export type DeviceId = string & { __brand: "uuid" };

export const packs = {
  MICRO: {
    priceId: "price_1S2qOsHrR3MuIlfbin7ihjMS", // $1 (prod_Syo08evQwrvTBl)
    credits: 15_000,
    usd: 1,
  },
  STARTER: {
    priceId: "price_1RXb46HrR3MuIlfbkctbZdjj", // $5
    credits: 150_000,
    usd: 5,
  },
  STANDARD: {
    priceId: "price_1RUh1SHrR3MuIlfbCgVgiZMS", // $10
    credits: 350_000,
    usd: 10,
  },
  PRO: {
    priceId: "price_1RXb54HrR3MuIlfbUnZffs8W", // $50
    credits: 2_400_000,
    usd: 50,
  },
} as const;

// The free-preview offer sells the $1 pack in multiples, so a video that
// needs a little more than one pack costs $2, $3 or $4 instead of jumping to
// the $5 pack. Five or more is never offered: the $5 pack holds more.
export const MULTI_PACK_ID: PackId = "MICRO";
export const MAX_PACK_QUANTITY = 4;

/**
 * How many packs a checkout bought. Anything but a whole number from 1 to
 * MAX_PACK_QUANTITY of the multi-buy pack counts as one.
 */
export function packQuantity(packId: PackId, raw: unknown): number {
  const value =
    typeof raw === "string" && /^[0-9]{1,2}$/.test(raw) ? Number(raw) : raw;
  if (
    packId !== MULTI_PACK_ID ||
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PACK_QUANTITY
  ) {
    return 1;
  }
  return value;
}

export const isValidPackId = (id: string): id is PackId => {
  return PACK_IDS.includes(id as PackId);
};
