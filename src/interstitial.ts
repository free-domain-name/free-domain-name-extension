/**
 * Consent / security interstitial. Every intercepted navigation lands here
 * because DNR cannot inspect the registry at request time.
 */
import { OFFICIAL_REGISTRY_REPO } from "./lib/constants";
import { sendRuntimeMessage } from "./lib/messages";
import type { BypassResponse, ResolveResponse } from "./lib/types";
import { registryRepoUrl } from "./lib/urls";
import { destinationWarnings, isIpv4, schemeDowngradeWarning } from "./lib/validation";

type Resolved = Extract<ResolveResponse, { ok: true }>;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const params = new URLSearchParams(location.search);
const requestedHost = (params.get("host") ?? "").trim();
const scheme: "http" | "https" = params.get("scheme") === "http" ? "http" : "https";

const hostHeading = el("host");
hostHeading.textContent = requestedHost.toLowerCase() || "Unknown host";
document.title = `${requestedHost || "Unknown host"} — Free Domain Name`;

let autoInterval: number | undefined;
let autoDeadline = 0;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" && autoInterval !== undefined) {
    cancelAutoContinue();
  }
});

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

function formatDate(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function hideAllPanels(): void {
  for (const id of [
    "record",
    "not-found",
    "error",
    "warnings",
    "conflict",
    "primary-actions",
    "not-found-actions",
  ]) {
    el(id).hidden = true;
  }
}

function showError(message: string): void {
  hideAllPanels();
  el("loading").hidden = true;
  setText("eyebrow", "Resolution stopped");
  setText("summary", "Nothing was opened. The requested name could not be resolved safely.");
  setText("error-text", message);
  el("error").hidden = false;
}

function setSourceBadge(meta: Resolved["registry"]): void {
  const badge = el("source-badge");
  badge.hidden = false;
  badge.classList.remove("warn", "danger");
  if (meta.source === "sample") {
    badge.textContent = "Sample registry";
    badge.classList.add("warn");
    badge.title = "Bundled demo data; the remote registry was unavailable.";
  } else if (meta.stale) {
    badge.textContent = "Stale registry";
    badge.classList.add("warn");
    badge.title = "The cached registry is older than expected.";
  } else {
    badge.textContent = "Validated registry";
    badge.title = "Fetched and validated from the configured endpoint.";
  }
}

function setRegistryLink(meta: Resolved["registry"]): void {
  const link = el<HTMLAnchorElement>("registry-link");
  link.href =
    meta.source === "sample" ? OFFICIAL_REGISTRY_REPO : registryRepoUrl(meta.registryUrl);
  link.textContent = meta.source === "sample" ? "Sample registry ↗" : "View registry source ↗";
  link.hidden = false;
}

function renderWarnings(response: Resolved): void {
  const messages: string[] = [];
  const danger: boolean[] = [];

  if (response.destination) {
    const downgrade = schemeDowngradeWarning(response.scheme, response.destination);
    if (downgrade) {
      messages.push(downgrade);
      danger.push(true);
    }
    for (const warning of destinationWarnings(response.destination)) {
      messages.push(warning);
      danger.push(warning.includes("plain HTTP") || warning.includes("IP address"));
    }
  }
  if (response.registry.source === "sample") {
    messages.push(
      "This is the bundled sample registry. Publish the organization registry and press Sync to replace it.",
    );
    danger.push(false);
  }
  if (response.registry.stale) {
    messages.push("The cached registry is stale; the last successful sync is old.");
    danger.push(false);
  }
  if (response.publicDns.status === "error") {
    messages.push(
      `Public DNS could not be checked (${response.publicDns.error ?? "unknown error"}). The conflict check is unverified.`,
    );
    danger.push(false);
  }
  if (response.publicDns.status === "disabled") {
    messages.push("Public DNS conflict checks are disabled in Settings.");
    danger.push(false);
  }

  const container = el("warnings");
  container.replaceChildren();
  messages.forEach((message, index) => {
    const paragraph = document.createElement("p");
    paragraph.className = danger[index] ? "warning danger" : "warning";
    paragraph.textContent = message;
    container.append(paragraph);
  });
  container.hidden = messages.length === 0;
}

function renderRecord(response: Resolved): void {
  const record = response.record;
  if (!record) return;
  el("record").hidden = false;
  setText("eyebrow", "Registry record found");
  setText("destination", response.destination ?? "No usable destination");

  const owner = el("owner");
  owner.replaceChildren();
  const ownerLink = document.createElement("a");
  ownerLink.href = `https://github.com/${encodeURIComponent(record.owner)}`;
  ownerLink.target = "_blank";
  ownerLink.rel = "noreferrer noopener";
  ownerLink.textContent = `@${record.owner}`;
  owner.append(ownerLink);

  const dns: string[] = [];
  if (record.a.length > 0) dns.push(`A ${record.a.join(", ")}`);
  if (record.aaaa.length > 0) dns.push(`AAAA ${record.aaaa.join(", ")}`);
  if (record.cname) dns.push(`CNAME ${record.cname}`);
  setText("dns-records", dns.length > 0 ? dns.join(" · ") : "URL target only");

  setText("record-updated", formatDate(record.updatedAt ?? response.registry.updatedAt));
  const description = el("description");
  description.textContent = record.description ?? "";
  description.hidden = !record.description;
}

function canAutoOpen(destination: string): boolean {
  try {
    const url = new URL(destination);
    return url.protocol === "https:" && !isIpv4(url.hostname) && !url.hostname.startsWith("[");
  } catch {
    return false;
  }
}

function cancelAutoContinue(): void {
  if (autoInterval !== undefined) window.clearInterval(autoInterval);
  autoInterval = undefined;
  el("countdown").hidden = true;
  setText("summary", "Navigation paused. Press Continue when you are ready.");
}

function navigate(destination: string): void {
  if (autoInterval !== undefined) window.clearInterval(autoInterval);
  autoInterval = undefined;
  try {
    const url = new URL(destination);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported destination scheme");
    }
    location.replace(url.href);
  } catch {
    showError("The registry target is not a safe HTTP(S) URL, so it was blocked.");
  }
}

