import { describe, expect, it } from "vitest";
import sampleRegistry from "../registry/client.json";
import type { Registry, RegistryRecord } from "../src/lib/types";
import {
  RegistryValidationError,
  buildDestination,
  destinationWarnings,
  isDestinationSafe,
  lookupRecord,
  normalizeHostname,
  normalizeRecordName,
  schemeDowngradeWarning,
  validateRegistry,
} from "../src/lib/validation";

function base(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 2,
    updatedAt: "2026-11-10T19:00:00Z",
    records: [
      {
        name: "hello.fdn",
        url: "https://example.com/",
        owner: "octocat",
      },
    ],
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "hello.fdn",
    url: "https://example.com/",
    owner: "octocat",
    ...overrides,
  };
}

describe("registry validation", () => {
  it("accepts the published sample registry, including a real domain", () => {
    const parsed = validateRegistry(sampleRegistry);
    expect(parsed.records).toHaveLength(8);
    expect(parsed.records.map((item) => item.name)).toContain("google.com");
    expect(parsed.records.find((item) => item.name === "google.com")?.url).toBe(
      "http://example.com/",
    );
    expect(parsed.records.find((item) => item.name === "xyz.fdn")?.url).toBe(
      "http://203.0.113.10:8080/",
    );
    expect(parsed.records.find((item) => item.name === "abc.fdn")?.url).toBe(
      "http://203.0.113.10/",
    );
    expect(parsed.records.find((item) => item.name === "ipmap.info")?.url).toBe(
      "http://ipmap.vitrn.com/",
    );
  });

  it("allows the same IP on different ports but rejects duplicate names", () => {
    const parsed = validateRegistry(
      base({
        records: [
          record({ name: "abc.com", url: "http://1.1.1.1/" }),
          record({ name: "xyz.com", url: "http://1.1.1.1:8080/" }),
        ],
      }),
    );
    expect(parsed.records).toHaveLength(2);
    expect(() =>
      validateRegistry(
        base({
          records: [
            record({ name: "abc.com", url: "http://1.1.1.1/" }),
            record({ name: "ABC.com", url: "http://1.1.1.1:8080/" }),
          ],
        }),
      ),
    ).toThrow(/duplicate/i);
  });

  it("normalizes names and wildcards", () => {
    const parsed = validateRegistry(
      base({
        records: [
          record({ name: "Hello.FDN" }),
          record({ name: "*.Demo.FDN", url: "https://example.net/" }),
        ],
      }),
    );
    expect(parsed.records[0]?.name).toBe("hello.fdn");
    expect(parsed.records[1]?.name).toBe("*.demo.fdn");
  });

  it("accepts arbitrary real domains such as google.com", () => {
    const parsed = validateRegistry(
      base({ records: [record({ name: "google.com", url: "http://example.com/" })] }),
    );
    expect(parsed.records[0]?.name).toBe("google.com");
  });

  it("rejects a bare TLD or a wildcard over a whole TLD", () => {
    expect(() => validateRegistry(base({ records: [record({ name: "com" })] }))).toThrow(
      /at least one dot/,
    );
    expect(() => validateRegistry(base({ records: [record({ name: "*.com" })] }))).toThrow(
      /at least one dot/,
    );
  });

  it("rejects duplicate names after normalization", () => {
    const payload = base({
      records: [record({ name: "hello.fdn" }), record({ name: "HELLO.fdn" })],
    });
    expect(() => validateRegistry(payload)).toThrow(/Duplicate record name/);
  });

  it("rejects wildcard labels in the middle", () => {
    const payload = base({ records: [record({ name: "a.*.fdn" })] });
    expect(() => validateRegistry(payload)).toThrow(RegistryValidationError);
  });

  it("rejects javascript and credential-bearing URLs", () => {
    for (const url of ["javascript:alert(1)", "https://user:pass@example.com/"]) {
      expect(() => validateRegistry(base({ records: [record({ url })] }))).toThrow(
        RegistryValidationError,
      );
    }
  });

  it("rejects a target that is also intercepted", () => {
    expect(() =>
      validateRegistry(base({ records: [record({ name: "google.com", url: "https://google.com/" })] })),
    ).toThrow(/also intercepts/);

    expect(() =>
      validateRegistry(
        base({
          records: [
            record({ name: "*.demo.fdn", url: "https://x.demo.fdn/" }),
          ],
        }),
      ),
    ).toThrow(/also intercepts/);
  });

  it("rejects a record without a destination", () => {
    const payload = base({ records: [{ name: "hello.fdn", owner: "octocat" }] });
    expect(() => validateRegistry(payload)).toThrow(/destination/);
  });

  it("rejects invalid IP literals", () => {
    expect(() => validateRegistry(base({ records: [record({ a: ["01.2.3.4"] })] }))).toThrow(
      /IPv4/,
    );
    expect(() => validateRegistry(base({ records: [record({ aaaa: ["fe80::1%eth0"] })] }))).toThrow(
      /IPv6/,
    );
  });

  it("rejects invalid owners", () => {
    expect(() => validateRegistry(base({ records: [record({ owner: "not a handle" })] }))).toThrow(
      /owner/,
    );
  });
});

