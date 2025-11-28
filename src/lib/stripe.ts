import Stripe from "stripe";

let cached: Stripe | undefined;

export const getStripe = (key: string) => {
  if (!cached) {
    if (!key) throw new Error("STRIPE_SECRET_KEY missing");
    cached = new Stripe(key, { apiVersion: "2024-11-20.acacia", typescript: true });
  }
  return cached;
};
