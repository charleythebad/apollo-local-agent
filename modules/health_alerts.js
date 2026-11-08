// modules/health_alerts.js — down/back service alerts.
// Pure logic, no I/O: health.js runs the checks every 5 minutes and posts what
// this returns to the health channel. One "down" after 2 failed checks in a row,
// one "back" when it passes again, nothing in between. A post that can't be
// sent stays queued and goes out on the next loop — never dropped, never repeated.
'use strict';

const FAILS_FOR_DOWN = 2;

function hhmm(ms, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ms));
}

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function newState() { return { services: {}, queue: [] }; }

// results: [{ name, ok }]. Returns the same state object, updated; new posts are
// appended to state.queue. Code-built text only.
function step(state, results, nowMs, { prefix = '[Apollo]', tz = process.env.APOLLO_TZ || 'UTC' } = {}) {
  for (const { name, ok } of results) {
    const s = state.services[name] || (state.services[name] = { fails: 0, down: false, firstFailAt: null });
    if (ok) {
      if (s.down) state.queue.push(`${prefix} ✅ ${name} back (down ${duration(nowMs - s.firstFailAt)})`);
      s.fails = 0; s.down = false; s.firstFailAt = null;
      continue;
    }
    s.fails++;
    if (s.fails === 1) s.firstFailAt = nowMs;
    if (s.fails >= FAILS_FOR_DOWN && !s.down) {
      s.down = true;
      state.queue.push(`${prefix} ❌ ${name} down (${FAILS_FOR_DOWN} checks, since ${hhmm(s.firstFailAt, tz)})`);
    }
  }
  return state;
}

// Sends queued posts in order; stops at the first failure and keeps the rest.
async function flush(state, send) {
  while (state.queue.length) {
    try { await send(state.queue[0]); }
    catch (err) { return { sent: false, error: err.message, left: state.queue.length }; }
    state.queue.shift();
  }
  return { sent: true, left: 0 };
}

module.exports = { newState, step, flush, duration, hhmm, FAILS_FOR_DOWN };
