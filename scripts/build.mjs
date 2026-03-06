import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");

async function ensureCleanDist() {
  await rm(distDir, { force: true, recursive: true });
  await mkdir(distDir, { recursive: true });
}

async function copyStaticAssets() {
  await cp(resolve(rootDir, "src/manifest.json"), resolve(distDir, "manifest.json"));
  await cp(resolve(rootDir, "src/sidepanel/index.html"), resolve(distDir, "sidepanel.html"));
}

async function bundleEntries() {
  await build({
    absWorkingDir: rootDir,
    bundle: true,
    entryPoints: {
      background: "src/background/index.ts",
      sidepanel: "src/sidepanel/main.tsx"
    },
    entryNames: "[name]",
    format: "esm",
    define: {
      "process.env.NODE_ENV": '"production"'
    },
    logLevel: "info",
    minify: true,
    outdir: distDir,
    platform: "browser",
    sourcemap: false,
    target: "chrome120"
  });
}

await ensureCleanDist();
await bundleEntries();
await copyStaticAssets();
