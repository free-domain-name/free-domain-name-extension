/** Limits and safety lists shared by the extension and registry validation. */

export const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;
export const MAX_REGISTRY_RECORDS = 2_000;
export const MAX_NAME_LENGTH = 253;

export const REGISTRY_SYNC_ALARM = "registry-sync";
export const SESSION_RULE_CLEANUP_PREFIX = "cleanup-session-rule:";
export const SESSION_RULE_TTL_MS = 60_000;

export const OFFICIAL_REGISTRY_REPO = "https://github.com/free-domain-name/registry";
export const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/free-domain-name/registry/main/registry.json";
export const DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
