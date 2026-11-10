# Free Domain Name Resolver

A Chrome and Firefox Manifest V3 extension that lets a community registry override
**any hostname**, including real domains such as `google.com`. When a name exists in
both the registry and public DNS, the extension stops and asks the user which one to
open.

The registry is a normal GitHub repository, changed through reviewed pull requests.
The extension is GPL-3.0-only: if you distribute a modified version, it must remain
open source under the same license.

> **Status: v1 MVP.** Chrome is end-to-end tested in Chrome for Testing. Firefox is
> linted with `web-ext` and loads as a temporary add-on. The extension does not
> perform real DNS, does not set the HTTP `Host` header, and does not provide TLS
> for overridden names. Read [the v1 boundary](#the-v1-boundary) before using it.

![Conflict interstitial](docs/screenshots/conflict.png)

## What it does

1. Fetches a JSON registry from a URL you control.
2. Validates every record and installs one `declarativeNetRequest` redirect rule per
   registered name. It does **not** claim a whole TLD, so adding `google.com` does
   not intercept every `.com` site.
3. When you navigate to a registered name, shows a full-page interstitial with the
   record, the destination, warnings, and a public-DNS conflict check.
4. If the name exists in public DNS too, offers **registry target** or **public DNS
   site**. The public choice adds a tab-scoped, 60-second `allow` rule.
5. If enabled and safe, auto-continues to an HTTPS target after 1.8 seconds. HTTP,
   IP-only, conflicting, disabled, and unverifiable targets always require a click.

Example with the sample registry:

```text
http://google.com/   -> conflict: public DNS exists -> choose example.com or public google.com
http://hello.fdn/    -> registry record -> http://example.com/
http://secure.fdn/   -> HTTPS target -> auto-continue
http://insecure.fdn/ -> HTTP/IP warning -> never auto-open
http://unknown.fdn/  -> no rule installed -> normal browser DNS
```

## The v1 boundary

This is important and shapes the whole design.

- **No true DNS.** A browser extension cannot answer DNS queries. The registry
  stores a `url` (or an HTTP fallback from `a`/`aaaa`), and the extension navigates
  to that URL.
- **No `Host` preservation.** The destination is a normal URL. Original path,
  query string, and port are not forwarded to the target.
- **No TLS for overridden names.** There is no trusted certificate for a name that
  is not delegated in public DNS. v1 is HTTP-first. If the user requested HTTPS and
  the record target is HTTP, the interstitial says so explicitly.
- **Real-domain overrides are allowed.** That is the requested behavior, not a
  loophole. A registry entry for `google.com` can redirect it. The conflict screen
  is the safety mechanism, and the registry's governance is the trust boundary.
- **No IANA allow-list.** Earlier drafts refused real IANA TLDs. That made
  `google.com` impossible, so it was removed. The validator now rejects only
  single-label names and wildcard-over-a-TLD patterns such as `*.com`.
- **Bounded scale.** v1 installs one DNR rule per record so it can leave unrelated
  names alone. Chrome/Firefox allow roughly 5,000 dynamic rules; the registry is
  capped at **2,000 records**. True DNS would remove this limit.

A true DNS/`Host`/TLS implementation requires a native resolver or local proxy, plus
a locally trusted CA for HTTPS. That is roadmap work, not an extension-only change.

## Try it

Requirements: Node 22+, Chrome 121+, or Firefox 140+.

```bash
npm install
npm run check          # typecheck + 28 unit tests + build
npm run test:e2e       # Chrome for Testing, writes docs/screenshots/*.png
npm run validate:registry
npm run build
```

Load the **same `dist/` directory** in either browser:

- **Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**
  → `dist/manifest.json`.

For a reproducible Firefox check:

```bash
npx --yes web-ext lint --source-dir dist --no-input
```

The manifest declares both `background.service_worker` (Chrome) and
`background.scripts` (Firefox), plus `browser_specific_settings`. Chrome 121+
ignores the script entry; Firefox 121+ ignores the service-worker entry.

## Registry

The registry repository is separate from the extension so changes are reviewed
without shipping a new extension build:

- Registry: <https://github.com/free-domain-name/registry>
- Raw file: <https://raw.githubusercontent.com/free-domain-name/registry/main/registry.json>
- Schema: [registry/schema.json](registry/schema.json)
- Sample: [registry/registry.json](registry/registry.json)

A minimal record:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-10T20:30:00Z",
  "records": [
    {
      "name": "google.com",
      "url": "http://example.com/",
      "owner": "free-domain-name",
      "description": "Demo override. Remove before production."
    }
  ]
}
```

Supported record fields:

| Field | Meaning |
| --- | --- |
| `name` | Exact hostname (`google.com`) or one wildcard (`*.demo.fdn`). At least one dot required. |
| `url` | HTTP(S) URL opened by the browser. Usually the authoritative destination. |
| `cname` | Hostname target; the extension opens `https://<cname>/`. |
| `a` / `aaaa` | DNS metadata. If no URL/CNAME, the first address becomes an HTTP target. |
| `owner` | GitHub handle of the steward. |
| `description` | Optional, up to 280 characters. |
| `updatedAt` | Optional ISO date for this record. |

Validation rejects duplicate names, mid-name wildcards, credentials in URLs,
unsafe schemes, invalid IPs, targets that are also intercepted by the same registry
(redirect loops), and names with no dot. The registry is capped at 2,000 records.

### Publish the registry

Copy [registry/](registry/) to the root of `free-domain-name/registry`, commit, and
push. Registry CI validates the JSON against the schema; run the stricter runtime
validator locally with:

```bash
npm run validate:registry
```

