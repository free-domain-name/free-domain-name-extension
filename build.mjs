import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const publicDir = path.join(root, "public");
const isWatch = process.argv.includes("--watch");

async function copyPublic() {
  await mkdir(dist, { recursive: true });
  await cp(publicDir, dist, {
    recursive: true,
    filter: (source) => !source.endsWith(".DS_Store"),
  });
}

const options = {
  entryPoints: [
    "src/background.ts",
    "src/interstitial.ts",
    "src/popup.ts",
    "src/options.ts",
  ],
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome121",
  platform: "browser",
  sourcemap: isWatch ? "inline" : false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

await rm(dist, { recursive: true, force: true });
await copyPublic();

if (isWatch) {
  const ctx = await context(options);
  await ctx.watch();
  fsWatch(publicDir, { recursive: true }, () => {
    void copyPublic().catch((error) => console.error("[build] copy public failed", error));
  });
  console.log("[build] watching src/ and public/");
} else {
  await build(options);
  console.log("[build] wrote dist/ — load unpacked from this directory");
}
