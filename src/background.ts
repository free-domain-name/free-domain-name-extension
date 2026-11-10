/**
 * MV3 service worker: registry sync, DNR rule management, and the small
 * request/response API used by the interstitial, popup, and options pages.
 */
import { api } from "./lib/api";
import { REGISTRY_SYNC_ALARM, SESSION_RULE_CLEANUP_PREFIX } from "./lib/constants";
import { checkPublicDns, clearDohCache } from "./lib/doh";
import {
  buildRegistryMeta,
  readRegistryCache,
  readSyncStatus,
  syncRegistry,
} from "./lib/registry";
import {
  allowTabForHost,
  applyInterceptionRules,
  cleanupSessionRule,
  clearSessionRules,
} from "./lib/rules";
import { getSettings, saveSettings } from "./lib/settings";
import type {
  BypassRequest,
  BypassResponse,
  ResolveRequest,
  ResolveResponse,
  SaveSettingsRequest,
  SaveSettingsResponse,
  Settings,
  StatusResponse,
  SyncResponse,
  ToggleRequest,
} from "./lib/types";
import {
  buildDestination,
  isDestinationSafe,
  isPlainObject,
  lookupRecord,
  normalizeHostname,
} from "./lib/validation";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown extension error";
}

async function ensureSyncAlarm(settings: Settings, recreate = false): Promise<void> {
  const minutes = Math.max(15, settings.syncIntervalMinutes);
  const existing = await api.alarms.get(REGISTRY_SYNC_ALARM);
  if (!recreate && existing?.periodInMinutes === minutes) return;
  await api.alarms.clear(REGISTRY_SYNC_ALARM);
  await api.alarms.create(REGISTRY_SYNC_ALARM, {
    periodInMinutes: minutes,
    delayInMinutes: minutes,
  });
}

async function bootstrap(): Promise<void> {
  try {
    const settings = await getSettings();
    await ensureSyncAlarm(settings, true);
    await syncRegistry();
  } catch (error) {
    console.error("[fdn] Bootstrap failed", error);
  }
}

async function statusResponse(): Promise<StatusResponse> {
  const [settings, status, cache] = await Promise.all([
    getSettings(),
    readSyncStatus(),
    readRegistryCache(),
  ]);
  return {
    ok: true,
    settings,
    status,
    registry: cache ? buildRegistryMeta(cache, settings) : null,
  };
}

async function handleResolve(message: ResolveRequest): Promise<ResolveResponse> {
  const settings = await getSettings();
  const cache = await readRegistryCache();
  if (!cache) {
    return {
      ok: false,
      error: "Registry is not ready yet. Open the extension and press “Sync now”.",
    };
  }

  const host = normalizeHostname(message.host);
  if (!host) return { ok: false, error: "This is not a valid hostname." };

  const record = lookupRecord(cache.registry, host);
  const destination = record ? buildDestination(record) : null;
  if (destination && !isDestinationSafe(destination, cache.registry)) {
    return { ok: false, error: "The registry record contains an unsafe destination." };
  }

  const publicDns = settings.checkPublicDns
    ? await checkPublicDns(host, settings.dohEndpoint)
    : { status: "disabled" as const, addresses: [], checkedAt: null };

  return {
    ok: true,
    host,
    scheme: message.scheme === "http" ? "http" : "https",
    record,
    destination,
    publicDns,
    registry: buildRegistryMeta(cache, settings),
    // v1 is HTTP-first; the legacy HTTPS auto-open path stays disabled.
    autoContinue: false,
  };
}

async function handleBypass(
  message: BypassRequest,
  sender: chrome.runtime.MessageSender,
): Promise<BypassResponse> {
  const cache = await readRegistryCache();
  if (!cache) return { ok: false, error: "Registry is not ready." };

  const host = normalizeHostname(message.host);
  if (!host || !lookupRecord(cache.registry, host)) {
    return { ok: false, error: "This name is not managed by the registry." };
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false, error: "This action must be started from a browser tab." };
  }

  const settings = await getSettings();
  if (!settings.checkPublicDns) {
    return { ok: false, error: "Public DNS checks are disabled in Settings." };
  }
  const publicDns = await checkPublicDns(host, settings.dohEndpoint);
  if (publicDns.status !== "exists") {
    return { ok: false, error: "Public DNS has no answer for this name." };
  }

  const scheme = message.scheme === "http" ? "http" : "https";
  await allowTabForHost(tabId, host);
  return { ok: true, url: `${scheme}://${host}/` };
}

