/** URL validation shared by settings, DoH, and registry code. */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function validateRegistryUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return null;
  }
  return url.href;
}

/**
 * DoH JSON endpoints must be HTTPS, except for loopback hosts so that the
 * extension can be tested against a local mock resolver.
 */
export function validateDohEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return null;
  }
  return url.href;
}

export function buildDohRequestUrl(endpoint: string, hostname: string, type: "A" | "AAAA"): string {
  const url = new URL(endpoint);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  return url.href;
}

/**
 * Best-effort human-facing URL for a registry endpoint. Raw GitHub URLs are
 * converted to their repository page so users can review or open a PR.
 */
export function registryRepoUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname === "raw.githubusercontent.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `https://github.com/${parts[0]}/${parts[1]}`;
    }
    return url.href;
  } catch {
    return raw;
  }
}
