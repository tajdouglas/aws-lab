import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import archiver from "archiver";
import { assertNode, functions, root } from "./config.mjs";

assertNode();

const require = createRequire(import.meta.url);
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const name of functions) {
  const outfile = join(dist, name, "index.cjs");
  await mkdir(join(dist, name), { recursive: true });
  await build({
    entryPoints: [join(root, "src", name, "index.mjs")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile,
    legalComments: "none",
    logLevel: "silent",
  });

  const handler = require(outfile).handler;
  if (typeof handler !== "function") {
    throw new Error(`${name}: export handler ausente no bundle`);
  }

  const zipPath = join(dist, `${name}.zip`);
  await zipFile(outfile, zipPath);
  const bytes = (await stat(zipPath)).size;
  console.log(`${name}: dist/${name}.zip (${bytes} bytes)`);
}

function zipFile(filePath, zipPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    output.on("error", reject);
    archive.pipe(output);
    archive.file(filePath, { name: "index.js" });
    archive.finalize();
  });
}
