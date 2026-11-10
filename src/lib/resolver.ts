/**
 * Local resolver-proxy integration.
 *
 * A browser extension cannot open sockets or answer DNS, so the "DNS-like"
 * mode is a companion HTTP proxy. This module asks the browser to send only
 * registry-managed HTTP navigations through that proxy; the proxy connects to
 * the record target while preserving the original URL/Host.
 *
 * The proxy is optional. If it is offline, the caller falls back to the DNR
 * redirect rules so the extension still works in its v1 compatibility mode.
 */
import { api } from "./api";
import type { RegistryRecord, Settings } from "./types";

export interface ResolverState {
  active: boolean;
  port: number;
  error: string | null;
}

const DEFAULT_RESOLVER_PORT = 8787;

interface FirefoxProxyInfo {
  type: "http";
  host: string;
  port: number;
}

interface FirefoxRequestDetails {
  url: string;
}

interface FirefoxProxyApi {
  onRequest?: {
    addListener: (
      listener: (details: FirefoxRequestDetails) => FirefoxProxyInfo | { type: "direct" },
      filter: { urls: string[] },
    ) => void;
  };
}

const firefoxProxy: {
  enabled: boolean;
  port: number;
  records: RegistryRecord[];
} = {
  enabled: false,
  port: DEFAULT_RESOLVER_PORT,
  records: [],
};

let state: ResolverState = {
  active: false,
  port: DEFAULT_RESOLVER_PORT,
  error: null,
};

export function getResolverState(): ResolverState {
  return { ...state };
}

export function resolverPortOf(settings: Settings): number {
  const port = Number(settings.resolverPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return DEFAULT_RESOLVER_PORT;
  return port;
}

function matchesRecord(records: RegistryRecord[], host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return records.some((record) => {
    const name = record.name.toLowerCase();
    if (name.startsWith("*.")) {
      const base = name.slice(2);
      return normalized === base || normalized.endsWith(`.${base}`);
    }
    return normalized === name;
  });
}

/**
 * PAC matching is generated from the current registry so normal HTTP browsing
 * stays direct. Only names that actually need resolution are sent to the
 * loopback proxy.
 */
export function buildPacScript(records: RegistryRecord[], port: number): string {
  const exact = new Set<string>();
  const suffixes = new Set<string>();
  for (const record of records) {
    const name = record.name.toLowerCase();
    if (name.startsWith("*.")) suffixes.add(name.slice(2));
    else exact.add(name);
  }

  const conditions: string[] = [];
  for (const name of exact) conditions.push(`host === ${JSON.stringify(name)}`);
  for (const base of suffixes) {
    conditions.push(
      `(host === ${JSON.stringify(base)} || dnsDomainIs(host, ${JSON.stringify(`.${base}`)}))`,
    );
  }

  const match = conditions.length > 0 ? conditions.join(" || ") : "false";
  return [
    "function FindProxyForURL(url, host) {",
    '  if (url.slice(0, 5) !== "http:") return "DIRECT";',
    "  host = host.toLowerCase();",
    `  if (${match}) return ${JSON.stringify(`PROXY 127.0.0.1:${port}`)};`,
    '  return "DIRECT";',
    "}",
  ].join("\n");
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

interface ChromeProxySettings {
  set: (details: unknown, callback: () => void) => void;
  clear: (details: unknown, callback: () => void) => void;
  get?: (details: unknown, callback: (details: unknown) => void) => void;
}

const PAC_MARKER = "// Free Domain Name resolver";

function chromeProxySettings(): ChromeProxySettings | null {
  // Chrome exposes `browser` as a partial alias in some versions, but the
  // reliable proxy-settings surface lives on `chrome`. Firefox uses
  // proxy.onRequest and skips this path.
  const chromeScope = globalThis as unknown as {
    chrome?: { proxy?: { settings?: unknown } };
  };
  const proxy =
    chromeScope.chrome?.proxy ??
    (api as unknown as { proxy?: { settings?: unknown } }).proxy;
  if (!proxy || !proxy.settings) return null;
  const settings = proxy.settings as Partial<ChromeProxySettings>;
  if (!settings.set || !settings.clear) return null;
  return settings as ChromeProxySettings;
}

function callProxySettings(
  target: ChromeProxySettings,
  method: "set" | "clear",
  details: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    target[method](details, () => {
      const runtime = api.runtime as unknown as { lastError?: { message?: string } };
      if (runtime.lastError?.message) reject(new Error(runtime.lastError.message));
      else resolve();
    });
  });
}

