// The queue: the team's matches in playing order, where each stands, and where the times came from.

import { esc, btn, tag, sideTag, teams, plural } from "../dom.js";
import { clock, day, countdown, span, sameDay, parseClock, dateInput, parseDateInput } from "../../core/format.js";
import { sorted, nextMatch, isPlayed, timing, sides, shortLabel, longLabel, freshness, addMatch, editMatch, removeMatch, byId, readLabel } from "../../core/queue.js";
import { hasLog } from "../../core/matchlog.js";
import { openSheet, confirmSheet } from "../sheet.js";

function feedTile(ctx) {
  const { S, settings, nexus } = ctx;
  const now = ctx.now();
  const configured = settings.hasNexusKey && settings.eventKey;

  if (!configured) {
    const missing = !settings.hasNexusKey && !settings.eventKey
      ? "Nexus is not set up, so this schedule is whatever is typed in here."
      : !settings.hasNexusKey
        ? "Nexus has an event key but no API key yet."
        : "Nexus has an API key but no event key yet.";
    return `<section class="tile" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px">
      <p class="quiet" style="flex:1 1 320px">${esc(missing)} With a key and an event code it fills in the team's matches and keeps their times current.</p>
      ${btn("Set up Nexus", "go", { cls: "small", d: { view: "settings" } })}
    </section>`;
  }

  const fresh = freshness(S.nexus, now);
  const parts = [`<span>Nexus · <b>${esc(settings.eventKey)}</b></span>`];
  if (nexus.busy) parts.push("<span>Asking Nexus…</span>");
  else if (nexus.error) parts.push(`<span class="warn-text">${esc(nexus.error)}</span>`);
  if (fresh) parts.push(`<span${fresh.stale ? ' class="warn-text"' : ""}>Updated ${clock(fresh.at)}${fresh.stale ? ` · ${span(fresh.age)} ago` : ""}</span>`);
  else if (!nexus.busy && !nexus.error) parts.push("<span>Not fetched yet</span>");
  if (S.nexus?.nowQueuing) parts.push(`<span>The field is queuing <b>${esc(S.nexus.nowQueuing)}</b></span>`);
  if (nexus.note) parts.push(`<span>${esc(nexus.note)}</span>`);

  const announcements = (S.nexus?.announcements ?? [])
    .map((a) => `<div class="announce">${a.at ? `<time>${clock(a.at)}</time>` : ""}${esc(a.text)}</div>`)
    .join("");
  return `<section class="tile"><div class="feed">${parts.join("")}</div>${announcements ? `<div style="margin-top:12px">${announcements}</div>` : ""}</section>`;
}

function matchRow(ctx, match, next) {
  const now = ctx.now();
  const { settings } = ctx;
  const side = sides(match, settings.team);
  const played = isPlayed(match, now);
  const isNext = next?.id === match.id;
  const t = timing(match, now);

  const times = [];
  if (match.times.queue !== null) times.push(`Queue ${clock(match.times.queue)}`);
  if (match.times.start !== null) times.push(`Start ${clock(match.times.start)}`);
  const timeText = times.length ? times.join(" · ") : "No time entered";

  const teamText = [
    side.partners.length ? `With ${teams(side.partners)}` : "",
    side.opponents.length ? `Against ${teams(side.opponents)}` : "",
  ].filter(Boolean).join("  ·  ");

  let end = "";
  if (played) end = tag("Played");
  else if (t.kind === "status") end = tag(t.text, "signal");
  else if (isNext && (t.kind === "queue" || t.kind === "start")) {
    const word = t.late ? (t.kind === "queue" ? "past queue" : "past start") : (t.kind === "queue" ? "to queue" : "to start");
    end = `<span class="quiet">${word}</span><span class="match-count${t.late ? " warn-text" : ""}" data-count-to="${t.at}" data-count-dir="${t.late ? "up" : "down"}">${countdown(t.ms)}</span>`;
  } else if (isNext) end = tag("Next");

  return `<button type="button" class="match" data-act="go" data-view="log" data-arg="${esc(match.id)}" data-played="${played}" data-next="${isNext}" aria-label="${esc(longLabel(match))}, open its log">
    <span class="match-label">${esc(shortLabel(match))}</span>
    <span class="match-mid">
      <span class="match-line"><span class="match-time${times.length ? "" : " dim"}">${esc(timeText)}</span>${sideTag(side.alliance)}${match.source === "manual" && settings.hasNexusKey && settings.eventKey ? `<span class="quiet">entered by hand</span>` : ""}</span>
      ${teamText ? `<span class="match-teams">${teamText}</span>` : ""}
    </span>
    <span class="match-end">${end}</span>
  </button>`;
}

