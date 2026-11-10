# Architecture

This document describes the resolver, its local HTTP proxy, the DNR fallback, sync
and cache behavior, and the threat model. For setup, see the [README](../README.md)
and [resolver/README.md](../resolver/README.md).

## Components

| Component | Responsibility |
| --- | --- |
| `src/background.ts` | Sync, resolver/DNR selection, settings, messages. |
| `src/lib/resolver.ts` | Health check, PAC generation, Chrome `proxy.settings`, Firefox `proxy.onRequest`. |
| `resolver/proxy.mjs` | Loopback HTTP resolver: registry lookup, target connect, Host, response rewrite. |
| `src/interstitial.ts` | Fallback consent screen, warnings, public-DNS conflict choice. |
| `src/popup.ts` | Resolver/fallback status, counts, enable toggle, sync. |
| `src/options.ts` | Registry URL, interval, DoH, resolver toggle/port, status. |
| `src/lib/validation.ts` | Pure registry validation, lookup, destinations, loop checks. |
| `src/lib/rules.ts` | DNR redirect rules and tab-scoped public bypass. |
| `src/lib/registry.ts` | Fetch, ETag, size cap, cache, sample fallback, rule apply. |
| `src/lib/doh.ts` | DoH A/AAAA conflict checks and short cache. |
| `registry/` | Sharded source records, generated client, validator, schema, CI. |

## Request flow: resolver mode

```text
browser navigation to http://abc.com/
  -> PAC (Chrome) or proxy.onRequest (Firefox)
  -> only registry-managed HTTP names -> 127.0.0.1:8787
  -> resolver proxy lookup
  -> target 89.58.37.84:9094
  -> Host: abc.com
  -> target response streamed back
  -> browser URL stays http://abc.com/
```

The extension never sees the page content. It only configures the browser's proxy
routing. The proxy is the component that owns target selection, DNS resolution of a
target hostname, Host selection, and response header rewriting.

### Target semantics

| Record | Connect | Upstream `Host` | Browser URL |
| --- | --- | --- | --- |
| `url` with IP literal + port | IP:port | original request `Host` | original name |
| `url` with hostname | DNS(hostname):port | target hostname (+ port) | original name |
| `cname` | DNS(cname):80 | cname | original name |
| `a[0]` fallback | address:80 | original request `Host` | original name |

An IP/port target is DNS-like: the requested name is the identity. A hostname
target is a reverse-proxy target: the target host selects its virtual host, while
the browser keeps the registry name. `Location` and `Set-Cookie` domains that point
at the target are rewritten to the original name.

## Request flow: fallback mode

If `http://127.0.0.1:<port>/__health` does not answer, the extension clears its PAC
(or leaves the Firefox listener direct) and installs DNR redirect rules:

```text
http://google.com/
  -> DNR main_frame redirect
  -> chrome-extension://.../interstitial.html?scheme=http&host=google.com
  -> resolve message, optional DoH conflict
  -> user choice -> normal navigation
```

The popup says `Redirect fallback`; this is not the resolver behavior. It exists so
the extension still works before the local companion is running.

## Proxy details

`resolver/proxy.mjs` is dependency-free Node 22:

- listens on `127.0.0.1:8787` by default;
- loads the generated client from the configured URL or a local `--registry` file;
- refreshes the registry every 60 seconds, retaining the last good copy on failure;
- serves `/__health` with CORS for the extension;
- forwards only HTTP; HTTPS is `DIRECT` and never enters the proxy;
- streams request/response bodies, strips hop-by-hop headers, and sets
  `connection: close`;
- returns 502 on target failure and 501 for non-HTTP requests.

The extension generates a PAC script containing only the current exact/wildcard
names. Chrome installs it with `chrome.proxy.settings`; Firefox uses
`browser.proxy.onRequest` and returns `127.0.0.1:<port>` for matching HTTP URLs.
Both paths are mutually exclusive with DNR redirects.

Proxy settings are only cleared if the PAC contains the extension's marker, so a
user-configured proxy is not overwritten.

## DNR fallback

For each record, `applyInterceptionRules` installs:

```text
regexFilter: ^(https?)://(google\.com)(?::\d+)?(?:[/?#][^\s]*)?$
resourceTypes: ["main_frame"]
action.redirect.regexSubstitution:
  chrome-extension://.../interstitial.html?scheme=\1&host=\2
```

Wildcard record `*.demo.fdn` becomes:

```text
^(https?)://([^/?#]+\.demo\.fdn)(?::\d+)?(?:[/?#][^\s]*)?$
```

