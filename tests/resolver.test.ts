import { describe, expect, it } from "vitest";
import { buildPacScript, resolverPortOf } from "../src/lib/resolver";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import type { RegistryRecord } from "../src/lib/types";

const record = (name: string): RegistryRecord => ({
  name,
  a: [],
  aaaa: [],
  owner: "free-domain-name",
});

describe("resolver PAC and port", () => {
  it("routes exact and wildcard names to the loopback proxy", () => {
    const pac = buildPacScript([record("abc.com"), record("*.demo.fdn")], 8787);
    expect(pac).toContain('host === "abc.com"');
    expect(pac).toContain('host === "demo.fdn"');
    expect(pac).toContain('dnsDomainIs(host, ".demo.fdn")');
    expect(pac).toContain('PROXY 127.0.0.1:8787');
    expect(pac).toContain('if (url.slice(0, 5) !== "http:") return "DIRECT"');
  });

  it("does not proxy an empty registry", () => {
    const pac = buildPacScript([], 8787);
    expect(pac).toContain('if (false) return "PROXY 127.0.0.1:8787"');
    expect(pac).toContain('return "DIRECT"');
  });

  it("uses the configured port and falls back for invalid ports", () => {
    expect(resolverPortOf({ ...DEFAULT_SETTINGS, resolverPort: 9000 })).toBe(9000);
    expect(resolverPortOf({ ...DEFAULT_SETTINGS, resolverPort: 0 })).toBe(8787);
  });
});
