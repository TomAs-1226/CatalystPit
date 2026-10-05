// Settings: who the team is, which event this is, the two optional links to the outside (Nexus and
// the robot), and where the data lives.

import { esc, btn, plural } from "../dom.js";
import { clock, span, parseNumber } from "../../core/format.js";
import { freshness } from "../../core/queue.js";
import { nextEvent } from "../../core/store.js";
import { BATTERY_TOPICS } from "../../core/topics.js";
import { openSheet, confirmSheet } from "../sheet.js";
import { call } from "../../bridge.js";

const input = (name, value, { placeholder = "", mode = "", label = "" } = {}) =>
  `<input type="text" data-change="set-${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}" autocomplete="off" spellcheck="false"${mode ? ` inputmode="${mode}"` : ""} />`;

function nexusStatus(ctx) {
  const { settings, nexus, S } = ctx;
  if (!settings.hasNexusKey && !settings.eventKey) return "Off. Enter an event key and an API key to turn it on.";
  if (!settings.hasNexusKey) return "Waiting for an API key.";
  if (!settings.eventKey) return "Waiting for an event key.";
  if (nexus.busy) return "Asking Nexus…";
  if (nexus.error) return nexus.error;
  const fresh = freshness(S.nexus, ctx.now());
  if (!fresh) return "Set up. Not fetched yet.";
  return `Working. Last updated ${clock(fresh.at)}${fresh.stale ? `, ${span(fresh.age)} ago` : ""}.${nexus.note ? ` ${nexus.note}` : ""}`;
}

function robotStatus(ctx) {
  const { robot, settings } = ctx;
  if (!settings.robotLink) return "Off. Pit is not looking for the robot.";
  if (!robot?.connected) return "Looking for the robot. None found yet.";
  if (robot.volts == null) return `Connected to ${robot.address}, but the robot code is not publishing a battery voltage.`;
  return `Connected to ${robot.address}. Reading ${robot.volts.toFixed(2)} V from ${robot.topic}.`;
}

export function render(ctx) {
  const { settings, S, info } = ctx;
  const runs = S.checklist.history.length;
  const eventFacts = [plural(S.schedule.length, "match", "matches"), plural(runs, "checklist run"), plural(S.issues.length, "issue")].join(" · ");

  return `<div class="head"><h1>Settings</h1></div>
  <div class="settings">
    <section class="tile">
      <h2>Team and event</h2>
      <div class="field-row">
        <div class="field"><span>Team number</span>${input("team", settings.team, { mode: "numeric", label: "Team number" })}</div>
        <div class="field"><span>Event name</span>${input("event-name", S.event.name, { placeholder: "Name of this event", label: "Event name" })}</div>
      </div>
      <div class="set-row">
        <div><div class="row-title">Start a new event</div><div class="row-sub">Archives this one (${esc(eventFacts)}) and starts clean. Batteries, the checklist's items and open issues carry over.</div></div>
        ${btn("New event", "event-new", { cls: "small" })}
      </div>
    </section>

    <section class="tile">
      <h2>Nexus for FRC</h2>
      <p class="quiet">Optional. Fills in the team's matches and keeps their queue and start times current. It needs an API key from your Nexus account and the event's key. Without it, the schedule is typed in by hand and works the same.</p>
      <div class="field-row">
        <div class="field"><span>Event key</span>${input("event-key", settings.eventKey, { placeholder: "2026casd", label: "Nexus event key" })}</div>
        <div class="field"><span>API key</span>
          <div style="display:flex;gap:8px;align-items:center;min-height:var(--pit-tap)">
            <span class="row-title" style="flex:1">${settings.hasNexusKey ? "Saved on this laptop" : "Not set"}</span>
            ${btn(settings.hasNexusKey ? "Replace" : "Enter key", "nexus-key", { cls: "small" })}
            ${settings.hasNexusKey ? btn("Remove", "nexus-key-clear", { cls: "small ghost danger" }) : ""}
          </div>
        </div>
      </div>
      <div class="set-row">
        <div class="row-sub${ctx.nexus.error ? " warn-text" : ""}" id="nexusStatus">${esc(nexusStatus(ctx))}</div>
        ${settings.hasNexusKey && settings.eventKey ? btn("Refresh now", "nexus-refresh", { cls: "small", disabled: ctx.nexus.busy }) : ""}
      </div>
      <p class="quiet">The key is kept in this app's data folder, apart from the event data, and is only ever sent to frc.nexus.</p>
    </section>

    <section class="tile">
      <h2>Robot battery reading</h2>
      <div class="set-row">
        <div><div class="row-title">Look for the robot</div><div class="row-sub">Reads the battery voltage over NetworkTables when the robot is on the same network. Read-only: Pit never sends anything to the robot.</div></div>
        <button type="button" class="switch" role="switch" aria-checked="${settings.robotLink}" aria-label="Look for the robot" data-act="set-robot-link"></button>
      </div>
      <div class="row-sub" id="robotStatus">${esc(robotStatus(ctx))}</div>
      <p class="quiet">The voltage appears only if the robot code publishes it, under ${BATTERY_TOPICS.map((t) => `<span class="path">${esc(t)}</span>`).join(" or ")}. It is shown for reference and is never logged for you.</p>
    </section>

    <section class="tile">
      <h2>Battery limits</h2>
      <p class="quiet">Where the battery board starts flagging. These are this app's defaults, not a standard; set them to what your team trusts.</p>
      <div class="field-row">
        <div class="field"><span>Ready but resting below, V</span>${input("low-rest", settings.lowRestVolts, { mode: "decimal", label: "Low resting voltage" })}</div>
        <div class="field"><span>Weak at or above, mΩ</span>${input("weak-mohm", settings.weakMilliohm, { mode: "decimal", label: "Weak internal resistance" })}</div>
      </div>
    </section>

  </div>
  <section class="tile about">
      <h2>This app</h2>
      <dl>
        <div class="kv"><dt>Version</dt><dd>${esc(info.version)}</dd></div>
        <div class="kv"><dt>Data folder</dt><dd class="path">${esc(info.dataDir)}</dd></div>
        <div class="kv"><dt>Updates</dt><dd>Not automatic in this build. Install a newer version over this one; the data folder is kept.</dd></div>
      </dl>
      <p class="quiet">Everything is saved in the data folder as plain JSON, with the previous save kept beside it as a backup. Nothing is sent anywhere except the Nexus request above.</p>
  </section>`;
}

