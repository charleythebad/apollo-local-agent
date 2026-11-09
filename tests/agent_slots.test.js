// tests/agent_slots.test.js — relay fences + note pipeline, end to end,
// against a fake agent CLI and a fake draft command (no OpenClaw needed).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, failed = 0;
function check(name, cond) { if (cond) { pass++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-slots-'));
const clawDir = path.join(tmp, 'claw'); fs.mkdirSync(clawDir);
const notesDir = path.join(tmp, 'notes'); fs.mkdirSync(notesDir);
const envDump = path.join(tmp, 'child-env.json');
const draftLog = path.join(tmp, 'draft.json');

// Fake agent CLI: records its env, then answers per FAKE_MODE.
fs.writeFileSync(path.join(clawDir, 'openclaw.mjs'), `
import fs from 'fs';
const a = process.argv.slice(2);
const msg = a[a.indexOf('--message') + 1];
fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));
const mode = fs.readFileSync(${JSON.stringify(path.join(tmp, 'mode'))}, 'utf8').trim();
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'crash') { process.stderr.write('boom'); process.exit(3); }
else {
  const dir = (msg.match(/"BUNDLE: ([^"]+)"/) || [])[1];
  const note = (msg.match(/<<<NOTE\\n([\\s\\S]*?)\\nNOTE>>>/) || [])[1];
  let text = 'echo: ' + msg.slice(0, 40);
  if (mode === 'faithful') text = 'BUNDLE: ' + dir + '\\n\\n' + note.charAt(0).toUpperCase() + note.slice(1) + '.';
  if (mode === 'invent')   text = 'BUNDLE: ' + dir + '\\n\\nA lovely hike with great views.';
  if (mode === 'chatty')   text = 'Sure! Want me to do anything else?';
  const wrap = mode === 'flat' ? { payloads: [{ text }] } : { result: { payloads: [{ text }] } };
  process.stdout.write(JSON.stringify(wrap));
}
`);
const setMode = m => fs.writeFileSync(path.join(tmp, 'mode'), m);

// Fake draft command: records its args and stdin. Never sends anything.
const draftCmd = path.join(tmp, 'draft.sh');
fs.writeFileSync(draftCmd, `#!/bin/sh\nbody=$(cat)\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({args: process.argv.slice(2), body: process.argv[2]}))' ${JSON.stringify(draftLog)} "$body" "$@"\n`);
fs.chmodSync(draftCmd, 0o755);

Object.assign(process.env, {
  OPENCLAW_PATH: clawDir, OPENCLAW_NODE: process.execPath, AGENT_TIMEOUT_MS: '1500',
  PRINCIPAL_ID: 'p1', PRINCIPAL_EMAIL: 'me@example.com', NOTES_DIR: notesDir, DRAFT_CMD: draftCmd,
  DISCORD_TOKEN: 'fake', SOME_API_KEY: 'fake'
});

const relay = require('../modules/openclaw_relay');
const notes = require('../modules/note_bundles');

// Discord stand-ins
const sent = { chat: [], email: [] }, replies = [];
const client = { channels: { cache: new Map([['c1', { send: async t => sent.chat.push(t) }], ['c2', { send: async t => sent.email.push(t) }]]) } };
const CHANNELS = { agentChat: 'c1', agentEmail: 'c2' };
const log = { info() {}, warn() {}, error() {} };
const msg = (content, author = 'p1') => ({ content, author: { id: author }, reply: async t => replies.push(t) });
const last = () => replies[replies.length - 1];

function bundle(stamp, note, status = 'NEW') {
  const d = path.join(notesDir, stamp); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ status, note }));
  fs.writeFileSync(path.join(d, 'a.jpg'), 'x');
  return d;
}

