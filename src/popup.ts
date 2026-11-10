import { api } from "./lib/api";
import { OFFICIAL_REGISTRY_REPO } from "./lib/constants";
import { sendRuntimeMessage } from "./lib/messages";
import type { RegistryMeta, StatusResponse, SyncResponse } from "./lib/types";
import { registryRepoUrl } from "./lib/urls";

type StatusOk = Extract<StatusResponse, { ok: true }>;

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

function sourceLabel(meta: RegistryMeta | null): string {
  if (!meta) return "No registry";
  if (meta.source === "sample") return "Bundled sample";
  if (meta.stale) return "Cached (stale)";
  return "Live registry";
}

function setNotice(text: string | null, isError = false): void {
  const notice = el("notice");
  notice.textContent = text ?? "";
  notice.hidden = !text;
  notice.classList.toggle("error", isError);
}

function render(response: StatusOk): void {
  const { settings, status, registry } = response;
  const enabledInput = el<HTMLInputElement>("enabled");
  enabledInput.checked = settings.enabled;
  enabledInput.disabled = false;

  const dot = el("status-dot");
  dot.classList.toggle("off", !settings.enabled);

  if (!settings.enabled) {
    el("headline").textContent = "Interception paused";
    el("status-detail").textContent = "Top-level navigations are untouched.";
  } else if (!registry) {
    el("headline").textContent = "Waiting for registry";
    el("status-detail").textContent = "No valid registry is loaded. Press Sync now.";
  } else {
    el("headline").textContent = registry.source === "sample" ? "Sample registry active" : "Interception active";
    el("status-detail").textContent = `${sourceLabel(registry)} · ${registry.recordCount} ${
      registry.recordCount === 1 ? "name" : "names"
    }`;
  }

  el("record-count").textContent = registry ? String(registry.recordCount) : "0";
  el("wildcard-count").textContent = registry ? String(registry.wildcardCount) : "0";

  const syncParts = [
    `Fetched ${formatDate(registry?.fetchedAt ?? status.lastAttemptAt)}`,
    `Last success ${status.lastSuccessAt ? formatDate(status.lastSuccessAt) : "never"}`,
  ];
  el("sync-state").textContent = syncParts.join(" · ");

  if (registry?.source === "sample") {
    setNotice(
      "Using bundled demo data. Publish the organization registry, then press Sync now to replace it.",
    );
  } else if (status.error) {
    setNotice(status.error, true);
  } else if (registry?.stale) {
    setNotice("The cached registry is stale. Press Sync now to refresh it.");
  } else {
    setNotice(null);
  }

  const repo = el<HTMLAnchorElement>("repo");
  repo.href =
    registry?.source === "sample"
      ? OFFICIAL_REGISTRY_REPO
      : registryRepoUrl(settings.registryUrl);
}

function renderFatal(message: string): void {
  el("headline").textContent = "Extension error";
  el("status-detail").textContent = "The background worker did not answer.";
  setNotice(message, true);
}

async function refresh(): Promise<void> {
  const syncButton = el<HTMLButtonElement>("sync");
  syncButton.disabled = true;
  try {
    const response = await sendRuntimeMessage<StatusResponse>({ type: "status" });
    if (!response.ok) {
      renderFatal(response.error);
      return;
    }
    render(response);
  } catch (error) {
    renderFatal(error instanceof Error ? error.message : "Unknown error");
  } finally {
    syncButton.disabled = false;
  }
}

el<HTMLButtonElement>("sync").onclick = () => {
  const button = el<HTMLButtonElement>("sync");
  button.disabled = true;
  button.textContent = "Syncing…";
  setNotice(null);
  void sendRuntimeMessage<SyncResponse>({ type: "sync" })
    .then((response) => {
      if (!response.ok) {
        setNotice(response.error, true);
        return;
      }
      return refresh();
    })
    .catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : "Sync failed", true);
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = "Sync now";
    });
};

el<HTMLButtonElement>("options").onclick = () => {
  void api.runtime.openOptionsPage();
  window.close();
};

el<HTMLInputElement>("enabled").onchange = (event) => {
  const input = event.currentTarget as HTMLInputElement;
  input.disabled = true;
  void sendRuntimeMessage<StatusResponse>({ type: "toggle", enabled: input.checked })
    .then((response) => {
      if (!response.ok) {
        input.checked = !input.checked;
        setNotice(response.error, true);
        return;
      }
      render(response);
    })
    .catch((error: unknown) => {
      input.checked = !input.checked;
      setNotice(error instanceof Error ? error.message : "Could not change state", true);
    })
    .finally(() => {
      input.disabled = false;
    });
};

el("version").textContent = `v${api.runtime.getManifest().version}`;
void refresh();
