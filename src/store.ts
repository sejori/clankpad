import { Redis } from "ioredis";
import type { DailyLog, ProjectEntry, Scratchpad } from "./types.ts";

/**
 * Persistence for daily logs and the aggregated scratchpad.
 *
 * Each (user, date) is one Redis hash keyed `<prefix>:log:<user>:<date>`; fields
 * are project slugs and values are JSON ProjectEntry. Every write refreshes the
 * key's TTL so old work ages out on its own.
 */
export interface Store {
  upsertProject(user: string, date: string, entry: ProjectEntry): Promise<void>;
  removeProject(user: string, date: string, slug: string): Promise<boolean>;
  getLog(user: string, date: string): Promise<DailyLog>;
  /** All logs whose date is >= since. */
  listLogs(since: string): Promise<DailyLog[]>;
  getScratchpad(): Promise<Scratchpad | null>;
  setScratchpad(s: Scratchpad): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

function parseEntries(hash: Record<string, string>): ProjectEntry[] {
  return Object.values(hash)
    .map((v) => {
      try {
        return JSON.parse(v) as ProjectEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is ProjectEntry => e !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export class RedisStore implements Store {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(url: string, prefix: string, retentionDays: number) {
    this.prefix = prefix;
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    let lastLogged = 0;
    this.redis.on("error", (err: Error) => {
      // ioredis reconnects on its own; log at most every 30s so an outage doesn't flood logs.
      if (Date.now() - lastLogged < 30_000) return;
      lastLogged = Date.now();
      console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "redis error", error: String(err) }));
    });
    this.ttlSeconds = retentionDays * 86_400;
  }

  private logKey(user: string, date: string) {
    return `${this.prefix}:log:${user}:${date}`;
  }

  async upsertProject(user: string, date: string, entry: ProjectEntry) {
    const key = this.logKey(user, date);
    await this.redis.multi().hset(key, entry.slug, JSON.stringify(entry)).expire(key, this.ttlSeconds).exec();
  }

  async removeProject(user: string, date: string, slug: string) {
    return (await this.redis.hdel(this.logKey(user, date), slug)) > 0;
  }

  async getLog(user: string, date: string): Promise<DailyLog> {
    const hash = await this.redis.hgetall(this.logKey(user, date));
    return { user, date, projects: parseEntries(hash) };
  }

  async listLogs(since: string): Promise<DailyLog[]> {
    const prefix = `${this.prefix}:log:`;
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    const wanted = keys
      .map((key) => {
        const rest = key.slice(prefix.length);
        const sep = rest.lastIndexOf(":");
        return { key, user: rest.slice(0, sep), date: rest.slice(sep + 1) };
      })
      .filter((k) => k.user && k.date >= since);
    if (wanted.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const k of wanted) pipeline.hgetall(k.key);
    const results = (await pipeline.exec()) ?? [];

    const logs: DailyLog[] = [];
    wanted.forEach((k, i) => {
      const [err, hash] = results[i] ?? [null, {}];
      if (err) throw err;
      const projects = parseEntries(hash as Record<string, string>);
      if (projects.length) logs.push({ user: k.user, date: k.date, projects });
    });
    return logs;
  }

  async getScratchpad() {
    const raw = await this.redis.get(`${this.prefix}:scratchpad`);
    return raw ? (JSON.parse(raw) as Scratchpad) : null;
  }

  async setScratchpad(s: Scratchpad) {
    await this.redis.set(`${this.prefix}:scratchpad`, JSON.stringify(s));
  }

  async ping() {
    await this.redis.ping();
  }

  async close() {
    await this.redis.quit();
  }
}

/** In-process store for local development and tests. TTL is applied on read. */
export class MemoryStore implements Store {
  private readonly logs = new Map<string, Map<string, ProjectEntry>>();
  private scratchpad: Scratchpad | null = null;
  private readonly retentionDays: number;
  private readonly now: () => Date;

  constructor(retentionDays = 14, now: () => Date = () => new Date()) {
    this.retentionDays = retentionDays;
    this.now = now;
  }

  private key(user: string, date: string) {
    return JSON.stringify([user, date]);
  }

  async upsertProject(user: string, date: string, entry: ProjectEntry) {
    const k = this.key(user, date);
    const m = this.logs.get(k) ?? new Map();
    m.set(entry.slug, entry);
    this.logs.set(k, m);
  }

  async removeProject(user: string, date: string, slug: string) {
    return this.logs.get(this.key(user, date))?.delete(slug) ?? false;
  }

  async getLog(user: string, date: string): Promise<DailyLog> {
    const m = this.logs.get(this.key(user, date));
    return { user, date, projects: m ? parseEntries(Object.fromEntries([...m].map(([k, v]) => [k, JSON.stringify(v)]))) : [] };
  }

  async listLogs(since: string): Promise<DailyLog[]> {
    const cutoff = new Date(this.now().getTime() - this.retentionDays * 86_400_000).toISOString().slice(0, 10);
    const out: DailyLog[] = [];
    for (const k of this.logs.keys()) {
      const [user, date] = JSON.parse(k) as [string, string];
      if (date < since || date < cutoff) continue;
      const log = await this.getLog(user, date);
      if (log.projects.length) out.push(log);
    }
    return out;
  }

  async getScratchpad() {
    return this.scratchpad;
  }

  async setScratchpad(s: Scratchpad) {
    this.scratchpad = s;
  }

  async ping() {}
  async close() {}
}
