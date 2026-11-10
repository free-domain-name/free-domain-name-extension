# Architecture

This document describes v1's components, per-record DNR model, sync/cache behavior,
conflict handling, failure modes, and threat model. For setup, see the
[README](../README.md).

## Components

| Component | Responsibility |
| --- | --- |
| `src/background.ts` | Sync, DNR rules, settings, resolve/bypass/toggle messages. |
| `src/interstitial.ts` | Consent, record facts, warnings, conflict choice. |
| `src/popup.ts` | Status, name/wildcard counts, enable toggle, sync. |
| `src/options.ts` | Registry URL, interval, DoH endpoint, status. |
| `src/lib/validation.ts` | Pure registry validation, lookup, destinations, loop checks. |
| `src/lib/rules.ts` | One redirect rule per record; tab-scoped session allow rule. |
| `src/lib/registry.ts` | Fetch, ETag, size cap, cache, sample fallback, apply rules. |
| `src/lib/doh.ts` | DoH A/AAAA conflict checks and short cache. |
| `src/lib/api.ts` | `browser` (Firefox) / `chrome` (Chrome) promise alias. |
| `registry/` | Sharded source records, generated client, validator, schema, CI. |

## Request flow

```text
navigation to registered host
  -> DNR redirects main_frame to:
     chrome-extension://.../interstitial.html?scheme=https&host=google.com
  -> interstitial sends {type:"resolve", host, scheme} to the background
  -> background looks up the record and queries DoH
  -> interstitial renders one of:
       resolved / conflict / no-record / error
  -> user clicks the registry target or the public DNS site
```

The interstitial is a packaged extension page listed in
`web_accessible_resources`. DNR cannot query the registry at request time, so every
match lands here first.

## DNR rules

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

Details:

- The regex matches the whole URL because DNR appends unmatched text to a regex
  substitution.
- Exact records have priority `1000`; wildcards use `100 + label count`, so a more
  specific wildcard wins over a broader one. Exact always wins.
- Rules are only `main_frame`; embedded images/scripts are not hijacked.
- One rule per record means `google.com` can be added without intercepting every
  `.com` site. It also caps v1 at 2,000 records, below the browser's dynamic-rule
  limit. A destination URL may carry a port such as `:8080`; the port is part of
  the target and is preserved by the browser.
- Rule IDs are assigned from the current record order; a sync removes all existing
  dynamic rules and adds the new set.

### Public DNS bypass

The bypass creates a **session** rule:

```text
tabIds: [currentTab]
requestDomains: ["google.com"]
resourceTypes: ["main_frame"]
action: allow
priority: 5000
```

The priority is deliberately above exact-record redirects (1000). Without it, the
redirect would win and the user would bounce back to the interstitial. An alarm
removes the rule after 60 seconds. Session rules are not persisted to disk.

## Registry source and sync

The reviewable source is sharded one record per file:

```text
names/<first3>/<next3>/<name>.json
```

`recordPath()` is deterministic (dots removed, then 3 + 3 characters). A shard
file contains exactly one record. The CI checks the path, duplicate names, ports,
URLs, IPs, and target loops. `client.json` is generated from those files for the
browser and is never hand-edited. This keeps PR diffs small and avoids one central
record file while still giving DNR a bounded list.

```text
onInstalled / onStartup / alarm / manual Sync
  -> read settings
  -> GET client.json with ETag
  -> size cap (5 MB)
  -> same-origin redirect check
  -> validateRegistry
  -> cache in storage.local
  -> replace dynamic rules
  -> write syncStatus
```

- A failed fetch keeps the last valid cache and its rules.
- If there is no cache, the bundled sample is validated and used, labelled
  `source: "sample"`.
- A 304 reuses the remote cache and refreshes `fetchedAt`.
- Changing the registry URL clears the cache, sync status, and session rules so
  records from two endpoints cannot mix.
- Non-registry settings changes reapply cached rules without a network round trip.

## Validation

`validateRegistry` is pure and runs in unit tests, the extension, and the CLI. The
registry repository's `scripts/validate.mjs` independently checks the sharded
source: every file must sit at the path derived from its name, duplicate names are
rejected, and manifest counts must match. That is the collision/overwrite guard.

