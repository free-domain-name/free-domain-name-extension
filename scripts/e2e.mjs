#!/usr/bin/env node
/**
 * End-to-end smoke test for the built MV3 extension.
 *
 * Requirements:
 *   - `dist/` built (npm run build)
 *   - Chrome for Testing / Chromium (supports --load-extension). Set CHROME_BIN
 *     or install Playwright's Chromium. Branded Chrome refuses --load-extension.
 *
 * The test uses a local mock DoH resolver so the conflict path is deterministic
 * and does not depend on internet DNS. It writes screenshots to docs/screenshots.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SHOTS = path.join(ROOT, "docs", "screenshots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function findChrome() {
  if (process.env.CHROME_BIN) {
    if (!existsSync(process.env.CHROME_BIN)) throw new Error("CHROME_BIN does not exist");
    return process.env.CHROME_BIN;
  }
  const direct = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const candidate of direct) if (existsSync(candidate)) return candidate;

  const roots = [
    path.join(homedir(), "Library", "Caches", "ms-playwright"),
    path.join(homedir(), ".cache", "ms-playwright"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const relative of readdirSync(root, { recursive: true })) {
      const full = path.join(root, relative);
      const base = path.basename(full);
      if (
        (base === "Google Chrome for Testing" || base === "Chromium" || base === "chrome") &&
        (full.includes(`${path.sep}MacOS${path.sep}`) || full.includes("chrome-linux"))
      ) {
        return full;
      }
    }
  }
  throw new Error(
    "Chrome for Testing not found. Set CHROME_BIN to a Chromium/Chrome-for-Testing executable.",
  );
}

class Cdp {
  static async connect(webSocketUrl) {
    const ws = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const message = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (message.result?.exceptionDetails) {
      throw new Error(
        message.result.exceptionDetails.exception?.description ??
          message.result.exceptionDetails.text ??
          "Evaluation failed",
      );
    }
    return message.result?.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(description, fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function getTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function findExtensionWorker(port) {
  return waitFor(
    "extension service worker",
    async () => {
      for (const target of await getTargets(port)) {
        if (target.type !== "service_worker") continue;
        const connection = await Cdp.connect(target.webSocketDebuggerUrl);
        try {
          const name = await connection.eval("chrome.runtime.getManifest().name");
          if (name === "Free Domain Name Resolver") return { target, connection };
        } catch {
          connection.close();
        }
      }
      return null;
    },
    20_000,
  );
}

async function setSettings(sw, partial) {
  const expression = `chrome.storage.local.get("settings").then(({ settings }) =>
    chrome.storage.local.set({ settings: { ...(settings || {}), ${Object.entries(partial)
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(", ")} } })
  ).then(() => true)`;
  await sw.eval(expression);
}

async function bodyText(cdp) {
  return cdp.eval("document.body ? document.body.innerText : ''");
}

async function waitForUri(cdp, predicate, timeoutMs = 8_000) {
  return waitFor("navigation", async () => {
    try {
      const href = await cdp.eval("location.href");
      return predicate(href) ? href : null;
    } catch {
      return null;
    }
  }, timeoutMs);
}

async function waitForText(cdp, needle, timeoutMs = 8_000) {
  return waitFor(`text "${needle}"`, async () => (await bodyText(cdp)).includes(needle), timeoutMs);
}

async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function screenshot(cdp, name) {
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const content = metrics.result?.cssContentSize ?? metrics.result?.contentSize;
  const width = Math.min(1400, Math.max(380, Math.ceil(content?.width ?? 1100)));
  const height = Math.min(2400, Math.max(400, Math.ceil(content?.height ?? 900)));
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  const file = path.join(SHOTS, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  return file;
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
}

async function main() {
  if (!existsSync(path.join(DIST, "manifest.json"))) {
    throw new Error("dist/manifest.json is missing. Run: npm run build");
  }
  mkdirSync(SHOTS, { recursive: true });
  const chromePath = findChrome();
  console.log(`Chrome: ${chromePath}`);

  const dohServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/dns-query") {
      response.writeHead(404).end("not found");
      return;
    }
    const name = (url.searchParams.get("name") ?? "").toLowerCase();
    const type = url.searchParams.get("type");
    const sendJson = (payload) => {
      response.writeHead(200, { "content-type": "application/dns-json" });
      response.end(JSON.stringify(payload));
    };
    // Simulate a real-world conflict for google.com.
    if (name === "google.com" && type === "A") {
      sendJson({
        Status: 0,
        Answer: [{ name: "google.com.", type: 1, TTL: 60, data: "203.0.113.10" }],
      });
      return;
    }
    if (name === "google.com" && type === "AAAA") {
      sendJson({ Status: 0, Answer: [] });
      return;
    }
    sendJson({ Status: 3 });
  });
  await new Promise((resolve) => dohServer.listen(0, "127.0.0.1", resolve));
  const dohPort = dohServer.address().port;
  console.log(`Mock DoH: http://127.0.0.1:${dohPort}/dns-query`);

  const profile = path.join(ROOT, ".sandbox", `e2e-profile-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const stderr = [];
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-crash-reporter",
      `--crash-dumps-dir=${path.join(profile, "crash")}`,
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--window-size=1200,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 200) stderr.shift();
  });

  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    await waitFor("Chrome DevTools port", () => existsSync(portFile), 25_000);
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    await waitFor(
      "Chrome DevTools endpoint",
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`);
          return response.ok;
        } catch {
          return false;
        }
      },
      15_000,
    );

    const { target: swTarget, connection: sw } = await findExtensionWorker(port);
    const extensionId = new URL(swTarget.url).hostname;
    console.log(`Extension ID: ${extensionId}`);
    await sw.send("Runtime.enable");

    const pageTarget = await waitFor("page target", async () => {
      const targets = await getTargets(port);
      return targets.find((target) => target.type === "page");
    });
    const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");

    // Wait for the install bootstrap so the setup save cannot join an in-flight
    // sync that still uses the default registry URL.
    await waitFor(
      "initial sync",
      async () =>
        (await sw.eval(
          'chrome.storage.local.get("syncStatus").then(({ syncStatus }) => syncStatus ? syncStatus.lastAttemptAt : null)',
        )) !== null,
      20_000,
    );

    // Force the labeled sample fallback with a guaranteed-404 loopback URL so
    // this suite is deterministic even after the public registry is published.
    // Going through saveSettings also exercises the registry-URL cache reset.
    const setupTabId = await sw.eval(
      'chrome.tabs.create({ url: chrome.runtime.getURL("options.html") }).then((tab) => tab.id)',
    );
    const setupTarget = await waitFor(
      "setup options target",
      async () =>
        (await getTargets(port)).find(
          (candidate) =>
            candidate.type === "page" &&
            candidate.url === `chrome-extension://${extensionId}/options.html`,
        ),
      8_000,
    );
    const setup = await Cdp.connect(setupTarget.webSocketDebuggerUrl);
    await setup.send("Runtime.enable");
    const setupResult = await setup.eval(`chrome.runtime.sendMessage({
      type: "saveSettings",
      settings: {
        enabled: true,
        autoContinue: false,
        checkPublicDns: true,
        registryUrl: "http://127.0.0.1:${dohPort}/registry-missing.json",
        dohEndpoint: "http://127.0.0.1:${dohPort}/dns-query",
        syncIntervalMinutes: 360
      }
    })`);
    assert(setupResult?.ok === true, `setup save failed: ${JSON.stringify(setupResult)}`);
    await sw.eval(`chrome.tabs.remove(${setupTabId})`).catch(() => {});
    setup.close();

    await waitFor(
      "validated sample cache",
      async () =>
        (await sw.eval(
          'chrome.storage.local.get("registryCache").then(({ registryCache }) => registryCache ? registryCache.source : null)',
        )) === "sample",
      20_000,
    );
    await waitFor(
      "DNR redirect rule",
      async () =>
        (await sw.eval("chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.length)")) === 9,
    );

    // 1) Conflict interstitial for an arbitrary real domain.
    await navigate(page, "http://google.com/");
    await waitForUri(page, (href) => href.includes("/interstitial.html"), 8_000);
    await waitForText(page, "also exists in the public DNS");
    assert(
      (await bodyText(page)).includes("203.0.113.10"),
      "conflict page must show the public DNS answer",
    );
    assert(
      await page.eval("!document.getElementById('conflict').hidden"),
      "conflict choices must be visible",
    );
    const conflictShot = await screenshot(page, "conflict");
    console.log(`Screenshot: ${conflictShot}`);

    // 2) Registry choice opens the target.
    await page.eval("document.getElementById('choose-registry').click()");
    await waitForUri(
      page,
      (href) => href === "http://example.com/" || href === "https://example.com/",
      10_000,
    );
    console.log("Registry choice navigated to example.com");

    // 3) A name with no record is not intercepted at all: per-record rules
    // leave the rest of the web alone. Give the navigation a moment to settle.
    await navigate(page, "http://unknown.fdn/");
    await sleep(1_200);
    assert(
      !(await page.eval("location.href")).includes("/interstitial.html"),
      "unregistered names must not be intercepted",
    );
    console.log("Unregistered name was left untouched");

    // 4) A newly registered name points at its target hostname.
    await navigate(page, "http://ipmap.info/");
    await waitForUri(page, (href) => href.includes("/interstitial.html"), 8_000);
    await waitForText(page, "ipmap.vitrn.com");
    console.log("ipmap.info registry target matched (redirect fallback)");

    // 5) HTTP/IP targets show the warning and preserve the target port. The
    // user must click; there is no auto-open for HTTP.
    await navigate(page, "http://insecure.fdn/");
    await waitForUri(page, (href) => href.includes("/interstitial.html"), 8_000);
    await waitForText(page, "plain HTTP");
    assert((await bodyText(page)).includes("IP address"), "IP targets must show a warning");
    assert((await bodyText(page)).includes(":8080"), "the target port must be preserved");
    const insecureShot = await screenshot(page, "insecure");
    console.log(`Screenshot: ${insecureShot}`);

    // Extension pages cannot be navigated to from a web/untrusted page. Open
    // them the way the browser does: from the extension itself.
    async function openExtensionPage(name, width, height) {
      const tabId = await sw.eval(
        `chrome.tabs.create({ url: chrome.runtime.getURL(${JSON.stringify(name)}) }).then((tab) => tab.id)`,
      );
      const target = await waitFor(
        `${name} target`,
        async () =>
          (await getTargets(port)).find(
            (candidate) =>
              candidate.type === "page" &&
              candidate.url === `chrome-extension://${extensionId}/${name}`,
          ),
        8_000,
      );
      const connection = await Cdp.connect(target.webSocketDebuggerUrl);
      await connection.send("Page.enable");
      await connection.send("Runtime.enable");
      await connection.send("Log.enable");
      await setViewport(connection, width, height);
      return { tabId, connection };
    }

    // 6) Public-DNS bypass adds a tab-scoped allow rule. The name does not
    // resolve publicly in this test environment, so the destination is Chrome's
    // error page; the important part is that the interstitial is bypassed and
    // the session rule exists.
    await navigate(page, "http://google.com/");
    await waitForUri(page, (href) => href.includes("/interstitial.html"), 8_000);
    await waitForText(page, "also exists in the public DNS");
    await page.eval("document.getElementById('choose-public').onclick()");
    await waitForUri(
      page,
      (href) =>
        !href.includes("/interstitial.html") &&
        (href.includes("google.com") || href.startsWith("chrome-error://")),
      8_000,
    );
    const sessionRuleCount = await sw.eval(
      "chrome.declarativeNetRequest.getSessionRules().then((rules) => rules.length)",
    );
    assert(sessionRuleCount === 1, "public bypass should add one session allow rule");
    await sw.eval(
      "chrome.declarativeNetRequest.getSessionRules().then((rules) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((rule) => rule.id) }))",
    );
    console.log("Public bypass added and removed a tab-scoped session rule");

    // 7) Popup + toggle plumbing.
    await setSettings(sw, { autoContinue: false });
    const popup = await openExtensionPage("popup.html", 380, 640);
    await waitFor(
      "popup status",
      async () => {
        const text = await bodyText(popup.connection);
        return text.includes("Interception active") || text.includes("Sample registry active");
      },
      8_000,
    );
    assert(
      (await popup.connection.eval("document.getElementById('record-count').textContent")) === "9",
      "popup record count",
    );
    assert(
      (await popup.connection.eval("document.getElementById('wildcard-count').textContent")) === "1",
      "popup wildcard count",
    );
    const popupShot = await screenshot(popup.connection, "popup");
    console.log(`Screenshot: ${popupShot}`);
    await popup.connection.eval("document.getElementById('enabled').click()");
    await waitForText(popup.connection, "Interception paused");
    await waitFor(
      "rules cleared",
      async () =>
        (await sw.eval("chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.length)")) === 0,
    );
    await popup.connection.eval("document.getElementById('enabled').click()");
    await waitFor(
      "popup active again",
      async () => {
        const text = await bodyText(popup.connection);
        return text.includes("Interception active") || text.includes("Sample registry active");
      },
      8_000,
    );
    await waitFor(
      "rules restored",
      async () =>
        (await sw.eval("chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.length)")) === 9,
    );
    console.log("Toggle cleared and restored the DNR rules");
    await sw.eval(`chrome.tabs.remove(${popup.tabId})`).catch(() => {});
    popup.connection.close();

    // 8) Options page. Restore the documented defaults only for the screenshot;
    // the cached sample remains labeled as sample.
    await setSettings(sw, {
      registryUrl: "https://raw.githubusercontent.com/free-domain-name/registry/refs/heads/main/client.json",
      dohEndpoint: "https://cloudflare-dns.com/dns-query",
      autoContinue: false,
      checkPublicDns: true,
    });
    const options = await openExtensionPage("options.html", 1100, 1200);
    await waitForText(options.connection, "Settings");
    const registryValue = await options.connection.eval(
      "document.getElementById('registry-url').value",
    );
    assert(registryValue.startsWith("https://"), "options must show the registry URL");
    const optionsShot = await screenshot(options.connection, "options");
    console.log(`Screenshot: ${optionsShot}`);
    await sw.eval(`chrome.tabs.remove(${options.tabId})`).catch(() => {});
    options.connection.close();

    await sleep(300);
    const pageExceptions = page.events.filter((event) => event.method === "Runtime.exceptionThrown");
    const swExceptions = sw.events.filter((event) => event.method === "Runtime.exceptionThrown");
    assert(pageExceptions.length === 0, `page exceptions: ${JSON.stringify(pageExceptions.slice(0, 2))}`);
    assert(swExceptions.length === 0, `worker exceptions: ${JSON.stringify(swExceptions.slice(0, 2))}`);

    console.log("\nPASS: arbitrary-domain conflict, registry navigation, ipmap target, non-interception, port-preserving insecure target, public bypass, popup toggle, options");
    page.close();
    sw.close();
  } catch (error) {
    const tail = stderr.join("").split("\n").slice(-15).join("\n");
    console.error(`\nFAIL: ${error.message}`);
    if (tail) console.error(`Chrome stderr tail:\n${tail}`);
    process.exitCode = 1;
  } finally {
    try {
      chrome.kill("SIGKILL");
    } catch {
      // Ignore cleanup errors.
    }
    dohServer.closeAllConnections?.();
    dohServer.close();
  }
}

await main();
