#!/usr/bin/env node
/**
 * Build the compact client index from the sharded source tree.
 *
 * The shards are the source of truth for review and history. Browser clients
 * need one bounded document because declarativeNetRequest rules are bounded;
 * client.json is generated from the shards and is never edited by hand.
 *
 * Usage:
 *   node scripts/build-client.mjs           # write client.json
 *   node scripts/build-client.mjs --check   # fail if client.json is stale
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT, recordPath } from "./shard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const namesDir = path.join(root, "names");
const manifestPath = path.join(root, "registry.json");
const clientPath = path.join(root, "client.json");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.layout !== LAYOUT) {
  throw new Error(`registry.json layout is ${manifest.layout}, expected ${LAYOUT}`);
}

const files = (await walk(namesDir)).sort();
const records = [];
const seen = new Set();
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const record = JSON.parse(await readFile(file, "utf8"));
  if (!record || typeof record.name !== "string") {
    throw new Error(`${relative}: record has no name`);
  }
  const expected = recordPath(record.name);
  if (relative !== expected) {
    throw new Error(`${relative}: expected shard path ${expected} for ${record.name}`);
  }
  if (seen.has(record.name)) {
    throw new Error(`${relative}: duplicate record name ${record.name}`);
  }
  seen.add(record.name);
  records.push(record);
}

records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const wildcardCount = records.filter((record) => record.name.startsWith("*.")).length;
if (manifest.recordCount !== records.length) {
  throw new Error(
    `registry.json recordCount is ${manifest.recordCount}, found ${records.length} record files`,
  );
}
if (manifest.wildcardCount !== wildcardCount) {
  throw new Error(
    `registry.json wildcardCount is ${manifest.wildcardCount}, found ${wildcardCount}`,
  );
}

const client = {
  schemaVersion: manifest.schemaVersion,
  name: manifest.name,
  updatedAt: manifest.updatedAt,
  layout: "client-v1",
  recordCount: records.length,
  wildcardCount,
  records,
};
const serialized = `${JSON.stringify(client, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = await readFile(clientPath, "utf8");
  } catch {
    // Missing client is stale.
  }
  if (current !== serialized) {
    console.error("client.json is stale. Run: node scripts/build-client.mjs");
    process.exit(1);
  }
  console.log(`OK client.json: ${records.length} record(s), ${wildcardCount} wildcard(s)`);
} else {
  await writeFile(clientPath, serialized);
  console.log(`wrote client.json: ${records.length} record(s), ${wildcardCount} wildcard(s)`);
}
