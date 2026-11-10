import { DEFAULT_SETTINGS } from "./lib/settings";
import { sendRuntimeMessage } from "./lib/messages";
import type {
  RegistryMeta,
  SaveSettingsResponse,
  Settings,
  StatusResponse,
  SyncResponse,
  SyncStatus,
} from "./lib/types";
import { validateDohEndpoint, validateRegistryUrl } from "./lib/urls";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function formatDate(value: number | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function setSaveStatus(message: string, isError = false): void {
  const status = el("save-status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function sourceLabel(meta: RegistryMeta | null): string {
  if (!meta) return "Not loaded";
  if (meta.source === "sample") return "Bundled sample (offline fallback)";
  if (meta.stale) return "Cached (stale)";
  return "Live (remote)";
}

function renderStatus(status: SyncStatus, registry: RegistryMeta | null): void {
  el("status-source").textContent = sourceLabel(registry);
  el("status-last-success").textContent = status.lastSuccessAt
    ? formatDate(status.lastSuccessAt)
    : "Never";
  el("status-names").textContent = String(status.recordCount);
  el("status-wildcards").textContent = registry ? String(registry.wildcardCount) : "—";
  el("status-last-attempt").textContent = formatDate(status.lastAttemptAt);
  el("status-error").textContent = status.error ?? "None";
}

function fill(settings: Settings): void {
  el<HTMLInputElement>("registry-url").value = settings.registryUrl;
  el<HTMLInputElement>("sync-interval").value = String(settings.syncIntervalMinutes);
  el<HTMLInputElement>("auto-continue").checked = settings.autoContinue;
  el<HTMLInputElement>("check-dns").checked = settings.checkPublicDns;
  el<HTMLInputElement>("doh-endpoint").value = settings.dohEndpoint;
}

function collect(): Partial<Settings> {
  const interval = Number(el<HTMLInputElement>("sync-interval").value);
  return {
    registryUrl: el<HTMLInputElement>("registry-url").value.trim(),
    syncIntervalMinutes: Number.isFinite(interval) ? interval : DEFAULT_SETTINGS.syncIntervalMinutes,
    autoContinue: el<HTMLInputElement>("auto-continue").checked,
    checkPublicDns: el<HTMLInputElement>("check-dns").checked,
    dohEndpoint: el<HTMLInputElement>("doh-endpoint").value.trim(),
  };
}

function validate(patch: Partial<Settings>): string | null {
  if (!validateRegistryUrl(patch.registryUrl)) {
    return "Registry URL must be HTTPS (HTTP is allowed only for localhost).";
  }
  if (!validateDohEndpoint(patch.dohEndpoint)) {
    return "DoH endpoint must be HTTPS (HTTP is allowed only for localhost).";
  }
  const interval = patch.syncIntervalMinutes ?? 0;
  if (!Number.isFinite(interval) || interval < 15 || interval > 1440) {
    return "Sync interval must be between 15 and 1440 minutes.";
  }
  return null;
}

async function load(): Promise<void> {
  try {
    const response = await sendRuntimeMessage<StatusResponse>({ type: "status" });
    if (!response.ok) {
      setSaveStatus(response.error, true);
      return;
    }
    fill(response.settings);
    renderStatus(response.status, response.registry);
  } catch (error) {
    setSaveStatus(error instanceof Error ? error.message : "Could not load settings", true);
  }
}

el<HTMLFormElement>("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const patch = collect();
  const problem = validate(patch);
  if (problem) {
    setSaveStatus(problem, true);
    return;
  }

  const button = el<HTMLButtonElement>("save");
  button.disabled = true;
  setSaveStatus("Saving and syncing…");
  void sendRuntimeMessage<SaveSettingsResponse>({ type: "saveSettings", settings: patch })
    .then((response) => {
      if (!response.ok) {
        setSaveStatus(response.error, true);
        return;
      }
      fill(response.settings);
      renderStatus(response.status, response.registry);
      setSaveStatus(
        "Saved.",
      );
    })
    .catch((error: unknown) => {
      setSaveStatus(error instanceof Error ? error.message : "Could not save settings", true);
    })
    .finally(() => {
      button.disabled = false;
    });
});

el<HTMLButtonElement>("sync-now").onclick = () => {
  const button = el<HTMLButtonElement>("sync-now");
  button.disabled = true;
  setSaveStatus("Syncing…");
  void sendRuntimeMessage<SyncResponse>({ type: "sync" })
    .then((response) => {
      if (!response.ok) {
        setSaveStatus(response.error, true);
        return;
      }
      renderStatus(response.status, response.registry);
      setSaveStatus("Registry synced.");
    })
    .catch((error: unknown) => {
      setSaveStatus(error instanceof Error ? error.message : "Sync failed", true);
    })
    .finally(() => {
      button.disabled = false;
    });
};

el<HTMLButtonElement>("reset").onclick = () => {
  fill(DEFAULT_SETTINGS);
  setSaveStatus("Defaults loaded. Press “Save settings” to apply.");
};

void load();
