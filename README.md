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
   Every agent loads the scratchpad into context, so its size is capped (see
   [Size budget](#size-budget)).
5. Daily logs expire after 14 days, so old work ages out on its own.

Clankpad runs in-cluster and is reachable only over Tailscale. It
identifies callers by the `Tailscale-User-Login` header, which the Tailscale
operator's ingress proxy sets. Callers need no tokens.

## API

All `/v1` routes require an identified caller.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /v1/whoami` | | `{user}` |
| `GET /v1/scratchpad` | `?format=md` or `Accept: text/markdown` for raw markdown | `{markdown, mode, model, generatedAt, chars, digest, error?}` |
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
| `LLM_MODEL` | `deepseek-ai/DeepSeek-V4.1-Flash` | |
| `LLM_REASONING_EFFORT` | `none` | sent as `reasoning_effort`; `""` omits it |
| `LLM_MAX_TOKENS` | `16384` | includes reasoning tokens |
| `LLM_TIMEOUT_MS` | `300000` | per call; rebuilds are background work |
| `CLANKPAD_SCRATCHPAD_MAX_CHARS` | `6000` | hard cap (~1.5k tokens) on what agents load |

## Size budget

The scratchpad never exceeds `CLANKPAD_SCRATCHPAD_MAX_CHARS`. Five layers enforce this:

1. The prompt sets a word target well under the cap, broken down into a
   **per-person allowance** based on team size. At 40 people, that means one
   bullet per person. The model is told not to count characters (see below).
2. A draft over the limit gets one shortening pass with a tighter allowance. A
   failed call (error, empty content, truncated output) gets one retry.
3. If the final draft is still over budget, the scratchpad becomes **hybrid**:
   the model's "Possible overlaps" section, which is the most valuable part,
   followed by a deterministic body that fits the remaining space.
4. With no model output at all, the deterministic renderer compacts step by step
   until it fits: it collapses stale projects, shortens summaries, caps
   projects per person, and finally truncates with a pointer to `/v1/activity`.
5. LLM input is also bounded: summaries are clipped to 300 characters, and
   repeated days fold into one record per (person, project).

`Scratchpad.mode` is `llm`, `hybrid` or `deterministic`, so degraded output is
visible.

**Reasoning is off by default (`LLM_REASONING_EFFORT=none`).** With reasoning
on, DeepSeek V4.1 Flash spent its whole token budget counting characters
against the limit. At 40 users it hit `finish_reason=length` with empty content
(about 15k reasoning tokens, 50–170 s per call). With reasoning off, the same
input takes 4–24 s, and overlap detection was no worse in the simulations.

## Simulation

`sim/simulate.ts` replays two weeks of synthetic team activity through the real
write path, against Redis and the configured LLM. The timeline comes from a fake
clock, and the scratchpad is validated after every rebuild. Validation checks
the size budget, that recently active users appear, that no identities are
invented, and that planted overlaps are detected.

```bash
docker run -d --rm --name cp-redis -p 6379:6379 redis:7-alpine
LLM_API_KEY=... npm run sim                                         # 10 users
LLM_API_KEY=... SIM_TEAM_MULTIPLIER=4 SIM_BURSTS=1 SIM_OUT=sim/out-stress npm run sim   # 40 users
```

Output goes to `sim/out*/`: `results.jsonl` (one row per rebuild, including
the markdown), `final.md` and `aggregator.log`.

### Validation results

These are from 2026-10-07 with `deepseek-ai/DeepSeek-V4.1-Flash`, a 6000-character
budget and reasoning off:

| Scenario | Rebuilds | Problems | Mode | Planted overlaps found | Max scratchpad | Max LLM input | LLM latency (median / max) |
|---|---|---|---|---|---|---|---|
| 10 users × 14 days, 2 bursts/day | 23 | 0 | 23 llm | 17/17 | 2310 chars (~580 tok) | 4.4k chars | 3.3 s / 7.4 s |
| 40 users × 14 days, 1 burst/day | 14 | 0 | 13 llm, 1 hybrid | 10/10 | 5988 chars (~1.5k tok) | 14.4k chars | 16.9 s / 85 s |

At 10 users, the scratchpad levels off around 2.3k characters, because older
projects collapse into "Earlier:" lines. At 40 users it sits just under the
cap. The model sometimes flags plausible adjacent work as overlaps (for
example, two people both scaling model capacity on the same platform). This is deliberate:
a false positive costs a short conversation, while a miss costs duplicated
work. In the 40-user run, cloned users work on near-identical projects by
construction, so each clone group is correctly flagged.

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
