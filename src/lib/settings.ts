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
  autoContinue: true,
  checkPublicDns: true,
  dohEndpoint: DEFAULT_DOH_ENDPOINT,
};

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
    autoContinue:
      typeof raw.autoContinue === "boolean" ? raw.autoContinue : DEFAULT_SETTINGS.autoContinue,
    checkPublicDns:
      typeof raw.checkPublicDns === "boolean"
        ? raw.checkPublicDns
        : DEFAULT_SETTINGS.checkPublicDns,
    dohEndpoint: validateDohEndpoint(raw.dohEndpoint) ?? DEFAULT_SETTINGS.dohEndpoint,
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

  await api.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}
