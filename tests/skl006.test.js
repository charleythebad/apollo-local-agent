// skl006.test.js — skl_006 v1.4: save/rollback carries skill files (Article XVII); labels validated, duplicates refused.
// Runs in a throwaway copy of the repo; git and pm2 are stubbed, nothing live is touched.
'use strict';
const cp = require('child_process'); let restarts = 0;
cp.exec = () => { restarts++; };
cp.execFile = (c, a, cb) => cb && cb(null);
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'skl006-'));
for (const e of ['bot.js', 'version_index.json', 'governance'])
  fs.cpSync(path.join(REPO, e), path.join(ROOT, e), { recursive: true });
fs.readdirSync(REPO).filter(f => /^skl_.*\.js$/.test(f)).forEach(f => fs.copyFileSync(path.join(REPO, f), path.join(ROOT, f)));
fs.mkdirSync(path.join(ROOT, 'versions'));
process.env.APOLLO_ROOT = ROOT;

const cmds = {}, sent = [], log = { info() {}, warn() {}, error() {} };
require(path.join(REPO, 'skl_006_version_control_v1.4.js'))(cmds, () => {}, log, null, null, {});
const ch = { send: async m => sent.push(m) }, msg = c => ({ content: c, channel: ch });
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, JSON.parse(fs.readFileSync(path.join(ROOT, 'version_index.json'))).active.manifest)));
const nSkills = manifest.skill_registry.active.length;
let fail = 0; const ok = (c, n) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

(async () => {
  await cmds['!version save'](msg('!version save T1'));
  ok(fs.readdirSync(path.join(ROOT, 'versions/T1/skills')).length === nSkills, 'save captures every registered skill');
  ok(sent.at(-1).includes('6 documents + ' + nSkills + ' skills archived'), 'save reply counts skills');
  ok(fs.existsSync(path.join(ROOT, 'versions/T1/bot.js')), 'save still captures documents');

  const f = path.join(ROOT, manifest.skill_registry.active[0].filename), orig = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '// tampered\n');
  await cmds['!version rollback'](msg('!version rollback T1'));
  await cmds['!confirm rollback'](msg('!confirm rollback'));
  ok(fs.readFileSync(f, 'utf8') === orig, 'rollback restores skill file');

  fs.mkdirSync(path.join(ROOT, 'versions/OLD'));
  fs.copyFileSync(path.join(ROOT, 'bot.js'), path.join(ROOT, 'versions/OLD/bot.js'));
  const vi = JSON.parse(fs.readFileSync(path.join(ROOT, 'version_index.json')));
  vi.history.unshift({ version: 'OLD' }); fs.writeFileSync(path.join(ROOT, 'version_index.json'), JSON.stringify(vi));
  fs.writeFileSync(f, '// newer\n');
  await cmds['!version rollback'](msg('!version rollback OLD'));
  await cmds['!confirm rollback'](msg('!confirm rollback'));
  ok(fs.readFileSync(f, 'utf8') === '// newer\n', 'pre-v1.3 snapshot rolls back, skills untouched');

  await cmds['!version save'](msg('!version save'));
  ok(/Usage/.test(sent.at(-1)), 'save without label replies usage');

  const before = fs.readdirSync(path.dirname(ROOT)).length, nHist = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'version_index.json'))).history.length;
  const h0 = nHist();
  for (const bad of ['../escape', '..', '.hidden', 'a/b', 'x'.repeat(65)]) {
    await cmds['!version save'](msg('!version save ' + bad));
    ok(/Invalid label/.test(sent.at(-1)), 'save rejects label ' + JSON.stringify(bad.slice(0, 12)));
  }
  ok(fs.readdirSync(path.dirname(ROOT)).length === before && !fs.existsSync(path.join(ROOT, 'escape')), 'rejected labels write nothing outside versions/');
  ok(nHist() === h0, 'rejected labels add no history');
  await cmds['!version rollback'](msg('!version rollback ../T1'));
  ok(/Invalid label/.test(sent.at(-1)), 'rollback rejects ../ label');

  const t1 = fs.statSync(path.join(ROOT, 'versions/T1/bot.js')).mtimeMs;
  await cmds['!version save'](msg('!version save T1'));
  ok(/already exists/.test(sent.at(-1)), 'save refuses duplicate label');
  ok(fs.statSync(path.join(ROOT, 'versions/T1/bot.js')).mtimeMs === t1 && nHist() === h0, 'duplicate leaves snapshot and history untouched');
  await cmds['!version save'](msg('!version save V7.0-test_ok.2'));
  ok(sent.at(-1).includes('✓ Version **V7.0-test_ok.2** saved'), 'normal label with . _ - still saves');
  await new Promise(r => setTimeout(r, 2200));
  ok(restarts === 2, 'pm2 restart stubbed');
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
})();
