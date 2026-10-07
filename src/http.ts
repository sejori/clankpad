import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { resolveUser } from "./identity.ts";
import { handleMcp } from "./mcp.ts";
import { ValidationError, type Service } from "./service.ts";
import type { Store } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json") {
  const payload = contentType === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8`, "cache-control": "no-store" });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function wantsMarkdown(req: IncomingMessage, url: URL) {
  return url.searchParams.get("format") === "md" || (req.headers.accept ?? "").includes("text/markdown");
}

export function createHttpServer(cfg: Config, store: Store, service: Service): Server {
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (path === "/healthz") return send(res, 200, { ok: true });
    if (path === "/readyz") {
      await store.ping();
      return send(res, 200, { ok: true });
    }

    const user = resolveUser(req.headers, cfg);
    if (!user) throw new HttpError(401, "unidentified caller: reach clankpad from a user-owned device on the tailnet");

    if (path === "/mcp") {
      const body = method === "POST" ? await readJson(req) : undefined;
      return handleMcp(service, user, req, res, body);
    }

    switch (`${method} ${path}`) {
      case "GET /v1/whoami":
        return send(res, 200, { user });

      case "GET /v1/scratchpad": {
        const s = await service.scratchpad();
        return wantsMarkdown(req, url) ? send(res, 200, s.markdown, "text/markdown") : send(res, 200, s);
      }

      case "POST /v1/scratchpad/rebuild":
        return send(res, 200, await service.rebuild());

      case "GET /v1/activity": {
        const days = url.searchParams.get("days");
        return send(res, 200, await service.activity(days ? Number(days) || undefined : undefined));
      }

      case "GET /v1/logs/me":
        return send(res, 200, await service.myLog(user, url.searchParams.get("date") ?? undefined));

      case "POST /v1/logs/me/projects":
        return send(res, 200, await service.logProject(user, await readJson(req)));
    }

    const del = path.match(/^\/v1\/logs\/me\/projects\/([^/]+)$/);
    if (method === "DELETE" && del?.[1]) {
      const result = await service.removeProject(user, decodeURIComponent(del[1]));
      return send(res, result.removed ? 200 : 404, result);
    }

    throw new HttpError(404, "not found");
  };

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof ValidationError ? 400 : 500;
      if (status === 500) console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "request failed", path: req.url, error: String(err) }));
      if (!res.headersSent) send(res, status, { error: status === 500 ? "internal error" : (err as Error).message });
      else res.end();
    });
  });
}
