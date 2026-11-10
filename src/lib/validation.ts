/**
 * Pure validation and lookup helpers.
 *
 * Keeping this module free of browser APIs lets it run in unit tests and in the
 * registry CLI. A registry may override any domain, including real IANA names
 * such as google.com; conflicts are resolved with the user in the interstitial.
 */
import { MAX_NAME_LENGTH, MAX_REGISTRY_RECORDS } from "./constants";
import { SCHEMA_VERSION, type Registry, type RegistryRecord } from "./types";

export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryValidationError";
  }
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a hostname to lowercase ASCII (punycode) without port/path.
 * Returns null for anything that is not a plausible DNS hostname.
 */
export function normalizeHostname(input: string): string | null {
  if (typeof input !== "string") return null;
  let candidate = input.trim();
  if (candidate.endsWith(".")) candidate = candidate.slice(0, -1);
  if (!candidate || candidate.length > 253) return null;
  // Reject things that are clearly not hostnames before handing them to URL.
  if (/[\s/?#@:%\\]/.test(candidate)) return null;
  if (candidate.includes("*")) return null;

  let url: URL;
  try {
    url = new URL(`http://${candidate}/`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    return null;
  }
  const host = url.hostname;
  if (!host || host.length > 253 || host.startsWith("[") || host.endsWith("]")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;

  const labels = host.split(".");
  if (labels.length < 1) return null;
  for (const label of labels) {
    if (!label || label.length > 63 || !LABEL_RE.test(label)) return null;
  }
  return host;
}

/** Normalize a record name, allowing one leading `*.` wildcard label. */
export function normalizeRecordName(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.startsWith("*.")) {
    const base = normalizeHostname(trimmed.slice(2));
    return base ? `*.${base}` : null;
  }
  if (trimmed.includes("*")) return null;
  return normalizeHostname(trimmed);
}

export function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => IPV4_RE.test(part) && Number(part) <= 255);
}

export function isIpv6(value: string): boolean {
  if (!value.includes(":") || value.includes("%") || value.includes("/")) return false;
  try {
    const url = new URL(`http://[${value}]/`);
    return url.hostname.startsWith("[") && url.hostname.endsWith("]");
  } catch {
    return false;
  }
}

export function ipv6ToUrlHost(value: string): string {
  return `[${value}]`;
}

function fail(message: string): never {
  throw new RegistryValidationError(message);
}

function validateIsoDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO-8601 date string`);
  }
  return value;
}

function validateTargetUrl(raw: string): string {
  if (raw.length > 2048) fail("record.url is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`record.url is not an absolute URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(`record.url must use http(s): ${raw}`);
  }
  if (url.username || url.password) fail("record.url must not contain credentials");
  if (!url.hostname) fail("record.url must include a hostname");
  return url.href;
}

function validateIPv4List(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > 8) fail(`${field} has too many entries`);
  return value.map((item) => {
    if (typeof item !== "string" || !isIpv4(item)) fail(`${field} contains an invalid IPv4 address`);
    return item;
  });
}

function validateIPv6List(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > 8) fail(`${field} has too many entries`);
  return value.map((item) => {
    if (typeof item !== "string" || !isIpv6(item)) fail(`${field} contains an invalid IPv6 address`);
    return item;
  });
}

/**
 * Validate an untrusted registry payload and return a normalized copy.
 * Throws {@link RegistryValidationError} with a human-readable reason.
 */
