// How a time, a span and a voltage are printed. One place, so every screen prints the same value the
// same way, and so the printing can be tested without a window.

const pad = (n) => String(n).padStart(2, "0");

/** Wall-clock time, 24 hour, in the laptop's own zone: "14:05". A missing time is a dash. */
export function clock(ms) {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Sat 10 Oct", for a schedule that runs over more than one day. */
export function day(ms) {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

/** "2026-10-10 14:05": the stamp a report carries, sortable and unambiguous. */
export function stamp(ms) {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * A countdown as it is read from across a pit: "18:42" under an hour, "1:05:09" over one. Seconds
 * are kept because a figure that only moves once a minute looks stopped. Never negative: a time
 * that has passed is the caller's to word.
 */
export function countdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** A span in words, for captions: "now", "4 min", "1 h 12 min", "2 d 3 h". */
export function span(ms) {
  const minutes = Math.floor(Math.abs(ms) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** Volts to two places, the resolution a multimeter or a Battery Beak gives. */
export function volts(v) {
  return Number.isFinite(v) ? `${v.toFixed(2)} V` : "— V";
}

/** Internal resistance in milliohms, whole numbers below 100 with one decimal. */
export function milliohm(v) {
  return Number.isFinite(v) ? `${Number(v.toFixed(1))} mΩ` : "— mΩ";
}

/**
 * A number someone typed, or null. Accepts a comma for the decimal point, since half the meters in
 * a pit are read aloud by someone who writes it that way. Anything else that is not a number is
 * null, never zero: a blank voltage must not become 0.00 V in a log.
 */
export function parseNumber(text) {
  if (typeof text === "number") return Number.isFinite(text) ? text : null;
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(",", ".");
  if (cleaned === "" || !/^-?\d*\.?\d+$|^-?\d+\.$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * "14:05" typed into a schedule, placed on the day of `base`. Returns epoch milliseconds or null.
 * Also takes "1405" and "2:05pm", because nobody types a colon with a wrench in the other hand.
 */
export function parseClock(text, base) {
  if (typeof text !== "string") return null;
  const m = text.trim().toLowerCase().match(/^(\d{1,2})[:.h]?(\d{2})?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] === undefined ? 0 : Number(m[2]);
  const half = m[3];
  if (half) {
    if (hours < 1 || hours > 12) return null;
    if (half.startsWith("p") && hours !== 12) hours += 12;
    if (half.startsWith("a") && hours === 12) hours = 0;
  }
  if (hours > 23 || minutes > 59) return null;
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

/** The value an `<input type="date">` wants for a moment: "2026-10-10". */
export function dateInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Midnight, local, of a "2026-10-10" from a date input. Null when it is not a date. */
export function parseDateInput(text) {
  const m = typeof text === "string" && text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
