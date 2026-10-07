export type IdentityMode = "tailscale" | "dev";

export interface Config {
  port: number;
  store: "redis" | "memory";
  redisUrl: string;
  keyPrefix: string;
  retentionDays: number;
  identityMode: IdentityMode;
  devDefaultUser: string | undefined;
  llm: {
    baseUrl: string;
    apiKey: string | undefined;
    model: string;
    timeoutMs: number;
    maxTokens: number;
  };
  rebuildDebounceMs: number;
  rebuildIntervalMs: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name] ?? fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got ${raw}`);
  }
  return raw as T;
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 8080),
    store: oneOf("CLANKPAD_STORE", ["redis", "memory"] as const, "redis"),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    keyPrefix: process.env.CLANKPAD_KEY_PREFIX ?? "clankpad",
    retentionDays: int("CLANKPAD_RETENTION_DAYS", 14),
    identityMode: oneOf("CLANKPAD_IDENTITY_MODE", ["tailscale", "dev"] as const, "tailscale"),
    devDefaultUser: process.env.CLANKPAD_DEV_USER || undefined,
    llm: {
      baseUrl: (process.env.LLM_BASE_URL ?? "https://api.doubleword.ai/v1").replace(/\/+$/, ""),
      apiKey: process.env.LLM_API_KEY || process.env.DOUBLEWORD_API_KEY || undefined,
      model: process.env.LLM_MODEL ?? "Qwen/Qwen3.5-35B-A3B-FP8",
      timeoutMs: int("LLM_TIMEOUT_MS", 120_000),
      maxTokens: int("LLM_MAX_TOKENS", 4096),
    },
    rebuildDebounceMs: int("CLANKPAD_REBUILD_DEBOUNCE_MS", 5_000),
    // Periodic rebuild picks up TTL expiry and day rollover; skipped when inputs are unchanged.
    rebuildIntervalMs: int("CLANKPAD_REBUILD_INTERVAL_MS", 60 * 60 * 1000),
  };
}
