# ADR 0005 — Security model: private network allowed, public internet refused

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 5
- **Supersedes:** —

## Context

The baseline was exploitable by any website the user happened to visit:

- `CORS_ORIGIN` defaulted to `*` and `Access-Control-Allow-Origin: *` was emitted on **every**
  route, including `/logs`, `/api/logs*` and `/metrics`.
- `validateOrigin` returned `true` for every origin when `CORS_ORIGIN` was `*`.
- When a request carried no key header the proxy fell back to the **server's own**
  `STITCH_API_KEY`.

Together that meant: page loads → preflight passes → POST with no credential → the server's key
is used → the attacker can list, read, create and edit the victim's Stitch projects
(findings ★C3 and ★C4, both reproduced).

Separately, `LOG_VIEWER_ENABLED=false` only matched paths starting with `/logs`, so the JSON APIs
and the raw log reader stayed reachable (★N1), and `X-Forwarded-For` was trusted from any peer,
so the per-IP rate limit could be bypassed by presenting a fresh address per request (★N4).

## Owner decisions that constrain the fix

1. **Bind `0.0.0.0`.** Other LAN computers must reach the proxy. Loopback-only is not acceptable.
2. **Origins must accept LAN computers.**
3. **No `PROXY_AUTH_TOKEN`.** LAN-only reachability *is* the control; adding a token would mean
   reconfiguring every LAN client.
4. Unsafe-call windows: 10 minutes (see ADR 0003).
5. Rate limiting on by default, generously.
6. JavaScript + `checkJs` (ADR 0001).

## Decision

The model is **"private network allowed, public internet refused"** — not "loopback only", which
would break decision 1.

### Origin policy

A request with **no** `Origin` is allowed: that is a non-browser client (VS Code, curl, an agent),
which cannot be driven by a hostile web page.

A request **with** an `Origin` is allowed when the origin's host is:

- `localhost`, `*.localhost`, or `*.local` (mDNS names cannot resolve publicly), or
- a private address — RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), loopback, link-local, CGNAT,
  IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`).

Everything else is refused with **`403` and JSON-RPC `-32001`**, before any credential or body is
processed. `CORS_ORIGIN=*` explicitly restores the old permissive behaviour; a specific
`CORS_ORIGIN` or `ALLOWED_ORIGINS` entry widens the allow-list further.

### Host policy (DNS rebinding)

Only private/LAN host names are accepted. A malicious public page can point its domain at a LAN
address, so the browser sends `Host: evil.example` to a machine on the LAN; refusing public hosts
closes that. Single-label names (`latitude`) are accepted because browsers cannot resolve them
from the public internet. `ALLOWED_HOSTS=*` is the escape hatch for a reverse proxy that presents
a public `Host`.

Ordering matters and is deliberate: **syntax first, policy second.** A malformed `Host` is
`400 -32600`; a well-formed but public `Host` is `403 -32001`.

### CORS is scoped to `/mcp`

No CORS headers are emitted for `/logs`, `/api/logs*`, `/metrics` or `/health`, so a browser
cannot read them cross-origin at all. `/mcp` reflects the request origin with `Vary: Origin`.

### Sensitive endpoints are local-network only

The log viewer, the logs API (including raw files), `/metrics` and verbose health are readable
from loopback and private addresses, and refused (`403`) otherwise. When `TRUST_PROXY` is on, the
forwarded client address decides — because behind a reverse proxy the socket peer is always the
proxy, and trusting it first would expose the viewer to the internet.

### `/health` is split

Public: `{status, version, uptime}`. Everything else — absolute paths, full configuration,
whether an API key is configured — is behind `/health?verbose=1`, which is local-network only.

### The env API key

Because the origin policy already refuses the public internet, an allowed (LAN) browser request
may use the env key — that is exactly what decision 2 asks for. A defence-in-depth check refuses
the env fallback for any origin the policy does **not** allow, so a future relaxation of the
policy cannot silently re-open ★C3.

### Rate limiting

Enabled by default with a generous budget (`RATE_LIMIT_MAX_RPS=100`, `RATE_LIMIT_BURST=200`).
`X-Forwarded-For` is ignored unless `TRUST_PROXY=true` (★N4).

### Redaction and headers

`redactHeaders` now also masks `x-proxy-token`, `cookie` and `set-cookie`; `redactUrl` scrubs
`key`, `api_key`, `access_token`, `token` and `idempotency-key` query parameters from logged
paths. Every HTML page carries `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.

## Consequences

### Positive

- A website the user visits can no longer drive the proxy or spend their Stitch quota.
- The LAN workflow the owner needs keeps working, including browser-based clients.
- The log viewer stops being a public directory of prompts, designs and project IDs.
- DNS rebinding is closed without requiring a bind-address change.

### Negative / accepted trade-offs

- **A public `Origin` is now refused where it used to work.** Anyone serving a browser client
  from a public host must add it to `ALLOWED_ORIGINS`. This is the point of the phase.
- **`/health` is smaller.** Monitoring that scraped the old payload must use `?verbose=1` from the
  LAN, or scrape `/metrics`.
- **A reverse proxy needs `TRUST_PROXY=true`** for the viewer to work through it, which also means
  trusting its `X-Forwarded-For`.
- There is no authentication. Anyone on the LAN can use the proxy with the server's env key by
  design (decision 3). If the LAN is not trusted, set `PROXY_AUTH_TOKEN`-equivalent controls at a
  reverse proxy.

## Alternatives considered

1. **Bind `127.0.0.1` only.** Rejected by owner decision 1.
2. **Require a proxy token.** Rejected by owner decision 3.
3. **Keep `CORS_ORIGIN=*` and rely on the absence of CORS for non-MCP routes.** Rejected: `/mcp`
   is the dangerous route, and `*` there is precisely ★C3.
4. **Allow-list by exact origin only, no private-range logic.** Rejected: the LAN's addresses are
   DHCP-assigned and change, so a static list is unmaintainable for this deployment.
