import { readFileSync } from "node:fs";
import { validateRegistry } from "../src/lib/validation";

const file = process.argv[2] ?? "registry/client.json";
try {
  const payload: unknown = JSON.parse(readFileSync(file, "utf8"));
  const registry = validateRegistry(payload);
  console.log(
    `OK ${file}: ${registry.records.length} record(s), ${registry.records.filter((r) => r.name.startsWith("*.")).length} wildcard(s)`,
  );
} catch (error) {
  console.error(`FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
