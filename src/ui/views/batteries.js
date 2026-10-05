// The battery board: which to take, and a tile for each battery with the one or two things that can
// be done to it from where it is.

import { esc, btn, tag, plural } from "../dom.js";
import { clock, span, stamp, volts, milliohm, parseNumber, sameDay } from "../../core/format.js";
import {
  STATE_NAMES, addBattery, renameBattery, removeBattery, putInRobot, takeOut, putOnCharge, markReady, logRest,
  retire, unretire, inRobot, restedVolts, lastMilliohm, lastReading, chargeTime, flags, recommend, boardOrder, byId,
} from "../../core/batteries.js";
import { sorted, isPlayed, nextMatch, longLabel, shortLabel } from "../../core/queue.js";
import { openSheet, confirmSheet } from "../sheet.js";

const STATE_LEVEL = { ready: "ok", charging: "", "in-robot": "signal", resting: "", retired: "" };

function sinceText(battery, now) {
  if (battery.stateSince === null) return "";
  const ago = span(now - battery.stateSince);
  switch (battery.state) {
    case "in-robot": return `In since ${clock(battery.stateSince)}`;
    case "charging": {
      const t = chargeTime(battery, now);
      return t === null ? "On charge" : `On charge for ${span(t)}`;
    }
    case "ready": {
      const t = chargeTime(battery, now);
      return t === null ? `Ready for ${ago}` : `On charge for ${span(t)}`;
    }
    case "resting": return `Off charge for ${ago}`;
    default: return `Retired ${sameDay(battery.stateSince, now) ? clock(battery.stateSince) : stamp(battery.stateSince)}`;
  }
}

function tile(ctx, battery) {
  const now = ctx.now();
  const rest = restedVolts(battery);
  const mohm = lastMilliohm(battery);
  const went = lastReading(battery, "in");
  const out = lastReading(battery, "out");
  const f = flags(battery, ctx.limits);
  const d = { id: battery.id };

  const facts = [];
  if (battery.state === "in-robot") {
    const fresh = went && went.at >= battery.stateSince;
    facts.push(["Went in at", fresh && went.volts !== null ? volts(went.volts) : "not measured"]);
    if (ctx.robot?.volts != null) facts.push(["Robot reads now", volts(ctx.robot.volts)]);
  } else if (battery.state === "resting" && out && !battery.readings.some((r) => r.kind === "in" && r.at > out.at)) {
    facts.push(["Came out at", out.volts !== null ? volts(out.volts) : "not measured"]);
  } else if (battery.state !== "retired") {
    facts.push(["Rested", rest !== null ? volts(rest) : "not measured"]);
  }
  facts.push(["Resistance", mohm !== null ? milliohm(mohm) : "not measured"]);
  facts.push(["Cycles", String(battery.cycles)]);

  // One thing per tile: the next step round the loop. Everything else is under More. The screen's
  // one loud button is the recommendation's, above.
  let actions = "";
  switch (battery.state) {
    case "resting": actions = btn("Put on charge", "batt-charge", { d }); break;
    case "charging": actions = btn("Mark ready", "batt-ready", { d }); break;
    case "ready": actions = btn("Put in robot", "batt-in", { d }); break;
    case "in-robot": actions = btn("Take out", "batt-out", { d }); break;
    default: actions = btn("Bring back", "batt-unretire", { d });
  }

  const flagLines = f.map((x) => `<span class="${x.level === "weak" ? "bad-text" : "warn-text"}">${x.level === "weak" ? "Weak" : "Check"} · ${esc(x.text)}</span>`).join("");
  return `<section class="tile batt" data-state="${battery.state}">
    <div class="batt-head">
      <div><div class="batt-name">${esc(battery.label)}</div><div class="batt-since">${esc(sinceText(battery, now))}</div></div>
      ${tag(STATE_NAMES[battery.state], STATE_LEVEL[battery.state])}
    </div>
    <dl>${facts.map(([k, v]) => `<div class="kv"><dt>${esc(k)}</dt><dd${v === "not measured" ? ' class="dim"' : ""}>${esc(v)}</dd></div>`).join("")}</dl>
    ${flagLines ? `<div class="batt-flags">${flagLines}</div>` : ""}
    ${battery.note ? `<div class="tile-sub">${esc(battery.note)}</div>` : ""}
    <div class="tile-actions">${actions}${btn("More", "batt-more", { cls: "ghost", d })}</div>
  </section>`;
}

