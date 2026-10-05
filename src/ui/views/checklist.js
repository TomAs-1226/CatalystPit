// The checklist screen: the list for one match, the issues still open above it, the stamp, and the
// record of every run.

import { esc, btn, meter, plural } from "../dom.js";
import { clock, stamp, sameDay } from "../../core/format.js";
import { sorted, nextMatch, isPlayed, shortLabel, longLabel, byId } from "../../core/queue.js";
import {
  NO_MATCH, progress, isTicked, toggle, stampRun, clearTicks, runSummary,
  addItem, renameItem, removeItem, moveItem, addGroup, renameGroup, removeGroup, resetList,
} from "../../core/checklist.js";
import { openIssues, SEVERITY_NAMES } from "../../core/matchlog.js";
import { openSheet, confirmSheet } from "../sheet.js";

/** Which match the screen is turned to: the one chosen, else the next one, else none. */
export function currentMatchId(ctx) {
  const chosen = ctx.ui.clMatch;
  if (chosen === NO_MATCH) return null;
  if (chosen && byId(ctx.S, chosen)) return chosen;
  return nextMatch(ctx.S, ctx.now())?.id ?? null;
}

function matchPicker(ctx, id) {
  const now = ctx.now();
  const options = sorted(ctx.S).map((m) => {
    const played = isPlayed(m, now) ? " · played" : "";
    return `<option value="${esc(m.id)}"${m.id === id ? " selected" : ""}>${esc(longLabel(m))}${played}</option>`;
  });
  options.push(`<option value="${NO_MATCH}"${id === null ? " selected" : ""}>No match (a practice run)</option>`);
  return `<select data-change="cl-match" aria-label="Checklist for which match" style="min-width:230px">${options.join("")}</select>`;
}

function openIssuesTile(ctx) {
  const open = openIssues(ctx.S);
  if (!open.length) return "";
  const rows = open.map((i) => {
    const match = i.matchId ? byId(ctx.S, i.matchId) : null;
    const from = match ? `Raised after ${shortLabel(match)}` : "Raised";
    return `<div class="row">
      <span class="sev" data-sev="${i.severity}">${esc(SEVERITY_NAMES[i.severity])}</span>
      <div class="row-main"><div class="row-title">${esc(i.title)}</div><div class="row-sub">${esc(from)}${i.openedAt ? ` at ${clock(i.openedAt)}` : ""}${i.detail ? ` · ${esc(i.detail)}` : ""}</div></div>
      <div class="row-actions">${btn("Fixed", "issue-fix", { cls: "small", d: { id: i.id } })}</div>
    </div>`;
  }).join("");
  return `<section class="tile"><div class="tile-label"><span>Still open from earlier · ${plural(open.length, "issue")}</span></div><div class="rows">${rows}</div></section>`;
}

function groupsHtml(ctx, id) {
  const { checklist } = ctx.S;
  const p = progress(checklist, id);
  return checklist.groups.map((g) => {
    const gp = p.groups.find((x) => x.id === g.id);
    const rows = g.items.map((item) => {
      const ticked = isTicked(checklist, id, item.id);
      return `<button type="button" class="check${ctx.ui.flash === item.id ? " just" : ""}" role="checkbox" aria-checked="${ticked}" data-act="cl-toggle" data-id="${esc(item.id)}"><span class="check-box"></span><span>${esc(item.text)}</span></button>`;
    }).join("");
    const empty = g.items.length ? "" : `<p class="quiet" style="padding:6px 12px 10px">Nothing in this group. Use Edit list to add to it.</p>`;
    return `<section class="tile group">
      <div class="group-head"><h2>${esc(g.name)}</h2><span class="num" data-done="${gp.total > 0 && gp.done === gp.total}">${gp.done} / ${gp.total}</span></div>
      ${rows}${empty}
    </section>`;
  }).join("");
}

