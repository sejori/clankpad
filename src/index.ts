import { Aggregator } from "./aggregator.ts";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./http.ts";
import { Service } from "./service.ts";
import { MemoryStore, RedisStore, type Store } from "./store.ts";

const cfg = loadConfig();
const store: Store =
  cfg.store === "memory" ? new MemoryStore(cfg.retentionDays) : new RedisStore(cfg.redisUrl, cfg.keyPrefix, cfg.retentionDays);
const aggregator = new Aggregator(store, cfg);
const service = new Service(store, aggregator, cfg);
const server = createHttpServer(cfg, store, service);

server.listen(cfg.port, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: "clankpad listening",
      port: cfg.port,
      store: cfg.store,
      identityMode: cfg.identityMode,
      llm: cfg.llm.apiKey ? cfg.llm.model : "disabled (deterministic scratchpad)",
    }),
  );
  aggregator.start();
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    aggregator.stop();
    server.close(() => void store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
