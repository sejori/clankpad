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
    /** Sent as reasoning_effort when set; "" disables. */
    reasoningEffort: string;
    timeoutMs: number;
    maxTokens: number;
  };
  rebuildDebounceMs: number;
  rebuildIntervalMs: number;
  /** Hard ceiling on scratchpad size; it is read into every agent's context. */
  scratchpadMaxChars: number;
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
      model: process.env.LLM_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash",
      // With reasoning on, the model burns its token budget counting characters
      // (observed: 15k reasoning tokens, 50-170s, finish_reason=length at 40 users).
      reasoningEffort: process.env.LLM_REASONING_EFFORT ?? "none",
      // Rebuilds are background work; at ~40 users a call can take ~2 min.
      timeoutMs: int("LLM_TIMEOUT_MS", 300_000),
      // Reasoning models spend part of this on thinking.
      maxTokens: int("LLM_MAX_TOKENS", 16384),
    },
    rebuildDebounceMs: int("CLANKPAD_REBUILD_DEBOUNCE_MS", 5_000),
    // Periodic rebuild picks up TTL expiry and day rollover; skipped when inputs are unchanged.
    rebuildIntervalMs: int("CLANKPAD_REBUILD_INTERVAL_MS", 60 * 60 * 1000),
    // ~1.5k tokens.
    scratchpadMaxChars: int("CLANKPAD_SCRATCHPAD_MAX_CHARS", 6000),
  };
}
