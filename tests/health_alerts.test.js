// health_alerts.test.js — down/back service alerts.
// No network, no Discord: fetch and the channel are fakes,
// logs go to a throwaway APOLLO_ROOT. Run: node tests/health_alerts.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
process.env.APOLLO_ROOT = ROOT;
process.env.LOG_LEVEL = 'error';
process.env.OLLAMA_URL = 'http://fake/ollama';
process.env.WEBUI_URL = 'http://fake/webui';
process.env.MEMORY_URL = 'http://fake/chroma';
process.env.AGENT_GATEWAY_URL = 'http://fake/gateway';
process.env.BACKUP_DEST = ROOT;
process.env.APOLLO_TZ = 'America/Denver';   // fixed zone so DST cases are deterministic

const A = require('../modules/health_alerts.js');
let failures = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : `  -> ${JSON.stringify(detail)}`));
  if (!cond) failures++;
}
const T0 = Date.parse('2026-11-06T23:52:00Z'), MIN = 60000;   // 16:52 Denver

(async () => {
  // ── state machine ───────────────────────────────────────────────────────
  let st = A.newState();
  A.step(st, [{ name: 'ChromaDB', ok: false }], T0);
  check('one failed check: no post (could be a blip)', st.queue.length === 0);
  A.step(st, [{ name: 'ChromaDB', ok: true }], T0 + 5 * MIN);
  check('blip then ok: still no post', st.queue.length === 0);

  st = A.newState();
  A.step(st, [{ name: 'ChromaDB', ok: false }], T0);
  A.step(st, [{ name: 'ChromaDB', ok: false }], T0 + 5 * MIN);
  check('two failed checks: one down post, time = first failure',
        st.queue.length === 1 && st.queue[0] === '[Apollo] ❌ ChromaDB down (2 checks, since 16:52)', st.queue);
  for (let i = 2; i < 170; i++) A.step(st, [{ name: 'ChromaDB', ok: false }], T0 + i * 5 * MIN);
  check('still down for hours: never repeated', st.queue.length === 1, st.queue.length);
  A.step(st, [{ name: 'ChromaDB', ok: true }], T0 + (14 * 60 + 3) * MIN);
  check('recovers: one back post with how long', st.queue[1] === '[Apollo] ✅ ChromaDB back (down 14h 3m)', st.queue);
  A.step(st, [{ name: 'ChromaDB', ok: true }], T0 + (14 * 60 + 8) * MIN);
  check('stays up: nothing more', st.queue.length === 2);

  st = A.newState();
  A.step(st, [{ name: 'Open WebUI', ok: false }, { name: 'ChromaDB', ok: true }], T0);
  A.step(st, [{ name: 'Open WebUI', ok: false }, { name: 'ChromaDB', ok: false }], T0 + 5 * MIN);
  A.step(st, [{ name: 'Open WebUI', ok: false }, { name: 'ChromaDB', ok: false }], T0 + 10 * MIN);
  check('services tracked separately', st.queue.length === 2 && st.queue[0].includes('Open WebUI down')
        && st.queue[1].includes('ChromaDB down (2 checks, since 16:57)'), st.queue);
  check('short outage reads in minutes', A.duration(12 * MIN) === '12m' && A.duration(65 * MIN) === '1h 5m');
  check('summer time shown in MDT', A.hhmm(Date.parse('2026-07-01T22:52:00Z'), 'America/Denver') === '16:52');

  // ── flush: Discord down keeps the queue, never drops or repeats ─────────
  st = A.newState(); st.queue.push('down msg', 'back msg');
  const sent = [];
  let r = await A.flush(st, async () => { throw new Error('getaddrinfo ENOTFOUND discord.com'); });
  check('Discord down: nothing lost', !r.sent && st.queue.length === 2, r);
  let calls = 0;
  r = await A.flush(st, async t => { if (++calls === 2) throw new Error('blip'); sent.push(t); });
  check('partial send keeps the rest in order', st.queue.length === 1 && st.queue[0] === 'back msg' && sent.join() === 'down msg');
  r = await A.flush(st, async t => { sent.push(t); });
  check('next loop sends the rest, no repeats', r.sent && st.queue.length === 0 && sent.join() === 'down msg,back msg', sent);

  // ── wiring in health.js (fake fetch + fake Discord) ─────────────────────
  const up = new Set(['http://fake/ollama', 'http://fake/webui', 'http://fake/chroma', 'http://fake/gateway']);
  const fetched = [];
  global.fetch = async url => { fetched.push(String(url)); if (!up.has(String(url))) throw new Error('ECONNREFUSED'); return { ok: true, json: async () => ({}) }; };
  const health = require('../health.js');
  const posts = { health: [], logs: [] };
  health.init({ system_name: 'Apollo' }, { health: 'H', logs: 'L', boss: 'B' }, ROOT);
  let discordUp = true;
  const client = { isReady: () => true, channels: { fetch: async id => ({ send: async t => {
    if (!discordUp) throw new Error('ENOTFOUND'); (id === 'H' ? posts.health : posts.logs).push(t); } }) } };

  const hc = await health.healthCheck();
  check('!health output unchanged: same four lines, same names',
        hc.split('\n').slice(0, 4).join('|') === '✅ Ollama|✅ Open WebUI|✅ Memory|✅ Agent gateway', hc);
  fetched.length = 0;
  await health.selfRecovery(client);
  check('loop checks the three watched services, not Ollama twice',
        ['webui', 'chroma', 'gateway'].every(x => fetched.includes('http://fake/' + x)), fetched);
  check('all up: no post', posts.health.length === 0);

  up.delete('http://fake/chroma');
  await health.selfRecovery(client);
  check('ChromaDB fails once: no post', posts.health.length === 0);
  discordUp = false;
  await health.selfRecovery(client);
  check('fails twice while Discord is down: queued, not lost', posts.health.length === 0);
  discordUp = true;
  await health.selfRecovery(client);
  check('Discord back: exactly one down post in #apollo-health',
        posts.health.length === 1 && /^\[Apollo\] ❌ ChromaDB down \(2 checks, since \d\d:\d\d\)$/.test(posts.health[0]), posts.health);
  await health.selfRecovery(client);
  check('still down: no repeat', posts.health.length === 1);
  up.add('http://fake/chroma');
  await health.selfRecovery(client);
  check('back: one back post', posts.health.length === 2 && /^\[Apollo\] ✅ ChromaDB back \(down \d+m\)$/.test(posts.health[1]), posts.health);
  check('nothing went to #logs (Ollama healthy)', posts.logs.length === 0, posts.logs);

  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASS'}`);
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error('test crashed:', err); process.exit(1); });
