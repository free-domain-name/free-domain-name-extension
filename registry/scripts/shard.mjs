/**
 * Deterministic shard layout shared by the registry CI and the client builder.
 *
 * The record name is lowercased and its dots are removed, then the first three
 * characters become the first directory and the next three the second:
 *
 *   google.com        -> names/goo/gle/google.com.json
 *   abc.com           -> names/abc/com/abc.com.json
 *   *.demo.fdn        -> names/dem/ofd/_wildcard.demo.fdn.json
 *
 * The full name is still in the filename and inside the record, so a path is
 * self-describing and duplicate names cannot silently land in two places.
 */
export const LAYOUT = "sharded-v1";
export const SHARD_LENGTHS = [3, 3];

export function isWildcard(name) {
  return typeof name === "string" && name.startsWith("*.");
}

export function baseName(name) {
  return isWildcard(name) ? name.slice(2) : name;
}

export function recordFileName(name) {
  const base = baseName(name);
  return isWildcard(name) ? `_wildcard.${base}.json` : `${base}.json`;
}

export function recordPath(name) {
  const slug = baseName(name).replace(/\./g, "").padEnd(6, "_");
  const first = slug.slice(0, SHARD_LENGTHS[0]);
  const second = slug.slice(SHARD_LENGTHS[0], SHARD_LENGTHS[0] + SHARD_LENGTHS[1]);
  return `names/${first}/${second}/${recordFileName(name)}`;
}

export function pathToName(relativePath) {
  const match = relativePath.match(/^names\/[^/]+\/[^/]+\/(.+)$/);
  if (!match) return null;
  const file = match[1];
  if (file.startsWith("_wildcard.") && file.endsWith(".json")) {
    return `*.${file.slice("_wildcard.".length, -".json".length)}`;
  }
  if (file.endsWith(".json")) return file.slice(0, -".json".length);
  return null;
}