async function patch(ctx, change, { toast = "" } = {}) {
  try {
    ctx.setSettings(await call("set_settings", { patch: change }));
    if (toast) ctx.toast(toast);
    return null;
  } catch (error) {
    ctx.toast(String(error));
    ctx.render();          // put the field back to the value that is actually saved
    return String(error);
  }
}

export const actions = {
  "set-team": async (ctx, el) => {
    const team = parseNumber(el.value);
    if (team === null || !Number.isInteger(team)) { ctx.toast("A team number is a whole number."); return ctx.render(); }
    await patch(ctx, { team }, { toast: `Team ${team}` });
  },

  "set-event-name": (ctx, el) => ctx.update((S) => { S.event.name = el.value.trim(); }),

  "set-event-key": async (ctx, el) => {
    const error = await patch(ctx, { eventKey: el.value });
    if (!error) ctx.refreshNexus({ manual: false });
  },

  "set-low-rest": async (ctx, el) => {
    const v = parseNumber(el.value);
    if (v === null) { ctx.toast("That is not a number."); return ctx.render(); }
    await patch(ctx, { lowRestVolts: v });
  },

  "set-weak-mohm": async (ctx, el) => {
    const v = parseNumber(el.value);
    if (v === null) { ctx.toast("That is not a number."); return ctx.render(); }
    await patch(ctx, { weakMilliohm: v });
  },

  "set-robot-link": (ctx) => patch(ctx, { robotLink: !ctx.settings.robotLink }),

  "nexus-key": (ctx) => openSheet({
    title: "Nexus API key",
    intro: "From your account page on frc.nexus. It is stored on this laptop only and is not shown again.",
    fields: [{ name: "key", label: "API key", type: "password" }],
    submit: "Save key",
    onSubmit: async ({ key }) => {
      if (!key.trim()) return "Paste the key first.";
      try {
        ctx.setSettings(await call("set_settings", { patch: { nexusKey: key } }));
      } catch (error) {
        return String(error);
      }
      ctx.toast("Nexus key saved");
      ctx.refreshNexus({ manual: false });
    },
  }),

  "nexus-key-clear": (ctx) => confirmSheet({
    title: "Remove the Nexus key?",
    intro: "The schedule already here stays. It will no longer be updated until a key is entered again.",
    submit: "Remove key",
    danger: true,
    run: async () => { await patch(ctx, { nexusKey: "" }, { toast: "Nexus key removed" }); },
  }),

  "event-new": (ctx) => openSheet({
    title: "Start a new event",
    intro: "This event is archived to the data folder first. Batteries, the checklist's items and open issues carry over; the schedule, the log and the runs start empty.",
    fields: [{ name: "name", label: "Name of the new event", placeholder: "Name of the event" }],
    submit: "Archive and start",
    onSubmit: async ({ name }) => {
      if (!name.trim()) return "Give the new event a name.";
      try {
        await call("archive_event", { data: ctx.S, name: ctx.S.event.name || "event" });
      } catch (error) {
        return `The current event could not be archived, so nothing was changed. ${error}`;
      }
      ctx.replaceState(nextEvent(ctx.S, name, ctx.now()));
      ctx.toast(`Started ${name.trim()}`);
      ctx.go("now");
    },
  }),
};