function editHtml(ctx) {
  const groups = ctx.S.checklist.groups.map((g) => {
    const rows = g.items.map((item, i) => `<div class="edit-row">
        <span class="row-title">${esc(item.text)}</span>
        ${btn("", "cl-item-move", { cls: "icon ghost", ico: "up", d: { id: item.id, dir: -1 }, disabled: i === 0, title: "Move up" })}
        ${btn("", "cl-item-move", { cls: "icon ghost", ico: "down", d: { id: item.id, dir: 1 }, disabled: i === g.items.length - 1, title: "Move down" })}
        ${btn("", "cl-item-rename", { cls: "icon ghost", ico: "edit", d: { id: item.id }, title: "Reword" })}
        ${btn("", "cl-item-remove", { cls: "icon ghost", ico: "trash", d: { id: item.id }, title: "Remove" })}
      </div>`).join("");
    return `<section class="tile group" style="padding:18px 16px 16px">
      <div class="group-head" style="padding:0 0 8px 12px"><h2>${esc(g.name)}</h2>
        <span style="display:flex;gap:4px">
          ${btn("", "cl-group-rename", { cls: "icon ghost", ico: "edit", d: { id: g.id }, title: "Rename group" })}
          ${btn("", "cl-group-remove", { cls: "icon ghost", ico: "trash", d: { id: g.id }, title: "Remove group" })}
        </span></div>
      ${rows}
      <div style="padding:10px 0 0 4px">${btn("Add an item", "cl-item-add", { cls: "small", ico: "plus", d: { id: g.id } })}</div>
    </section>`;
  }).join("");
  return `<div class="groups">${groups}</div>
    <div class="head-actions">
      ${btn("Add a group", "cl-group-add", { ico: "plus" })}
      ${btn("Back to the starting list", "cl-reset", { cls: "ghost" })}
    </div>`;
}

function stampTile(ctx, id, p) {
  const match = id ? byId(ctx.S, id) : null;
  const label = match ? shortLabel(match) : "practice";
  if (!p.total) return "";
  const left = p.total - p.done;
  const text = p.complete
    ? "Everything is ticked."
    : p.started
      ? `${plural(left, "item")} not ticked. Stamping now records ${left === 1 ? "it" : "them"} as skipped.`
      : "Nothing is ticked yet.";
  return `<section class="tile stamp">
    <div class="stamp-text"><div class="tile-title">${p.complete ? "Ready to stamp" : "Stamp this run"}</div><div class="tile-sub">${esc(text)} A stamp records the time and the match, then clears the ticks.</div></div>
    ${p.started ? btn("Clear ticks", "cl-clear", { cls: "ghost" }) : ""}
    ${btn(match ? `Stamp for ${label}` : "Stamp practice run", "cl-stamp", { cls: p.complete ? "primary" : "", ico: "check", disabled: !p.started })}
  </section>`;
}

function historyTile(ctx) {
  const runs = [...ctx.S.checklist.history].reverse();
  if (!runs.length) {
    return `<section class="tile"><div class="tile-label"><span>Runs</span></div><p class="quiet">No run has been stamped at this event yet. Each one is kept here with its time, its match and anything that was skipped.</p></section>`;
  }
  const now = ctx.now();
  const rows = runs.map((run) => {
    const skipped = run.total - run.done;
    const when = sameDay(run.at, now) ? clock(run.at) : stamp(run.at);
    const missed = run.missed.length
      ? `<ul>${run.missed.map((m) => `<li>${esc(m.text)} <span class="quiet">· ${esc(m.group)}</span></li>`).join("")}</ul>`
      : "";
    return `<details class="run"${skipped ? "" : " data-clean"}>
      <summary><span class="num dim" style="min-width:56px">${esc(when)}</span>
        <span class="row-main"><span class="row-title">${esc(run.matchLabel || "Practice run")}</span><span class="row-sub">${esc(runSummary(run))}</span></span>
        ${skipped ? `<span class="tag" data-level="warn">${skipped} skipped</span>` : `<span class="tag" data-level="ok">Complete</span>`}
      </summary>${missed}
    </details>`;
  }).join("");
  return `<section class="tile"><div class="tile-label"><span>Runs · ${runs.length}</span></div>${rows}</section>`;
}

export function render(ctx) {
  const id = currentMatchId(ctx);
  const p = progress(ctx.S.checklist, id);

  if (ctx.ui.editList) {
    return `<div class="head"><h1>Edit the checklist</h1><div class="head-actions">${btn("Done", "cl-edit", { cls: "primary" })}</div></div>
      <p class="quiet" style="max-width:70ch">This is the list every match starts from. Changes apply from now on; runs already stamped keep what they recorded.</p>
      ${editHtml(ctx)}`;
  }

  const bar = `<section class="tile cl-bar">
    <div class="cl-count">${p.done}<small>of ${p.total} ticked</small></div>
    <div class="cl-for"><span class="dim">For</span>${matchPicker(ctx, id)}</div>
    ${meter(`cl-${id}`, p.done, p.total, { big: true })}
  </section>`;

  return `<div class="head"><h1>Checklist</h1><div class="head-actions">${btn("Edit list", "cl-edit", { cls: "ghost", ico: "edit" })}</div></div>
    ${bar}
    ${openIssuesTile(ctx)}
    <div class="groups">${groupsHtml(ctx, id)}</div>
    ${stampTile(ctx, id, p)}
    ${historyTile(ctx)}`;
}

