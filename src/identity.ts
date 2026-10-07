import type { IncomingHttpHeaders } from "node:http";
import type { Config } from "./config.ts";

const USER_RE = /^[\w.+-]+(@[\w.-]+)?$/;

/**
 * Resolve the caller.
 *
 * tailscale: trust `Tailscale-User-Login`, which the Tailscale operator's ingress
 * proxy sets for requests from user-owned devices (tagged devices get none and
 * are rejected). This is only safe when the pod is unreachable except via that
 * proxy — see the NetworkPolicy in deploy/.
 *
 * dev: trust `X-Clankpad-User`, falling back to CLANKPAD_DEV_USER.
 */
export function resolveUser(headers: IncomingHttpHeaders, cfg: Pick<Config, "identityMode" | "devDefaultUser">): string | null {
  const raw =
    cfg.identityMode === "tailscale"
      ? header(headers, "tailscale-user-login")
      : header(headers, "x-clankpad-user") ?? cfg.devDefaultUser;
  const user = raw?.trim().toLowerCase();
  return user && USER_RE.test(user) && user.length <= 200 ? user : null;
}

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}
