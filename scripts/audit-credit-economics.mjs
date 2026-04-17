const USD_PER_CREDIT = 10 / 350_000;
const MARGIN = 2;
const WEB_SEARCH_USD_PER_CALL = 10 / 1_000;

const packs = {
  MICRO: { usd: 1, credits: 15_000 },
  STARTER: { usd: 5, credits: 150_000 },
  STANDARD: { usd: 10, credits: 350_000 },
  PRO: { usd: 50, credits: 2_400_000 },
};

const translationPrices = {
  "gpt-5.1": { in: 1.25 / 1_000_000, out: 10 / 1_000_000 },
  "gpt-5.4": { in: 2.5 / 1_000_000, out: 15 / 1_000_000 },
  "claude-opus-4-7": { in: 5 / 1_000_000, out: 25 / 1_000_000 },
};

const transcriptionPrices = {
  "whisper-1": { perSecond: 0.006 / 60 },
  "elevenlabs-scribe": { perSecond: 0.4 / 3600 },
};

const ttsPrices = {
  "tts-1": { perChar: 15 / 1_000_000 },
  "tts-1-hd": { perChar: 30 / 1_000_000 },
  eleven_v3: { perChar: 180 / 1_000_000 },
  eleven_turbo_v2_5: { perChar: 90 / 1_000_000 },
};

function formatUsd(value, digits = 4) {
  return `$${value.toFixed(digits)}`;
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function grossMarginPercent(revenueUsd, vendorCostUsd) {
  if (!Number.isFinite(revenueUsd) || revenueUsd <= 0) return 0;
  return ((revenueUsd - vendorCostUsd) / revenueUsd) * 100;
}

function chargeForVendorCost(vendorCostUsd) {
  return vendorCostUsd * MARGIN;
}

function packRevenueMultiple(packId) {
  const baselineUsdPerCredit = USD_PER_CREDIT;
  const actualUsdPerCredit = packs[packId].usd / packs[packId].credits;
  return MARGIN * (actualUsdPerCredit / baselineUsdPerCredit);
}

function searchBreakEvenTokenCostUsd(packId) {
  const revenueMultiple = packRevenueMultiple(packId);
  if (revenueMultiple <= 1) return Number.POSITIVE_INFINITY;
  return WEB_SEARCH_USD_PER_CALL / (revenueMultiple - 1);
}

const rows = [
  {
    label: "GPT-5.1 input / 1M tokens",
    vendorCostUsd: 1_000_000 * translationPrices["gpt-5.1"].in,
  },
  {
    label: "GPT-5.1 output / 1M tokens",
    vendorCostUsd: 1_000_000 * translationPrices["gpt-5.1"].out,
  },
  {
    label: "GPT-5.4 input / 1M tokens",
    vendorCostUsd: 1_000_000 * translationPrices["gpt-5.4"].in,
  },
  {
    label: "GPT-5.4 output / 1M tokens",
    vendorCostUsd: 1_000_000 * translationPrices["gpt-5.4"].out,
  },
  {
    label: "Claude Opus 4.7 input / 1M tokens",
    vendorCostUsd: 1_000_000 * translationPrices["claude-opus-4-7"].in,
  },
  {
    label: "Claude Opus 4.7 output / 1M tokens",
    vendorCostUsd: 1_000_000 * translationPrices["claude-opus-4-7"].out,
  },
  {
    label: "Whisper-1 / hour",
    vendorCostUsd: 3600 * transcriptionPrices["whisper-1"].perSecond,
  },
  {
    label: "ElevenLabs Scribe / hour",
    vendorCostUsd: 3600 * transcriptionPrices["elevenlabs-scribe"].perSecond,
  },
  {
    label: "tts-1 / 1M chars",
    vendorCostUsd: 1_000_000 * ttsPrices["tts-1"].perChar,
  },
  {
    label: "tts-1-hd / 1M chars",
    vendorCostUsd: 1_000_000 * ttsPrices["tts-1-hd"].perChar,
  },
  {
    label: "ElevenLabs v3 / 1M chars",
    vendorCostUsd: 1_000_000 * ttsPrices.eleven_v3.perChar,
  },
  {
    label: "ElevenLabs turbo / 1M chars",
    vendorCostUsd: 1_000_000 * ttsPrices["eleven_turbo_v2_5"].perChar,
  },
];

console.log("Stage5 credit economics audit");
console.log(`Baseline USD/credit: ${USD_PER_CREDIT}`);
console.log(
  `Search surcharge per tool call: ${formatUsd(WEB_SEARCH_USD_PER_CALL)}`,
);
console.log("");

console.log("Per-pack realized margin vs billed vendor cost");
for (const packId of Object.keys(packs)) {
  const revenueMultiple = packRevenueMultiple(packId);
  const margin = grossMarginPercent(revenueMultiple, 1);
  const breakEven = searchBreakEvenTokenCostUsd(packId);
  console.log(
    `${packId.padEnd(8)} revenue=${revenueMultiple.toFixed(3)}x vendor cost  gm=${formatPercent(
      margin,
    )}  search-break-even-token-cost=${formatUsd(breakEven)}`,
  );
}

console.log("");
console.log("Current Stage5 schedule");
for (const row of rows) {
  const revenueUsd = chargeForVendorCost(row.vendorCostUsd);
  console.log(
    `${row.label.padEnd(34)} vendor=${formatUsd(
      row.vendorCostUsd,
    )}  stage5=${formatUsd(revenueUsd)}  gm=${formatPercent(
      grossMarginPercent(revenueUsd, row.vendorCostUsd),
    )}`,
  );
}