function startAutoContinue(destination: string): void {
  // Never open a destination in a background tab: the user did not see the
  // notice, so require an explicit click instead.
  if (document.visibilityState !== "visible") {
    cancelAutoContinue();
    return;
  }
  const delayMs = 1800;
  autoDeadline = Date.now() + delayMs;
  el("countdown").hidden = false;
  const tick = (): void => {
    const remaining = Math.max(0, autoDeadline - Date.now());
    setText(
      "countdown",
      remaining > 0
        ? `Opening in ${(remaining / 1000).toFixed(1)}s — press Escape or “Stay here” to cancel.`
        : "Opening…",
    );
    if (remaining <= 0) {
      if (autoInterval !== undefined) window.clearInterval(autoInterval);
      autoInterval = undefined;
      navigate(destination);
    }
  };
  tick();
  autoInterval = window.setInterval(tick, 100);
}

async function openPublic(): Promise<void> {
  const buttons = [el<HTMLButtonElement>("choose-public"), el<HTMLButtonElement>("public-button")];
  for (const button of buttons) button.disabled = true;
  try {
    const response = await sendRuntimeMessage<BypassResponse>({
      type: "bypass",
      host: requestedHost,
      scheme,
    });
    if (!response.ok) throw new Error(response.error);
    location.replace(response.url);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not open the public DNS site.");
  }
}

function renderResolved(response: Resolved): void {
  const destination = response.destination;
  if (!destination) {
    showError("The record exists but has no usable destination. Ask the steward to add a URL.");
    return;
  }
  el("not-found-actions").hidden = true;
  el("conflict").hidden = true;
  el("primary-actions").hidden = false;

  const safeAuto = canAutoOpen(destination);
  if (response.publicDns.status === "none") {
    setText("summary", "No public DNS conflict was found. The registry target is ready.");
  } else if (response.publicDns.status === "disabled") {
    setText("summary", "The registry target is ready. Public DNS checking is disabled.");
  } else {
    setText(
      "summary",
      "The registry target is ready, but public DNS could not be verified. Review it before continuing.",
    );
  }

  el<HTMLButtonElement>("continue").onclick = () => navigate(destination);
  el<HTMLButtonElement>("stay").onclick = cancelAutoContinue;

  const shouldAuto =
    response.autoContinue && safeAuto && response.publicDns.status === "none";
  if (shouldAuto) startAutoContinue(destination);
  else el("countdown").hidden = true;

  // Escape is a deliberate, keyboard-accessible way to stop the timer.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && autoInterval !== undefined) cancelAutoContinue();
    },
    { once: false },
  );
}

