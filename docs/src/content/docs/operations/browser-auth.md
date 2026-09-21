---
title: Browser access and sign-in
description: "Put an operator access token in front of the fleet UI when it is not loopback only, and understand what the browser stores, what a wrong credential returns, and which routes stay outside the gate."
---

On its default loopback bind the fleet UI has no login: any process on the machine can register projects, spawn session daemons, and prompt agents. Binding the fleet to a non-loopback address is supported, and it requires browser auth, which puts an operator access token and a session cookie in front of every data route and mutation for non-loopback peers. This page covers the flags and config keys, what the browser does when it signs in, how a reverse proxy names the real client, and what the gate deliberately leaves alone.

For the network layout around this, see [Networking and browser access](/operations/networking/). For the trust boundaries and the on-disk artifacts, see [Security model](/operations/security/).

## What the gate covers

Browser auth is enabled by exactly one thing: an operator access token being configured. With no token, every request is admitted and every `/auth/*` route answers HTTP 404, so a client can probe and detect the disabled state.

| Surface | Loopback peer | Non-loopback peer |
| --- | --- | --- |
| `GET /events`, `POST /command` | Admitted | Needs a live browser session |
| `/ctl/*` | Admitted | `GET` needs a session; every mutation also needs the CSRF header and an allowed origin |
| Any other mutation (`POST`, `PATCH`, `DELETE`) | Admitted | Same as a `/ctl` mutation |
| Static UI files | Admitted | Admitted: the shell carries no data, and the page has to load before it can offer the sign-in dialog |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/session` | Public | Public: this is the login surface itself, read straight from the session store |
| `/callback/*` | Never rides this gate | Never rides this gate |

The `/callback/*` exclusion is structural, not a setting. Those routes are mounted before the browser gate and authenticate a clone workspace daemon with its workspace enrollment credentials, which is the only credential a sandboxed daemon has. See [Clone workspaces](/fleet/clone-workspaces/).

Rejections are plain JSON, with the status carrying the reason:

| Condition | Answer |
| --- | --- |
| Non-loopback request to a gated route with no live session | HTTP 401, `{ "error": "unauthorized" }` |
| Non-loopback mutation with a missing or wrong `X-Omp-Csrf` header | HTTP 403, `{ "error": "forbidden" }` |
| Non-loopback mutation whose `Origin` (or `Referer`) is not allowed | HTTP 403, `{ "error": "forbidden" }` |

An allowed origin means the configured public browser origin, plus loopback origins under the loopback-dev exception (see below). A missing or non-absolute origin header is refused: browsers always send `Origin` on mutations.

## Configure the operator token

| Setting | CLI flag | Environment | Config key |
| --- | --- | --- | --- |
| Operator access token | `--browser-access-token` | `OMP_FLEET_BROWSER_TOKEN` | `browserAccessToken` |
| Public browser origin | `--browser-origin` | `OMP_FLEET_BROWSER_ORIGIN` | `browserOrigin` |
| Trusted reverse proxies | `--trusted-proxy` (repeatable, each occurrence comma-splittable) | `OMP_FLEET_TRUSTED_PROXY` (comma-separated) | `trustedProxies` |
| Bind address | `--bind` | `OMP_FLEET_BIND` | `bind` |

Each row resolves flag first, then environment, then config key.

- The token is stored only as the sha-256 hex digest of the access token. A flag or environment value is hashed during the fleet's config load; the config-file key must already be the 64-character digest. The plaintext is never written to config, state, or logs, and the server never echoes it back.
- A config-file value that is not a 64-character hex digest is a startup error, not a silent auth-disable:

```text
invalid config browserAccessToken: expected the 64-char sha-256 hex digest of the access token (hash it once with `sha256sum` and configure that; the plaintext is never stored)
```

- `browserOrigin` names the origin browsers will use in production, for example `https://omp.example.com`. It is compared as a normalized origin against the `Origin` or `Referer` header of mutations.

Hash a token for the config file once, with no trailing newline:

```sh
printf '%s' "$OMP_BROWSER_TOKEN" | sha256sum
```

The fleet's own store lives at `<state dir>/browser-auth.json`, next to `fleet-state.json`, and is written `0600`. It holds the expected token digest, one record per session keyed by the sha-256 of the session id, and the per-session CSRF state. A corrupt store or an unknown version fails the boot instead of silently dropping sessions, because a silent reset would resurrect revoked ones.

## Bind off loopback

```sh
omp-web serve --bind 0.0.0.0 --browser-access-token "$OMP_BROWSER_TOKEN" \
  --browser-origin https://omp.example.com
```

A non-loopback bind without a configured token is refused at startup, before the port opens:

```text
refusing to bind non-loopback address "0.0.0.0" without browser auth; set OMP_FLEET_BROWSER_TOKEN (or --browser-access-token / config browserAccessToken)
```

Expected result: the banner names the bound address, a browser at the public origin loads the shell and then asks for the token, and `curl http://<host>:4722/ctl/sessions` answers `401` until it presents a session cookie. The `omp-web` CLI on the fleet host keeps working unchanged, because it connects over loopback.

## Signing in from the browser

The client holds one credential: the server-issued cookie. The access token is posted once and dropped.

1. The page loads and probes `GET /auth/session`. HTTP 404 means browser auth is disabled and nothing changes; HTTP 401 means signed out, and the sign-in dialog opens.
2. The dialog takes a single **Access token** field, rendered as a password input with the placeholder `Paste access token`. The note under it reads `Sessions last 30 days; the token is used once and never stored in this browser.`
3. Submitting posts `POST /auth/login` with `{ accessToken }`. A wrong token answers HTTP 401 with `{ "error": { "code": "unauthorized", "message": "access token rejected" } }`, and the dialog shows that message. The server refuses a missing or empty token with HTTP 400 `{ "error": "missing or invalid field: accessToken" }`, and the dialog disables **Sign in** until the field has content.
4. On success the server answers `{ sessionIdHash, csrfToken, expiresAt }` and sets the `omp_session` cookie. The browser keeps the CSRF token in memory only, adds it as `X-Omp-Csrf` on mutations, and sends the cookie same-origin on every request.
5. Any later 401 from a gated request (expired session, revoked session, rotated token) flips the client to signed out, clears the cached CSRF token, and reopens the dialog.
6. **sign out** in the settings overlay posts `POST /auth/logout`. The tab drops its signed-in state immediately; the POST is best-effort cookie invalidation.

Cookie and session properties:

| Property | Value |
| --- | --- |
| Cookie | `omp_session`, opaque, 256-bit |
| Attributes | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000`, and `Secure` unless the bind is loopback |
| Lifetime | 30 days, absolute. Activity never extends it. |
| Restart behavior | Sessions survive a fleet restart, because the store persists them and re-serves the CSRF token to an authenticated browser. |
| Multiple devices | Each sign-in mints its own session; `POST /ctl/auth/revoke-all` ends all of them. |

The access token is never placed in a URL, in `localStorage`, or in `sessionStorage`. The only client-side trace of a session is the HttpOnly cookie plus the in-memory CSRF token.

## Behind a reverse proxy: trusted proxies

A proxy that terminates TLS and forwards to the fleet's loopback port hides the real client address. The fleet sees a loopback peer and, by default, trusts nothing else. Grant that trust explicitly by listing the proxy in `trustedProxies`, using bare IP literals or CIDR:

```sh
omp-web serve --bind 127.0.0.1 --browser-access-token "$OMP_BROWSER_TOKEN" \
  --browser-origin https://omp.example.com --trusted-proxy 127.0.0.1
```

List the address the proxy actually dials from, which for a proxy on the fleet host is `127.0.0.1` (or `::1`). When the proxy reaches the fleet over a private network, the entry is that network's literal or CIDR, for example `10.0.0.0/8`. Repeat `--trusted-proxy` for several proxies, or pass one comma-separated value.

- `X-Forwarded-For` and `X-Forwarded-Proto` are read only when the direct socket peer matches a configured entry. Then the first `X-Forwarded-For` hop is the client address, and `X-Forwarded-Proto` may mark the request as arriving over HTTPS.
- Forwarded headers from any other peer are ignored completely, so a client cannot spoof its address, talk its way into the loopback exemption, or widen the origin allowlist.
- A loopback peer that does send forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`, or `X-Forwarded-Host`) is treated as an undeclared proxy and resolves as a non-loopback client, which means a session is required until you list that proxy. This is the fail-closed path: a proxy in front of remote clients cannot open the fleet by being overlooked.
- IPv4 and IPv6 literals both parse, an IPv4-mapped IPv6 peer compares as its IPv4 form, and anything that does not parse never matches. A malformed literal is a hard config error, so a typo cannot quietly strand your proxy:

```text
invalid trusted proxy literal(s): "<literal>" (expected IP or CIDR, e.g. 10.0.0.0/8; forwarded headers are ignored unless the direct peer matches a configured trusted proxy)
```

One case stays yours to judge: a proxy that forwards no headers at all from the loopback side is indistinguishable from a local browser, so its clients are admitted like any loopback peer. That is why the proxy or tunnel in front is the access control in that setup, as described in [Networking and browser access](/operations/networking/).

## The loopback-dev exception

When the bind resolves to a loopback address, the fleet runs with the loopback-dev exception on. It drops only the `Secure` flag from the session cookie (so plain HTTP on `127.0.0.1` can hold a session) and admits loopback origins for mutations. It never applies to a public bind, and it is never inferred from a request header.

The exemption is server-side and credential-free: a loopback peer never needs a cookie, which is what keeps the local CLI and a local browser working. The UI still asks, though, because the page derives its signed-in state from `GET /auth/session`, which reads only the cookie. With a token configured on a loopback bind the dialog appears on first load; you can sign in, or close it and keep working locally.

## Revoking sessions and rotating the token

Both actions are mutations, so a non-loopback caller needs a live session, the CSRF header, and an allowed origin.

| Route | Body | Effect |
| --- | --- | --- |
| `POST /ctl/auth/revoke-all` | none | Revokes every live session and clears the caller's cookie. Every device signs in again. |
| `POST /ctl/auth/rotate-token` | `{ accessToken }` | Revokes every session, then adopts the sha-256 digest of the new token. The plaintext travels only in this request. |

Rotating is also implied by configuration: if the fleet boots with a digest that differs from the one in its store, every stored session is revoked and the new digest is adopted, so a rotated token never coexists with sessions minted under the old one. Sessions have absolute lifetimes, so nothing slides at rotation; they simply end.

## Failures you can hit

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `refusing to bind non-loopback address "<addr>" without browser auth` | No token was configured for a non-loopback bind. | Set `OMP_FLEET_BROWSER_TOKEN`, pass `--browser-access-token`, or set the `browserAccessToken` config key (as a digest). |
| `invalid config browserAccessToken: expected the 64-char sha-256 hex digest` | The config file holds a plaintext token or a malformed digest. | Configure the digest produced by `printf '%s' "$TOKEN" \| sha256sum`. |
| `invalid trusted proxy literal(s): "<literal>"` | A `trustedProxies` entry is not an IP or CIDR literal. | Correct the literal; the fleet refuses to start until every entry parses. |
| The dialog says `access token rejected` | The presented token's digest does not match the configured one. | Re-check the token, or rotate it and sign in again. |
| Everything answers 401 after a working session | The session expired, was revoked, or the token was rotated. | Sign in again with the current token. |
| Mutations answer 403 while reads work | The CSRF header is missing, or `Origin` is not the configured browser origin. | Serve the UI from the configured origin, or set `browserOrigin` to the origin you actually use. |
| `/auth/session` answers 404 | Browser auth is disabled: no token is configured. | Configure a token if you want the gate. |
| A remote client reaches the fleet without signing in | The bind is loopback and a tunnel or proxy dials from the host, or a proxy sends no forwarded headers. | Treat the tunnel or proxy as the login, or bind off loopback with browser auth and list the proxy in `trustedProxies`. |

## What this is not

- It is one operator token, not an identity system. There are no accounts, roles, or per-user permissions, and omp-web assumes a single operator.
- It provides no transport security of its own. Terminate TLS where you choose, or reach the fleet over SSH or a tailnet.
- It does not gate the static UI shell, the `/auth/*` login surface, or `/callback/*`.
- It does not stop a local user on the fleet host. Loopback peers are exempt by design, and the CLI depends on that.

## Related

- [Networking and browser access](/operations/networking/): binds, tunnels, and proxy requirements for the streaming endpoints.
- [Security model](/operations/security/): trust boundaries and the file permissions that protect the auth store.
- [CLI commands and flags](/reference/cli/): the full `serve` flag list.
- [Configuration schema](/reference/configuration/): `browserAccessToken`, `browserOrigin`, and `trustedProxies` in context.
- [Clone workspaces](/fleet/clone-workspaces/): the `/callback/*` surface and its own credentials.
- [Stored sessions and orphans](/analysis/stored-sessions/): the read-only history surface behind the same gate.