const textSheet = (title, label, value, submit, run) =>
  openSheet({ title, fields: [{ name: "text", label, value }], submit, onSubmit: ({ text }) => run(text) });

export const actions = {
  "cl-toggle": (ctx, el) => {
    const id = currentMatchId(ctx);
    // Only a tick being made is animated; one being taken away simply goes.
    const making = !isTicked(ctx.S.checklist, id, el.dataset.id);
    ctx.update((S) => toggle(S.checklist, id, el.dataset.id, ctx.now()), { flash: making ? el.dataset.id : null, keepFocus: `[data-act="cl-toggle"][data-id="${CSS.escape(el.dataset.id)}"]` });
  },

  "cl-match": (ctx, el) => {
    ctx.ui.clMatch = el.value;
    ctx.render();
  },

  "cl-edit": (ctx) => {
    ctx.ui.editList = !ctx.ui.editList;
    ctx.render({ arrive: true });
  },

  "cl-clear": (ctx) => {
    const id = currentMatchId(ctx);
    confirmSheet({
      title: "Clear the ticks?",
      intro: "Nothing is recorded. The list goes back to blank for this match.",
      submit: "Clear ticks",
      danger: true,
      run: () => ctx.update((S) => clearTicks(S.checklist, id)),
    });
  },

  "cl-stamp": (ctx) => {
    const id = currentMatchId(ctx);
    const match = id ? byId(ctx.S, id) : null;
    const p = progress(ctx.S.checklist, id);
    const doStamp = () => {
      let run = null;
      ctx.update((S) => { run = stampRun(S, id, match ? longLabel(match) : "", ctx.now()); }, {});
      if (run) ctx.toast(`Stamped${match ? ` for ${shortLabel(match)}` : ""} · ${runSummary(run)}`);
    };
    if (p.complete) return doStamp();
    const left = p.total - p.done;
    confirmSheet({
      title: `Stamp with ${plural(left, "item")} skipped?`,
      intro: "The run is recorded as it stands, and the report will list what was not ticked.",
      submit: "Stamp anyway",
      run: doStamp,
    });
  },

  "cl-item-add": (ctx, el) => textSheet("Add an item", "What to check", "", "Add", (text) => {
    if (!text.trim()) return "Say what to check.";
    ctx.update((S) => addItem(S, el.dataset.id, text));
  }),

  "cl-item-rename": (ctx, el) => {
    const item = ctx.S.checklist.groups.flatMap((g) => g.items).find((i) => i.id === el.dataset.id);
    if (!item) return;
    textSheet("Reword this item", "What to check", item.text, "Save", (text) => {
      if (!text.trim()) return "Say what to check.";
      ctx.update((S) => renameItem(S, item.id, text));
    });
  },

  "cl-item-remove": (ctx, el) => ctx.update((S) => removeItem(S, el.dataset.id)),
  "cl-item-move": (ctx, el) => ctx.update((S) => moveItem(S, el.dataset.id, Number(el.dataset.dir)), { keepFocus: `[data-act="cl-item-move"][data-id="${CSS.escape(el.dataset.id)}"][data-dir="${el.dataset.dir}"]` }),

  "cl-group-add": (ctx) => textSheet("Add a group", "Group name", "", "Add", (text) => {
    if (!text.trim()) return "Give the group a name.";
    ctx.update((S) => addGroup(S, text));
  }),

  "cl-group-rename": (ctx, el) => {
    const group = ctx.S.checklist.groups.find((g) => g.id === el.dataset.id);
    if (!group) return;
    textSheet("Rename this group", "Group name", group.name, "Save", (text) => {
      if (!text.trim()) return "Give the group a name.";
      ctx.update((S) => renameGroup(S, group.id, text));
    });
  },

  "cl-group-remove": (ctx, el) => {
    const group = ctx.S.checklist.groups.find((g) => g.id === el.dataset.id);
    if (!group) return;
    if (!group.items.length) return ctx.update((S) => removeGroup(S, group.id));
    confirmSheet({
      title: `Remove ${group.name}?`,
      intro: `Its ${plural(group.items.length, "item")} go with it.`,
      submit: "Remove group",
      danger: true,
      run: () => ctx.update((S) => removeGroup(S, group.id)),
    });
  },

  "cl-reset": (ctx) => confirmSheet({
    title: "Go back to the starting list?",
    intro: "Your changes to the list are replaced, and ticks not yet stamped are cleared. Stamped runs are kept.",
    submit: "Replace the list",
    danger: true,
    run: () => ctx.update((S) => resetList(S)),
  }),
};

