// Screenshot every screen, headlessly, at a desktop size and at the narrow column Pit takes beside
// a Driver Station.
//
//   node scripts/screenshots.mjs                 # into docs/screenshots/
//   node scripts/screenshots.mjs <dir>           # somewhere else
//   node scripts/screenshots.mjs <dir> --tall    # a tall viewport, to review a whole long page
//   node scripts/screenshots.mjs <dir> --only=checklist
//
// It starts the harness (scripts/harness.mjs), which serves the real `src/` over a stand-in
// backend and invented fixtures, and drives headless Edge at it. Edge, because it is on every
// Windows laptop; set EDGE to another Chromium to use that instead.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { start } from "./harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const tall = args.includes("--tall");
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const out = resolve(args.find((a) => !a.startsWith("--")) || join(root, "docs", "screenshots"));

const EDGE = [
  process.env.EDGE,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/microsoft-edge",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!EDGE) {
  console.error("screenshots: no Edge or Chromium found; set EDGE to one");
  process.exit(1);
}

const DESKTOP = [1180, 800];
// Chromium will not lay a window out narrower than 500, so this is the narrowest a screenshot can
// be. The app's own minimum is 480; that last step is checked by hand in the app.
const NARROW = [500, 900];
const act = (name, id) => `[data-act="${name}"]${id ? `[data-id="${id}"]` : ""}`;

// name, fixture, route, selectors to click first.
const SHOTS = [
  ["now", "manual", "now"],
  ["now-empty", "empty", "now"],
  ["now-nexus", "nexus", "now"],
  ["now-nexus-unreachable", "offline", "now"],
  ["now-in-robot", "robot", "now"],
  ["checklist", "manual", "checklist"],
  ["checklist-empty-event", "empty", "checklist"],
  ["checklist-edit", "manual", "checklist", [act("cl-edit")]],
  ["checklist-stamp-with-gaps", "manual", "checklist", [act("cl-stamp")]],
  ["batteries", "manual", "batteries"],
  ["batteries-empty", "empty", "batteries"],
  ["batteries-in-robot", "robot", "batteries"],
  ["batteries-put-in", "manual", "batteries", [".rec .btn.primary"]],
  ["batteries-swap", "robot", "batteries", [".rec .btn.primary"]],
  ["batteries-more", "manual", "batteries", [`.batt[data-state="resting"] ${act("batt-more")}`]],
  ["queue", "manual", "queue"],
  ["queue-empty", "empty", "queue"],
  ["queue-nexus", "nexus", "queue"],
  ["queue-add-match", "empty", "queue", [".head " + act("match-add")]],
  ["log", "manual", "log"],
  ["log-empty", "empty", "log"],
  ["log-raise-issue", "manual", "log", ["#issues " + act("issue-add")]],
  ["settings", "manual", "settings"],
  ["settings-nexus", "nexus", "settings"],
  ["settings-robot", "robot", "settings"],
  ["newer-data", "newer", "now"],
];

mkdirSync(out, { recursive: true });
const port = 5217;
const server = await start(port);

let failed = 0;
for (const [name, fixture, route, clicks = []] of SHOTS) {
  if (only && !name.includes(only)) continue;
  for (const [suffix, [w, h]] of [["", DESKTOP], ["-narrow", NARROW]]) {
    const height = tall ? 2600 : h;
    // Long enough for the app to boot and draw, and for each click to land and its sheet to open.
    const query = new URLSearchParams({ fixture, still: "1", hold: String(900 + clicks.length * 500) });
    if (clicks.length) query.set("click", clicks.join(";;"));
    const url = `http://127.0.0.1:${port}/?${query}#${route}`;
    const file = join(out, `${name}${suffix}.png`);
    // Not spawnSync: the harness is in this process, and a blocked event loop cannot serve the page
    // the browser is waiting for.
    const result = await new Promise((done) => {
      execFile(EDGE, [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--force-device-scale-factor=1",
        `--window-size=${w},${height}`,
        `--screenshot=${file}`,
        url,
      ], { timeout: 60_000 }, (error, stdout, stderr) => done({ status: error ? 1 : 0, stderr }));
    });
    if (result.status !== 0 || !existsSync(file)) {
      failed++;
      console.error(`FAILED ${name}${suffix}: ${result.stderr?.trim().split("\n").pop() || "no file written"}`);
    } else {
      console.log(`${name}${suffix}.png`);
    }
  }
}

server.close();
process.exit(failed ? 1 : 0);