Exact records have priority `1000`; wildcards use `100 + label count`. Rules are
`main_frame` only. One rule per record means adding `google.com` does not intercept
every `.com`. The fallback is capped at 2,000 records because DNR is bounded.

The public bypass is a session rule with `tabIds`, `requestDomains`, priority
`5000`, and a 60-second cleanup alarm.

## Registry source and sync

The reviewable source is sharded one record per file:

```text
names/<first3>/<next3>/<name>.json
```

`recordPath()` is deterministic (dots removed, 3 + 3 characters). CI checks the
path, duplicate names, ports, URLs, IPs, and target loops. `client.json` is
generated and never hand-edited.

```text
onInstalled / onStartup / alarm / manual Sync
  -> read settings
  -> GET client.json with ETag
  -> size cap (5 MB)
  -> same-origin redirect check
  -> validateRegistry
  -> cache in storage.local
  -> configure resolver or apply DNR fallback
  -> write syncStatus
```

A failed fetch keeps the last valid cache. If there is no cache, the bundled sample
is validated and used as `source: "sample"`. A 304 reuses the remote cache. Changing
the registry URL clears the cache, sync status, and session rules.

## Validation

`validateRegistry` is pure and runs in unit tests, the extension, and the CLI. It
rejects wrong schema, duplicate names, malformed dates/names, `*.com`, mid-name
wildcards, invalid addresses, unsafe URLs, records with no target, and target loops.
It deliberately allows real IANA names.

The registry repository's `scripts/validate.mjs` independently validates the source
tree: every file must sit at its derived path, duplicate names are rejected, and
manifest counts must match. That is the collision/overwrite guard.

## Conflict states (fallback only)

| DoH result | Behavior |
| --- | --- |
| `none` | Registry result; user confirms |
| `exists` | Conflict screen; registry or public |
| `error` | Registry result; conflict unverified |
| `disabled` | Registry result; public bypass unavailable |

Resolver mode does not perform DoH conflict checks; the registry record is the
answer, matching DNS semantics.

## Firefox / Chrome

- Chrome 121+ uses `background.service_worker` and `chrome.proxy.settings` + PAC.
- Firefox 140+ uses `background.scripts` and `browser.proxy.onRequest`.
- Firefox ignores `background.service_worker` (expected lint warning).
- `src/lib/api.ts` selects `browser` when present, otherwise `chrome`.
- `browser_specific_settings.gecko.data_collection_permissions` declares `none`.

## Failure behavior

| Failure | Result |
| --- | --- |
| Registry 404/500/timeout | Keep last cache; sample only if no cache |
| Invalid remote JSON | Keep last cache; status error |
| Resolver health offline | Clear extension PAC, use DNR fallback |
| Proxy registry load failure | Keep last proxy records; health still reports error |
| Proxy target failure | HTTP 502 |
| HTTPS request | `DIRECT`; not proxied |
| DNR update failure | Status error; previous rules may remain |
| Target loop | Rejected at validation time |
| Target is IP | Resolver uses IP:port; fallback warns |

## Threat model

The registry is the trust boundary. A merged record can point any registered name
at any target. Mitigations are PR review, branch protection, transparent shard
diffs, explicit fallback UI, and GPL-3.0-only distribution.

The local proxy is privileged: it sees HTTP traffic for names it handles and can
connect to arbitrary targets. It binds only to `127.0.0.1`, has no remote code, and
must not be exposed on a LAN. It does not terminate TLS.

The extension has no content scripts and executes no remote code. It validates
registry structure and configures the browser proxy; it does not inspect page
content.

## Scale and performance

- Generated client: 2,000 records max; one PAC condition or DNR rule each.
- Source shards: one record per file; 3/3 tree, 46,656² buckets.
- Proxy refresh: 60 seconds; lookup is exact + wildcard scan; 9 records today.
- A 5-billion-name deployment needs on-demand shard lookup in the proxy and a PAC
  strategy that does not enumerate every name. The proxy is the extension point;
  the generated client is the current bridge.
- DoH cache bounded to 200 entries/10 minutes.
- Sync every 15–1440 minutes (default 360).

## Testing

- Vitest: validation, loops, destinations, DoH parsing, URL policy, settings, ports,
  duplicate names, PAC generation.
- `scripts/e2e.mjs`: raw CDP Chrome fallback/DNR suite with mock DoH.
- Resolver checks:
  - local Node target + proxy: Host preserved for IP target;
  - Chrome extension + local registry/target: URL stayed, target received Host;
  - Firefox + `ipmap.info`: URL stayed and target content loaded;
  - `abc.com` proxy check: target page returned with `Host: abc.com`.
- `web-ext lint` validates the Firefox manifest/API surface.
