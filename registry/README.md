# Free Domain Name registry

This repository is the public, PR-governed source of truth for names in the Free
Domain Name resolver. The browser extension reads `registry.json`, validates it,
and installs one redirect rule per record.

The registry may override **any** domain, including real domains such as
`google.com`. That is intentional. The extension shows a conflict screen when
public DNS also has an answer, and the user chooses which one to open.

## Format

```json
{
  "schemaVersion": 1,
  "name": "Free Domain Name community registry",
  "updatedAt": "2026-11-10T20:30:00Z",
  "records": [
    {
      "name": "google.com",
      "url": "http://example.com/",
      "owner": "free-domain-name",
      "description": "Demo override; remove before production.",
      "updatedAt": "2026-11-10T20:30:00Z"
    }
  ]
}
```

Fields:

- `name`: exact hostname (`google.com`) or one leading wildcard (`*.demo.fdn`).
  It must contain at least one dot. `*.com` is rejected because it would claim a
  whole TLD.
- `url`: HTTP(S) target opened by the browser. Usually authoritative. HTTPS is
  allowed, but v1 does not provide custom-TLD TLS.
- `cname`: hostname target; the extension opens `https://<cname>/`.
- `a` / `aaaa`: DNS metadata. If no URL/CNAME exists, the first address is used as
  an HTTP target.
- `owner`: GitHub handle accountable for the record.
- `description`: optional, max 280 characters.
- `updatedAt`: optional ISO date.

Constraints: max 2,000 records; unique normalized names; no mid-name wildcards;
no URL credentials; no non-HTTP(S) schemes; no target that this same registry also
intercepts (redirect loops).

## Sample records

The sample intentionally includes:

- `google.com` -> `http://example.com/`: demonstrates a real-domain override and
  the public-DNS conflict screen. **Remove this before a production registry.**
- `hello.fdn` and `docs.fdn`: ordinary records.
- `*.demo.fdn`: wildcard record.
- `insecure.fdn`: HTTP/IP warning.
- `secure.fdn`: HTTPS target used by the auto-continue test.

The extension labels this data `SAMPLE REGISTRY` until a remote registry is
available.

## Adding a name

1. Fork this repository.
2. Add or edit one record in `registry.json`.
3. Update the top-level `updatedAt`.
4. Open a Pull Request. CI validates `registry.json` against `schema.json`.
5. A maintainer reviews ownership, target safety, and accuracy.

By opening a PR you confirm you control the target and accept that maintainers may
remove records for abuse, phishing, malware, or trademark issues.

## Security model

- GitHub review and branch protection are the trust boundary.
- A merged record can redirect a real domain. Review accordingly.
- The extension also validates at runtime: duplicate names, schemes, credentials,
  invalid IPs, redirect loops, and the 2,000-record cap.
- The conflict screen is the user's escape hatch for real domains.
- Plain HTTP and IP targets are warned; auto-continue never applies to them.
- Do not publish personal data here. The repository is public forever.

## Local validation

From the extension checkout, point the validator at this file:

```bash
npx tsx scripts/validate-registry.ts /path/to/registry.json
```

The registry repository's CI checks the JSON Schema. The extension validator is the
runtime authority and is stricter.

## License

GPL-3.0-only; see [LICENSE](LICENSE).
