import sampleRegistryJson from "../../registry/client.json";
import { api } from "./api";
import { MAX_REGISTRY_BYTES } from "./constants";
import { getSettings } from "./settings";
import type {
  Registry,
  RegistryCache,
  RegistryMeta,
  RegistrySource,
  Settings,
  SyncStatus,
} from "./types";
import { RegistryValidationError, validateRegistry } from "./validation";

const CACHE_KEY = "registryCache";
const STATUS_KEY = "syncStatus";
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

let inFlight: Promise<SyncStatus> | null = null;

function isRegistryCache(value: unknown): value is RegistryCache {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RegistryCache>;
  return (
    typeof candidate.fetchedAt === "number" &&
    (candidate.source === "remote" || candidate.source === "sample") &&
    typeof candidate.registry === "object" &&
    candidate.registry !== null &&
    Array.isArray(candidate.registry.records) &&
    candidate.registry.schemaVersion === 2
  );
}

export async function readRegistryCache(): Promise<RegistryCache | null> {
  const stored = await api.storage.local.get(CACHE_KEY);
  const value = stored[CACHE_KEY];
  return isRegistryCache(value) ? value : null;
}

export async function readSyncStatus(): Promise<SyncStatus> {
  const stored = await api.storage.local.get(STATUS_KEY);
  const value = stored[STATUS_KEY];
  if (typeof value === "object" && value !== null) return value as SyncStatus;
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
    source: null,
    recordCount: 0,
    wildcardCount: 0,
  };
}

export function countWildcards(registry: Registry): number {
  return registry.records.filter((record) => record.name.startsWith("*.")).length;
}

export function buildRegistryMeta(cache: RegistryCache, settings: Settings): RegistryMeta {
  const staleAfter = Math.max(MAX_STALE_MS, settings.syncIntervalMinutes * 3 * 60_000);
  return {
    source: cache.source,
    registryUrl: settings.registryUrl,
    updatedAt: cache.registry.updatedAt,
    fetchedAt: cache.fetchedAt,
    stale: Date.now() - cache.fetchedAt > staleAfter,
    recordCount: cache.registry.records.length,
    wildcardCount: countWildcards(cache.registry),
  };
}

async function fetchRemoteRegistry(
  url: string,
  cached: RegistryCache | null,
): Promise<RegistryCache> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (cached?.source === "remote" && cached.etag) headers["if-none-match"] = cached.etag;

  const response = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers,
  });

  if (response.status === 304) {
    if (!cached || cached.source !== "remote") {
      throw new Error("Registry returned 304 without a remote cached copy");
    }
    return { ...cached, fetchedAt: Date.now(), source: "remote" };
  }
  if (!response.ok) throw new Error(`Registry request failed: HTTP ${response.status}`);

  const requestedOrigin = new URL(url).origin;
  if (response.url) {
    const finalOrigin = new URL(response.url).origin;
    if (finalOrigin !== requestedOrigin) {
      throw new Error("Registry request was redirected to a different origin");
    }
  }

  const text = await response.text();
  if (text.length > MAX_REGISTRY_BYTES) throw new Error("Registry payload is too large");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Registry payload is not valid JSON");
  }

  const registry = validateRegistry(json);
  const next: RegistryCache = {
    registry,
    fetchedAt: Date.now(),
    source: "remote",
  };
  const etag = response.headers.get("etag");
  if (etag) next.etag = etag;
  return next;
}

function sampleFallback(): Registry {
  return validateRegistry(sampleRegistryJson);
}

function errorMessage(error: unknown): string {
  if (error instanceof RegistryValidationError) return `Registry validation failed: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown registry error";
}

/**
 * Fetch, validate, cache, and apply the registry. Never leaves the extension
 * with zero rules after a transient network failure if a cache exists.
 */
export async function syncRegistry(): Promise<SyncStatus> {
  if (inFlight) return inFlight;
  inFlight = performSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function performSync(): Promise<SyncStatus> {
  const settings = await getSettings();
  const previous = await readSyncStatus();
  let cached = await readRegistryCache();
  const attemptedAt = Date.now();

  if (!settings.enabled) {
    const status: SyncStatus = {
      lastAttemptAt: attemptedAt,
      lastSuccessAt: previous.lastSuccessAt,
      error: null,
      source: cached?.source ?? null,
      recordCount: cached?.registry.records.length ?? 0,
      wildcardCount: cached ? countWildcards(cached.registry) : 0,
    };
    await api.storage.local.set({ [STATUS_KEY]: status });
    return status;
  }

  let next: RegistryCache | null = cached;
  let error: string | null = null;

  try {
    next = await fetchRemoteRegistry(settings.registryUrl, cached);
  } catch (fetchError) {
    error = errorMessage(fetchError);
    console.warn("[fdn] Registry sync failed", fetchError);
    if (!cached) {
      try {
        const registry = sampleFallback();
        next = { registry, fetchedAt: Date.now(), source: "sample" };
        error = `${error} (using bundled sample registry)`;
      } catch (sampleError) {
        error = `${error}; sample registry also failed: ${errorMessage(sampleError)}`;
        next = null;
      }
    }
  }

  if (next) {
    await api.storage.local.set({ [CACHE_KEY]: next });
  }

  const source: RegistrySource | null = next?.source ?? null;
  const success = next !== null && (source === "remote" || source === "sample");

  const status: SyncStatus = {
    lastAttemptAt: attemptedAt,
    lastSuccessAt: success && source === "remote" ? Date.now() : previous.lastSuccessAt,
    error,
    source,
    recordCount: next?.registry.records.length ?? 0,
    wildcardCount: next ? countWildcards(next.registry) : 0,
  };
  await api.storage.local.set({ [STATUS_KEY]: status });
  return status;
}
