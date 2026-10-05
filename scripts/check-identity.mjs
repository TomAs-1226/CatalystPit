// The house stylesheet is copied, not imported, so it can drift. This is the same check CatalystApp
// and Catalyst Console run, with two differences that are fixes rather than taste:
//
//   - It knows where the library's worktrees are today. The siblings look for
//     `_worktrees/FrcCatalyst-systemcore`, which has since been renamed, so on this machine their
//     check finds no library and passes without comparing anything.
//   - It compares text, not bytes. A Windows checkout of the library has CRLF line endings and our
//     copy is LF; that is git's doing, not drift, and a check that fails on it gets switched off.
//
//   node scripts/check-identity.mjs            # report drift, exit 1 if there is any
//   node scripts/check-identity.mjs --write    # copy the library's originals over ours
//   node scripts/check-identity.mjs path/to/docs/assets
//
// With no library checkout on the machine it says so and exits 0: a contributor without the library
// should still be able to build, and a check nobody can act on gets ignored.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const write = args.includes("--write");
const given = args.find((a) => !a.startsWith("--"));

// The 2.0 line first: it is where the identity is maintained.
export const CANDIDATES = [
  "../_worktrees/FrcCatalyst-systemcore-alpha6/docs/assets",
  "../_worktrees/FrcCatalyst-systemcore/docs/assets",
  "../_worktrees/FrcCatalyst-alpha7/docs/assets",
  "../FrcCatalyst/docs/assets",
  "../FrcCatalyst-v1.1.0/docs/assets",
];

export const FILES = [
  ["identity.css", join("src", "styles", "identity.css")],
  ["motion.js", join("src", "motion.js")],
];

/** The same text whatever git did to its line endings on the way out. */
export const normalise = (text) => text.replace(/\r\n/g, "\n");

/** Which of the files differ between a library directory and this repo. Pure, so it is tested. */
export function drift(sourceDir, repoRoot, read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null)) {
  const out = [];
  for (const [name, rel] of FILES) {
    const theirs = read(join(sourceDir, name));
    const ours = read(join(repoRoot, rel));
    if (theirs === null) continue;
    if (ours === null || normalise(ours) !== normalise(theirs)) out.push({ name, rel, text: normalise(theirs) });
  }
  return out;
}

function main() {
  const candidates = given ? [resolve(given)] : CANDIDATES.map((p) => resolve(root, p));
  const source = candidates.find((p) => FILES.every(([name]) => existsSync(join(p, name))));
  if (!source) {
    console.log("check-identity: no FrcCatalyst checkout found, leaving the identity alone");
    console.log("  looked in:", candidates.join(", "));
    return 0;
  }

  const drifted = drift(source, root);
  if (!drifted.length) {
    console.log(`check-identity: identity matches ${source}`);
    return 0;
  }
  for (const file of drifted) {
    if (write) {
      // Written as LF with no BOM, whatever the library's checkout had.
      writeFileSync(join(root, file.rel), file.text, "utf8");
      console.log(`check-identity: copied ${file.name} from ${source}`);
    } else {
      console.error(`check-identity: ${file.rel} differs from ${join(source, file.name)}`);
    }
  }
  if (write) return 0;
  console.error("Run `npm run identity` to copy the library's originals over these.");
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
