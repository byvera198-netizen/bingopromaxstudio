import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const distPath = fileURLToPath(new URL("../dist/", import.meta.url));

await access(join(distPath, "index.html"));
const html = await readFile(join(distPath, "index.html"), "utf8");
assert.match(html, /Bingo ProMax Studio/);
assert.match(html, /<script[^>]+type="module"/);

const assetsPath = join(distPath, "assets");
const assets = await readdir(assetsPath);
assert.ok(assets.some((asset) => /generator\.worker-.*\.js$/.test(asset)), "Falta el worker de generación en dist/assets");
assert.ok(assets.some((asset) => /\.js$/.test(asset)), "Falta el bundle JavaScript principal en dist/assets");

console.log(`Studio production smoke OK: ${assets.length} assets compilados.`);
