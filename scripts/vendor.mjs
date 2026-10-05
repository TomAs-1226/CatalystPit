// Copies the one third-party thing we ship into src/vendor: the interface typeface.
//
// The app loads it from disk, not a CDN. The webview runs under a strict CSP, and an app that needs
// the internet to draw its own letters fails in exactly the venue it is meant for.
//
// Figtree is the face Catalyst Console uses, for the same reason: both are drawn after Tesla's
// in-car screens, whose own typeface is proprietary, and Figtree is the openly licensed face nearest
// it. The licence travels with the files, as the SIL Open Font License requires.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "src/vendor");
mkdirSync(out, { recursive: true });

const files = [
  ["node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2", "fonts/figtree-latin-wght-normal.woff2"],
  ["node_modules/@fontsource-variable/figtree/files/figtree-latin-ext-wght-normal.woff2", "fonts/figtree-latin-ext-wght-normal.woff2"],
  ["node_modules/@fontsource-variable/figtree/LICENSE", "fonts/FIGTREE-LICENSE.txt"],
];

for (const [from, to] of files) {
  const target = resolve(out, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, from), target);
  console.log(`vendored ${to}`);
}