`validateRegistry` rejects:

- wrong schema version or malformed dates;
- duplicate normalized names;
- names without a dot, and `*.com`-style wildcard-over-TLD;
- mid-name wildcards;
- invalid IPv4/IPv6 literals;
- URLs with non-HTTP(S) schemes or credentials;
- records with no destination;
- targets that this same registry also intercepts (redirect chains/loops).

It deliberately does **not** reject real IANA names. `google.com` is allowed. The
shard validator also allows two names to share an IP and port; only names must be
unique.

## Conflict states

| DoH result | Behavior |
| --- | --- |
| `none` | Registry result; user confirms the target |
| `exists` | Conflict screen; choose registry or public |
| `error` | Registry result; conflict unverified |
| `disabled` | Registry result; public bypass unavailable |

DoH answers are cached in memory/session for 10 minutes on success only. Errors are
never cached. A and AAAA are queried in parallel.

## Auto-open

Auto-open is not exposed in the v1 settings UI and defaults to disabled. The legacy
code path is HTTPS-only; HTTP, IP, conflict, disabled, and error paths never
auto-open. The HTTP-first sample therefore always waits for a click.

## Firefox / Chrome

The same bundle targets both:

- Chrome 121+ uses `background.service_worker` and ignores `background.scripts`.
- Firefox 140+ uses `background.scripts` and ignores the service worker.
- `src/lib/api.ts` selects `browser` when present, otherwise `chrome`; the MV3
  methods used here return promises in both.
- DNR, storage.session, alarms, and tab-scoped session rules are shared.
- `browser_specific_settings.gecko.data_collection_permissions` declares `none`.

`web-ext lint` warns that Firefox ignores the service-worker key; this is expected.

## Failure behavior

| Failure | Result |
| --- | --- |
| Registry 404/500/timeout | Keep last cache; sample only if no cache |
| Invalid remote JSON | Keep last cache; validation error in status |
| Invalid sample | No rules; explicit error |
| DNR update failure | Status error; previous rules may remain |
| DoH timeout/error | Registry page; conflict unverified |
| Target loop | Rejected at validation time |
| Target is IP | HTTP fallback; warning |
| `https` request to `http` target | Warning |

## Threat model

The registry is the trust boundary. A merged record can redirect any registered
domain, including a real one. Mitigations are transparent PR review, branch
protection, conflict UI, HTTP warnings, and GPL-3.0-only distribution. There is no
cryptographic proof that a record is legitimate.

The extension itself:

- has no content scripts and executes no remote code;
- validates all URLs and record shapes;
- never sends full browsing history to DoH—only names that reached the
  interstitial;
- does not preserve the original request path/query/port (the registry target's own port is explicit), and does not claim TLS for custom names.

A compromised registry can phish users who click through. That is why the conflict
screen is explicit, why the sample is labelled, and why the registry governance is
part of the security model.

## Scale and performance

- 2,000 client records max; one DNR rule each.
- Source shards are one record per file; the generated client is the bounded bridge.
- Lookup is a Map plus a short wildcard suffix walk.
- Registry payload capped at 5 MB.
- A 3/3 shard tree spreads names over 46,656 first-level and 46,656 second-level
  buckets. That is a repository-layout fix, not a substitute for a database or a
  browser's 5,000-rule ceiling. A 5-billion-name deployment needs an on-demand local
  resolver/proxy, not a preloaded DNR list.
- DoH cache bounded to 200 entries/10 minutes.
- Sync runs every 15–1440 minutes (default 360).

## Testing

- Vitest covers validation, loops, destinations, DoH parsing, URL policy, settings,
  ports, and duplicate-name collisions.
- `scripts/e2e.mjs` uses raw CDP in Chrome for Testing and a mock DoH server.
- `web-ext lint` validates the Firefox manifest and API surface.
- Firefox is smoke-loaded with `web-ext run`; a BiDi navigation confirmed
  `google.com` redirects to the `moz-extension://` interstitial. Chrome has the full
  scripted E2E.
