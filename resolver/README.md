# Local resolver proxy

This is the DNS-like half of Free Domain Name. A Manifest V3 extension cannot open a
TCP socket or answer DNS, so the extension asks the browser to send **registry-managed
HTTP names** to this loopback proxy. The proxy then connects to the record target while
the browser keeps the original URL and `Host`.

```bash
npm run resolver
# or:
node resolver/proxy.mjs --port 8787 --registry registry/client.json
```

The extension probes `http://127.0.0.1:8787/__health` during sync/settings changes. If
the proxy is running, it installs a PAC script in Chrome (or a `proxy.onRequest`
listener in Firefox) and clears the DNR redirect rules. If the proxy is offline, the
extension keeps the redirect fallback.

## Target semantics

| Record target | Proxy connects to | `Host` sent upstream | Browser URL |
| --- | --- | --- | --- |
| `http://89.58.37.84:9094/` | `89.58.37.84:9094` | original name, e.g. `abc.com` | `abc.com` |
| `http://ipmap.vitrn.com/` | resolved IP of `ipmap.vitrn.com:80` | `ipmap.vitrn.com` | `ipmap.info` |
| `a: ["1.1.1.1"]` | `1.1.1.1:80` | original name | original name |
| `cname: "target.example"` | resolved `target.example:80` | `target.example` | original name |

An IP/port target is DNS-like: the name is the identity. A hostname target is a
reverse-proxy target: the target host selects its own virtual host, but the browser
still shows the registry name.

## Limits

- HTTP only. HTTPS requests are `DIRECT` and never enter the proxy.
- No TLS termination for overridden names.
- `Location` and `Set-Cookie` domains pointing at the target are rewritten to the
  original name. Other absolute URLs inside a page may still point at the target.
- The proxy runs on loopback and is not a public service. It sees the HTTP requests
  it handles; do not expose it on a LAN interface.
- The current registry loading is the generated `client.json`. On-demand shard
  lookup is the next step for very large registries; the proxy is the place for it.
- No authentication or access control beyond binding to `127.0.0.1`.