(async () => {
  // ── pure helpers ──
  const env = relay.clawEnv({ HOME: '/h', PATH: '/p', TMPDIR: '/t', DISCORD_TOKEN: 'x', OPENCLAW_PATH: '/c' });
  check('clawEnv drops DISCORD_TOKEN', !('DISCORD_TOKEN' in env));
  check('clawEnv keeps OPENCLAW_*', env.OPENCLAW_PATH === '/c');
  check('parseAgentReply: gateway shape', relay.parseAgentReply('{"result":{"payloads":[{"text":"hi"}]}}') === 'hi');
  check('parseAgentReply: flat shape', relay.parseAgentReply('{"payloads":[{"text":"hi"}]}') === 'hi');
  check('bodyKeepsNote: cleanup ok', notes.bodyKeepsNote('Looks like a new road.', 'looks like a new road'));
  check('bodyKeepsNote: invented fails', !notes.bodyKeepsNote('A lovely hike.', 'looks like a new road'));
  check('bodyKeepsNote: empty note fails', !notes.bodyKeepsNote('anything', ''));
  check('resolveBundle rejects path walk', notes.resolveBundle(notesDir, '../..') === null);

  // ── callAgent through a real subprocess ──
  setMode('flat');
  const r = await relay.callAgent('main', 'hello');
  check('callAgent returns text', r.text.startsWith('echo: hello'));
  const childEnv = JSON.parse(fs.readFileSync(envDump, 'utf8'));
  check('child never sees DISCORD_TOKEN', !('DISCORD_TOKEN' in childEnv));
  check('child never sees other secrets', !('SOME_API_KEY' in childEnv) && !('PRINCIPAL_EMAIL' in childEnv));
  setMode('crash');
  check('callAgent surfaces exit code', await relay.callAgent('main', 'x').then(() => false, e => /^exit 3/.test(e.message)));
  setMode('hang');
  check('callAgent times out', await relay.callAgent('main', 'x').then(() => false, e => e.message === 'timeout'));

  // ── !oc slot ──
  const cmds = {};
  require('../skl_010_openclaw_v1.0')(cmds, () => {}, log, null, client, CHANNELS);
  require('../skl_012_pipeline_v1.0')(cmds, () => {}, log, null, client, CHANNELS);
  await cmds['!oc'](msg('!oc hi', 'stranger'));
  check('!oc is principal-locked', /principal-locked/.test(last()));
  setMode('ok');
  await cmds['!oc'](msg('!oc say hi'));
  check('!oc relays the reply to the agent channel', sent.chat.some(t => t.startsWith('[Agent→Apollo]')));

  // ── !pipe note, end to end ──
  await cmds['!pipe'](msg('!pipe note', 'stranger'));
  check('!pipe is principal-locked', /principal-locked/.test(last()));
  await cmds['!pipe'](msg('!pipe note'));
  check('no NEW bundle → nothing runs', /No matching note bundle/.test(last()));

  const b1 = bundle('2026-09-14_0818', 'looks like a new road');
  setMode('invent');
  await cmds['!pipe'](msg('!pipe note'));
  check('invented body is refused', /likely invented/.test(last()) && !fs.existsSync(draftLog));
  check('refused bundle stays NEW', JSON.parse(fs.readFileSync(path.join(b1, 'meta.json'))).status === 'NEW');

  setMode('chatty');
  await cmds['!pipe'](msg('!pipe note'));
  check('chat reply after retries is refused', /wrong format/.test(last()) && !fs.existsSync(draftLog));

  setMode('faithful');
  await cmds['!pipe'](msg('!pipe note please'));
  const d = fs.existsSync(draftLog) && JSON.parse(fs.readFileSync(draftLog, 'utf8'));
  check('faithful body is staged by code', d && d.body === 'Looks like a new road.');
  check('draft goes only to the principal', d && d.args[d.args.indexOf('--to') + 1] === 'me@example.com');
  check('photos attached', d && d.args.includes('--attach'));
  check('status flips to DRAFTED after staging', JSON.parse(fs.readFileSync(path.join(b1, 'meta.json'))).status === 'DRAFTED');
  check('success reply', /complete\. Draft staged/.test(last()));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
