import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY environment variable is required");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
  typescript: true,
});

export const constructWebhookEvent = ({
  payload,
  signature,
  secret,
}: {
  payload: string | Buffer;
  signature: string;
  secret: string;
}): Stripe.Event => {
  return stripe.webhooks.constructEvent(payload, signature, secret);
};
