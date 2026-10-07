# clankpad

A shared scratchpad that tells your coding agent what the rest of the team is
working on, so it can say *"you should speak to Rushil about this"* before you
duplicate their work.

```
 Claude Code ──(skill: curl  /  MCP)──▶ clankpad ──▶ Redis  user:date → projects (TTL 14d)
      ▲                                    │
      └──── team scratchpad (markdown) ◀───┴── aggregator: LLM condenses all logs on every write
```

1. At the start of a task, the agent reads the team scratchpad.
2. If a teammate is on something related, the agent tells the user who to talk to.
3. The agent logs the user's project to today's daily log.
4. Every write triggers a debounced rebuild. The aggregator folds all daily logs
   from the retention window and asks an LLM (Doubleword API by default) for a
   condensed Markdown summary, with possible overlaps first. If no LLM is
   configured or the call fails, it renders a deterministic summary instead.
5. Daily logs expire after 14 days, so old work ages out on its own.

Clankpad runs in the Euler cluster and is reachable only over Tailscale. It
identifies callers by the `Tailscale-User-Login` header, which the Tailscale
operator's ingress proxy sets. Callers need no tokens.

## API

All `/v1` routes require an identified caller.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /v1/whoami` | | `{user}` |
| `GET /v1/scratchpad` | `?format=md` or `Accept: text/markdown` for raw markdown | `{markdown, generatedAt, model, digest, error?}` |
| `POST /v1/scratchpad/rebuild` | | forces a rebuild, returns the scratchpad |
| `GET /v1/activity` | `?days=N` | per-user, per-project activity JSON |
| `GET /v1/logs/me` | `?date=YYYY-MM-DD` (default today, UTC) | `{user, date, projects[]}` |
| `POST /v1/logs/me/projects` | `{name, summary?, repos?[]}` | upserts by slug(name), returns today's log |
| `DELETE /v1/logs/me/projects/:name` | | `{removed, log}`; 404 if absent |
| `POST /mcp` | MCP streamable HTTP (stateless) | tools: `get_scratchpad`, `get_team_activity`, `log_project`, `list_my_projects`, `remove_project` |
| `GET /healthz`, `GET /readyz` | | liveness / Redis ping |

Redis layout: `clankpad:log:<user>:<YYYY-MM-DD>` is a hash of
`slug → ProjectEntry` JSON, and every write refreshes its TTL.
`clankpad:scratchpad` holds the latest aggregate.

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `REDIS_URL` | `redis://localhost:6379` | |
| `CLANKPAD_STORE` | `redis` | `memory` for local dev |
| `CLANKPAD_IDENTITY_MODE` | `tailscale` | `dev` trusts `X-Clankpad-User` (never expose) |
| `CLANKPAD_DEV_USER` | | fallback user in `dev` mode |
| `CLANKPAD_RETENTION_DAYS` | `14` | TTL and aggregation window |
| `CLANKPAD_REBUILD_DEBOUNCE_MS` | `5000` | coalesces bursts of writes |
| `CLANKPAD_REBUILD_INTERVAL_MS` | `3600000` | catches TTL expiry and day rollover; no-op when nothing changed |
| `LLM_BASE_URL` | `https://api.doubleword.ai/v1` | any OpenAI-compatible endpoint |
| `LLM_API_KEY` / `DOUBLEWORD_API_KEY` | | unset means deterministic scratchpad only |
| `LLM_MODEL` | `Qwen/Qwen3.5-35B-A3B-FP8` | |

## Development

```bash
npm install
npm test
CLANKPAD_DEV_USER=me@example.com npm run dev      # in-memory store, dev identity
curl -s -XPOST localhost:8080/v1/logs/me/projects -H 'content-type: application/json' -d '{"name":"demo"}'
curl -s 'localhost:8080/v1/scratchpad?format=md'
```

## Deploying

CI publishes `ghcr.io/sejori/clankpad` with these tags: `sha-<sha>` and `main` on
pushes to main, and `X.Y.Z` / `X.Y` on `vX.Y.Z` tags. `deploy/kubernetes/`
holds example manifests: Redis with AOF, the app, a Tailscale Ingress, and
NetworkPolicies.

**Security model:** identity is a header, so the pod must be reachable only
through the Tailscale proxy. Keep the NetworkPolicy in place, and never expose
clankpad through a public ingress.

## Agent skill

`skill/clankpad/SKILL.md` is a template Claude Code skill. Copy it into a
workspace's `.claude/skills/clankpad/`. To use MCP directly instead:

```bash
claude mcp add --transport http clankpad https://clankpad.<tailnet>.ts.net/mcp
```

## Privacy

Everyone on the tailnet can read the summaries, and they are sent to the
configured LLM. Agents are told never to log secrets or customer data, and to
treat scratchpad content as data rather than instructions.
