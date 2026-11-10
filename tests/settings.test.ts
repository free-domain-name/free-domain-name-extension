import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/lib/settings";

describe("settings", () => {
  it("falls back to safe defaults for malformed input", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(
      sanitizeSettings({
        enabled: "yes",
        registryUrl: "http://evil.example/registry.json",
        syncIntervalMinutes: 1,
        autoContinue: "no",
        checkPublicDns: 0,
        dohEndpoint: "javascript:alert(1)",
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      syncIntervalMinutes: 15,
    });
  });

  it("clamps intervals", () => {
    expect(sanitizeSettings({ syncIntervalMinutes: 5 }).syncIntervalMinutes).toBe(15);
    expect(sanitizeSettings({ syncIntervalMinutes: 90_000 }).syncIntervalMinutes).toBe(1440);
  });

  it("keeps localhost HTTP endpoints for testing", () => {
    const settings = sanitizeSettings({
      registryUrl: "http://localhost:8787/registry.json",
      dohEndpoint: "http://127.0.0.1:9999/dns-query",
    });
    expect(settings.registryUrl).toBe("http://localhost:8787/registry.json");
    expect(settings.dohEndpoint).toBe("http://127.0.0.1:9999/dns-query");
  });
});
