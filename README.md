# Free Domain Name Resolver

A Chrome and Firefox Manifest V3 extension that lets a community registry override
**any hostname**, including real domains such as `google.com`. When a name exists in
both the registry and public DNS, the extension stops and asks the user which one to
open.

The registry is a normal GitHub repository, changed through reviewed pull requests.
The extension is GPL-3.0-only: if you distribute a modified version, it must remain
open source under the same license.

> **Status: v1 MVP, HTTP-first.** Chrome is end-to-end tested in Chrome for Testing.
> Firefox is linted, smoke-loaded, and its DNR redirect is verified. The extension
> does not perform real DNS, does not set the HTTP `Host` header, and does not
> provide custom-TLD TLS. Read [the v1 boundary](#the-v1-boundary) before using it.

![Conflict interstitial](docs/screenshots/conflict.png)

## What it does

1. Fetches the generated client index from a registry you control.
2. Validates every record and installs one `declarativeNetRequest` redirect rule per
   registered name. It does **not** claim a whole TLD, so adding `google.com` does
   not intercept every `.com` site.
3. When you navigate to a registered name, shows a full-page interstitial with the
   record, the destination (including its port), warnings, and a public-DNS check.
4. If the name exists in public DNS too, offers **registry target** or **public DNS
   site**. The public choice adds a tab-scoped, 60-second `allow` rule.

Example with the sample registry:

```text
http://google.com/   -> conflict: public DNS exists -> choose example.com or public google.com
http://hello.fdn/    -> registry record -> http://example.com/
http://docs.fdn/     -> registry record -> http://example.org/
http://ipmap.info/   -> http://ipmap.vitrn.com/
http://abc.fdn/      -> http://203.0.113.10/      (port 80)
http://xyz.fdn/      -> http://203.0.113.10:8080/ (same IP, different port)
http://insecure.fdn/ -> HTTP/IP warning -> never opens automatically
http://unknown.fdn/  -> no rule installed -> normal browser DNS
```

## The v1 boundary

This is important and shapes the whole design.

- **No true DNS.** A browser extension cannot answer DNS queries. The registry
  stores a `url` (or an HTTP fallback from `a`/`aaaa`), and the extension navigates
  to that URL.
- **No `Host` preservation.** The destination is a normal URL. The original path,
  query string, and port are not forwarded to the target. The target URL can carry
  its own port, which is the supported way to reach a service on a non-default port.
- **No TLS for overridden names.** There is no trusted certificate for a name that
  is not delegated in public DNS. v1 is HTTP-first. If the user requested HTTPS and
  the record target is HTTP, the interstitial says so explicitly.
- **Real-domain overrides are allowed.** That is the requested behavior, not a
  loophole. A registry entry for `google.com` can redirect it. The conflict screen
  is the safety mechanism, and the registry's governance is the trust boundary.
- **No IANA allow-list.** The validator rejects only malformed names, single-label
  names, and wildcard-over-a-TLD patterns such as `*.com`.
- **Bounded browser rules.** v1 installs one DNR rule per record so it can leave
  unrelated names alone. Chrome/Firefox allow roughly 5,000 dynamic rules; the
  client index is capped at **2,000 records**.

A true DNS/`Host` implementation for a registry with billions of records requires a
native resolver or local proxy that looks names up on demand. The registry source
tree is already sharded for that future; a browser extension alone cannot install
5 billion rules.

## Try it

Requirements: Node 22+, Chrome 121+, or Firefox 140+.

```bash
npm install
npm run check          # typecheck + 29 tests + build + shard/client validation
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
npx --yes web-ext@10.8.0 lint --source-dir dist --no-input
```

The manifest declares both `background.service_worker` (Chrome) and
`background.scripts` (Firefox), plus `browser_specific_settings`. Chrome 121+
ignores the script entry; Firefox ignores the service-worker entry.

## Registry

The registry repository is separate from the extension so changes are reviewed
without shipping a new extension build:

- Registry: <https://github.com/free-domain-name/registry>
- Client index (what the extension fetches):
  <https://raw.githubusercontent.com/free-domain-name/registry/main/client.json>
- Manifest: [registry/registry.json](registry/registry.json)
- Client sample: [registry/client.json](registry/client.json)
- Schema: [registry/schema.json](registry/schema.json)

### Sharded source, generated client

Records are **not** kept in one editable file. One record lives in one file:

```text
registry/
  registry.json                 # manifest: schema, layout, counts
  client.json                   # generated, do not hand-edit
  names/
    goo/gle/google.com.json
    hel/lof/hello.fdn.json
    doc/sfd/docs.fdn.json
    dem/ofd/_wildcard.demo.fdn.json
    ins/ecu/insecure.fdn.json
    abc/fdn/abc.fdn.json
    xyz/fdn/xyz.fdn.json
    ipm/api/ipmap.info.json
```

The path is deterministic: remove dots from the name, use the first three
characters as the first directory and the next three as the second. The full name
stays in the filename and in the record.

| Name | Path |
| --- | --- |
| `google.com` | `names/goo/gle/google.com.json` |
| `abc.com` | `names/abc/com/abc.com.json` |
| `*.demo.fdn` | `names/dem/ofd/_wildcard.demo.fdn.json` |

`client.json` is generated by `node registry/scripts/build-client.mjs`. It exists
because DNR needs a bounded local list; the shards are the reviewable source of
truth. The 2,000-record client cap is a browser limit, not a directory limit.

A single record file looks like this:

```json
{
  "name": "insecure.fdn",
  "url": "http://203.0.113.10:8080/",
  "a": ["203.0.113.10"],
  "owner": "free-domain-name",
  "description": "HTTP/IP-only demo with a non-default port. TEST-NET-3 is not reachable.",
  "updatedAt": "2026-11-10T21:30:00Z"
}
```

Supported fields:

| Field | Meaning |
| --- | --- |
| `name` | Exact hostname (`google.com`) or one wildcard (`*.demo.fdn`). At least one dot required. |
| `url` | HTTP(S) URL opened by the browser. **Ports are allowed and preserved.** |
| `cname` | Hostname target; the extension opens `https://<cname>/`. |
| `a` / `aaaa` | DNS metadata. If no URL/CNAME, the first address becomes an HTTP target. |
| `owner` | GitHub handle of the steward. |
| `description` | Optional, up to 280 characters. |
| `updatedAt` | Optional ISO date for this record. |

Validation rejects duplicate names, files outside their deterministic shard path,
mid-name wildcards, credentials in URLs, unsafe schemes, invalid IPs, ports that
make a URL invalid, targets that are also intercepted by the same registry (loops),
and names with no dot.

### Collision and overwrite rules

- A name maps to exactly one path. Duplicate names are rejected by
  `registry/scripts/validate.mjs`; CI also checks that the path matches the name.
- Two different names may share an IP **and** a port. Only the name must be unique.
  `abc.fdn` and `xyz.fdn` both use `203.0.113.10`; one uses port 80 and the other
  8080. That is valid.
- Changing an existing record means editing its one file in a PR. Protect `main`,
  require review, and treat owner changes as security changes. The validator cannot
  prove that a PR author is the owner; GitHub review is the authorization boundary.
- The registry is capped at 2,000 records for the browser client. See the scale
  note in [registry/README.md](registry/README.md).

### Publish the registry

Copy [registry/](registry/) to the root of `free-domain-name/registry`, commit, and
push. Registry CI runs:

```bash
node scripts/validate.mjs
node scripts/build-client.mjs --check
npx ajv validate -s schema.json -d client.json ...
```

Run the stricter extension runtime validator locally with:

```bash
npm run validate:registry
```

In the extension, open **Settings**, set the client-index URL, and press **Sync
now**. Until the remote is available, the built-in sample is used and labelled
`Sample registry` everywhere. The sample intentionally includes a `google.com`
override so the conflict flow can be demonstrated; remove it before production.

## Conflict and safety behavior

Public DNS is checked with DNS-over-HTTPS (Cloudflare by default, configurable).
The result is one of:

| Public DNS | Registry record | Behavior |
| --- | --- | --- |
| `none` | yes | Registry interstitial; user confirms the target |
| `exists` | yes | Conflict screen; user chooses registry or public site |
| `error` | yes | Registry interstitial, conflict marked unverified |
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
- `npm test` — 29 Vitest tests for validation, destinations, DoH parsing, URL
  policy, settings, target ports, and duplicate-name collisions.
- `npm run test:e2e` — raw CDP test in Chrome for Testing. Covers arbitrary-domain
  conflict (`google.com`), registry navigation, non-interception of unregistered
  names, HTTP/IP warnings, port preservation, tab-scoped public bypass, popup
  toggle, and options. It also refreshes the screenshots.
- `npm run validate:registry` — validates the generated client with the extension
  validator.
- `npx web-ext@10.8.0 lint --source-dir dist` — Firefox manifest/API lint.
- Firefox smoke: temporary `web-ext` install plus a BiDi navigation confirmed the
  `google.com` DNR redirect to the interstitial.

## Screenshots

| | |
| --- | --- |
| ![Conflict](docs/screenshots/conflict.png) | ![Insecure target](docs/screenshots/insecure.png) |
| ![Popup](docs/screenshots/popup.png) | ![Settings](docs/screenshots/options.png) |
