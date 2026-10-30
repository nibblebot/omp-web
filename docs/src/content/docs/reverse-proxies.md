---
title: Reverse proxies and ingress
description: "What a reverse proxy or ingress must do in front of the control plane, the UI listener and a session's outbound path: WebSocket upgrade, idle timeouts, message sizes, caching headers, outbound proxies and the preflight check."
---

**Reverse proxy or ingress in front of the control plane.** Every session reaches the control plane through `GET /callback/ws`, one long-lived WebSocket per session (there is no renewal and no per-connection byte cap). Anything between a session and the control plane (nginx, Caddy, Envoy, an Istio or Kubernetes ingress, a cloud load balancer, a corporate proxy) must:

- **Pass the WebSocket upgrade** on `/callback/ws`: forward the `Upgrade: websocket` and `Connection: Upgrade` request headers, speak HTTP/1.1 to the upstream, and forward the `Authorization` and `X-Omp-*` request headers unchanged (identity and credential travel in the upgrade request headers, never in the URL). A proxy that strips `Upgrade` answers the upgrade with a plain HTTP response and the session never pairs; its log shows a refused or failed WebSocket dial.
- **Tolerate idle time.** Each side sends a heartbeat message every 15 s (`HEARTBEAT_INTERVAL_MS`) and closes the pair after 30 s without any message (`SILENCE_DEADLINE_MS`), so the pair is never silent for more than about 15 s in either direction. Set the proxy's read, send and idle timeouts for this route above 30 s (60 s or more is a safe margin); a shorter idle timeout drops the pair on every quiet period and the session redials with backoff.
- **Pass messages up to 2 MiB** (`CALLBACK_WS_MAX_PAYLOAD_BYTES`; an envelope is at most 1 MiB) without a lower frame or message size cap.
- **Accept `POST /callback/bulk/<id>` bodies up to 64 MiB** (`BULK_MAX_BYTES`); these downloads and wake transfers are separate plain HTTP requests.

nginx:

```nginx
location /callback/ {
    proxy_pass http://127.0.0.1:4722;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    client_max_body_size 64m;
}
```

Kubernetes ingress-nginx passes the upgrade by itself; raise its timeouts and body limit on the control plane's Ingress: `nginx.ingress.kubernetes.io/proxy-read-timeout: "120"`, `nginx.ingress.kubernetes.io/proxy-send-timeout: "120"`, `nginx.ingress.kubernetes.io/proxy-body-size: "64m"`. Other ingress controllers and gateways have equivalent upgrade and timeout settings; use their WebSocket or upgrade option for `/callback/ws`.

**Reverse proxy or ingress in front of the control plane or the UI listener (browsers).** Every browser tab holds one long-lived WebSocket, `GET /ws` on the page's own origin, for everything it sends and receives (the page's event stream and its commands); `omp-web ui` bridges it to the control plane's `/ws` on loopback. Anything between a browser and the control plane (or `omp-web ui`) must:

- **Pass the WebSocket upgrade** on `/ws`: forward the `Upgrade: websocket` and `Connection: Upgrade` request headers, speak HTTP/1.1 to the upstream, and forward the `Cookie`, `Origin` and `X-Forwarded-For` request headers (the session cookie and the Origin check authenticate the upgrade). A proxy that strips `Upgrade` answers with a plain HTTP response and the page never connects; its network tab shows a failed WebSocket handshake on `/ws`.
- **Tolerate idle time.** The server sends a keepalive message every 15 s (`CLIENT_KEEPALIVE_MS`) and the page closes the socket after 30 s without any message (`CLIENT_SILENCE_DEADLINE_MS`), so the socket is never silent for more than about 15 s. Set the proxy's read, send and idle timeouts for this route above 30 s (60 s or more is a safe margin); a shorter idle timeout drops the socket on every quiet period and the page reconnects with backoff.
- **Pass messages up to about 32 MiB** from the browser (`BROWSER_SOCKET_MAX_PAYLOAD_BYTES`: the largest command plus its envelope) without a lower frame or message size cap, and **not buffer the upstream's messages**: the control plane drops a browser that stops reading for 30 s (close 4503), and a proxy that buffers its upstream hides a stalled browser from that rule.
- **Pass the UI's caching and compression headers through.** The fleet serves hashed `/assets/*` as `Cache-Control: public, max-age=31536000, immutable`, `index.html` and the other unhashed files as `no-cache` with an `ETag` (a reload revalidates and gets `304`), and picks a build-time Brotli or gzip copy of each file by `Accept-Encoding` (`Vary: Accept-Encoding`). `/ctl` JSON over 1 KiB is gzipped for clients that accept it. A proxy that rewrites or drops `Cache-Control`, `ETag`, `Vary` or `Content-Encoding`, or that sends the upstream no `Accept-Encoding`, makes every load download the whole bundle uncompressed (about 1.2 MB instead of about 270 KB).

nginx, in front of the control plane or the UI listener:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:4722;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

Kubernetes ingress-nginx passes the upgrade by itself; raise `nginx.ingress.kubernetes.io/proxy-read-timeout` and `nginx.ingress.kubernetes.io/proxy-send-timeout` to `"120"` on the Ingress that serves the UI. Other ingress controllers and gateways have an equivalent WebSocket or upgrade option and timeout setting.

The other direction: a session that has to leave its network through a proxy resolves the proxy itself, because Bun's WebSocket client ignores `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (Bun's `fetch`, used for the bulk POSTs, honors them; the session passes the one resolved proxy to both). It uses the launch payload's explicit `callback.proxy` (`OMP_SESSION_CALLBACK_PROXY` in the callback handoff) when present, else those variables in its own process environment. The fleet does not copy its own proxy variables into a clone or pod: a sandboxed or in-pod session sees only the proxy variables the runtime environment gives it (for a pod, whatever the cluster injects). Only `http://` and `https://` proxies are supported, reached with `CONNECT`; an unsupported scheme is an error, never a silent direct connection. The proxy must allow `CONNECT` to the control plane's port.

Check the path before launching clones: `OMP_FLEET_CALLBACK_URL=https://control.example.com omp-web preflight --profile <id>` opens a real WebSocket upgrade to `<url>/callback/ws` (through the proxy resolved from the fleet's own `HTTP(S)_PROXY` / `NO_PROXY`, as a session with that environment would), carrying no credential. The `callback-ws` row passes when the control plane answers with its typed refusal for the missing credential, and fails with the proxy or ingress setting to fix when the upgrade is refused, never answered, or answered by something that is not the fleet. A host-local session and the fleet's own derived callback URL (`http://<bind>:<port>`) need none of this.