describe("lookup", () => {
  const registry: Registry = {
    schemaVersion: 2,
    updatedAt: "2026-11-10T19:00:00Z",
    records: [
      {
        name: "*.demo.fdn",
        a: [],
        aaaa: [],
        url: "https://example.net/",
        owner: "octocat",
      },
      {
        name: "exact.demo.fdn",
        a: [],
        aaaa: [],
        url: "https://example.org/",
        owner: "octocat",
      },
    ],
  };

  it("prefers an exact match over a wildcard", () => {
    expect(lookupRecord(registry, "exact.demo.fdn")?.url).toBe("https://example.org/");
    expect(lookupRecord(registry, "other.demo.fdn")?.url).toBe("https://example.net/");
    expect(lookupRecord(registry, "deep.other.demo.fdn")?.url).toBe("https://example.net/");
  });

  it("does not match unrelated names or suffixes", () => {
    expect(lookupRecord(registry, "demo.fdn")).toBeNull();
    expect(lookupRecord(registry, "notdemo.fdn")).toBeNull();
    expect(lookupRecord(registry, "x.demo.fdn.example")).toBeNull();
  });
});

describe("destinations", () => {
  const recordBase: RegistryRecord = { name: "x.fdn", a: [], aaaa: [], owner: "octocat" };
  const registry: Registry = {
    schemaVersion: 2,
    updatedAt: "2026-11-10T19:00:00Z",
    records: [recordBase],
  };

  it("builds URL, CNAME, IPv4, and IPv6 destinations", () => {
    expect(buildDestination({ ...recordBase, url: "https://example.com/" })).toBe(
      "https://example.com/",
    );
    expect(buildDestination({ ...recordBase, cname: "example.com" })).toBe("https://example.com/");
    expect(buildDestination({ ...recordBase, a: ["192.0.2.1"] })).toBe("http://192.0.2.1/");
    expect(buildDestination({ ...recordBase, aaaa: ["2001:db8::1"] })).toBe(
      "http://[2001:db8::1]/",
    );
    expect(buildDestination(recordBase)).toBeNull();
  });

  it("flags HTTP and IP-literal targets", () => {
    expect(destinationWarnings("http://192.0.2.1/")).toHaveLength(2);
    expect(destinationWarnings("https://example.com/")).toEqual([]);
  });

  it("flags HTTPS navigations that land on HTTP", () => {
    expect(schemeDowngradeWarning("https", "http://example.com/")).toMatch(/plain HTTP/);
    expect(schemeDowngradeWarning("http", "http://example.com/")).toBeNull();
    expect(schemeDowngradeWarning("https", "https://example.com/")).toBeNull();
  });

  it("rejects a target that would be intercepted again", () => {
    expect(isDestinationSafe("https://example.com/", registry)).toBe(true);
    expect(isDestinationSafe("https://x.fdn/", registry)).toBe(false);
  });
});

describe("hostname normalization", () => {
  it("lowercases and punycodes IDNs", () => {
    expect(normalizeHostname("BÜCHER.fdn")).toBe("xn--bcher-kva.fdn");
    expect(normalizeRecordName("*.BÜCHER.fdn")).toBe("*.xn--bcher-kva.fdn");
  });

  it("rejects ports, paths, credentials, and invalid labels", () => {
    for (const value of ["x.fdn:8080", "x.fdn/path", "user@x.fdn", "-x.fdn", "x..fdn"]) {
      expect(normalizeHostname(value)).toBeNull();
    }
  });
});
