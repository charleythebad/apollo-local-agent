// modules/jobs_runner.js — Apollo's scheduler for command jobs (jobs.json).
// Runs as its own pm2 app, separate from bot.js, so a bot restart never kills a
// running job.
//
// Behaviour:
//   - argv run as given (e.g. `sh -lc ...`) with a fixed PATH (JOBS_PATH)
//   - output = trimmed stdout; stdout AND stderr -> "stdout:\n..\n\nstderr:\n.."
//   - posted verbatim to the job's channel by the bot (DISCORD_TOKEN)
//   - output exactly NO_REPLY, or empty -> nothing posted
//   - failed run (exit != 0, timeout, signal) -> nothing posted, except a failure
//     alert for jobs that configure one (failureAlert)
//   - missed runs (machine off/asleep) are not caught up
//   - when Discord is down, only the post is re-sent. A job is never re-run
//     because a post failed (re-running a trade job could double an order).
//
// Usage:  node modules/jobs_runner.js                     (scheduler loop, pm2)
//         node modules/jobs_runner.js --run-now <name> [--dry]   (one run; --dry prints, posts nothing)
//         node modules/jobs_runner.js --list
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JOBS_FILE = path.join(ROOT, 'jobs.json');
// APOLLO_JOBS_LOG_DIR is for tests only (a throwaway folder).
const LOG_DIR = process.env.APOLLO_JOBS_LOG_DIR || path.join(ROOT, 'logs', 'jobs');
const RUN_LOG = path.join(path.dirname(LOG_DIR), 'jobs_runs.jsonl');
const STATE_FILE = path.join(LOG_DIR, 'state.json');
// Jobs get a fixed, minimal PATH; put wrapper scripts (like a no-send shim) first.
const JOB_PATH = process.env.JOBS_PATH || '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
// Jobs start in the repo root unless they set their own cwd.
const JOB_CWD = ROOT;
const DEFAULT_TIMEOUT_S = 600;            // when a job sets none
const DISCORD_MAX = 2000;
const POST_RETRY_S = [30, 60, 120, 300, 600, 900];   // ~33 min of re-sends, then give up
const UA = 'ApolloJobs (local, 1.0)';

