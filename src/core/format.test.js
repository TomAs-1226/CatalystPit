import test from "node:test";
import assert from "node:assert/strict";

import { clock, countdown, span, volts, milliohm, parseNumber, parseClock, dateInput, parseDateInput, stamp, sameDay } from "./format.js";

const at = (h, m, s = 0) => new Date(2026, 9, 10, h, m, s, 0).getTime();

test("a countdown is read at a glance and never goes negative", () => {
  assert.equal(countdown(0), "00:00");
  assert.equal(countdown(59_999), "00:59");
  assert.equal(countdown(18 * 60000 + 42000), "18:42");
  assert.equal(countdown(65 * 60000 + 9000), "1:05:09");
  assert.equal(countdown(-5000), "00:00");
});

test("spans in words", () => {
  assert.equal(span(20_000), "under a minute");
  assert.equal(span(4 * 60000), "4 min");
  assert.equal(span(-4 * 60000), "4 min");
  assert.equal(span(60 * 60000), "1 h");
  assert.equal(span(72 * 60000), "1 h 12 min");
  assert.equal(span(51 * 3600000), "2 d 3 h");
});

test("clock times and stamps are local and zero-padded", () => {
  assert.equal(clock(at(9, 5)), "09:05");
  assert.equal(clock(at(14, 0)), "14:00");
  assert.equal(clock(null), "—");
  assert.equal(stamp(at(9, 5)), "2026-10-10 09:05");
  assert.equal(sameDay(at(0, 1), at(23, 59)), true);
  assert.equal(sameDay(at(23, 59), at(23, 59) + 120000), false);
});

test("measurements print with their unit, and a missing one is a dash", () => {
  assert.equal(volts(12.9), "12.90 V");
  assert.equal(volts(null), "— V");
  assert.equal(milliohm(13), "13 mΩ");
  assert.equal(milliohm(13.46), "13.5 mΩ");
  assert.equal(milliohm(undefined), "— mΩ");
});

test("a typed number is a number or nothing, never zero by accident", () => {
  assert.equal(parseNumber("12.9"), 12.9);
  assert.equal(parseNumber(" 12,9 "), 12.9);
  assert.equal(parseNumber(".5"), 0.5);
  assert.equal(parseNumber("13."), 13);
  assert.equal(parseNumber(12.5), 12.5);
  for (const bad of ["", "   ", "12.9V", "twelve", "1.2.3", null, undefined, NaN]) assert.equal(parseNumber(bad), null);
});

test("a typed time lands on the given day", () => {
  const base = at(8, 0);
  assert.equal(parseClock("14:05", base), at(14, 5));
  assert.equal(parseClock("1405", base), at(14, 5));
  assert.equal(parseClock("9:30", base), at(9, 30));
  assert.equal(parseClock("2:05pm", base), at(14, 5));
  assert.equal(parseClock("12:10 am", base), at(0, 10));
  assert.equal(parseClock("12pm", base), at(12, 0));
  assert.equal(parseClock("7", base), at(7, 0));
  for (const bad of ["", "25:00", "12:75", "noon", "13pm", null]) assert.equal(parseClock(bad, base), null);
});

test("date inputs round-trip", () => {
  assert.equal(dateInput(at(14, 5)), "2026-10-10");
  assert.equal(parseDateInput("2026-10-10"), at(0, 0));
  assert.equal(parseDateInput("10/10/2026"), null);
});