In the extension, open **Settings**, set the raw registry URL, and press **Sync
now**. Until the remote is available, the built-in sample is used and labelled
`SAMPLE REGISTRY` everywhere. The sample intentionally includes a `google.com`
override so the conflict flow can be demonstrated; remove it before production.

## Conflict and safety behavior

Public DNS is checked with DNS-over-HTTPS (Cloudflare by default, configurable).
The result is one of:

| Public DNS | Registry record | Behavior |
| --- | --- | --- |
| `none` | yes | Registry interstitial; auto-continue only for safe HTTPS |
| `exists` | yes | Conflict screen; user chooses registry or public site |
| `error` | yes | Registry interstitial, conflict marked unverified; no auto |
| `disabled` | yes | Registry interstitial; no public bypass |
| `none` / `exists` | no | No DNR rule, so the request is untouched |

Warnings are always shown for plain HTTP targets, IP-literal targets, and HTTPS
navigations that resolve to an HTTP target. The public-DNS choice is limited to the
current tab and expires after 60 seconds.

## Permissions

| Permission | Why |
| --- | --- |
| `declarativeNetRequest` | Install and remove per-record redirect rules. |
| `host_permissions: <all_urls>` | Dynamic redirect rules require host access; it also lets the background fetch the configured registry. |
| `storage` | Cache the registry, settings, sync status, and short-lived DoH results. |
| `alarms` | Periodic registry sync and session-rule cleanup. |

There are no content scripts and no remote code. The interstitial is a packaged
extension page. `<all_urls>` is broad; a future version can request optional host
permissions per registry record, but DNR redirects still need host access.

## Security model

- The registry is trusted input. Anyone who can merge to it can redirect any
  registered name. Use branch protection, required reviews, and signed commits.
- HTTPS targets are only as trustworthy as their normal certificate. An HTTP
  target is unencrypted, and the UI says so.
- The conflict screen is the user's escape hatch for a real domain. It is not a
  guarantee that the registry is honest.
- The extension validates structure and destinations, but cannot verify that the
  registry's claims are true.
- GPL-3.0-only keeps distributed modifications open. It is not a security control.

See [SECURITY.md](SECURITY.md) and [docs/architecture.md](docs/architecture.md).

## Privacy

- The registry URL and DoH endpoint are user-configured.
- The extension sends the visited **registered** hostname to the DoH resolver to
  check for conflicts. It does not send browsing history.
- DoH providers see those names and the user's IP address. This can be disabled.
- Registry fetches go to the configured URL. There is no analytics or telemetry.
- See [docs/privacy.md](docs/privacy.md).

## Firefox notes

- Firefox 140+ is required by the current `data_collection_permissions` manifest
  field; the extension itself targets Firefox 121+ behavior.
- Firefox uses the event-page background (`background.scripts`); Chrome uses the
  service worker.
- DNR session rules with `tabIds` are supported, so the 60-second public bypass is
  tab-scoped in both browsers.
- `web-ext lint` reports one warning: Firefox ignores `background.service_worker`.
  That is expected because `background.scripts` is present.
- Chrome E2E is automated. Firefox is linted, smoke-loaded with `web-ext`, and its
  DNR path was verified via WebDriver BiDi: `http://google.com/` redirects to the
  packaged `moz-extension://.../interstitial.html?scheme=http&host=google.com`
  page. The same UI/DNR code is shared.

## Tests

- `npm run typecheck` — strict TypeScript.
- `npm test` — 28 Vitest tests for validation, destinations, DoH parsing, URL
  policy, and settings.
- `npm run test:e2e` — raw CDP test in Chrome for Testing. Covers arbitrary-domain
  conflict (`google.com`), registry navigation, non-interception of unregistered
  names, HTTP/IP warnings, HTTPS auto-continue, tab-scoped public bypass, popup
  toggle, and options. It also refreshes the screenshots.
- `npm run validate:registry` — validates the sample with the extension validator.
- `npx web-ext lint --source-dir dist` — Firefox manifest/API lint.
- Firefox smoke: temporary `web-ext` install plus a BiDi navigation confirmed the
  `google.com` DNR redirect to the interstitial.

## Screenshots

| | |
| --- | --- |
| ![Conflict](docs/screenshots/conflict.png) | ![Insecure target](docs/screenshots/insecure.png) |
| ![Popup](docs/screenshots/popup.png) | ![Settings](docs/screenshots/options.png) |

## Repository layout

```text
src/
  background.ts        service worker / event page
  interstitial.ts      consent, conflict, warnings
  popup.ts             status and toggle
  options.ts           settings and status
  lib/
    api.ts             browser/chrome promise alias
    validation.ts      pure registry validation + lookup
    rules.ts           per-record DNR rules + session allow
    registry.ts        fetch, cache, sync, sample fallback
    doh.ts             conflict checks
    settings.ts        sanitized settings
    urls.ts            HTTPS/loopback URL policy
public/                manifest, HTML, CSS, icons
registry/              sample registry, schema, registry CI
scripts/e2e.mjs        Chrome E2E
tests/                 Vitest
docs/                  architecture, privacy, screenshots
```

## Roadmap

1. Publish the registry with branch protection and a review policy.
2. Decide whether the URL-target model is sufficient or whether a native resolver
   (`Host` header + local CA) is required. That is the only path to true virtual
   hosting over HTTPS.
3. Optional host permissions / per-record DNR to reduce the `<all_urls>` grant.
4. Firefox automated E2E with WebDriver BiDi.
5. Signed Chrome/Firefox builds and store listings.
6. Registry moderation tooling, audit log, and key signing.

## License

GPL-3.0-only. See [LICENSE](LICENSE). The registry data in this repository is
distributed under the same license unless a registry repository states otherwise.
