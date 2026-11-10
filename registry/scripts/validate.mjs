#!/usr/bin/env node
/**
 * Validate the sharded registry without any npm dependencies.
 *
 * Checks:
 *   - every record lives at the deterministic shard path for its name
 *   - names are unique (duplicate names cannot overwrite each other)
 *   - names are lowercase DNS names with at least one dot, or one leading *.
 *   - URL/CNAME/A/AAAA destinations are well formed; ports are allowed
 *   - a destination cannot also be intercepted by this registry (loop)
 *   - manifest counts match the files
 */
import { isIP } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT, SHARD_LENGTHS, recordPath } from "./shard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const namesDir = path.join(root, "names");
const errors = [];

function fail(message) {
  errors.push(message);
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function checkHostname(value, what) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) {
    fail(`${what}: invalid hostname`);
    return false;
  }
  if (value !== value.toLowerCase()) fail(`${what}: hostname must be lowercase`);
  if (value.endsWith(".")) fail(`${what}: trailing dot is not allowed`);
  const labels = value.split(".");
  if (labels.length < 2) fail(`${what}: hostname must contain at least one dot`);
  for (const label of labels) {
    if (!LABEL.test(label)) fail(`${what}: invalid label "${label}"`);
  }
  return true;
}

function checkRecordName(name) {
  if (typeof name !== "string" || name.length === 0) {
    fail("record: missing name");
    return false;
  }
  const wildcard = name.startsWith("*.");
  const base = wildcard ? name.slice(2) : name;
  if (!wildcard && name.includes("*")) {
    fail(`${name}: only one leading wildcard is allowed`);
    return false;
  }
  if (wildcard && base.includes("*")) {
    fail(`${name}: only one leading wildcard is allowed`);
    return false;
  }
  return checkHostname(base, name);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

const manifest = JSON.parse(await readFile(path.join(root, "registry.json"), "utf8"));
if (manifest.schemaVersion !== 2) fail("registry.json: schemaVersion must be 2");
if (manifest.layout !== LAYOUT) fail(`registry.json: layout must be ${LAYOUT}`);
if (
  !Array.isArray(manifest.shardLengths) ||
  manifest.shardLengths.join(",") !== SHARD_LENGTHS.join(",")
) {
  fail(`registry.json: shardLengths must be [${SHARD_LENGTHS.join(", ")}]`);
}
if (typeof manifest.updatedAt !== "string" || Number.isNaN(Date.parse(manifest.updatedAt))) {
  fail("registry.json: updatedAt must be an ISO date");
}

const files = (await walk(namesDir)).sort();
const records = new Map();

for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`${relative}: invalid JSON (${error.message})`);
    continue;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail(`${relative}: record must be an object`);
    continue;
  }
  const name = record.name;
  if (!checkRecordName(name)) continue;
  const expected = recordPath(name);
  if (relative !== expected) {
    fail(`${relative}: expected ${expected} for ${name}`);
    continue;
  }
  if (records.has(name)) {
    fail(`${relative}: duplicate name ${name}; refusing to overwrite`);
    continue;
  }
  records.set(name, record);

  if (typeof record.owner !== "string" || !record.owner.trim()) {
    fail(`${relative}: owner is required`);
  }
  if (record.description !== undefined) {
    if (typeof record.description !== "string" || record.description.length > 280) {
      fail(`${relative}: description must be a string of at most 280 characters`);
    }
  }
  if (record.updatedAt !== undefined && Number.isNaN(Date.parse(record.updatedAt))) {
    fail(`${relative}: updatedAt is not a date`);
  }

  const hasUrl = typeof record.url === "string" && record.url.length > 0;
  const hasCname = typeof record.cname === "string" && record.cname.length > 0;
  const a = Array.isArray(record.a) ? record.a : [];
  const aaaa = Array.isArray(record.aaaa) ? record.aaaa : [];
  if (!hasUrl && !hasCname && a.length === 0 && aaaa.length === 0) {
    fail(`${relative}: needs url, cname, a, or aaaa`);
  }

  if (hasUrl) {
    let url;
    try {
      url = new URL(record.url);
    } catch {
      fail(`${relative}: invalid url`);
    }
    if (url) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        fail(`${relative}: url must be http(s)`);
      }
      if (!url.hostname) fail(`${relative}: url has no hostname`);
      if (url.username || url.password) fail(`${relative}: url must not contain credentials`);
      if (url.port === "0") fail(`${relative}: port 0 is not allowed`);
    }
  }
  if (hasCname && !checkHostname(record.cname, `${relative}: cname`)) {
    // checkHostname already reported.
  }
  for (const value of a) {
    if (typeof value !== "string" || isIP(value) !== 4) {
      fail(`${relative}: a[] must contain IPv4 addresses`);
    }
  }
  for (const value of aaaa) {
    if (typeof value !== "string" || isIP(value) !== 6) {
      fail(`${relative}: aaaa[] must contain IPv6 addresses`);
    }
  }
}

function lookup(name) {
  if (records.has(name)) return records.get(name);
  const parts = name.split(".");
  for (let index = 1; index < parts.length; index += 1) {
    const candidate = `*.${parts.slice(index).join(".")}`;
    if (records.has(candidate)) return records.get(candidate);
  }
  return undefined;
}

for (const [name, record] of records) {
  const targets = [];
  if (typeof record.url === "string") {
    try {
      targets.push(new URL(record.url).hostname);
    } catch {
      // Already reported.
    }
  }
  if (typeof record.cname === "string") targets.push(record.cname);
  for (const target of targets) {
    const match = lookup(target);
    if (match) {
      fail(`${name}: destination ${target} is also intercepted by ${match.name}; loop`);
    }
  }
}

if (records.size === 0) fail("names/: no record files found");
if (manifest.recordCount !== records.size) {
  fail(`registry.json: recordCount is ${manifest.recordCount}, found ${records.size}`);
}
const wildcardCount = [...records.keys()].filter((name) => name.startsWith("*.")).length;
if (manifest.wildcardCount !== wildcardCount) {
  fail(`registry.json: wildcardCount is ${manifest.wildcardCount}, found ${wildcardCount}`);
}

if (errors.length > 0) {
  console.error(`FAIL registry: ${errors.length} problem(s)`);
  for (const error of errors.slice(0, 50)) console.error(`  - ${error}`);
  if (errors.length > 50) console.error(`  ... and ${errors.length - 50} more`);
  process.exit(1);
}

console.log(`OK registry: ${records.size} record(s), ${wildcardCount} wildcard(s), ${files.length} shard file(s)`);