function renderConflict(response: Resolved): void {
  const destination = response.destination;
  if (!destination) {
    showError("The record exists but has no usable destination.");
    return;
  }
  setText("summary", "This name resolves in both universes. Nothing has been opened yet. Choose one:");
  setText("registry-sub", destination);
  setText("public-sub", `Public DNS: ${response.publicDns.addresses.join(", ") || "answer returned"}`);
  el("conflict").hidden = false;
  el("primary-actions").hidden = true;

  el<HTMLButtonElement>("choose-registry").onclick = () => navigate(destination);
  el<HTMLButtonElement>("choose-public").onclick = () => void openPublic();
  el<HTMLButtonElement>("conflict-stay").onclick = () => {
    setText("summary", "Nothing was opened. Close this tab when you are done.");
  };
}

function renderNotFound(response: Resolved): void {
  setText("eyebrow", "No current registry record");
  el("not-found").hidden = false;
  el("not-found-actions").hidden = false;
  setText("missing-host", response.host);

  if (response.publicDns.status === "exists") {
    setText("summary", "This name has no current registry record, but it resolves in public DNS.");
    const publicButton = el<HTMLButtonElement>("public-button");
    publicButton.hidden = false;
    publicButton.textContent = "Open public DNS site";
    publicButton.onclick = () => void openPublic();
  } else if (response.publicDns.status === "error") {
    setText("summary", "This name has no current registry record, and public DNS could not be checked.");
  } else if (response.publicDns.status === "disabled") {
    setText("summary", "This name has no current registry record. Public DNS checking is disabled.");
  } else {
    setText("summary", "This name has no current registry record, and public DNS returned no answer.");
  }

  const repo =
    response.registry.source === "sample"
      ? OFFICIAL_REGISTRY_REPO
      : registryRepoUrl(response.registry.registryUrl);
  const request = el<HTMLAnchorElement>("request-name");
  if (repo.startsWith("https://github.com/")) {
    const body = [
      `Name: ${response.host}`,
      "Target URL: ",
      "GitHub handle: @",
      "",
      "Why this name:",
      "",
    ].join("\n");
    request.href = `${repo}/issues/new?title=${encodeURIComponent(
      `Register ${response.host}`,
    )}&body=${encodeURIComponent(body)}`;
    request.hidden = false;
  } else {
    request.hidden = true;
  }
  el<HTMLButtonElement>("back").onclick = goBack;
}

function goBack(): void {
  if (history.length > 1) history.back();
  else window.close();
}

function render(response: Resolved): void {
  if (response.host !== requestedHost.toLowerCase()) {
    hostHeading.textContent = response.host;
  }
  el("loading").hidden = true;
  setSourceBadge(response.registry);
  setRegistryLink(response.registry);
  renderWarnings(response);

  if (!response.record) {
    renderNotFound(response);
    return;
  }
  renderRecord(response);
  if (response.publicDns.status === "exists") renderConflict(response);
  else renderResolved(response);
}

async function init(): Promise<void> {
  if (!requestedHost || requestedHost.length > 253) {
    showError("The request did not include a valid hostname.");
    return;
  }
  try {
    const response = await sendRuntimeMessage<ResolveResponse>({
      type: "resolve",
      host: requestedHost,
      scheme,
    });
    if (!response.ok) {
      showError(response.error);
      return;
    }
    render(response);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not resolve this name.");
  }
}

el<HTMLButtonElement>("error-back").onclick = goBack;

void init();
