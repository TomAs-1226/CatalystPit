// Catalyst Pit — the shell.
//
// This file owns the things there is one of: the event in memory, the save, the clock, the route,
// and the two optional links (Nexus, the robot). What each screen shows and does is in `ui/views/`;
// what the data means is in `core/`, which never touches the DOM and is where the tests are.
//
// Three rules, the same three the backend keeps:
//   - It works with no network. Nothing here waits on Nexus or the robot.
//   - It shows what is known. A time is one somebody typed or Nexus sent; a voltage is one somebody
//     measured or the robot published. Anything else is a dash or an empty state, never a guess.
//   - It does not lose notes. Every change is saved within a moment, and a data file this build
//     cannot read is left exactly as it was found.

import { call, native } from "./bridge.js";
import { stateLayer } from "./motion.js";
import { SCHEMA, migrate } from "./core/store.js";
import { clock, countdown, span } from "./core/format.js";
import { parseNexus, mergeNexus, freshness } from "./core/queue.js";
import { openIssues } from "./core/matchlog.js";
import { DEFAULT_LIMITS } from "./core/batteries.js";
import { esc, icon } from "./ui/dom.js";
import { initSheet, sheetOpen } from "./ui/sheet.js";

import * as nowView from "./ui/views/now.js";
import * as checklistView from "./ui/views/checklist.js";
import * as batteriesView from "./ui/views/batteries.js";
import * as queueView from "./ui/views/queue.js";
import * as logView from "./ui/views/log.js";
import * as settingsView from "./ui/views/settings.js";

const VIEWS = {
  now: { name: "Now", icon: "now", module: nowView },
  checklist: { name: "Checklist", icon: "checklist", module: checklistView },
  batteries: { name: "Batteries", icon: "battery", module: batteriesView },
  queue: { name: "Queue", icon: "queue", module: queueView },
  log: { name: "Log", icon: "log", module: logView },
  settings: { name: "Settings", icon: "settings", module: settingsView },
};

const $ = (id) => document.getElementById(id);

/** How often Nexus is asked while the app is open. It re-estimates as the event runs late. */
const NEXUS_EVERY = 60_000;
const ROBOT_EVERY = 2_000;
const SAVE_AFTER = 300;

const ctx = {
  S: null,
  settings: null,
  info: { version: "", dataDir: "" },
  limits: { ...DEFAULT_LIMITS },
  robot: null,
  nexus: { busy: false, error: null, note: "" },
  ui: { view: "now", arg: null, clMatch: null, editList: false, logMatch: null, flash: null },

  now: () => Date.now(),
  render,
  go,
  toast,
  update,
  refreshNexus,

  setSettings(next) {
    ctx.settings = next;
    ctx.limits = { ...DEFAULT_LIMITS, lowRestVolts: next.lowRestVolts, weakMilliohm: next.weakMilliohm };
    render();
  },

  replaceState(next) {
    ctx.S = next;
    ctx.ui.clMatch = null;
    ctx.ui.logMatch = null;
    scheduleSave();
    render();
  },
};

const ACTIONS = {
  go: (c, el) => go(el.dataset.view, el.dataset.arg ?? null),
  "dismiss-notice": () => { $("notice").hidden = true; },
};
for (const view of Object.values(VIEWS)) Object.assign(ACTIONS, view.module.actions);

// ---- saving ------------------------------------------------------------------------------------

let saveTimer = 0;
let saving = false;
let dirty = false;

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_AFTER);
}

async function save() {
  if (saving || !dirty || !ctx.S) return;
  saving = true;
  dirty = false;
  try {
    await call("save_state", { data: ctx.S });
  } catch (error) {
    // The change is still on screen and in memory; it will be tried again with the next one. Say so
    // where it will be seen, and keep saying so until a save works.
    dirty = true;
    notice(`This could not be saved to disk: ${error} Your changes are still here; keep the app open.`);
  } finally {
    saving = false;
    if (dirty) scheduleSave();
  }
}

/** Change the event. Everything that edits data comes through here. */
function update(change, { toast: message = "", render: draw = true, flash = null, keepFocus = null } = {}) {
  if (!ctx.S) return;
  change(ctx.S);
  scheduleSave();
  ctx.ui.flash = flash;
  if (draw) render({ keepFocus });
  ctx.ui.flash = null;
  if (message) toast(message);
}

// ---- drawing -----------------------------------------------------------------------------------

function notice(text) {
  $("noticeText").textContent = text;
  $("notice").hidden = false;
}

function renderRail() {
  const open = ctx.S ? openIssues(ctx.S) : [];
  const worst = open.some((i) => i.severity === "high") ? "bad" : "warn";
  $("rail").innerHTML = Object.entries(VIEWS).map(([id, v]) => {
    const count = id === "log" && open.length ? `<span class="nav-count" data-level="${worst}" aria-label="${open.length} open issues">${open.length}</span>` : "";
    const spacer = id === "settings" ? '<span class="nav-spacer"></span>' : "";
    return `${spacer}<button type="button" class="nav-btn" data-act="go" data-view="${id}"${ctx.ui.view === id ? ' aria-current="page"' : ""}>${icon(v.icon)}<span>${v.name}</span>${count}</button>`;
  }).join("");
}

