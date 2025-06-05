import Stripe from "stripe";

// Initialize Stripe lazily to avoid issues during module loading
let stripeInstance: Stripe | null = null;

const getStripe = (): Stripe => {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY environment variable is required");
    }

    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2023-10-16",
      typescript: true,
    });
  }

  return stripeInstance;
};

export const stripe = new Proxy({} as Stripe, {
  get: (target, prop) => {
    const stripeInstance = getStripe();
    const value = (stripeInstance as any)[prop];
    return typeof value === "function" ? value.bind(stripeInstance) : value;
  },
});

// Check if we're in test mode
export const isTestMode = () => {
  return (
    /^(sk_test_|rk_test_)/.test(process.env.STRIPE_SECRET_KEY || "") || false
  );
};

// Check if we should process live payments
export const isLiveMode = () => {
  return process.env.STRIPE_LIVE === "true" && !isTestMode();
};

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
