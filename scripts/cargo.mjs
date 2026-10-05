// Run a command with cargo on the PATH.
//
//   node scripts/cargo.mjs cargo test --manifest-path src-tauri/Cargo.toml
//   node scripts/cargo.mjs tauri build
//
// rustup installs cargo into ~/.cargo/bin and adds that to the PATH of new shells, which is not the
// same as the PATH of whatever is running npm: on the pit laptop, `npm test` from one terminal found
// cargo and from another did not. Looking in the one place rustup always puts it removes the
// difference. `tauri` is resolved from node_modules/.bin, as npm itself would.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/cargo.mjs <command> [args...]");
  process.exit(2);
}

const extra = [join(root, "node_modules", ".bin"), join(homedir(), ".cargo", "bin")].filter(existsSync);
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
const env = { ...process.env, [pathKey]: [...extra, process.env[pathKey] || ""].join(delimiter) };

// `shell: true` so Windows finds tauri.cmd and cargo.exe alike. Arguments with spaces are quoted;
// nothing here comes from outside the repo's own package.json.
const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
const result = spawnSync(command, quoted, { cwd: root, env, stdio: "inherit", shell: true });
if (result.error) {
  console.error(`could not run ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
