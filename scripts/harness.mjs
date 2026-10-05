// Serve the REAL frontend with a stand-in for the Rust side, so every screen can be opened, clicked
// and screenshotted in a plain browser.
//
//   node scripts/harness.mjs [port]            # then open http://localhost:5210/?fixture=manual
//
// It serves `src/` itself, not a copy, and injects a `window.__TAURI__` ahead of the app's own
// module. That stand-in answers each backend command from a fixture (scripts/fixtures.mjs) and keeps
// later saves in memory; nothing touches the real data folder.
//
// Query parameters on the page:
//   fixture=<name>   which fixture to start from: empty, manual, robot, nexus, offline, newer
//   still=1          switch animations off, so a screenshot is of the finished frame
//   click=<a>;;<b>   CSS selectors to click in turn once the app has drawn, to open a sheet
//   hold=<ms>        hold the page's load event back this long (see /__hold below); screenshots only
//
// The fixtures are invented. They exist to look at the interface and are not in the shipped app.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURES } from "./fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** The stand-in backend, as a script. The fixture is baked in as JSON. */
function fakeTauri(name, { still, clicks }) {
  const make = FIXTURES[name] || FIXTURES.empty;
  const fixture = make(Date.now());
  return `(() => {
  const F = ${JSON.stringify(fixture)};
  let data = F.data;
  let settings = F.settings;
  const COMMANDS = {
    app_info: () => ({ version: ${JSON.stringify(`${version} (harness)`)}, dataDir: "C:\\\\Users\\\\driver\\\\AppData\\\\Roaming\\\\com.frccatalyst.pit" }),
    load_state: () => ({ data, notice: null, damaged: false }),
    save_state: (a) => { data = a.data; window.__pitSaves = (window.__pitSaves || 0) + 1; },
    archive_event: () => "harness-archive.json",
    get_settings: () => settings,
    set_settings: (a) => {
      const { nexusKey, ...rest } = a.patch;
      if (rest.team !== undefined && !(rest.team >= 1 && rest.team <= 9999)) throw "A team number is between 1 and 9999.";
      if (rest.eventKey !== undefined) {
        rest.eventKey = rest.eventKey.trim().toLowerCase();
        if (!/^[a-z0-9]{0,32}$/.test(rest.eventKey)) throw "An event key is letters and digits only, such as 2026casd.";
      }
      settings = { ...settings, ...rest };
      if (nexusKey !== undefined) settings.hasNexusKey = nexusKey !== "";
      return settings;
    },
    nexus_fetch: () => {
      if (!settings.hasNexusKey) throw "No Nexus API key is set. Add one in Settings.";
      if (!F.nexus) throw "Could not reach Nexus. The schedule already here is unchanged.";
      if (F.nexus.error) throw F.nexus.error;
      return F.nexus;
    },
    export_report: (a) => { window.__pitReport = a.markdown; return "C:\\\\Users\\\\driver\\\\Documents\\\\" + a.fileName; },
    robot_battery: () => (settings.robotLink ? F.robot : { enabled: false, connected: false, address: "", volts: null, topic: null }),
  };
  window.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        const handler = COMMANDS[command];
        if (!handler) throw "harness: no such command " + command;
        const result = handler(args || {});
        return result === undefined ? null : structuredClone(result);
      },
    },
  };
  ${still ? `document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    document.head.appendChild(style);
  });` : ""}
  const clicks = ${JSON.stringify(clicks)};
  if (clicks.length) {
    const run = async () => {
      for (const selector of clicks) {
        for (let tries = 0; tries < 60 && !document.querySelector(selector); tries++) await new Promise((r) => setTimeout(r, 50));
        const el = document.querySelector(selector);
        if (!el) { console.error("harness: nothing matches " + selector); return; }
        el.click();
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    document.addEventListener("DOMContentLoaded", () => setTimeout(run, 150));
  }
})();`;
}

export function start(port = 5210) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/__fake-tauri.js") {
        const clicks = (url.searchParams.get("click") || "").split(";;").map((s) => s.trim()).filter(Boolean);
        const body = fakeTauri(url.searchParams.get("fixture") || "empty", { still: url.searchParams.get("still") === "1", clicks });
        res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
        return res.end(body);
      }

      // Held open on purpose. Headless Edge takes its screenshot at the page's load event, and the
      // app draws after that: it boots, asks the backend for its state, and may then be clicked.
      // An image that takes a moment to arrive holds the load event back until all of that is done.
      if (url.pathname === "/__hold") {
        const ms = Math.min(10_000, Number(url.searchParams.get("ms")) || 0);
        await new Promise((r) => setTimeout(r, ms));
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
        return res.end(Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"));
      }

      let path = join(src, normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, ""));
      if (!path.startsWith(src)) { res.writeHead(403).end("forbidden"); return; }
      let info = await stat(path).catch(() => null);
      if (info?.isDirectory()) { path = join(path, "index.html"); info = await stat(path).catch(() => null); }
      if (!info) { res.writeHead(404).end(`not found: ${url.pathname}`); return; }

      if (path.endsWith(`${sep}index.html`)) {
        // The stand-in has to exist before app.js evaluates: bridge.js reads window.__TAURI__ at
        // module scope. A classic script in the head runs first.
        const hold = Number(url.searchParams.get("hold")) || 0;
        const html = (await readFile(path, "utf8"))
          .replace("</head>", `  <script src="/__fake-tauri.js${url.search}"></script>\n</head>`)
          .replace("</body>", hold ? `  <img src="/__hold?ms=${hold}" alt="" width="0" height="0" style="position:absolute" />\n</body>` : "</body>");
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        return res.end(html);
      }
      res.writeHead(200, { "content-type": TYPES[extname(path).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
      res.end(await readFile(path));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 5210);
  await start(port);
  console.log(`harness: http://localhost:${port}/?fixture=manual`);
  console.log(`fixtures: ${Object.keys(FIXTURES).join(", ")}`);
}
