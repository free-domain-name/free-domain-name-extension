# Contributing

- One logical change per PR.
- Add one JSON file under `names/<first3>/<next3>/<name>.json`; do not add records to a central file.
- Run `node scripts/validate.mjs` and `node scripts/build-client.mjs` before pushing.
- Record additions must set `owner` to your GitHub handle.
- A record must contain at least one dot; whole-TLD wildcards such as `*.com` are rejected.
- Any domain is allowed, including real domains such as `google.com`. Expect extra review for those: the extension shows a public-DNS conflict to users.
- Ports are allowed in `url`. Two different names may share an IP and a port; only the name must be unique.
- Do not add a second record for a name that already exists. CI rejects duplicate names and files outside their deterministic shard path. To change an existing record, edit its file in a PR; the diff and review are the overwrite protection.
- Prefer an HTTP URL you control for v1. HTTPS targets are ordinary URLs, not custom-TLD TLS.
- Do not claim names for other people, brands you do not own, or illegal content.
- Do not add redirect loops: a target that is also intercepted by this registry is rejected.
- Security fixes (removing a malicious record) should reference the incident in the PR description and may be fast-tracked by maintainers.
- CI must pass. The extension also validates the generated client at runtime, so a schema pass is necessary but not sufficient.
