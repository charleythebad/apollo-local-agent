// approval_gate.test.js — approval gate logic + skill wiring. No network, no Discord:
// the client and channels are fakes, data goes to a throwaway APOLLO_ROOT.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { EventEmitter } = require('events');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
process.env.APOLLO_ROOT = ROOT; process.env.PRINCIPAL_ID = 'P'; process.env.APPROVAL_TTL_MIN = '10';
const G = require('../modules/approval_gate');
let failures = 0;
const check = (name, cond, detail = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail))); if (!cond) failures++; };
const MIN = 60000;

(async () => {
  // ── pure logic ───────────────────────────────────────────────────────────
  let st = G.newState();
  check('empty proposal refused', G.propose(st, { text: '   ', by: 'P', nowMs: 0, ttlMs: MIN }).error === 'empty proposal');
  check('overlong proposal refused', /too long/.test(G.propose(st, { text: 'x'.repeat(301), by: 'P', nowMs: 0, ttlMs: MIN }).error));
  const a = G.propose(st, { text: 'do  the\nthing', by: 'P', nowMs: 0, ttlMs: 10 * MIN });
  check('proposal pending, whitespace collapsed', a.proposal.status === 'pending' && a.proposal.text === 'do the thing');
  check('id is 6 hex chars', G.ID_RE.test(a.proposal.id));
  const id = a.proposal.id;
  let r = G.decide(st, { id, actor: 'X', principal: 'P', decision: 'approve', nowMs: MIN });
  check('non-principal ignored, still pending', !r.ok && r.entry.event === 'ignored' && st.proposals[id].status === 'pending');
  r = G.decide(st, { id: '../../x', actor: 'P', principal: 'P', decision: 'approve', nowMs: MIN });
  check('bad id refused', !r.ok && r.error === 'no such proposal');
  r = G.decide(st, { id, actor: 'P', principal: 'P', decision: 'approve', nowMs: 2 * MIN });
  check('principal approves', r.ok && st.proposals[id].status === 'approved');
  r = G.decide(st, { id, actor: 'P', principal: 'P', decision: 'reject', nowMs: 3 * MIN });
  check('second decision refused', !r.ok && /already approved/.test(r.error));
  check('approved awaits execution', G.awaitingExecution(st).length === 1);
  check('executed once', G.markExecuted(st, id, 4 * MIN, 'done').event === 'executed' && G.markExecuted(st, id, 5 * MIN, 'again') === null);
  const b = G.propose(st, { text: 'late', by: 'P', nowMs: 0, ttlMs: 10 * MIN }).proposal;
  r = G.decide(st, { id: b.id, actor: 'P', principal: 'P', decision: 'approve', nowMs: 10 * MIN });
  check('approval at/after expiry becomes expired, not approved', !r.ok && st.proposals[b.id].status === 'expired');
  const c = G.propose(st, { text: 'sweep me', by: 'P', nowMs: 0, ttlMs: MIN }).proposal;
  check('expireDue catches overdue only', G.expireDue(st, 2 * MIN).map(e => e.id).join() === c.id && G.expireDue(st, 3 * MIN).length === 0);
  check('ids never collide', G.newId({ proposals: { aaaaaa: {} } }, (() => { const q = ['aaaaaa', 'bbbbbb']; return () => q.shift(); })()) === 'bbbbbb');

  // ── skill wiring (fake Discord) ─────────────────────────────────────────
  let t = 0; const now = () => t;
  const posted = [], replies = [];
  const channel = { send: async text => { posted.push(text); return { id: 'm' + posted.length }; } };
  const client = new EventEmitter(); client.channels = { fetch: async () => channel };
  const cmds = {}; const log = { info() {}, warn() {}, error() {} };
  const skill = require('../skl_014_approval_gate_v1.0.js')(cmds, () => {}, log, null, client, { approvals: 'A', boss: 'B' }, { now, noTimers: true });
  const msg = (content, author = 'P') => ({ content, author: { id: author }, reply: async x => replies.push(x) });

  await cmds['!propose'](msg('!propose write the report'));
  const pid = Object.keys(skill.state.proposals)[0];
  check('proposal posted to approvals channel with id', posted.length === 1 && posted[0].includes(pid) && posted[0].includes('Expires in 10 min'), posted);
  const react = (emoji, user) => client.listeners('messageReactionAdd')[0]({ partial: false, emoji: { name: emoji }, message: { id: 'm1', reply: async x => replies.push(x) } }, { id: user, bot: false });
  await react('✅', 'stranger');
  check('stranger ✅ ignored', skill.state.proposals[pid].status === 'pending');
  await react('👍', 'P');
  check('other emoji ignored', skill.state.proposals[pid].status === 'pending');
  t = 5 * MIN; await react('✅', 'P');
  check('principal ✅ approves and executes', skill.state.proposals[pid].status === 'executed');
  const out = path.join(ROOT, 'data/approved', pid + '.txt');
  check('action wrote the file', fs.readFileSync(out, 'utf8') === 'write the report\n');
  const lines = fs.readFileSync(path.join(ROOT, 'data/approvals_ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('ledger tells the whole story', lines.map(l => l.event).join() === 'proposed,ignored,approved,executed', lines.map(l => l.event));

  await cmds['!propose'](msg('!propose second'));
  const p2 = Object.keys(skill.state.proposals).find(k => k !== pid);
  t = 30 * MIN; await skill.sweep();
  check('sweep expires and posts', skill.state.proposals[p2].status === 'expired' && posted.at(-1).includes('Expired') && posted.at(-1).includes(p2));
  await cmds['!approve'](msg('!approve ' + p2));
  check('approve after expiry refused', /already expired/.test(replies.at(-1)), replies.at(-1));

  // crash recovery: approved but not executed survives a restart
  const stFile = path.join(ROOT, 'data/approvals_state.json');
  const saved = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  saved.proposals.cccccc = { id: 'cccccc', text: 'after crash', status: 'approved', expiresAt: 1e15, messageId: null };
  fs.writeFileSync(stFile, JSON.stringify(saved));
  delete require.cache[require.resolve('../skl_014_approval_gate_v1.0.js')];
  const client2 = new EventEmitter(); client2.channels = { fetch: async () => channel };
  const skill2 = require('../skl_014_approval_gate_v1.0.js')({}, () => {}, log, null, client2, { approvals: 'A' }, { now, noTimers: true });
  await skill2.runAwaiting();
  check('restart finishes an approved action', fs.readFileSync(path.join(ROOT, 'data/approved/cccccc.txt'), 'utf8') === 'after crash\n' && skill2.state.proposals.cccccc.status === 'executed');

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASS'}`);
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error('test crashed:', err); process.exit(1); });
