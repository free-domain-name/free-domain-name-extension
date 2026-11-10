# Contributing

- One logical change per PR.
- Record additions must set `owner` to your GitHub handle.
- You may propose an exact name or one wildcard. A record must contain at least one
  dot; whole-TLD wildcards such as `*.com` are rejected.
- Any domain is allowed, including real domains such as `google.com`. Expect extra
  review for those: the extension will show a public-DNS conflict to users.
- Prefer an HTTPS `url` target you control. v1 is HTTP-first and will warn about
  HTTP/IP targets, but HTTPS is still the better default for a normal site.
- Do not claim names for other people, brands you do not own, or illegal content.
- Do not add redirect loops: a target that is also intercepted by this registry is
  rejected.
- Security fixes (removing a malicious record) should reference the incident in
  the PR description and may be fast-tracked by maintainers.
- CI must pass. The extension also validates the registry at runtime, so a schema
  pass is necessary but not sufficient.