function recTile(ctx) {
  const now = ctx.now();
  const rec = recommend(ctx.S, now, ctx.limits);
  const current = inRobot(ctx.S);
  if (!rec.pick) {
    return `<section class="tile"><div class="tile-label"><span>Take next</span></div>
      <div class="tile-value">Nothing to take</div><div class="tile-sub">${esc(rec.reason)}</div></section>`;
  }
  const b = rec.pick.battery;
  // What follows it, leaving out anything flagged weak: that is not a "then".
  const others = rec.ranked.slice(1).filter((c) => !c.weak).slice(0, 3).map((c) => c.battery.label);
  return `<section class="tile rec">
    <div class="rec-main">
      <div class="tile-label" style="margin-bottom:6px"><span>Take next</span></div>
      <div class="rec-label">${esc(b.label)}</div>
      <div class="tile-sub" style="font-size:var(--pit-fs-17);color:var(--cat-body)">${esc(rec.reason)}</div>
      ${rec.caution ? `<div class="tile-sub warn-text">${esc(rec.caution)}</div>` : ""}
      ${others.length ? `<div class="tile-sub">Then ${esc(others.join(", "))}</div>` : ""}
    </div>
    ${btn(current ? `Swap ${current.label} for ${b.label}` : `Put ${b.label} in the robot`, "batt-in", { cls: "primary", d: { id: b.id } })}
  </section>`;
}

export function render(ctx) {
  const { S } = ctx;
  const head = `<div class="head"><h1>Batteries</h1><div class="head-actions">${btn("Add a battery", "batt-add", { ico: "plus" })}</div></div>`;
  if (!S.batteries.length) {
    return `${head}<section class="tile empty-tile"><div class="empty">
      <h2>No batteries on the board</h2>
      <p>Add each battery by the label written on it. Log its voltage as it goes into the robot and as it comes out, and the board will say which to take next and which are getting weak.</p>
      <div class="tile-actions">${btn("Add a battery", "batt-add", { cls: "primary", ico: "plus" })}</div>
    </div></section>`;
  }
  const now = ctx.now();
  const tiles = boardOrder(S, now, ctx.limits).map((b) => tile(ctx, b)).join("");
  return `${head}${recTile(ctx)}<div class="batt-grid">${tiles}</div>
    <p class="quiet">Flags use this app's limits: resting below ${ctx.limits.lowRestVolts} V when marked ready, or ${ctx.limits.weakMilliohm} mΩ and above. Change them in Settings.</p>`;
}

// ---- sheets ------------------------------------------------------------------------------------

const voltField = (name, label, hint = "") => ({ name, label, type: "number", placeholder: "12.90", big: true, hint, row: "m" });
const ohmField = { name: "mohm", label: "Resistance, mΩ (optional)", type: "number", placeholder: "13", big: true, row: "m" };

/** Read the measurement fields. Returns `{ error }` when something typed is not a number. */
function measured(values, voltsKey = "volts") {
  const v = values[voltsKey]?.trim() ? parseNumber(values[voltsKey]) : undefined;
  const r = values.mohm?.trim() ? parseNumber(values.mohm) : undefined;
  if (v === null) return { error: "The voltage is not a number." };
  if (r === null) return { error: "The resistance is not a number." };
  if (v !== undefined && (v < 5 || v > 16)) return { error: "A 12 V battery reads between 5 and 16 volts. Check the figure." };
  if (r !== undefined && (r <= 0 || r > 500)) return { error: "Resistance is in milliohms, usually between 8 and 40." };
  return { volts: v ?? null, mohm: r ?? null };
}

