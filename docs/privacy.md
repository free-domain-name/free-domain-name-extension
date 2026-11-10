# Privacy

_Last updated: 2026-11-10_

Free Domain Name Resolver runs locally. The project operates no analytics service,
sells no data, and includes no telemetry.

## Local storage

`storage.local`:

- the cached registry and its ETag/source/fetch time;
- sync status and the last error;
- settings (registry URL, interval, DoH endpoint, enable flag, resolver toggle and
  loopback port).

`storage.session` / memory:

- a 10-minute DoH result cache (successful lookups only);
- no browsing history.

Uninstalling the extension removes its local data.

## Network requests

| Destination | When | Data |
| --- | --- | --- |
| Registry URL | Sync at install/startup/alarm/manual | Normal HTTP request; no cookies or identifiers |
| DoH endpoint | Fallback mode, when a registered name is opened | The hostname, query type (A/AAAA), and the user's IP |
| Registry target | Resolver mode or after the user continues in fallback | Normal HTTP request; the local proxy sees it |
| `127.0.0.1:<resolverPort>` | Sync/settings health check | No user data; just a health probe |

In **resolver mode** the extension does not query DoH at all. It sends the
registry-managed HTTP request to the local proxy on `127.0.0.1`; that proxy connects
to the record target. In **fallback mode** the extension queries DoH only for names
that reached the interstitial because a registry record matched. Names with no
record are untouched and never queried by the extension.

The default DoH provider is Cloudflare (`https://cloudflare-dns.com/dns-query`);
Google (`https://dns.google/resolve`) is also supported. The endpoint is
configurable, and public-DNS checking can be disabled entirely. A DoH provider sees
the queried name, the user's IP address, and timing. This is the privacy trade-off
for conflict detection.

Registry fetches go to the URL configured in Settings. The default is the public
`free-domain-name/registry` raw GitHub URL. GitHub sees the request as it would any
other raw-file fetch.

## Permissions

`host_permissions: <all_urls>` is required because proxy/PAC routing and dynamic
DNR redirect rules need host access. It is also what lets the background fetch the
registry. The `proxy` permission is used only to route registry-managed HTTP names
to the loopback resolver; it does not route ordinary HTTP or any HTTPS. There are no
content scripts, no remote code, and no data collection.

## Store disclosure

For a Chrome Web Store or Firefox AMO listing, disclose:

- local storage of registry/settings;
- network requests to the configured registry and DoH resolver;
- the hostname sent to DoH for registered names in fallback mode;
- local resolver-proxy use (loopback only);
- no sale, analytics, or advertising.

Firefox's manifest declares `data_collection_permissions.required: ["none"]`.
That is accurate in the sense that the extension does not collect data for the
developer. DoH queries are made by the browser to a resolver chosen by the user;
if a store reviewer treats those as collection, disclose them explicitly in the
listing.
