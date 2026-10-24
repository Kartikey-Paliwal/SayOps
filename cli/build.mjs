// Bundles the CLI and @sayops/core into one executable ESM file: dist/sayops.mjs
import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/sayops.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync("dist/sayops.mjs", 0o755);
console.log("built dist/sayops.mjs");
