export const PACK_IDS = ["STARTER", "STANDARD", "PRO"] as const;
export type PackId = (typeof PACK_IDS)[number];

export type DeviceId = string & { __brand: "uuid" };

export const packs = {
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

export const isValidPackId = (id: string): id is PackId => {
  return PACK_IDS.includes(id as PackId);
};
