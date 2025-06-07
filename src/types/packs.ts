export const PACK_IDS = ["HOUR_5"] as const;
export type PackId = (typeof PACK_IDS)[number];

export type DeviceId = string & { __brand: "uuid" };

export const CREDITS_PER_HOUR = 50000;

export interface Pack {
  id: PackId;
  name: string;
  price: number;
  stripePrice: string;
  credits: number;
  description: string;
}

export const packs: Record<PackId, Pack> = {
  HOUR_5: {
    id: "HOUR_5",
    name: "Standard Credit Pack",
    price: 1000,
    stripePrice: "price_1RUh1SHrR3MuIlfbCgVgiZMS",
    credits: 250000,
    description: "250,000 credits, enough for about 5 hours of typical use.",
  },
};

export const isValidPackId = (id: string): id is PackId => {
  return PACK_IDS.includes(id as PackId);
};
