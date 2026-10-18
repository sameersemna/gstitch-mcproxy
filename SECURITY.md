# Security policy

## Threat model

`gstitch-mcproxy` is designed for a **trusted private network** — typically a home or office LAN.
It holds a Google Stitch credential, either from the environment or forwarded per request, and it
can create projects, generate screens and spend generation quota.

What the proxy defends against:

| Threat                                                           | Control                                                         | Reference                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| A website the user visits drives the proxy with the server's key | Origin allow-list: private-network origins only                 | [ADR 0005](./docs/adr/0005-security.md) |
| DNS rebinding (a public domain pointing at a LAN address)        | `Host` policy: public host names refused                        | ADR 0005                                |
| Reading prompts, designs and project IDs cross-origin            | No CORS on `/logs`, `/api/logs*`, `/metrics`, `/health`         | ADR 0005                                |
| Reading them from the internet                                   | Those endpoints refuse non-local-network clients                | ADR 0005                                |
| Rate-limit bypass by spoofing `X-Forwarded-For`                  | Trusted only with `TRUST_PROXY=true`                            | ADR 0005                                |
| Credentials written to disk                                      | Header and query-parameter redaction                            | ADR 0005                                |
| Stored XSS through a logged body in the viewer                   | Output escaping plus a strict CSP                               | ADR 0005                                |
| One malformed packet killing the service                         | Constant-base URL parsing, `clientError`, always-answer wrapper | ADR 0002                                |

What it does **not** defend against — these are deliberate, owner-approved decisions:

- **Anyone on the LAN can use the proxy**, including with the server's own environment credential.
  There is no authentication token (owner decision 3). If your LAN is not trusted, terminate
  access at a reverse proxy or run the proxy on `127.0.0.1`.
- **A caller who supplies `X-Stitch-Api-Key` can use that key.** The proxy does not validate the
  credential; Stitch does.
- **The log viewer is readable from the LAN** when `LOG_VIEWER_ENABLED=true`. It contains full
  request and response bodies. Turn it off in any environment where that is unacceptable.

## Reporting a vulnerability

Open a private security advisory on the repository (`Security` → `Advisories` → `New draft
security advisory`) rather than a public issue. Please include:

- the affected version or commit;
- a minimal reproduction (a `curl` command is ideal);
- what you expected versus what happened.

You can expect an acknowledgement within a few days. This is a personal project, so there is no
formal SLA, but security reports are prioritised over feature work.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |

The `main` branch is the supported line. The proxy has no runtime dependencies, so there is no
dependency-upgrade treadmill; the relevant surface is Node.js itself, and `engines` requires
`>=20.3.0` (the first release with `AbortSignal.any`).

## Hardening checklist for operators

1. **Bind deliberately.** The default is `0.0.0.0` so other LAN machines can connect (owner
   decision 1). Set `MCP_SERVER_HOST=127.0.0.1` if you do not need that.
2. **Do not set `CORS_ORIGIN=*`.** The empty default means "private network only".
3. **Keep `TRUST_PROXY=false`** unless a reverse proxy you control sets `X-Forwarded-For`.
4. **Turn the log viewer off** (`LOG_VIEWER_ENABLED=false`) on networks you do not fully control.
   It renders request and response bodies.
5. **Prefer per-request credentials.** Sending `X-Stitch-Api-Key` from the MCP client means one
   compromised client cannot spend the server's key.
6. **Never commit a key.** `.env` is gitignored; `.env.example` contains placeholders only.
7. **Use the hardened units.** Both systemd templates set `NoNewPrivileges`, `ProtectSystem=strict`,
   `PrivateTmp`, `RestrictAddressFamilies`, an empty capability set and `MemoryMax`.
8. **Give the proxy time to stop.** `TimeoutStopSec` must exceed `SHUTDOWN_DRAIN_MS`, or in-flight
   generations are killed mid-stream.
