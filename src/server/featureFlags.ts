export interface FeatureFlagContext {
  targetingKey: string;
  account?: string;
  app: 'gogglebox';
  activePartyKey?: string;
  activeViewerIds: string[];
}

export interface FeatureFlagReader {
  booleanValue(key: string, defaultValue: boolean, context: FeatureFlagContext): Promise<boolean>;
}

export const FEATURE_FLAGS = {
  tonightsNine: 'tonights-nine',
} as const;

class DisabledFeatureFlagReader implements FeatureFlagReader {
  async booleanValue(_key: string, defaultValue: boolean): Promise<boolean> {
    return defaultValue;
  }
}

export class GoffFeatureFlagReader implements FeatureFlagReader {
  private readonly endpoint: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor({
    endpoint,
    apiKey = null,
    timeoutMs = 1500,
  }: {
    endpoint: string;
    apiKey?: string | null;
    timeoutMs?: number;
  }) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async booleanValue(key: string, defaultValue: boolean, context: FeatureFlagContext): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/ofrep/v1/evaluate/flags/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}`, 'X-API-Key': this.apiKey } : {}),
        },
        body: JSON.stringify({ context }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return defaultValue;
      }

      const body = (await response.json()) as { value?: unknown };
      return typeof body.value === 'boolean' ? body.value : defaultValue;
    } catch {
      return defaultValue;
    }
  }
}

export function createFeatureFlagReaderFromEnv(env: NodeJS.ProcessEnv = process.env): FeatureFlagReader {
  const endpoint = env.GOFF_ENDPOINT?.trim();
  if (!endpoint) {
    return new DisabledFeatureFlagReader();
  }

  const timeoutMs = Number(env.GOFF_TIMEOUT_MS);
  return new GoffFeatureFlagReader({
    endpoint,
    apiKey: env.GOFF_API_KEY?.trim() || null,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  });
}