async function handleToggle(message: ToggleRequest): Promise<StatusResponse> {
  const saved = await saveSettings({ enabled: message.enabled });
  if (!saved.enabled) {
    await applyInterceptionRules([], false);
    await clearSessionRules();
  } else {
    const cache = await readRegistryCache();
    if (cache) await applyInterceptionRules(cache.registry.records, true);
    else await syncRegistry();
  }
  return statusResponse();
}

async function handleSaveSettings(message: SaveSettingsRequest): Promise<SaveSettingsResponse> {
  const before = await getSettings();
  const saved = await saveSettings(message.settings);
  await ensureSyncAlarm(saved, before.syncIntervalMinutes !== saved.syncIntervalMinutes);

  if (before.registryUrl !== saved.registryUrl) {
    // Never mix records from one namespace with the URL of another: if the new
    // endpoint is unavailable, fall back to the labeled sample instead.
    await api.storage.local.remove(["registryCache", "syncStatus"]);
    await clearSessionRules();
  }
  if (before.dohEndpoint !== saved.dohEndpoint) {
    await clearDohCache();
  }

  let status;
  if (!saved.enabled) {
    await applyInterceptionRules([], false);
    await clearSessionRules();
    status = await readSyncStatus();
  } else if (
    before.registryUrl !== saved.registryUrl ||
    !before.enabled ||
    !(await readRegistryCache())
  ) {
    status = await syncRegistry();
  } else {
    // Non-registry settings (auto-continue, DoH, interval) do not need a
    // network round-trip. Re-apply the cached rules so a failed earlier apply
    // can recover without forcing a sync.
    const cache = await readRegistryCache();
    if (cache) await applyInterceptionRules(cache.registry.records, true);
    status = await readSyncStatus();
  }

  const cache = await readRegistryCache();
  return {
    ok: true,
    settings: saved,
    status,
    registry: cache ? buildRegistryMeta(cache, saved) : null,
  };
}

async function handleSync(): Promise<SyncResponse> {
  const settings = await getSettings();
  await ensureSyncAlarm(settings, true);
  const status = await syncRegistry();
  const cache = await readRegistryCache();
  return {
    ok: true,
    status,
    registry: cache ? buildRegistryMeta(cache, settings) : null,
  };
}

async function handleMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (!isPlainObject(raw) || typeof raw.type !== "string") {
    return { ok: false, error: "Unknown request" };
  }
  switch (raw.type) {
    case "resolve":
      return handleResolve(raw as unknown as ResolveRequest);
    case "bypass":
      return handleBypass(raw as unknown as BypassRequest, sender);
    case "status":
      return statusResponse();
    case "sync":
      return handleSync();
    case "toggle":
      return handleToggle(raw as unknown as ToggleRequest);
    case "saveSettings":
      return handleSaveSettings(raw as unknown as SaveSettingsRequest);
    default:
      return { ok: false, error: `Unknown request type: ${raw.type}` };
  }
}

api.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: errorText(error) }));
  // Keep the message channel open for the async response.
  return true;
});

api.runtime.onInstalled.addListener(() => {
  console.info("[fdn] Installed/updated; syncing registry");
  void bootstrap();
});

api.runtime.onStartup.addListener(() => {
  console.info("[fdn] Browser startup; refreshing registry");
  void bootstrap();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REGISTRY_SYNC_ALARM) {
    void syncRegistry().catch((error) => console.error("[fdn] Scheduled sync failed", error));
    return;
  }
  if (alarm.name.startsWith(SESSION_RULE_CLEANUP_PREFIX)) {
    const ruleId = Number(alarm.name.slice(SESSION_RULE_CLEANUP_PREFIX.length));
    if (Number.isInteger(ruleId) && ruleId > 0) void cleanupSessionRule(ruleId);
  }
});

// Wake-up safety net: if the worker restarts without an alarm (e.g. during
// development), make sure a periodic sync is scheduled when one is missing.
void (async () => {
  try {
    const settings = await getSettings();
    await ensureSyncAlarm(settings);
  } catch (error) {
    console.warn("[fdn] Could not ensure sync alarm", error);
  }
})();
