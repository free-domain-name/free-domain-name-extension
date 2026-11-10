# Security policy

## Supported versions

The project is pre-1.0. Fixes land on `main` and in the latest tagged release.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could redirect users or expose
data. Use GitHub's private vulnerability reporting on
`free-domain-name/free-domain-name-extension`, or contact a maintainer listed in the
organization profile. Include reproduction steps and the affected version. Do not
include real user data.

## Scope

In scope:

- bypassing the interstitial or the destination validation;
- DNR rules that intercept names outside the registry;
- registry URL redirect tricks, size/ETag/cache bugs;
- path traversal or web-accessible-resource abuse;
- DoH parsing/caching bugs that hide a conflict;
- Chrome/Firefox permission or manifest issues;
- extension pages executing untrusted registry content.

Out of scope, by design:

- a registry record resolving a real domain to an attacker-chosen target (the
  registry is the trust boundary; review is the control);
- HTTP targets being readable/modifiable;
- no TLS for overridden names;
- a malicious target serving unsafe content;
- a malicious DoH resolver returning false answers in fallback mode.

## Security model

- The registry is trusted input. Anyone who can merge to it can redirect any
  registered name, including `google.com`.
- In resolver mode the local proxy connects to the record target and keeps the
  requested name in the browser. The registry's answer is the resolution; there is
  no conflict screen on that path.
- In fallback mode the conflict screen lets the user choose public DNS, but it is
  not proof that either side is honest.
- HTTPS targets use the browser's normal certificate validation. There is no
  custom-TLD certificate. HTTPS is not proxied.
- HTTP and IP targets are flagged in fallback mode; HTTP never auto-opens.
- Registry records are sharded one file per name. CI rejects duplicate names and
  files outside the deterministic shard path, so a second record cannot silently
  overwrite a name. Changing an existing file still requires reviewed PR approval.
- GPL-3.0-only keeps distributed modifications open source; it is not a security
  boundary.

## Hardening in v1

- Registry schema validation, shard-path/duplicate/loop checks, 5 MB cap,
  2,000-record client cap.
- HTTP(S)-only URLs; credentials and non-HTTP schemes rejected.
- Same-origin registry redirect check.
- One DNR rule per exact/wildcard record, `main_frame` only.
- Resolver PAC/Firefox listener routes only registry-managed HTTP names to a
  loopback proxy; proxy settings are cleared only if they contain this extension's
  marker.
- The local proxy binds to `127.0.0.1`, supports HTTP only, rewrites target
  `Location`/`Set-Cookie` domains, and never terminates TLS.
- Tab-scoped public bypass session rule, priority above redirects, 60-second TTL.
- No content scripts and no remote code.
- Explicit conflict, sample, stale, HTTP, IP, and HTTPS-to-HTTP warnings in
  fallback mode.
- Target ports are first-class. Two names may share an IP/port; only the name is
  unique.

## Registry compromise

If a malicious record is merged, publish an advisory, revert the record, and ask
users to press **Sync now**. The extension has no remote kill switch beyond the
registry itself; disabling interception in the popup immediately clears all
dynamic rules.