function renderTop() {
  const { settings, S, robot, nexus } = ctx;
  $("teamTag").textContent = settings ? String(settings.team) : "";
  $("eventTag").textContent = S?.event.name ?? "";
  $("previewTag").hidden = native;

  const configured = settings?.hasNexusKey && settings?.eventKey;
  const fresh = S ? freshness(S.nexus, Date.now()) : null;
  const tag = $("nexusTag");
  tag.hidden = !configured;
  if (configured) {
    const bad = nexus.error || fresh?.stale;
    tag.dataset.level = bad ? "warn" : "";
    tag.textContent = nexus.error
      ? (fresh ? `Nexus unreachable · data from ${clock(fresh.at)}` : "Nexus unreachable")
      : fresh
        ? (fresh.stale ? `Nexus · ${span(fresh.age)} old` : `Nexus · ${clock(fresh.at)}`)
        : "Nexus";
  }

  const hasVolts = robot?.volts != null;
  $("robotTag").hidden = !hasVolts;
  if (hasVolts) {
    $("robotText").textContent = `${robot.volts.toFixed(1)} V`;
    $("robotTag").title = `The robot's battery, read from ${robot.topic}`;
  }
  $("clock").textContent = clock(Date.now());
}

/** A meter's fill travels from where it last was, so a tick is seen to move the bar. */
const meterAt = new Map();
function settleMeters(root) {
  const fills = [...root.querySelectorAll("[data-meter]")];
  for (const fill of fills) {
    const key = fill.dataset.meter;
    const from = meterAt.has(key) ? meterAt.get(key) : Number(fill.dataset.to);
    fill.style.transition = "none";
    fill.style.width = `${from}%`;
  }
  if (!fills.length) return;
  void root.offsetWidth;      // commit the starting widths before the targets are set
  for (const fill of fills) {
    fill.style.transition = "";
    fill.style.width = `${fill.dataset.to}%`;
    meterAt.set(fill.dataset.meter, Number(fill.dataset.to));
  }
}

function render({ arrive = false, keepFocus = null } = {}) {
  renderTop();
  renderRail();
  if (!ctx.S) return;
  const view = $("view");
  const stage = $("stage");
  const scroll = stage.scrollTop;
  view.innerHTML = VIEWS[ctx.ui.view].module.render(ctx);
  view.classList.remove("arrive");
  if (arrive) {
    void view.offsetWidth;    // restart the animation when the same class is put back
    view.classList.add("arrive");
    stage.scrollTop = 0;
  } else {
    stage.scrollTop = scroll;
  }
  settleMeters(view);
  tick();
  if (keepFocus) view.querySelector(keepFocus)?.focus({ preventScroll: true });
}

function go(view, arg = null) {
  if (!VIEWS[view]) return;
  const hash = `#${view}${arg ? `/${arg}` : ""}`;
  if (location.hash === hash) return route();
  location.hash = hash;
}

