import Stripe from "stripe";

let cached: Stripe | undefined;

export const getStripe = (key: string) => {
  if (!cached) {
    if (!key) throw new Error("STRIPE_SECRET_KEY missing");
    cached = new Stripe(key, { apiVersion: "2025-11-17.clover", typescript: true });
  }
  return cached;
};
