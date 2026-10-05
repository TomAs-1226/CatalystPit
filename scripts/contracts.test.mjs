// Things that are written down in two places and have to stay the same in both.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURES, nexusResponse } from "./fixtures.mjs";
import { drift, normalise, FILES } from "./check-identity.mjs";
import { migrate, SCHEMA } from "../src/core/store.js";
import { parseNexus, nextMatch } from "../src/core/queue.js";
import { recommend } from "../src/core/batteries.js";
import { BATTERY_TOPICS } from "../src/core/topics.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("the version is the same in all three places it is written", () => {
  const pkg = JSON.parse(read("package.json")).version;
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")).version;
  const cargo = /^version = "([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))[1];
  assert.deepEqual([conf, cargo], [pkg, pkg]);
});

test("the names the installer and the launcher rely on have not moved", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(conf.productName, "Catalyst Pit");
  assert.equal(conf.identifier, "com.frccatalyst.pit");
  assert.deepEqual(conf.bundle.targets, ["nsis"]);
  assert.equal(conf.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(conf.app.withGlobalTauri, true);
  assert.match(read("src-tauri/Cargo.toml"), /^name = "catalyst-pit"$/m);
  assert.match(read("src-tauri/src/main.rs"), /tauri_plugin_single_instance::init/);
});

test("the page is closed to the network and to inline script", () => {
  const csp = JSON.parse(read("src-tauri/tauri.conf.json")).app.security.csp;
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'self' ipc: http:\/\/ipc\.localhost/);
  assert.doesNotMatch(csp, /https:/);
  assert.doesNotMatch(read("src/index.html"), /<script(?![^>]*\bsrc=)/, "no inline script in index.html");
});

test("the battery topics Settings names are the ones the backend reads", () => {
  const rust = read("src-tauri/src/nt.rs");
  const block = /BATTERY_TOPICS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(rust)[1];
  const topics = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(topics, BATTERY_TOPICS);
});

test("the data schema the page writes is the one the docs name", () => {
  assert.match(read("README.md"), new RegExp(`schema ${SCHEMA}\\b`));
});

test("every fixture is a state the app itself could have written", () => {
  const now = Date.UTC(2026, 9, 10, 18, 0, 0);
  for (const [name, make] of Object.entries(FIXTURES)) {
    const fixture = make(now);
    const result = migrate(fixture.data);
    if (name === "newer") { assert.equal(result.status, "newer"); continue; }
    assert.ok(["new", "ok"].includes(result.status), `${name}: ${result.status}`);
    if (fixture.data) assert.deepEqual(result.state, JSON.parse(JSON.stringify(fixture.data)), `${name} survives a load unchanged`);
  }
  const manual = FIXTURES.manual(now).data;
  assert.equal(nextMatch(manual, now).id, "q21");
  assert.equal(recommend(manual, now).pick.battery.label, "B1");
});

test("the shifted Nexus fixture still parses, with its times moved to now", () => {
  const now = Date.UTC(2026, 9, 10, 18, 0, 0);
  const parsed = parseNexus(nexusResponse(now), 5805);
  assert.equal(parsed.asOf, now);
  assert.equal(parsed.matches.find((m) => m.id === "q13").times.queue, now + 15 * 60000);
});

test("identity drift is judged on text, not on line endings", () => {
  const files = {
    [join("lib", "identity.css")]: "a {\r\n  b: c;\r\n}\r\n",
    [join("lib", "motion.js")]: "export const x = 1;\n",
    [join("repo", FILES[0][1])]: "a {\n  b: c;\n}\n",
    [join("repo", FILES[1][1])]: "export const x = 2;\n",
  };
  const found = drift("lib", "repo", (p) => files[p] ?? null);
  assert.deepEqual(found.map((f) => f.name), ["motion.js"], "CRLF alone is not drift; a changed value is");
  assert.equal(normalise("a\r\nb"), "a\nb");
  delete files[join("repo", FILES[0][1])];
  assert.equal(drift("lib", "repo", (p) => files[p] ?? null).length, 2, "a missing copy is drift");
});
