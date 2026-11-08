// jobs_runner.test.js — Apollo jobs runner.
// No network, no Discord, no real token: fetch and the token are fakes, and every
// run writes to a throwaway log folder. Run: node tests/jobs_runner.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
process.env.APOLLO_JOBS_LOG_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-')), 'jobs');
const J = require('../modules/jobs_runner.js');

let failures = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : `  -> ${JSON.stringify(detail)}`));
  if (!cond) failures++;
}
const D = 'America/Denver', at = iso => new Date(iso);

(async () => {
  // ── cron parsing ────────────────────────────────────────────────────────
  check('field list and range', [...J.parseCron('5,35 8-13 * * 1-5').sets[1]].join() === '8,9,10,11,12,13');
  check('step', [...J.parseCron('*/20 * * * *').sets[0]].join() === '0,20,40');
  for (const bad of ['61 * * * *', '* * *', '5-1 * * * *', '*/0 * * * *'])
    check(`bad cron rejected: "${bad}"`, (() => { try { J.parseCron(bad); return false; } catch (e) { return true; } })());

  // ── matching in Denver time, both sides of DST ─────────────────────────
  check('nightly 03:35 MST (10:35Z in November)', J.cronMatches('35 3 * * *', at('2026-11-07T10:35:00Z'), D));
  check('nightly not at 09:35Z in November', !J.cronMatches('35 3 * * *', at('2026-11-07T09:35:00Z'), D));
  check('nightly 03:35 MDT (09:35Z in July)', J.cronMatches('35 3 * * *', at('2026-07-01T09:35:00Z'), D));
  check('intraday Mon 08:05', J.cronMatches('5,35 8-13 * * 1-5', at('2026-11-09T15:05:00Z'), D));
  check('intraday Mon 13:35 (last slot)', J.cronMatches('5,35 8-13 * * 1-5', at('2026-11-09T20:35:00Z'), D));
  check('intraday not 14:05', !J.cronMatches('5,35 8-13 * * 1-5', at('2026-11-09T21:05:00Z'), D));
  check('intraday not on Saturday', !J.cronMatches('5,35 8-13 * * 1-5', at('2026-11-07T15:05:00Z'), D));
  check('monthly scorecard Dec 1 07:00', J.cronMatches('0 7 1 * *', at('2026-12-01T14:00:00Z'), D));
  check('monthly scorecard not Dec 2', !J.cronMatches('0 7 1 * *', at('2026-12-02T14:00:00Z'), D));
  check('Sunday 09:00', J.cronMatches('0 9 * * 0', at('2026-11-08T16:00:00Z'), D));
  check('Sunday as 7 too', J.cronMatches('0 9 * * 7', at('2026-11-08T16:00:00Z'), D));
  check('day-of-month OR day-of-week when both set', J.cronMatches('0 9 1 * 0', at('2026-11-08T16:00:00Z'), D)
        && J.cronMatches('0 9 1 * 0', at('2026-12-01T16:00:00Z'), D));

  // ── once per local minute, DST edges ───────────────────────────────────
  const job = { name: 'x', enabled: true, schedule: '30 1 * * *', tz: D, _cron: J.parseCron('30 1 * * *') };
  const fired = {};
  const a = J.dueJobs([job], at('2026-11-01T07:30:00Z'), fired);     // 01:30 MDT
  const b = J.dueJobs([job], at('2026-11-01T07:30:30Z'), fired);     // same minute again
  const c = J.dueJobs([job], at('2026-11-01T08:30:00Z'), fired);     // 01:30 MST, repeated hour
  check('fires once in a minute', a.length === 1 && b.length === 0);
  check('fall-back repeated 01:30 fires once', c.length === 0);
  const spring = { ...job, schedule: '30 2 * * *', _cron: J.parseCron('30 2 * * *') };
  let springHits = 0;
  for (let m = Date.parse('2026-03-08T07:00:00Z'); m < Date.parse('2026-03-08T11:00:00Z'); m += 60000)
    springHits += J.dueJobs([spring], new Date(m), {}).length;
  check('spring-forward 02:30 does not exist -> skipped, never late', springHits === 0, springHits);
  check('disabled job never due', J.dueJobs([{ ...job, enabled: false }], at('2026-11-02T08:30:00Z'), {}).length === 0);

  // ── output rules ────────────────────────────────
  check('stdout only', J.buildSummary('  report\n', '') === 'report');
  check('stdout and stderr', J.buildSummary('a', 'b') === 'stdout:\na\n\nstderr:\nb');
  check('stderr only', J.buildSummary('', 'oops\n') === 'oops');
  check('NO_REPLY with newline is silent', J.isSilent(J.buildSummary('NO_REPLY\n', '')));
  check('empty is silent', J.isSilent(J.buildSummary('', '')));
  check('NO_REPLY plus text is not silent', !J.isSilent('NO_REPLY\nmore'));

  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ` + 'x'.repeat(10)).join('\n');
  const parts = J.chunk(long);
  check('chunks fit Discord and rejoin exactly', parts.every(p => p.length <= 2000) && parts.join('\n') === long,
        parts.map(p => p.length));
  const huge = J.chunk('y'.repeat(4500));
  check('overlong single line hard-split', huge.length === 3 && huge.every(p => p.length <= 2000) && huge.join('') === 'y'.repeat(4500));
  check('channel prefix stripped', J.channelId('channel:123') === '123' && J.channelId('456') === '456');

  // ── what gets posted ───────────────────────────────────────────────────
  const wj = { name: 'w', channel: 'channel:1' };
  const gj = { name: 'g', channel: '2', failureAlert: { after: 1, cooldownMs: 86400000, channel: '2' } };
  check('ok run posts its output', J.deliveryFor(wj, { status: 'ok', summary: 'hi' }, {}, 0).text === 'hi');
  check('ok NO_REPLY posts nothing', J.deliveryFor(wj, { status: 'ok', summary: 'NO_REPLY' }, {}, 0) === null);
  check('failed run without alert posts nothing (as today)',
        J.deliveryFor(wj, { status: 'error', error: 'command exited with code 1', summary: 'x' }, { consecutiveErrors: 1 }, 0) === null);
  const al = J.deliveryFor(gj, { status: 'error', error: 'command timed out' }, { consecutiveErrors: 1 }, 1000);
  check('failed run with alert posts the alert', al && al.kind === 'alert' && al.text.includes('"g" failed: command timed out'), al);
  check('alert cooldown respected', J.deliveryFor(gj, { status: 'error', error: 'e' },
        { consecutiveErrors: 2, lastAlertAt: 1000 }, 1000 + 3600000) === null);
  check('alert "after" respected', J.deliveryFor({ ...gj, failureAlert: { after: 2 } }, { status: 'error', error: 'e' },
        { consecutiveErrors: 1 }, 0) === null);

  // ── posting: retries the post, never the job ───────────────────────────
  const fake = plan => {
    const calls = [];
    const f = async (url, opt) => { calls.push(JSON.parse(opt.body).content); const r = plan.shift();
      if (r === 'dns') throw new Error('getaddrinfo ENOTFOUND discord.com');
      return { ok: r === 200, status: r, json: async () => ({ retry_after: 2 }) }; };
    return { f, calls };
  };
  const slept = [], sleep = async ms => slept.push(ms), token = () => 'FAKE';
  let fk = fake(['dns', 'dns', 200]);
  let r = await J.post('1', 'hello', { fetchImpl: fk.f, sleep, token });
  check('DNS down twice then delivered', r.ok && r.retried === 2 && fk.calls.length === 3, r);
  check('backoff 30s then 60s', slept.join() === '30000,60000', slept);
  slept.length = 0; fk = fake([429, 200]);
  r = await J.post('1', 'hello', { fetchImpl: fk.f, sleep, token });
  check('429 waits retry_after', r.ok && slept[0] === 2000, slept);
  fk = fake(['dns', 'dns', 'dns']);
  r = await J.post('1', 'hello', { fetchImpl: fk.f, sleep, token, retries: [1, 1] });
  check('gives up after the retry list', !r.ok && fk.calls.length === 3, r);
  fk = fake([200, 'dns', 200, 200]);
  r = await J.post('1', long, { fetchImpl: fk.f, sleep, token });
  check('multi-part post resumes at the failed part, no duplicates',
        r.ok && fk.calls.length === parts.length + 1 && fk.calls[1] === fk.calls[2] && new Set(fk.calls).size === parts.length, fk.calls.length);

  // ── running commands ───────────────────────────────────────────────────
  const res1 = await J.execJob({ name: 't-ok', argv: ['sh', '-c', 'echo report; echo warn >&2'] });
  check('command output captured, stderr kept', res1.status === 'ok' && res1.summary === 'stdout:\nreport\n\nstderr:\nwarn', res1);
  const res2 = await J.execJob({ name: 't-exit', argv: ['sh', '-c', 'echo partial; exit 3'] });
  check('nonzero exit is an error', res2.status === 'error' && res2.code === 3 && res2.error === 'command exited with code 3', res2);
  const t0 = Date.now();
  const res3 = await J.execJob({ name: 't-slow', timeoutSeconds: 1, argv: ['sh', '-c', 'sleep 30 & wait'] }, { killGraceMs: 500 });
  check('timeout kills the whole process group', res3.status === 'error' && res3.error === 'command timed out'
        && Date.now() - t0 < 5000, { ...res3, ms: Date.now() - t0 });
  const res4 = await J.execJob({ name: 't-missing', argv: ['/no/such/binary'] });
  check('missing binary is an error, not a crash', res4.status === 'error' && /failed to start/.test(res4.error), res4);

  process.env.FAKE_SECRET_TOKEN = 'fake';
  const env = J.childEnv();
  check('jobs get the fixed PATH and no secrets', env.PATH === J.JOB_PATH && !('FAKE_SECRET_TOKEN' in env)
        && Object.keys(env).every(k => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR'].includes(k)), Object.keys(env));
  const res5 = await J.execJob({ name: 't-env', argv: ['sh', '-c', 'echo ${FAKE_SECRET_TOKEN:-absent}'] });
  check('secret really absent inside the job', res5.summary === 'absent', res5.summary);

  // ── one run at a time ──────────────────────────────────────────────────
  fs.mkdirSync(process.env.APOLLO_JOBS_LOG_DIR, { recursive: true });
  check('first lock taken', J.takeLock('lk', { pid: process.pid }));
  check('second lock refused while holder alive', !J.takeLock('lk', { pid: process.pid }));
  J.dropLock('lk');
  fs.writeFileSync(J.lockPath('lk'), JSON.stringify({ pid: 999999 }));
  check('stale lock (dead pid) is cleared', J.takeLock('lk', { pid: process.pid }));
  J.dropLock('lk');

  // ── review fixes (2026-11-07) ──────────────────────────────────────────
  fs.writeFileSync(J.lockPath('old'), JSON.stringify({ pid: process.pid, started: 1000 }));
  check('old lock with a live (reused) pid is stale by age', J.takeLock('old', { pid: process.pid }, 60000, 1000 + 120000));
  J.dropLock('old');
  fs.writeFileSync(J.lockPath('young'), JSON.stringify({ pid: process.pid, started: 1000 }));
  check('young lock with a live pid still blocks', !J.takeLock('young', { pid: process.pid }, 60000, 1000 + 30000));
  J.dropLock('young');

  const res6 = await J.execJob({ name: 't-stubborn', timeoutSeconds: 1,
    argv: ['sh', '-c', '(trap "" TERM; exec sleep 37) & sleep 36'] }, { killGraceMs: 300 });
  await new Promise(r => setTimeout(r, 800));
  const { execSync } = require('child_process');
  const left = execSync("pgrep -f 'sleep 3[67]' || true").toString().trim();
  check('grandchild ignoring SIGTERM still gets SIGKILL', res6.error === 'command timed out' && left === '', left);

  const res7 = await J.execJob({ name: 't-cwd', argv: ['sh', '-lc', 'pwd'] });
  check('jobs start in the repo root', res7.summary === J.JOB_CWD, res7.summary);

  const failing = { name: 't-state', channel: '1', argv: ['sh', '-c', 'exit 1'] };
  await J.runJob(failing, { dry: true, log: () => {} });
  check('dry run leaves state alone', !('t-state' in J.loadState()));
  const slowPost = ms => async () => { await new Promise(r => setTimeout(r, ms)); return { ok: true }; };
  const ja = { name: 't-a', channel: '1', argv: ['sh', '-c', 'exit 1'], failureAlert: { after: 1 } };
  const jb = { name: 't-b', channel: '1', argv: ['sh', '-c', 'exit 1'], failureAlert: { after: 1 } };
  await Promise.all([J.runJob(ja, { postImpl: slowPost(300) }), J.runJob(jb, { postImpl: slowPost(10) })]);
  const st = J.loadState();
  check('two jobs saving at once keep both updates', st['t-a'] && st['t-b']
        && st['t-a'].consecutiveErrors === 1 && st['t-b'].consecutiveErrors === 1, st);

  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASS'}`);
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error('test crashed:', err); process.exit(1); });
