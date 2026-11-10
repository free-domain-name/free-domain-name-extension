import { describe, expect, it } from "vitest";
import { parseDohResponse } from "../src/lib/doh";
import { buildDohRequestUrl, validateDohEndpoint, validateRegistryUrl } from "../src/lib/urls";

describe("DoH response parsing", () => {
  it("maps NXDOMAIN to none", () => {
    expect(parseDohResponse({ Status: 3 })).toEqual({ status: "none", addresses: [] });
  });

  it("extracts A, AAAA, and CNAME answers", () => {
    const parsed = parseDohResponse({
      Status: 0,
      Answer: [
        { type: 5, data: "example.com." },
        { type: 1, data: "192.0.2.1" },
        { type: 28, data: "2001:db8::1" },
        { type: 16, data: "ignored" },
      ],
    });
    expect(parsed.status).toBe("exists");
    expect(parsed.addresses).toEqual(["example.com.", "192.0.2.1", "2001:db8::1"]);
  });

  it("treats NOERROR/NODATA as none", () => {
    expect(parseDohResponse({ Status: 0, Answer: [] }).status).toBe("none");
  });

  it("treats resolver failures as errors", () => {
    expect(parseDohResponse({ Status: 2 }).status).toBe("error");
    expect(parseDohResponse({})).toMatchObject({ status: "error" });
  });
});

describe("URL policy", () => {
  it("allows HTTPS and loopback HTTP only", () => {
    expect(validateRegistryUrl("https://example.com/registry.json")).toBe(
      "https://example.com/registry.json",
    );
    expect(validateRegistryUrl("http://127.0.0.1:8787/registry.json")).toBe(
      "http://127.0.0.1:8787/registry.json",
    );
    expect(validateRegistryUrl("http://example.com/registry.json")).toBeNull();
    expect(validateRegistryUrl("javascript:alert(1)")).toBeNull();
    expect(validateDohEndpoint("https://dns.google/resolve")).toBe(
      "https://dns.google/resolve",
    );
    expect(validateDohEndpoint("ftp://dns.example/")).toBeNull();
  });

  it("builds DoH URLs without dropping existing parameters", () => {
    const url = buildDohRequestUrl("https://dns.example/q?ct=application/dns-json", "hello.fdn", "A");
    expect(url).toContain("name=hello.fdn");
    expect(url).toContain("type=A");
    expect(url).toContain("ct=application%2Fdns-json");
  });
});
