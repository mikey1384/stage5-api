import { OPENAI_RELAY_URL } from "./constants";

export type RelayCapabilities = {
  stage5AnthropicReviewAvailable: boolean;
};

const RELAY_CAPABILITIES_TIMEOUT_MS = 5_000;
const RELAY_CAPABILITIES_STALE_MAX_AGE_MS = 15 * 60_000;

let relayCapabilitiesCache:
  | { capabilities: RelayCapabilities; fetchedAt: number }
  | null = null;

export async function fetchRelayCapabilities(params: {
  relaySecret: string;
  workerAnthropicAvailable?: boolean;
}): Promise<RelayCapabilities> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RELAY_CAPABILITIES_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "X-Relay-Secret": params.relaySecret,
    };
    if (params.workerAnthropicAvailable) {
      headers["X-Stage5-Worker-Anthropic-Available"] = "1";
    }

    const response = await fetch(`${OPENAI_RELAY_URL}/translation-capabilities`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Relay capability lookup failed (${response.status} ${response.statusText})`,
      );
    }

    const data = (await response.json().catch(() => ({}))) as {
      capabilities?: {
        stage5AnthropicReviewAvailable?: unknown;
      };
    };

    const capabilities = {
      stage5AnthropicReviewAvailable: Boolean(
        data?.capabilities?.stage5AnthropicReviewAvailable,
      ),
    };
    relayCapabilitiesCache = {
      capabilities,
      fetchedAt: Date.now(),
    };
    return capabilities;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getCachedRelayCapabilities(): RelayCapabilities | null {
  if (!relayCapabilitiesCache) return null;

  const ageMs = Date.now() - relayCapabilitiesCache.fetchedAt;
  if (ageMs > RELAY_CAPABILITIES_STALE_MAX_AGE_MS) {
    return null;
  }
  return relayCapabilitiesCache.capabilities;
}

export function clearRelayCapabilitiesCacheForTests(): void {
  relayCapabilitiesCache = null;
}
