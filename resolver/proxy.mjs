#!/usr/bin/env node
/**
 * Free Domain Name local resolver proxy.
 *
 * The browser extension cannot open a socket, so this companion process does
 * the actual DNS-like step for HTTP: it receives the original absolute URL
 * (including the original Host), looks up the registry, connects to the record
 * target, and streams the response back. The browser URL never changes.
 *
 * HTTP only. HTTPS is intentionally out of scope.
 */
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY =
  "https://raw.githubusercontent.com/free-domain-name/registry/refs/heads/main/client.json";
const DEFAULT_PORT = 8787;
const REFRESH_MS = 60_000;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const port = Number(argValue("--port", process.env.RESOLVER_PORT ?? DEFAULT_PORT));
const registrySource =
  argValue("--registry", process.env.REGISTRY_URL ?? DEFAULT_REGISTRY);
const host = "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Invalid --port; expected 1..65535");
  process.exit(2);
}

let records = [];
let loadedAt = null;
let loadError = null;

function normalizeHost(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.$/, "");
}

function lookupRecord(hostname) {
  const name = normalizeHost(hostname);
  let wildcard = null;
  for (const record of records) {
    const recordName = normalizeHost(record.name);
    if (recordName === name) return record;
    if (recordName.startsWith("*.")) {
      const base = recordName.slice(2);
      if (name === base || name.endsWith(`.${base}`)) wildcard = record;
    }
  }
  return wildcard;
}

async function loadRegistry() {
  try {
    let payload;
    if (/^https?:\/\//i.test(registrySource)) {
      const response = await fetch(registrySource, {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } else {
      const file = path.resolve(registrySource);
      payload = JSON.parse(await readFile(file, "utf8"));
    }
    if (!payload || !Array.isArray(payload.records)) {
      throw new Error("registry payload has no records array");
    }
    records = payload.records;
    loadedAt = Date.now();
    loadError = null;
    console.log(`[resolver] loaded ${records.length} record(s) from ${registrySource}`);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    console.error(`[resolver] registry load failed: ${loadError}`);
  }
}

function originalFromRequest(req) {
  const raw = req.url || "/";
  try {
    const absolute = new URL(raw);
    if (absolute.protocol === "http:") return absolute;
  } catch {
    // Fall through to the origin-form request below.
  }
  return new URL(raw, `http://${req.headers.host || "localhost"}`);
}

function targetForRecord(record) {
  if (record.url) {
    const target = new URL(record.url);
    if (target.protocol !== "http:") {
      throw new Error("resolver proxy only supports http targets");
    }
    return {
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: Number(target.port || 80),
      isIp: isIP(target.hostname.replace(/^\[|\]$/g, "")) !== 0,
    };
  }
  if (record.cname) {
    return { hostname: String(record.cname), port: 80, isIp: false };
  }
  const address = Array.isArray(record.a) && record.a[0];
  if (address && isIP(address) === 4) {
    return { hostname: address, port: 80, isIp: true };
  }
  throw new Error("record has no usable target");
}

function hopByHopHeaders(headers) {
  const next = { ...headers };
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete next[name];
  }
  return next;
}

function hostHeader(hostname, portNumber) {
  const rendered = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return portNumber === 80 ? rendered : `${rendered}:${portNumber}`;
}

function rewriteLocation(location, target, original) {
  try {
    const resolved = new URL(location, `http://${hostHeader(target.hostname, target.port)}/`);
    if (
      normalizeHost(resolved.hostname) === normalizeHost(target.hostname) &&
      (resolved.port || "80") === String(target.port)
    ) {
      return `http://${original.host}${resolved.pathname}${resolved.search}${resolved.hash}`;
    }
  } catch {
    // Keep the upstream value if it is not a parseable absolute URL.
  }
  return location;
}

function rewriteSetCookie(value, target, original) {
  if (typeof value !== "string") return value;
  const targetHost = target.hostname.replace(/^\[|\]$/g, "");
  return value.replace(
    new RegExp(`Domain=\\.?${targetHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"),
    `Domain=${original.hostname}`,
  );
}

function rewriteHeaders(headers, target, original) {
  const next = hopByHopHeaders(headers);
  // The target's HSTS belongs to the target host; forwarding it under the
  // requested name would force that name to HTTPS and break this HTTP resolver.
  delete next["strict-transport-security"];
  delete next["alt-svc"];
  if (typeof next.location === "string") {
    next.location = rewriteLocation(next.location, target, original);
  }
  if (next["set-cookie"]) {
    next["set-cookie"] = next["set-cookie"].map((cookie) =>
      rewriteSetCookie(cookie, target, original),
    );
  }
  if (typeof next["access-control-allow-origin"] === "string") {
    try {
      const allowed = new URL(next["access-control-allow-origin"]);
      if (normalizeHost(allowed.hostname) === normalizeHost(target.hostname)) {
        next["access-control-allow-origin"] = `${original.protocol}//${original.host}`;
      }
    } catch {
      // "*" and "null" are valid and need no rewrite.
    }
  }
  return next;
}

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(`${message}\n`);
}

const server = createServer((req, res) => {
  if (req.url === "/__health") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(
      JSON.stringify({
        ok: true,
        records: records.length,
        loadedAt,
        error: loadError,
      }),
    );
    return;
  }

  let original;
  try {
    original = originalFromRequest(req);
  } catch {
    sendError(res, 400, "Invalid request URL");
    return;
  }
  if (original.protocol !== "http:") {
    sendError(res, 501, "The resolver proxy only handles HTTP");
    return;
  }

  const record = lookupRecord(original.hostname);
  let target;
  try {
    target = record
      ? targetForRecord(record)
      : {
          hostname: original.hostname,
          port: Number(original.port || 80),
          isIp: isIP(original.hostname) !== 0,
        };
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : "No target");
    return;
  }

  const upstreamHeaders = hopByHopHeaders(req.headers);
  upstreamHeaders.connection = "close";
  // An IP/port target is DNS-like: preserve the name the user requested. A
  // hostname target is a reverse proxy: use that target host so its vhost is
  // selected while the browser still shows the original name.
  upstreamHeaders.host = target.isIp
    ? req.headers.host || original.host
    : hostHeader(target.hostname, target.port);

  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${original.pathname}${original.search}`,
      headers: upstreamHeaders,
      timeout: 30_000,
    },
    (upstreamResponse) => {
      const headers = rewriteHeaders(upstreamResponse.headers, target, original);
      res.writeHead(upstreamResponse.statusCode || 502, headers);
      upstreamResponse.pipe(res);
    },
  );

  upstream.on("timeout", () => {
    upstream.destroy(new Error("upstream timeout"));
  });
  upstream.on("error", (error) => {
    sendError(res, 502, `Resolver upstream failed: ${error.message}`);
  });
  req.pipe(upstream);
});

server.on("error", (error) => {
  console.error(`[resolver] server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`[resolver] listening on http://${host}:${port}`);
  console.log(`[resolver] registry: ${registrySource}`);
  void loadRegistry();
  setInterval(loadRegistry, REFRESH_MS).unref();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
