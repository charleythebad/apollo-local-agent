// skl_006_version_control_v1.4.js - Apollo V7.0 | Branch: Spells
// Commands: !version save <label>, !version list, !version rollback <label>, !confirm rollback
// Reads active paths from version_index.json + manifest registry — no hardcoded versions.
// v1.1 schema in snapshot set; v1.2 saves git-commit themselves (execFile, label never hits a shell).
// v1.3: snapshots also carry active skill files in skills/
// (Article XVII); rollback restores whatever the snapshot holds, so older archives restore unchanged.
// v1.4: labels must match LABEL_RE (letters, digits, . _ -,
// no leading dot, max 64) so a label can never point outside versions/ ("../x"); save refuses
// a label that already exists instead of silently overwriting that snapshot.

'use strict';

const fs            = require('fs');
const path          = require('path');
const { exec, execFile } = require('child_process');

const ROOT    = process.env.APOLLO_ROOT || __dirname;
const VI_PATH = path.join(ROOT, 'version_index.json');
const VER_DIR = path.join(ROOT, 'versions');
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BAD_LABEL = '[Apollo] Invalid label — use letters, numbers, . _ - (max 64, no leading dot).';

module.exports = function registerSkl006(registeredCommands, touchSkill, log, memory, client, CHANNELS) {

  const loadIndex = () => JSON.parse(fs.readFileSync(VI_PATH, 'utf8'));
  const saveIndex = (idx) => fs.writeFileSync(VI_PATH, JSON.stringify(idx, null, 2));

  function activeDocs(idx) {
    const a = idx.active;
    return [
      { key: 'bot.js',            src: path.join(ROOT, 'bot.js') },
      { key: 'manifest.json',     src: path.join(ROOT, a.manifest) },
      { key: 'schema.json',       src: a.schema ? path.join(ROOT, a.schema) : null },
      { key: 'constitution.md',   src: a.constitution ? path.join(ROOT, a.constitution) : null },
      { key: 'roles.md',          src: a.roles ? path.join(ROOT, a.roles) : null },
      { key: 'version_index.json',src: VI_PATH }
    ].filter(d => d.src && fs.existsSync(d.src));
  }

  function activeSkills(idx) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, idx.active.manifest), 'utf8'));
    return ((m.skill_registry || {}).active || []).map(s => s.filename)
      .filter(f => f && path.basename(f) === f && fs.existsSync(path.join(ROOT, f)));
  }
  async function saveVersion(label, channel) {
    if (!label) { await channel.send('[Apollo] Usage: !version save <label>'); return; }
    if (!LABEL_RE.test(label)) { await channel.send(BAD_LABEL); return; }
    const idx = loadIndex();
    const dir = path.join(VER_DIR, label);
    if (fs.existsSync(dir) || (idx.history || []).some(v => v.version === label)) {
      await channel.send('[Apollo] Version `' + label + '` already exists — pick another label.'); return;
    }
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    const docs = activeDocs(idx);
    docs.forEach(d => fs.copyFileSync(d.src, path.join(dir, d.key)));
    const skills = activeSkills(idx);
    skills.forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(dir, 'skills', f)));
    idx.history = idx.history || [];
    idx.history.unshift({ version: label, archived_date: new Date().toISOString().slice(0,10), notes: 'Saved via !version save' });
    saveIndex(idx);
    log.info('SKL-006 version saved', { label, docs: docs.length, skills: skills.length });
    execFile('git', ['-C', ROOT, 'add', path.join('versions', label), 'version_index.json'], (aErr) => {
      if (aErr) { log.warn('SKL-006 git add failed — snapshot saved but uncommitted', { label, error: aErr.message }); return; }
      execFile('git', ['-C', ROOT, 'commit', '-m', 'snapshot: ' + label + ' (via !version save)'], (cErr) => {
        if (cErr) log.warn('SKL-006 git commit failed — snapshot saved but uncommitted', { label, error: cErr.message });
        else log.info('SKL-006 snapshot committed to git', { label });
      });
    });
    touchSkill('skl_006_version_control');
    await channel.send('[Apollo] ✓ Version **' + label + '** saved — ' + docs.length + ' documents + ' + skills.length + ' skills archived.');
  }

  async function listVersions(channel) {
    const idx  = loadIndex();
    const hist = (idx.history || []).slice(0, 10);
    const lines = hist.length
      ? hist.map(v => '`' + v.version + '` ' + v.archived_date + ' — ' + v.notes).join('\n')
      : 'none';
    touchSkill('skl_006_version_control');
    await channel.send('[Apollo] Active: **' + idx.active.version + '**\n' + lines);
  }

  let pendingRollback = null;

  async function rollback(label, channel) {
    if (!label) { await channel.send('[Apollo] Usage: !version rollback <label>'); return; }
    if (!LABEL_RE.test(label)) { await channel.send(BAD_LABEL); return; }
    const idx = loadIndex();
    const match = (idx.history || []).find(v => v.version === label);
    if (!match) { await channel.send('[Apollo] Version `' + label + '` not found.'); return; }
    const dir = path.join(VER_DIR, label);
    if (!fs.existsSync(dir)) { await channel.send('[Apollo] Archive folder for `' + label + '` missing.'); return; }
    pendingRollback = label;
    touchSkill('skl_006_version_control');
    await channel.send('[Apollo] Rollback to **' + label + '** staged. Type `!confirm rollback` to proceed.');
  }

  async function confirmRollback(channel) {
    if (!pendingRollback) { await channel.send('[Apollo] No pending rollback.'); return; }
    const label = pendingRollback;
    const dir   = path.join(VER_DIR, label);
    const idx   = loadIndex();
    const docs  = activeDocs(idx);
    docs.forEach(d => {
      const archived = path.join(dir, d.key);
      if (fs.existsSync(archived)) fs.copyFileSync(archived, d.src);
    });
    const skillDir = path.join(dir, 'skills');
    if (fs.existsSync(skillDir)) fs.readdirSync(skillDir).filter(f => /^skl_.*\.js$/.test(f))
      .forEach(f => fs.copyFileSync(path.join(skillDir, f), path.join(ROOT, f)));
    const fresh = loadIndex();
    fresh.active.version = label;
    fresh.rollback_log   = fresh.rollback_log || [];
    fresh.rollback_log.push({ to: label, date: new Date().toISOString().slice(0,10) });
    saveIndex(fresh);
    log.info('SKL-006 rollback complete', { label });
    touchSkill('skl_006_version_control');
    pendingRollback = null;
    await channel.send('[Apollo] ✓ Rolled back to **' + label + '**. Restarting...');
    setTimeout(() => exec('pm2 restart apollo'), 2000);
  }

  registeredCommands['!version save']     = (msg) => saveVersion(msg.content.split(' ')[2], msg.channel);
  registeredCommands['!version list']     = (msg) => listVersions(msg.channel);
  registeredCommands['!version rollback'] = (msg) => rollback(msg.content.split(' ')[2], msg.channel);
  registeredCommands['!confirm rollback'] = (msg) => confirmRollback(msg.channel);
};
