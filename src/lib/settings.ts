import { api } from "./api";
import {
  DEFAULT_DOH_ENDPOINT,
  DEFAULT_REGISTRY_URL,
} from "./constants";
import type { Settings } from "./types";
import { validateDohEndpoint, validateRegistryUrl } from "./urls";

const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  registryUrl: DEFAULT_REGISTRY_URL,
  syncIntervalMinutes: 360,
  autoContinue: false,
  checkPublicDns: true,
  dohEndpoint: DEFAULT_DOH_ENDPOINT,
  resolverEnabled: true,
  resolverPort: 8787,
};

function clampPort(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) {
    return DEFAULT_SETTINGS.resolverPort;
  }
  return numeric;
}

function clampInterval(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.syncIntervalMinutes;
  return Math.min(1440, Math.max(15, Math.round(numeric)));
}

export function sanitizeSettings(input: unknown): Settings {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    registryUrl: validateRegistryUrl(raw.registryUrl) ?? DEFAULT_SETTINGS.registryUrl,
    syncIntervalMinutes: clampInterval(raw.syncIntervalMinutes),
    autoContinue: false,
    checkPublicDns:
      typeof raw.checkPublicDns === "boolean"
        ? raw.checkPublicDns
        : DEFAULT_SETTINGS.checkPublicDns,
    dohEndpoint: validateDohEndpoint(raw.dohEndpoint) ?? DEFAULT_SETTINGS.dohEndpoint,
    resolverEnabled:
      typeof raw.resolverEnabled === "boolean"
        ? raw.resolverEnabled
        : DEFAULT_SETTINGS.resolverEnabled,
    resolverPort: clampPort(raw.resolverPort),
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await api.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const merged: Settings = { ...current, ...patch };

  if (validateRegistryUrl(merged.registryUrl) === null) {
    throw new Error("Registry URL must be HTTPS (HTTP is allowed only for localhost).");
  }
  if (validateDohEndpoint(merged.dohEndpoint) === null) {
    throw new Error("DoH endpoint must be HTTPS (HTTP is allowed only for localhost).");
  }
  merged.registryUrl = validateRegistryUrl(merged.registryUrl) ?? current.registryUrl;
  merged.dohEndpoint = validateDohEndpoint(merged.dohEndpoint) ?? current.dohEndpoint;
  merged.syncIntervalMinutes = clampInterval(merged.syncIntervalMinutes);
  merged.resolverPort = clampPort(merged.resolverPort);
  if (merged.resolverPort < 1) {
    throw new Error("Resolver proxy port must be between 1 and 65535.");
  }

  await api.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}