function route() {
  const [view, arg] = location.hash.replace(/^#/, "").split("/");
  ctx.ui.view = VIEWS[view] ? view : "now";
  ctx.ui.arg = arg || null;
  if (ctx.ui.view === "log" && arg && arg !== "issues") ctx.ui.logMatch = arg;
  if (ctx.ui.view !== "checklist") ctx.ui.editList = false;
  render({ arrive: true });
  if (ctx.ui.view === "log" && arg === "issues") document.getElementById("issues")?.scrollIntoView({ block: "start" });
}

// ---- the island --------------------------------------------------------------------------------

let islandTimer = 0;
function toast(text) {
  if (!text) return;
  const island = $("island");
  $("islandText").textContent = text;
  clearTimeout(islandTimer);
  // A new message while one shows reshapes the island rather than starting it over.
  if (island.hidden || island.classList.contains("leaving")) {
    island.classList.remove("leaving");
    island.hidden = false;
    island.style.animation = "none";
    void island.offsetWidth;
    island.style.animation = "";
  }
  islandTimer = setTimeout(() => {
    island.classList.add("leaving");
    islandTimer = setTimeout(() => { island.hidden = true; island.classList.remove("leaving"); }, 800);
  }, 2400 + Math.min(2600, text.length * 30));
}

// ---- time --------------------------------------------------------------------------------------

/** Move every countdown on screen. A countdown that reaches its time redraws the view once. */
function tick() {
  const now = Date.now();
  let crossed = false;
  for (const el of document.querySelectorAll("[data-count-to]")) {
    const to = Number(el.dataset.countTo);
    if (el.dataset.countDir === "down") {
      if (to - now < 0) crossed = true;
      el.textContent = countdown(to - now);
    } else {
      el.textContent = countdown(now - to);
    }
  }
  return crossed;
}

/** Whether redrawing now would take something out from under someone's fingers. */
const busy = () => sheetOpen() || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

let lastMinute = -1;
function everySecond() {
  $("clock").textContent = clock(Date.now());
  const crossed = tick();
  const minute = Math.floor(Date.now() / 60000);
  // Once a minute the words around the figures go stale too ("52 min on charge", "3 min old").
  if ((crossed || minute !== lastMinute) && !busy()) {
    lastMinute = minute;
    render();
  }
}

// ---- Nexus -------------------------------------------------------------------------------------

async function refreshNexus({ manual = false } = {}) {
  const { settings } = ctx;
  if (!settings?.hasNexusKey || !settings?.eventKey || ctx.nexus.busy || !ctx.S) return;
  ctx.nexus.busy = true;
  if (manual) render();
  try {
    const parsed = parseNexus(await call("nexus_fetch"), settings.team);
    if (parsed.error) throw parsed.error;
    ctx.nexus.error = null;
    ctx.nexus.note = parsed.matches.length || !parsed.eventMatchCount
      ? ""
      : `Nexus lists ${parsed.eventMatchCount} matches at this event and none include team ${settings.team}.`;
    let result;
    ctx.S && update((S) => { result = mergeNexus(S, parsed, Date.now()); }, { render: false });
    if (manual) toast(parsed.matches.length ? `Nexus: ${parsed.matches.length} of your matches, ${result.added} new` : ctx.nexus.note || "Nexus has no matches for this event yet");
  } catch (error) {
    ctx.nexus.error = String(error);
    if (manual) toast(ctx.nexus.error);
  } finally {
    ctx.nexus.busy = false;
    if (!busy() || manual) render(); else renderTop();
  }
}

async function pollRobot() {
  try {
    const next = await call("robot_battery");
    const before = ctx.robot;
    ctx.robot = next;
    const changed = !before || before.connected !== next.connected || before.volts?.toFixed(2) !== next.volts?.toFixed(2);
    if (!changed) return;
    renderTop();
    // The battery and settings screens print the reading; the others only show it in the bar.
    if (["batteries", "settings", "now"].includes(ctx.ui.view) && !busy()) render();
  } catch {
    ctx.robot = null;
  }
}

// ---- boot --------------------------------------------------------------------------------------

function blocked(title, body) {
  $("rail").innerHTML = "";
  $("view").innerHTML = `<section class="tile empty-tile" style="margin-top:8px"><div class="empty"><h2>${esc(title)}</h2><p style="max-width:62ch">${esc(body)}</p></div></section>`;
}

async function boot() {
  initSheet();

  // Every press answers where it was pressed, on the way down.
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".btn, .nav-btn, .check, button.tile, .match, .mrow, .seg-btn");
    if (el && !el.disabled) stateLayer(el, e, { opacity: el.classList.contains("primary") ? 0.2 : 0.1 });
  });

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const handler = ACTIONS[el.dataset.act];
    if (handler) handler(ctx, el, e);
  });

  document.addEventListener("change", (e) => {
    const el = e.target.closest("[data-change]");
    if (!el) return;
    const handler = ACTIONS[el.dataset.change];
    if (handler) handler(ctx, el, e);
  });

  // Enter in a settings field commits it, the way it would in a form.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.("input[data-change]")) e.target.blur();
  });

  window.addEventListener("hashchange", route);
  // A save that is still waiting on its timer goes now, before the window does.
  window.addEventListener("beforeunload", () => { if (dirty) save(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && dirty) save(); });

  try {
    [ctx.info, ctx.settings] = await Promise.all([call("app_info"), call("get_settings")]);
    ctx.limits = { ...DEFAULT_LIMITS, lowRestVolts: ctx.settings.lowRestVolts, weakMilliohm: ctx.settings.weakMilliohm };
    const loaded = await call("load_state");
    const result = migrate(loaded.data);

    if (result.status === "newer") {
      renderTop();
      return blocked(
        "This data is from a newer Catalyst Pit",
        `The event on this laptop was saved by a newer version (data format ${result.from}; this build reads up to ${SCHEMA}). Nothing has been changed. Install the newer version to open it. The file is in ${ctx.info.dataDir}.`,
      );
    }
    if (result.status === "invalid") {
      renderTop();
      return blocked(
        "The data file is not an event",
        `The file in ${ctx.info.dataDir} could be read but is not in a form this app understands. Nothing has been changed. Move pit.json out of that folder to start fresh, and keep it: it may still be recoverable.`,
      );
    }

    ctx.S = result.state;
    if (loaded.notice) notice(loaded.damaged ? `${loaded.notice} A new, empty event has been started.` : loaded.notice);
    if (result.status === "migrated") scheduleSave();
  } catch (error) {
    renderTop();
    return blocked("Catalyst Pit could not start", String(error));
  }

  route();
  setInterval(everySecond, 1000);
  setInterval(() => refreshNexus(), NEXUS_EVERY);
  setInterval(pollRobot, ROBOT_EVERY);
  refreshNexus();
  pollRobot();
}

boot();