function matchOptions(ctx) {
  const now = ctx.now();
  const open = sorted(ctx.S).filter((m) => !isPlayed(m, now));
  return [...open.map((m) => ({ value: m.id, label: longLabel(m) })), { value: "", label: "No match (practice, or not listed)" }];
}

function putIn(ctx, id) {
  const battery = byId(ctx.S, id);
  if (!battery) return;
  const current = inRobot(ctx.S);
  if (current?.id === id) return ctx.toast(`${battery.label} is already in the robot`);
  const next = nextMatch(ctx.S, ctx.now());
  const fields = [];
  if (current) fields.push({ name: "outVolts", label: `${current.label} came out at, V`, type: "number", placeholder: "12.10", big: true });
  fields.push(voltField("volts", `${battery.label} goes in at, V`), ohmField);
  fields.push({ name: "matchId", label: "For", type: "select", value: next?.id ?? "", options: matchOptions(ctx) });

  openSheet({
    title: current ? `Swap ${current.label} for ${battery.label}` : `Put ${battery.label} in the robot`,
    intro: "Measure the battery at rest, before it is plugged in. Leave a figure blank if it was not measured.",
    fields,
    submit: current ? "Swap" : "Put in",
    onSubmit: (values) => {
      const m = measured(values);
      if (m.error) return m.error;
      let outgoing = { volts: null };
      if (current) {
        outgoing = measured({ volts: values.outVolts });
        if (outgoing.error) return outgoing.error;
      }
      let error = null;
      ctx.update((S) => {
        const now = ctx.now();
        if (current) error = takeOut(S, current.id, { volts: outgoing.volts }, now).error;
        if (!error) error = putInRobot(S, id, { ...m, matchId: values.matchId || null }, now).error;
      }, {});
      if (error) return error;
      ctx.toast(`${battery.label} is in the robot`);
    },
  });
}

function readingSheet(ctx, id, { title, intro, submit, apply, done }) {
  const battery = byId(ctx.S, id);
  if (!battery) return;
  openSheet({
    title: title(battery),
    intro,
    fields: [voltField("volts", "Voltage, V"), ohmField],
    submit,
    onSubmit: (values) => {
      const m = measured(values);
      if (m.error) return m.error;
      let error = null;
      ctx.update((S) => { error = apply(S, m).error; }, {});
      if (error) return error;
      ctx.toast(done(battery));
    },
  });
}

