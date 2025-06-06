export const PACK_IDS = ["HOUR_5"] as const;
export type PackId = (typeof PACK_IDS)[number];

// Branded type for better UUID validation and autocomplete
export type DeviceId = string & { __brand: "uuid" };

export interface Pack {
  id: PackId;
  name: string;
  price: number; // in cents
  stripePriceId: string; // Stripe price ID
  credits: number;
  description: string;
}

export const packs: Record<PackId, Pack> = {
  HOUR_5: {
    id: "HOUR_5",
    name: "Standard Credit Pack",
    price: 1000, // $10.00
    stripePriceId: "price_1PEXQyRxH3a5E6S7kL5zJ8bF", // Replace with your actual Stripe Price ID
    credits: 250000,
    description: "250,000 credits, enough for about 5 hours of typical use.",
  },
};

export const isValidPackId = (id: string): id is PackId => {
  return PACK_IDS.includes(id as PackId);
};