export function render(ctx) {
  const { S, settings } = ctx;
  const now = ctx.now();
  const configured = settings.hasNexusKey && settings.eventKey;
  const head = `<div class="head"><h1>Queue</h1><div class="head-actions">
    ${configured ? btn(ctx.nexus.busy ? "Asking…" : "Refresh", "nexus-refresh", { ico: "refresh", disabled: ctx.nexus.busy }) : ""}
    ${btn("Add a match", "match-add", { ico: "plus" })}
  </div></div>`;

  const matches = sorted(S);
  if (!matches.length) {
    return `${head}${feedTile(ctx)}<section class="tile empty-tile"><div class="empty">
      <h2>No matches yet</h2>
      <p>${configured
        ? `Nexus has sent no matches for team ${esc(settings.team)}. The schedule may not be published yet; you can add matches by hand in the meantime.`
        : "Type the team's matches in from the printed schedule: a label such as Q12 and a start time are enough. Add the queue time too if the schedule gives one."}</p>
      <div class="tile-actions">${btn("Add a match", "match-add", { cls: "primary", ico: "plus" })}</div>
    </div></section>`;
  }

  const next = nextMatch(S, now);
  const key = (m) => m.times.start ?? m.times.queue;
  const days = new Set(matches.map(key).filter((t) => t !== null).map((t) => day(t)));
  let lastDay = null;
  const rows = matches.map((m) => {
    let headRow = "";
    const t = key(m);
    if (days.size > 1 && t !== null && day(t) !== lastDay) {
      lastDay = day(t);
      headRow = `<div class="day-head">${esc(sameDay(t, now) ? `Today · ${lastDay}` : lastDay)}</div>`;
    }
    return headRow + matchRow(ctx, m, next);
  }).join("");

  const left = matches.filter((m) => !isPlayed(m, now)).length;
  return `${head}${feedTile(ctx)}
    <div class="match-list">${rows}</div>
    <p class="quiet">${plural(matches.length, "match", "matches")}, ${left} still to play. Open a match to log it, mark it played, or correct it.</p>`;
}

// ---- the match sheet ---------------------------------------------------------------------------

const numbers = (text) => (text || "").split(/[\s,;·]+/).map((t) => t.trim()).filter(Boolean);

/** Add a match, or correct one that was entered by hand. */
export function matchSheet(ctx, id = null) {
  const existing = id ? byId(ctx.S, id) : null;
  const now = ctx.now();
  const base = existing?.times.start ?? existing?.times.queue ?? now;
  const side = existing ? sides(existing, ctx.settings.team) : { alliance: null, partners: [], opponents: [] };

  openSheet({
    title: existing ? `Correct ${shortLabel(existing)}` : "Add a match",
    intro: existing ? "" : "From the printed schedule. Only the label is needed; everything else can be filled in later.",
    fields: [
      ...(existing ? [] : [{ name: "label", label: "Match", placeholder: "Q12", big: true, hint: "Q12, Practice 3, Playoff 5, Final 1" }]),
      { name: "date", label: "Day", type: "date", value: dateInput(base) },
      { name: "start", label: "Start time", placeholder: "14:35", value: existing?.times.start != null ? clock(existing.times.start) : "", inputmode: "numeric", row: "t" },
      { name: "queue", label: "Queue time (if given)", placeholder: "14:15", value: existing?.times.queue != null ? clock(existing.times.queue) : "", inputmode: "numeric", row: "t" },
      { name: "alliance", label: "Alliance", type: "seg", optional: true, value: side.alliance ?? "", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] },
      { name: "partners", label: "Partners", placeholder: "254 1678", value: side.partners.join(" "), inputmode: "numeric", row: "a" },
      { name: "opponents", label: "Opponents", placeholder: "971 1323 118", value: side.opponents.join(" "), inputmode: "numeric", row: "a" },
    ],
    submit: existing ? "Save" : "Add",
    onSubmit: (values) => {
      const dayMs = parseDateInput(values.date) ?? now;
      const read = (text, what) => {
        if (!text.trim()) return { value: null };
        const ms = parseClock(text, dayMs);
        return ms === null ? { error: `The ${what} time is not a time. Write it like 14:35.` } : { value: ms };
      };
      const start = read(values.start, "start");
      if (start.error) return start.error;
      const queue = read(values.queue, "queue");
      if (queue.error) return queue.error;
      if (start.value !== null && queue.value !== null && queue.value > start.value) return "The queue time is after the start time.";
      if ((values.partners.trim() || values.opponents.trim()) && !values.alliance) return "Choose the alliance, so the partners can be told from the opponents.";

      const fields = { start: start.value, queue: queue.value, alliance: values.alliance || null, partners: numbers(values.partners), opponents: numbers(values.opponents) };
      let error = null;
      let label = "";
      ctx.update((S) => {
        const result = existing ? editMatch(S, existing.id, fields, ctx.settings.team) : addMatch(S, { label: values.label, ...fields }, ctx.settings.team);
        error = result.error ?? null;
        if (result.match) label = shortLabel(result.match);
      }, {});
      if (error) return error;
      ctx.toast(existing ? `${label} corrected` : `${label} added`);
    },
  });
}

export const actions = {
  "match-add": (ctx) => matchSheet(ctx),
  "match-edit": (ctx, el) => matchSheet(ctx, el.dataset.id),

  "match-remove": (ctx, el) => {
    const match = byId(ctx.S, el.dataset.id);
    if (!match) return;
    confirmSheet({
      title: `Remove ${shortLabel(match)} from the schedule?`,
      intro: hasLog(ctx.S, match)
        ? "What was logged for it stays in the data file, but it will no longer appear in the log or the report."
        : match.source === "nexus" ? "If Nexus still lists it, the next refresh will bring it back." : "",
      submit: "Remove",
      danger: true,
      run: () => {
        ctx.ui.logMatch = null;
        ctx.update((S) => removeMatch(S, match.id), { toast: `${readLabel(match.label).short} removed` });
      },
    });
  },

  "nexus-refresh": (ctx) => ctx.refreshNexus({ manual: true }),
};