export function validateRegistry(input: unknown): Registry {
  if (!isPlainObject(input)) fail("Registry must be a JSON object");
  if (input.schemaVersion !== SCHEMA_VERSION) {
    fail(`Unsupported schemaVersion (expected ${SCHEMA_VERSION})`);
  }
  const updatedAt = validateIsoDate(input.updatedAt, "updatedAt");
  if (!updatedAt) fail("updatedAt is required");

  if (!Array.isArray(input.records)) fail("records must be an array");
  if (input.records.length > MAX_REGISTRY_RECORDS) {
    fail(`Registry has more than ${MAX_REGISTRY_RECORDS} records`);
  }

  const seen = new Set<string>();
  const records: RegistryRecord[] = [];
  for (let index = 0; index < input.records.length; index++) {
    const raw = input.records[index];
    const at = `records[${index}]`;
    if (!isPlainObject(raw)) fail(`${at} must be an object`);

    if (typeof raw.name !== "string") fail(`${at}.name must be a string`);
    const name = normalizeRecordName(raw.name);
    if (!name) fail(`${at}.name is not a valid DNS name: ${raw.name}`);
    if (name.length > MAX_NAME_LENGTH) fail(`${at}.name is too long`);

    const baseName = name.startsWith("*.") ? name.slice(2) : name;
    // A single label such as "com" would intercept an entire TLD. Requiring a
    // dot keeps wildcard records to a concrete domain (e.g. *.example.com).
    if (!baseName.includes(".")) fail(`${at}.name must contain at least one dot`);

    if (seen.has(name)) fail(`Duplicate record name: ${name}`);
    seen.add(name);

    if (typeof raw.owner !== "string" || !OWNER_RE.test(raw.owner)) {
      fail(`${at}.owner must be a GitHub handle`);
    }
    if (raw.description !== undefined) {
      if (typeof raw.description !== "string" || raw.description.length > 280) {
        fail(`${at}.description must be a string of at most 280 characters`);
      }
    }
    const recordUpdatedAt = validateIsoDate(raw.updatedAt, `${at}.updatedAt`);

    let cname: string | undefined;
    if (raw.cname !== undefined) {
      if (typeof raw.cname !== "string") fail(`${at}.cname must be a string`);
      const normalized = normalizeHostname(raw.cname);
      if (!normalized) fail(`${at}.cname is not a valid hostname`);
      cname = normalized;
    }

    let url: string | undefined;
    if (raw.url !== undefined) {
      if (typeof raw.url !== "string") fail(`${at}.url must be a string`);
      url = validateTargetUrl(raw.url);
    }

    const a = validateIPv4List(raw.a, `${at}.a`);
    const aaaa = validateIPv6List(raw.aaaa, `${at}.aaaa`);

    if (!url && !cname && a.length === 0 && aaaa.length === 0) {
      fail(`${at} must have a url, cname, a, or aaaa destination`);
    }

    const record: RegistryRecord = { name, a, aaaa, owner: raw.owner };
    if (url) record.url = url;
    if (cname) record.cname = cname;
    if (raw.description !== undefined) record.description = raw.description;
    if (recordUpdatedAt) record.updatedAt = recordUpdatedAt;
    records.push(record);
  }

  const registry: Registry = { schemaVersion: SCHEMA_VERSION, updatedAt, records };
  if (typeof input.name === "string" && input.name.length <= 120) registry.name = input.name;

  // A target that is itself intercepted would bounce the user back into the
  // interstitial, so reject chains inside this registry.
  for (const record of records) {
    const targets: string[] = [];
    if (record.url) targets.push(new URL(record.url).hostname);
    if (record.cname) targets.push(record.cname);
    for (const target of targets) {
      if (lookupRecord(registry, target)) {
        fail(`${record.name} points to ${target}, which this registry also intercepts`);
      }
    }
  }

  return registry;
}

/** Exact match wins; then the most specific `*.` wildcard suffix. */
export function lookupRecord(registry: Registry, host: string): RegistryRecord | null {
  const byName = new Map(registry.records.map((record) => [record.name, record]));
  const exact = byName.get(host);
  if (exact) return exact;

  const labels = host.split(".");
  for (let index = 1; index < labels.length; index++) {
    const wildcard = `*.${labels.slice(index).join(".")}`;
    const match = byName.get(wildcard);
    if (match) return match;
  }
  return null;
}

/**
 * Choose what the browser should open. An explicit URL always wins. IP-only
 * records fall back to plain HTTP and are flagged by the UI as insecure.
 */
export function buildDestination(record: RegistryRecord): string | null {
  if (record.url) return record.url;
  if (record.cname) return `https://${record.cname}/`;
  if (record.a.length > 0) return `http://${record.a[0]}/`;
  if (record.aaaa.length > 0) return `http://${ipv6ToUrlHost(record.aaaa[0] ?? "")}/`;
  return null;
}

export function isDestinationSafe(destination: string, registry: Registry): boolean {
  try {
    const url = new URL(destination);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return !lookupRecord(registry, url.hostname);
  } catch {
    return false;
  }
}

/** True when the target is not end-to-end HTTPS (or is an IP literal). */
export function destinationWarnings(destination: string): string[] {
  const warnings: string[] = [];
  try {
    const url = new URL(destination);
    if (url.protocol === "http:") {
      warnings.push("This target uses plain HTTP. Traffic can be read or modified.");
    }
    if (isIpv4(url.hostname) || url.hostname.startsWith("[")) {
      warnings.push(
        "This target is an IP address, so HTTPS certificate and virtual-host checks cannot work reliably.",
      );
    }
  } catch {
    warnings.push("The target URL could not be parsed.");
  }
  return warnings;
}

/** Warn when the user asked for HTTPS but the registry target is HTTP. */
export function schemeDowngradeWarning(
  scheme: "http" | "https",
  destination: string,
): string | null {
  if (scheme !== "https") return null;
  try {
    if (new URL(destination).protocol === "http:") {
      return "You requested HTTPS, but this registry target is plain HTTP. Traffic can be read or modified.";
    }
  } catch {
    return null;
  }
  return null;
}