async function enableChromeProxy(records: RegistryRecord[], port: number): Promise<void> {
  const settings = chromeProxySettings();
  if (!settings) throw new Error("This browser does not expose the proxy settings API");
  await callProxySettings(settings, "set", {
    value: {
      mode: "pac_script",
      pacScript: { data: `${PAC_MARKER}\n${buildPacScript(records, port)}` },
    },
    scope: "regular",
  });
}

async function disableChromeProxy(): Promise<void> {
  const settings = chromeProxySettings();
  if (!settings) return;
  // Never clear a proxy the user configured. Only remove the PAC this
  // extension writes, identified by its marker.
  if (!settings.get) return;
  try {
    const existing = await new Promise<unknown>((resolve, reject) => {
      settings.get?.({}, (details) => {
        const runtime = api.runtime as unknown as { lastError?: { message?: string } };
        if (runtime.lastError?.message) reject(new Error(runtime.lastError.message));
        else resolve(details);
      });
    });
    const value = (existing as { value?: { pacScript?: { data?: string } } } | null)?.value;
    if (!value?.pacScript?.data?.includes(PAC_MARKER)) return;
    await callProxySettings(settings, "clear", { scope: "regular" });
  } catch (error) {
    console.warn("[fdn] Could not clear proxy settings", error);
  }
}

function firefoxProxyApi(): FirefoxProxyApi | null {
  const browserScope = globalThis as unknown as { browser?: { proxy?: FirefoxProxyApi } };
  return browserScope.browser?.proxy ?? null;
}

function installFirefoxProxyListener(): void {
  const proxy = firefoxProxyApi();
  if (!proxy?.onRequest?.addListener) return;

  proxy.onRequest.addListener(
    (details) => {
      if (!firefoxProxy.enabled) return { type: "direct" };
      try {
        const url = new URL(details.url);
        if (url.protocol !== "http:") return { type: "direct" };
        if (!matchesRecord(firefoxProxy.records, url.hostname)) return { type: "direct" };
        return { type: "http", host: "127.0.0.1", port: firefoxProxy.port };
      } catch {
        return { type: "direct" };
      }
    },
    { urls: ["http://*/*"] },
  );
}

installFirefoxProxyListener();

/**
 * Enable the resolver when the local proxy answers, otherwise stay on the DNR
 * compatibility path. Returns true only when the proxy is active.
 */
export async function configureResolver(
  settings: Settings,
  records: RegistryRecord[],
): Promise<boolean> {
  const port = resolverPortOf(settings);
  state = { active: false, port, error: null };

  if (!settings.enabled || !settings.resolverEnabled) {
    firefoxProxy.enabled = false;
    await disableChromeProxy();
    return false;
  }

  const healthy = await checkHealth(port);
  if (!healthy) {
    firefoxProxy.enabled = false;
    await disableChromeProxy();
    state = {
      active: false,
      port,
      error: "Resolver service is offline; no interception is active.",
    };
    return false;
  }

  try {
    firefoxProxy.records = records;
    firefoxProxy.port = port;
    firefoxProxy.enabled = true;
    // Firefox uses proxy.onRequest; Chrome has no per-request proxy API and
    // uses the PAC script instead.
    if (!firefoxProxyApi()?.onRequest) {
      await enableChromeProxy(records, port);
    }
    state = { active: true, port, error: null };
    return true;
  } catch (error) {
    console.error("[fdn] Resolver proxy enable failed", error);
    firefoxProxy.enabled = false;
    state = {
      active: false,
      port,
      error: error instanceof Error ? error.message : "Could not enable the resolver proxy",
    };
    return false;
  }
}

export async function disableResolver(): Promise<void> {
  firefoxProxy.enabled = false;
  await disableChromeProxy();
  state = { active: false, port: state.port, error: null };
}
