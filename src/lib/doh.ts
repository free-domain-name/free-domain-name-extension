import { api } from "./api";
import type { PublicDnsResult } from "./types";
import { buildDohRequestUrl, validateDohEndpoint } from "./urls";

const SESSION_CACHE_KEY = "dohCache";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

interface DohAnswer {
  status: "exists" | "none" | "error";
  addresses: string[];
  error?: string;
}

interface DohCacheEntry {
  result: PublicDnsResult;
  checkedAt: number;
}

const memoryCache = new Map<string, DohCacheEntry>();

/** Clear cached conflict results, e.g. after the DoH endpoint changes. */
export async function clearDohCache(): Promise<void> {
  memoryCache.clear();
  try {
    await api.storage.session.remove(SESSION_CACHE_KEY);
  } catch {
    // Best effort; a stale cache is not security-critical, but clear it when possible.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a Cloudflare/Google DoH JSON response. Exported for tests.
 * Status: 0 = NOERROR, 3 = NXDOMAIN.
 */
export function parseDohResponse(json: unknown): DohAnswer {
  if (!isPlainObject(json) || typeof json.Status !== "number") {
    return { status: "error", addresses: [], error: "Resolver returned an unexpected response" };
  }
  if (json.Status === 3) return { status: "none", addresses: [] };
  if (json.Status !== 0) {
    return { status: "error", addresses: [], error: `DNS resolver status ${json.Status}` };
  }
  const answers = Array.isArray(json.Answer) ? json.Answer : [];
  const addresses: string[] = [];
  for (const answer of answers) {
    if (!isPlainObject(answer)) continue;
    const type = answer.type;
    const data = answer.data;
    // CNAME (5), A (1), AAAA (28)
    if ((type === 5 || type === 1 || type === 28) && typeof data === "string") {
      addresses.push(data);
    }
  }
  return addresses.length > 0
    ? { status: "exists", addresses: [...new Set(addresses)] }
    : { status: "none", addresses: [] };
}

async function queryDoh(
  endpoint: string,
  hostname: string,
  type: "A" | "AAAA",
): Promise<DohAnswer> {
  try {
    const response = await fetch(buildDohRequestUrl(endpoint, hostname, type), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(6_000),
      headers: { accept: "application/dns-json" },
    });
    if (!response.ok) {
      return { status: "error", addresses: [], error: `DoH HTTP ${response.status}` };
    }
    return parseDohResponse(await response.json());
  } catch (error) {
    return {
      status: "error",
      addresses: [],
      error: error instanceof Error ? error.message : "DoH request failed",
    };
  }
}

async function readSessionCache(): Promise<Record<string, DohCacheEntry>> {
  try {
    const stored = await api.storage.session.get(SESSION_CACHE_KEY);
    const value = stored[SESSION_CACHE_KEY];
    return isPlainObject(value) ? (value as Record<string, DohCacheEntry>) : {};
  } catch {
    return {};
  }
}

async function writeSessionCache(hostname: string, result: PublicDnsResult): Promise<void> {
  try {
    const cache = await readSessionCache();
    cache[hostname] = { result, checkedAt: Date.now() };
    const entries = Object.entries(cache)
      .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
      .slice(0, MAX_CACHE_ENTRIES);
    await api.storage.session.set({ [SESSION_CACHE_KEY]: Object.fromEntries(entries) });
  } catch {
    // Session storage is an optimization; never let it break resolution.
  }
}

/**
 * Check whether a name also exists in the public DNS universe. A conflict is
 * present when any A/AAAA/CNAME record is returned.
 */
export async function checkPublicDns(
  hostname: string,
  endpoint: string,
  now = Date.now(),
): Promise<PublicDnsResult> {
  const validEndpoint = validateDohEndpoint(endpoint);
  if (!validEndpoint) {
    return { status: "error", addresses: [], error: "Invalid DoH endpoint", checkedAt: now };
  }

  const memory = memoryCache.get(hostname);
  if (memory && now - memory.checkedAt < CACHE_TTL_MS) return memory.result;

  const session = await readSessionCache();
  const cached = session[hostname];
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
    memoryCache.set(hostname, cached);
    return cached.result;
  }

  const [a, aaaa] = await Promise.all([
    queryDoh(validEndpoint, hostname, "A"),
    queryDoh(validEndpoint, hostname, "AAAA"),
  ]);

  const addresses = [...new Set([...a.addresses, ...aaaa.addresses])];
  let result: PublicDnsResult;
  if (addresses.length > 0) {
    result = { status: "exists", addresses, checkedAt: now };
  } else if (a.status === "error" && aaaa.status === "error") {
    result = {
      status: "error",
      addresses: [],
      error: a.error ?? aaaa.error ?? "Public DNS check failed",
      checkedAt: now,
    };
  } else if (a.status === "error" || aaaa.status === "error") {
    // One query failed, the other was NXDOMAIN/NODATA. Treat as unverifiable.
    result = {
      status: "error",
      addresses: [],
      error: a.error ?? aaaa.error ?? "Public DNS check was incomplete",
      checkedAt: now,
    };
  } else {
    result = { status: "none", addresses: [], checkedAt: now };
  }

  if (result.status !== "error") {
    memoryCache.set(hostname, { result, checkedAt: now });
    await writeSessionCache(hostname, result);
  }
  return result;
}