function more(ctx, id) {
  const battery = byId(ctx.S, id);
  if (!battery) return;
  const now = ctx.now();
  const KIND = { in: "Went in", out: "Came out", rest: "At rest" };
  const readings = [...battery.readings].reverse().slice(0, 8).map((r) => {
    const match = r.matchId ? ctx.S.schedule.find((m) => m.id === r.matchId) : null;
    const what = `${KIND[r.kind]}${match ? ` · ${shortLabel(match)}` : ""}`;
    const value = [r.volts !== null ? volts(r.volts) : null, r.mohm !== null ? milliohm(r.mohm) : null].filter(Boolean).join(" · ");
    return `<div class="kv"><dt>${esc(sameDay(r.at, now) ? clock(r.at) : stamp(r.at))} · ${esc(what)}</dt><dd>${esc(value)}</dd></div>`;
  }).join("");
  const history = readings
    ? `<dl class="history">${readings}</dl>${battery.readings.length > 8 ? `<small>The ${plural(battery.readings.length - 8, "older reading")} are in the report.</small>` : ""}`
    : `<p class="quiet">No readings yet.</p>`;

  // The steps that are possible from here but are not the tile's one button.
  const extra = [];
  const act = (name) => () => actions[name](ctx, { dataset: { id } });
  if (battery.state !== "retired") extra.push({ label: "Log a reading", body: true, run: act("batt-log") });
  if (battery.state === "charging" || battery.state === "resting") extra.push({ label: "Put in robot", body: true, run: act("batt-in") });
  if (battery.state === "resting") extra.push({ label: "Mark ready", body: true, run: act("batt-ready") });
  if (battery.state === "ready") {
    extra.push({ label: "Back on charge", body: true, run: (close) => { close(); ctx.update((S) => putOnCharge(S, id, ctx.now()), { toast: `${battery.label} is back on charge` }); } });
  }
  if (battery.state !== "in-robot" && battery.state !== "retired") {
    extra.push({ label: "Retire", body: true, run: (close) => { close(); ctx.update((S) => retire(S, id, ctx.now()), { toast: `${battery.label} retired` }); } });
  }
  extra.push({
    label: "Remove",
    danger: true,
    run: () => confirmSheet({
      title: `Remove ${battery.label}?`,
      intro: "Its readings and cycle count are deleted. To keep them, retire it instead.",
      submit: "Remove",
      danger: true,
      run: () => ctx.update((S) => removeBattery(S, id), { toast: `${battery.label} removed` }),
    }),
  });

  const fields = [
    { name: "label", label: "Label", value: battery.label },
    { name: "note", label: "Note (optional)", value: battery.note, placeholder: "Bought 2024, loose terminal re-crimped" },
    { type: "static", name: "history", label: "Readings", html: history },
  ];
  openSheet({
    title: battery.label,
    intro: `${STATE_NAMES[battery.state]} · ${plural(battery.cycles, "cycle")}`,
    fields,
    extra,
    submit: "Save",
    onSubmit: (values) => {
      let error = null;
      ctx.update((S) => {
        error = renameBattery(S, id, values.label).error;
        if (!error) byId(S, id).note = values.note.trim();
      }, {});
      return error || undefined;
    },
  });
}

export const actions = {
  "batt-add": (ctx) => openSheet({
    title: "Add a battery",
    intro: "Use the label written on the battery itself, so anyone can find it.",
    fields: [{ name: "label", label: "Label", placeholder: "B1", big: true }],
    submit: "Add",
    onSubmit: ({ label }) => {
      let error = null;
      ctx.update((S) => { error = addBattery(S, label, ctx.now()).error; }, {});
      return error || undefined;
    },
  }),

  "batt-in": (ctx, el) => putIn(ctx, el.dataset.id),

  "batt-out": (ctx, el) => readingSheet(ctx, el.dataset.id, {
    title: (b) => `Take ${b.label} out`,
    intro: "Measure it once it is unplugged. Leave a figure blank if it was not measured.",
    submit: "Take out",
    apply: (S, m) => takeOut(S, el.dataset.id, m, ctx.now()),
    done: (b) => `${b.label} is out and resting`,
  }),

  "batt-ready": (ctx, el) => readingSheet(ctx, el.dataset.id, {
    title: (b) => `Mark ${b.label} ready`,
    intro: "Take it off the charger and let it sit a few minutes before measuring: straight off the charger it reads high.",
    submit: "Mark ready",
    apply: (S, m) => markReady(S, el.dataset.id, m, ctx.now()),
    done: (b) => `${b.label} is ready`,
  }),

  "batt-log": (ctx, el) => readingSheet(ctx, el.dataset.id, {
    title: (b) => `Log a reading for ${b.label}`,
    intro: "A resting measurement. The battery stays where it is.",
    submit: "Log",
    apply: (S, m) => logRest(S, el.dataset.id, m, ctx.now()),
    done: (b) => `Reading logged for ${b.label}`,
  }),

  "batt-charge": (ctx, el) => {
    const battery = byId(ctx.S, el.dataset.id);
    let error = null;
    ctx.update((S) => { error = putOnCharge(S, el.dataset.id, ctx.now()).error; }, {});
    ctx.toast(error || `${battery?.label} is on charge`);
  },

  "batt-unretire": (ctx, el) => ctx.update((S) => unretire(S, el.dataset.id, ctx.now())),
  "batt-more": (ctx, el) => more(ctx, el.dataset.id),
};
