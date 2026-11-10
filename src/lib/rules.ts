import { api } from "./api";
import { SESSION_RULE_CLEANUP_PREFIX, SESSION_RULE_TTL_MS } from "./constants";
import type { RegistryRecord } from "./types";

/** Escape a string for use inside a RE2 regexFilter. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One redirect rule per registered name. This is intentionally not one rule per
 * TLD: a registry can contain google.com without intercepting every .com site.
 * Only main-frame navigations are touched, so embedded resources are not.
 *
 * The regex must match the *entire* URL: DNR appends the unmatched remainder
 * of the URL to a regexSubstitution.
 */
export async function applyInterceptionRules(
  records: RegistryRecord[],
  enabled: boolean,
): Promise<void> {
  const existing = await api.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  if (!enabled || records.length === 0) {
    if (removeRuleIds.length > 0) {
      await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
    return;
  }

  const interstitial = api.runtime.getURL("interstitial.html");
  const addRules: chrome.declarativeNetRequest.Rule[] = records.map((record, index) => {
    const wildcard = record.name.startsWith("*.");
    const base = wildcard ? record.name.slice(2) : record.name;
    const hostPattern = wildcard
      ? `([^/?#]+\\.${escapeRegex(base)})`
      : `(${escapeRegex(base)})`;
    return {
      id: index + 1,
      // More specific wildcards win. Exact records always beat wildcards.
      priority: wildcard ? 100 + base.split(".").length : 1_000,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: `${interstitial}?scheme=\\1&host=\\2` },
      },
      condition: {
        regexFilter: `^(https?)://${hostPattern}(?::\\d+)?(?:[/?#][^\\s]*)?$`,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame"],
      },
    };
  });

  await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

/**
 * Let a single tab reach the public-DNS version of a name for 60 seconds.
 * DNR session rules support `tabIds`; dynamic rules do not.
 */
export async function allowTabForHost(tabId: number, host: string): Promise<void> {
  const existing = await api.declarativeNetRequest.getSessionRules();
  const nextId = existing.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
  await api.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id: nextId,
        priority: 5_000,
        action: { type: "allow" },
        condition: {
          tabIds: [tabId],
          requestDomains: [host],
          resourceTypes: ["main_frame"],
        },
      },
    ],
  });
  await api.alarms.create(`${SESSION_RULE_CLEANUP_PREFIX}${nextId}`, {
    when: Date.now() + SESSION_RULE_TTL_MS,
  });
}

export async function clearSessionRules(): Promise<void> {
  const existing = await api.declarativeNetRequest.getSessionRules();
  if (existing.length === 0) return;
  await api.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((rule) => rule.id),
  });
}

export async function cleanupSessionRule(ruleId: number): Promise<void> {
  try {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch (error) {
    console.warn("[fdn] Could not remove session rule", ruleId, error);
  }
}
