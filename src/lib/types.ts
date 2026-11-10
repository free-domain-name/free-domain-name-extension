/**
 * Shared types for the Free Domain Name resolver.
 *
 * The on-disk registry format intentionally mirrors DNS vocabulary while also
 * carrying the one thing a browser can actually navigate to: a target URL.
 */

export const SCHEMA_VERSION = 1;

/** A single name in the registry. */
export interface RegistryRecord {
  /** Lowercase ASCII/punycode name; may start with `*.` for a wildcard. */
  name: string;
  /** IPv4 addresses. Metadata only; `url` is what the browser navigates to. */
  a: string[];
  /** IPv6 addresses. Metadata only. */
  aaaa: string[];
  /** Canonical DNS name, if any. */
  cname?: string;
  /** HTTPS/HTTP URL the extension opens. Recommended. */
  url?: string;
  /** GitHub handle of the steward, e.g. "octocat". */
  owner: string;
  description?: string;
  updatedAt?: string;
}

export interface Registry {
  schemaVersion: number;
  name?: string;
  updatedAt: string;
  records: RegistryRecord[];
}

export type RegistrySource = "remote" | "sample";

export interface RegistryCache {
  registry: Registry;
  fetchedAt: number;
  source: RegistrySource;
  etag?: string;
}

export interface SyncStatus {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  error: string | null;
  source: RegistrySource | null;
  recordCount: number;
  wildcardCount: number;
}

export interface Settings {
  enabled: boolean;
  registryUrl: string;
  syncIntervalMinutes: number;
  /** Automatically open a non-conflicting HTTPS target after a short notice. */
  autoContinue: boolean;
  /** Query public DNS (DoH) to detect conflicts with the real internet. */
  checkPublicDns: boolean;
  dohEndpoint: string;
}

export type DnsStatus = "exists" | "none" | "error" | "disabled";

export interface PublicDnsResult {
  status: DnsStatus;
  addresses: string[];
  error?: string;
  checkedAt: number | null;
}

export interface RegistryMeta {
  source: RegistrySource;
  registryUrl: string;
  updatedAt: string;
  fetchedAt: number;
  stale: boolean;
  recordCount: number;
  wildcardCount: number;
}

export type ResolveResponse =
  | {
      ok: true;
      host: string;
      scheme: "http" | "https";
      record: RegistryRecord | null;
      destination: string | null;
      publicDns: PublicDnsResult;
      registry: RegistryMeta;
      autoContinue: boolean;
    }
  | { ok: false; error: string };

export type StatusResponse =
  | {
      ok: true;
      settings: Settings;
      status: SyncStatus;
      registry: RegistryMeta | null;
    }
  | { ok: false; error: string };

export type SyncResponse =
  | { ok: true; status: SyncStatus; registry: RegistryMeta | null }
  | { ok: false; error: string };

export type BypassResponse = { ok: true; url: string } | { ok: false; error: string };

export type SaveSettingsResponse =
  | { ok: true; settings: Settings; status: SyncStatus; registry: RegistryMeta | null }
  | { ok: false; error: string };

export interface ResolveRequest {
  type: "resolve";
  host: string;
  scheme: "http" | "https";
}

export interface BypassRequest {
  type: "bypass";
  host: string;
  scheme: "http" | "https";
}

export interface StatusRequest {
  type: "status";
}

export interface SyncRequest {
  type: "sync";
}

export interface ToggleRequest {
  type: "toggle";
  enabled: boolean;
}

export interface SaveSettingsRequest {
  type: "saveSettings";
  settings: Partial<Settings>;
}

export type RequestMessage =
  | ResolveRequest
  | BypassRequest
  | StatusRequest
  | SyncRequest
  | ToggleRequest
  | SaveSettingsRequest;
