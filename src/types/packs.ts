export const PACK_IDS = ["HOUR_1", "HOUR_5", "HOUR_10"] as const;
export type PackId = (typeof PACK_IDS)[number];

export interface Pack {
  id: PackId;
  name: string;
  minutes: number;
  price: number; // in cents
  stripePrice: string; // Stripe price ID
  description: string;
}

export const packs: Record<PackId, Pack> = {
  HOUR_1: {
    id: "HOUR_1",
    name: "1 Hour Pack",
    minutes: 60,
    price: 999, // $9.99
    stripePrice: "price_1hour", // Replace with actual Stripe price ID
    description: "Perfect for quick translations",
  },
  HOUR_5: {
    id: "HOUR_5",
    name: "5 Hour Pack",
    minutes: 300,
    price: 3999, // $39.99
    stripePrice: "price_5hour", // Replace with actual Stripe price ID
    description: "Best value for regular use",
  },
  HOUR_10: {
    id: "HOUR_10",
    name: "10 Hour Pack",
    minutes: 600,
    price: 6999, // $69.99
    stripePrice: "price_10hour", // Replace with actual Stripe price ID
    description: "For power users",
  },
};

export const isValidPackId = (id: string): id is PackId => {
  return PACK_IDS.includes(id as PackId);
};