// ── cron matching ──────────────────────────────────────────────────────────────

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(text, [lo, hi]) {
  const out = new Set();
  for (const part of text.split(',')) {
    const [base, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${text}"`);
    let a, b;
    if (base === '*') { a = lo; b = hi; }
    else if (base.includes('-')) { [a, b] = base.split('-').map(Number); }
    else { a = Number(base); b = stepText === undefined ? a : hi; }
    if (![a, b].every(Number.isInteger) || a < lo || b > hi || a > b) throw new Error(`bad field "${text}"`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const sets = f.map((t, i) => parseField(t, RANGES[i]));
  if (sets[4].has(7)) sets[4].add(0);               // 7 = Sunday too
  return { sets, domStar: f[2] === '*', dowStar: f[4] === '*' };
}

// Wall-clock fields of `date` in `tz` (handles DST through Intl).
function localFields(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { year: +get('year'), month: +get('month'), day: +get('day'),
           hour: +get('hour'), minute: +get('minute'), dow };
}

function cronMatches(cron, date, tz) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const t = localFields(date, tz);
  const [min, hr, dom, mon, dow] = c.sets;
  if (!min.has(t.minute) || !hr.has(t.hour) || !mon.has(t.month)) return false;
  // Vixie rule: if both day fields are restricted, either may match.
  if (!c.domStar && !c.dowStar) return dom.has(t.day) || dow.has(t.dow);
  return dom.has(t.day) && dow.has(t.dow);
}

// Key for one local minute; a repeated wall-clock minute (DST fall-back) fires once.
function minuteKey(date, tz) {
  const t = localFields(date, tz);
  return `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}`;
}

// ── output and Discord ─────────────────────────────────────────────────────────

function buildSummary(stdout, stderr) {
  const o = (stdout || '').trim(), e = (stderr || '').trim();
  if (o && e) return `stdout:\n${o}\n\nstderr:\n${e}`;
  return o || e || '';
}

function isSilent(summary) {
  return !summary || summary === 'NO_REPLY';
}

function chunk(text, max = DISCORD_MAX) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let l = line;
    while (l.length > max) {                       // a single overlong line
      if (cur) { out.push(cur); cur = ''; }
      out.push(l.slice(0, max)); l = l.slice(max);
    }
    const next = cur ? `${cur}\n${l}` : l;
    if (next.length > max) { out.push(cur); cur = l; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

function channelId(to) {
  return String(to).replace(/^channel:/, '');
}

function botToken() {
  // Read at call time from the environment; never logged, never written to disk.
  const t = process.env.DISCORD_TOKEN;
  if (!t) throw new Error('DISCORD_TOKEN is not set');
  return t;
}

async function postOnce(channel, content, fetchImpl = fetch, token = botToken) {
  const res = await fetchImpl(`https://discord.com/api/v10/channels/${channelId(channel)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token()}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ content, allowed_mentions: { parse: ['users'] } }),
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    const err = new Error('rate limited'); err.retryAfterS = Number(j.retry_after) || 5; throw err;
  }
  if (!res.ok) throw new Error(`discord HTTP ${res.status}`);
}

// Sends every chunk in order; retries the remaining chunks on failure.
async function post(channel, text, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
                                     retries = POST_RETRY_S, token = botToken } = {}) {
  const parts = chunk(text);
  let i = 0, attempt = 0, lastErr = null;
  while (i < parts.length) {
    try { await postOnce(channel, parts[i], fetchImpl, token); i++; continue; }
    catch (err) {
      lastErr = err;
      if (attempt >= retries.length) return { ok: false, sent: i, of: parts.length, error: err.message };
      await sleep(1000 * (err.retryAfterS || retries[attempt]));
      attempt++;
    }
  }
  return { ok: true, sent: i, of: parts.length, retried: attempt, error: lastErr && lastErr.message };
}

// ── running a job ──────────────────────────────────────────────────────────────

function ensureDirs() { fs.mkdirSync(LOG_DIR, { recursive: true }); }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function lockPath(name) { return path.join(LOG_DIR, `${name}.lock`); }

// One run at a time per job, across runner restarts (children are detached).
// maxAgeMs: a lock older than this is stale even if its pid is alive (after a
// reboot the pid can belong to some unrelated process).
function takeLock(name, info, maxAgeMs = Infinity, nowMs = Date.now()) {
  const p = lockPath(name);
  if (fs.existsSync(p)) {
    try {
      const held = JSON.parse(fs.readFileSync(p, 'utf8'));
      const young = !held.started || nowMs - held.started < maxAgeMs;
      if (held.pid && pidAlive(held.pid) && young) return false;
    } catch (e) { /* unreadable lock = stale */ }
    fs.unlinkSync(p);
  }
  fs.writeFileSync(p, JSON.stringify(info), { flag: 'wx' });
  return true;
}

function updateLock(name, info) { fs.writeFileSync(lockPath(name), JSON.stringify(info)); }
function dropLock(name) { try { fs.unlinkSync(lockPath(name)); } catch (e) { /* gone */ } }

function childEnv() {
  const e = process.env;
  const env = { PATH: JOB_PATH, HOME: e.HOME || require('os').homedir() };
  for (const k of ['USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR']) if (e[k]) env[k] = e[k];
  return env;
}

// Runs argv detached with output to files (so it outlives a runner restart).
// Resolves { status, code, signal, error, summary, durationMs }.
function execJob(job, { now = Date.now, killGraceMs = 5000 } = {}) {
  ensureDirs();
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(LOG_DIR, `${job.name}.${stamp}.out`);
  const errPath = path.join(LOG_DIR, `${job.name}.${stamp}.err`);
  const outFd = fs.openSync(outPath, 'w'), errFd = fs.openSync(errPath, 'w');
  const started = now();
  return new Promise(resolve => {
    let child, timedOut = false, timer, done = false;
    const finish = (status, code, signal, error) => {
      if (done) return;                    // 'error' and 'exit' can both fire
      done = true;
      clearTimeout(timer);                 // a pending SIGKILL after a timeout still goes out
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch (e) { /* closed */ }
      const summary = buildSummary(fs.readFileSync(outPath, 'utf8'), fs.readFileSync(errPath, 'utf8'));
      for (const p of [outPath, errPath]) try { fs.unlinkSync(p); } catch (e) { /* gone */ }
      resolve({ status, code, signal, error, summary, durationMs: now() - started });
    };
    try {
      child = spawn(job.argv[0], job.argv.slice(1), {
        detached: true, stdio: ['ignore', outFd, errFd], env: childEnv(), cwd: job.cwd || JOB_CWD,
      });
    } catch (err) { return finish('error', null, null, `command failed to start: ${err.message}`); }
    updateLock(job.name, { pid: child.pid, started, outPath, errPath });
    child.on('error', err => finish('error', null, null, `command failed to start: ${err.message}`));
    const timeoutS = job.timeoutSeconds || DEFAULT_TIMEOUT_S;
    timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* exited */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* exited */ } }, killGraceMs).unref();
    }, timeoutS * 1000);
    child.on('exit', (code, signal) => {
      if (timedOut) return finish('error', code, signal, 'command timed out');
      if (signal) return finish('error', code, signal, `command stopped by signal ${signal}`);
      if (code !== 0) return finish('error', code, signal, `command exited with code ${code}`);
      finish('ok', code, signal, null);
    });
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(st) {
  ensureDirs();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2)); fs.renameSync(tmp, STATE_FILE);
}

function logRun(entry) {
  fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });
  fs.appendFileSync(RUN_LOG, JSON.stringify(entry) + '\n');
}

// What to post for one finished run: { text, channel } or null. Pure, so it is tested.
function deliveryFor(job, result, jobState, nowMs) {
  if (result.status === 'ok') {
    return isSilent(result.summary) ? null : { text: result.summary, channel: job.channel, kind: 'output' };
  }
  const fa = job.failureAlert;
  if (!fa) return null;
  const after = fa.after || 1;
  if ((jobState.consecutiveErrors || 0) < after) return null;
  if (jobState.lastAlertAt && nowMs - jobState.lastAlertAt < (fa.cooldownMs || 0)) return null;
  return { text: `⚠️ Job "${job.name}" failed: ${result.error}`, channel: fa.channel || job.channel, kind: 'alert' };
}

async function runJob(job, { dry = false, postImpl = post, now = Date.now, log = console.log } = {}) {
  ensureDirs();
  const maxAgeMs = ((job.timeoutSeconds || DEFAULT_TIMEOUT_S) + 120) * 1000;
  if (!takeLock(job.name, { pid: process.pid, started: now() }, maxAgeMs, now())) {
    logRun({ ts: new Date(now()).toISOString(), job: job.name, status: 'skipped', error: 'previous run still going' });
    return { status: 'skipped' };
  }
  let result;
  try { result = await execJob(job, { now }); } finally { dropLock(job.name); }
  const js = { ...(loadState()[job.name] || {}) };
  js.consecutiveErrors = result.status === 'ok' ? 0 : (js.consecutiveErrors || 0) + 1;
  const d = deliveryFor(job, result, js, now());
  let delivery = 'none';
  if (d && dry) { log(`[dry] would post to ${d.channel} (${d.kind}):\n${d.text}`); delivery = 'dry'; }
  else if (d) {
    const r = await postImpl(d.channel, d.text);  // never re-runs the job
    delivery = r.ok ? 'delivered' : `not-delivered: ${r.error}`;
    if (d.kind === 'alert' && r.ok) js.lastAlertAt = now();
  } else if (dry) log(`[dry] nothing to post (status ${result.status}${result.error ? ', ' + result.error : ''})`);
  if (!dry) {                     // re-read right before saving: other jobs may have saved meanwhile
    const st = loadState(); st[job.name] = js; saveState(st);
  }
  logRun({ ts: new Date(now()).toISOString(), job: job.name, status: result.status, error: result.error,
           code: result.code, durationMs: result.durationMs, chars: result.summary.length,
           silent: isSilent(result.summary), delivery, dry });
  return { ...result, delivery };
}

// ── jobs file and loop ─────────────────────────────────────────────────────────

function loadJobs(file = JOBS_FILE) {
  const jobs = JSON.parse(fs.readFileSync(file, 'utf8')).jobs;
  const names = new Set();
  for (const j of jobs) {
    if (!j.name || names.has(j.name)) throw new Error(`job name missing or duplicated: ${j.name}`);
    names.add(j.name);
    if (!Array.isArray(j.argv) || !j.argv.length) throw new Error(`${j.name}: argv required`);
    if (!j.channel) throw new Error(`${j.name}: channel required`);
    j._cron = parseCron(j.schedule);              // throws on a bad expression
    j.tz = j.tz || process.env.APOLLO_TZ || 'UTC';
  }
  return jobs;
}

// Jobs due at `date`, each fired at most once per local minute.
function dueJobs(jobs, date, fired) {
  const due = [];
  for (const j of jobs) {
    if (!j.enabled) continue;
    if (!cronMatches(j._cron, date, j.tz)) continue;
    const key = minuteKey(date, j.tz);
    if (fired[j.name] === key) continue;
    fired[j.name] = key; due.push(j);
  }
  return due;
}

function loop() {
  const fired = {};
  const tick = () => {
    let jobs = [];
    try { jobs = loadJobs(); } catch (err) { console.error(`[jobs] jobs.json unreadable: ${err.message}`); }
    const now = new Date();
    for (const j of dueJobs(jobs, now, fired)) {
      console.log(`[jobs] ${now.toISOString()} start ${j.name}`);
      runJob(j).then(r => console.log(`[jobs] ${j.name} ${r.status}${r.error ? ' (' + r.error + ')' : ''} delivery=${r.delivery || '-'}`))
               .catch(err => console.error(`[jobs] ${j.name} runner error: ${err.message}`));
    }
    // Next tick at the start of the next minute (+1 s). A missed minute is never replayed.
    setTimeout(tick, 61000 - (Date.now() % 60000));
  };
  const enabled = (() => { try { return loadJobs().filter(j => j.enabled).length; } catch (e) { return 'ERR'; } })();
  console.log(`[jobs] Apollo jobs runner online, ${enabled} enabled job(s)`);
  setTimeout(tick, 61000 - (Date.now() % 60000));
}

async function main(argv) {
  if (argv.includes('--list')) {
    for (const j of loadJobs()) console.log(`${j.enabled ? 'ON ' : 'off'} ${j.name} | ${j.schedule} ${j.tz} | timeout ${j.timeoutSeconds || DEFAULT_TIMEOUT_S}s`);
    return;
  }
  const i = argv.indexOf('--run-now');
  if (i >= 0) {
    const job = loadJobs().find(j => j.name === argv[i + 1]);
    if (!job) { console.error(`no job named ${argv[i + 1]}`); process.exit(2); }
    const r = await runJob(job, { dry: argv.includes('--dry') });
    console.log(`[jobs] ${job.name}: ${r.status}${r.error ? ' (' + r.error + ')' : ''}, delivery ${r.delivery}`);
    return;
  }
  loop();
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseCron, cronMatches, localFields, minuteKey, buildSummary, isSilent, chunk,
                   channelId, post, deliveryFor, dueJobs, loadJobs, execJob, takeLock, dropLock, lockPath,
                   childEnv, JOB_PATH, JOB_CWD, DEFAULT_TIMEOUT_S, runJob, loadState };
