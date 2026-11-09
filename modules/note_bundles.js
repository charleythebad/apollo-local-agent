// modules/note_bundles.js
// Pure helpers for the "note" pipeline (skl_012). No Discord, no agent calls,
// so every check here is unit-tested on its own.
//
// A bundle is a folder in NOTES_DIR holding meta.json ({ "status": "NEW",
// "note": "..." }), an optional note.txt, and optional .jpg/.png photos.
// Pattern: code does everything that has a right answer (find the bundle,
// read the note, check the result, file the draft, flip the status); the
// model only does the one judgment call (light cleanup of the wording).

'use strict';

const fs = require('fs');
const path = require('path');

const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{4}$/;   // bundle folder names, e.g. 2026-09-14_0818

// Newest bundle with status NEW, or the named one. Returns { dir, stamp } or null.
// Only names matching STAMP_RE are accepted, so input can't walk out of NOTES_DIR.
function resolveBundle(notesDir, stamp) {
  if (stamp) {
    if (!STAMP_RE.test(stamp)) return null;
    const dir = path.join(notesDir, stamp);
    return fs.existsSync(path.join(dir, 'meta.json')) ? { dir, stamp } : null;
  }
  let entries;
  try {
    entries = fs.readdirSync(notesDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch (e) {
    return null;
  }
  let best = null;
  for (const e of entries) {
    const dir = path.join(notesDir, e.name);
    const metaPath = path.join(dir, 'meta.json');
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e2) { continue; }
    if (meta.status !== 'NEW') continue;
    const mtime = fs.statSync(metaPath).mtimeMs;
    if (!best || mtime > best.mtime) best = { dir, stamp: e.name, mtime };
  }
  return best ? { dir: best.dir, stamp: best.stamp } : null;
}

// The note is read here and handed to the agent inline. Field incident: when
// the agent was told to open note.txt itself, it once made zero tool calls
// and returned a fully invented report in the correct format. With the note
// in the prompt there is no file read left for the model to skip.
function readNote(bundleDir) {
  try {
    const note = fs.readFileSync(path.join(bundleDir, 'note.txt'), 'utf8').trim();
    if (note) return note;
  } catch (e) { /* fall back to meta.json's copy */ }
  try {
    return String(JSON.parse(fs.readFileSync(path.join(bundleDir, 'meta.json'), 'utf8')).note || '').trim();
  } catch (e) { return ''; }
}

function photosIn(bundleDir) {
  try {
    return fs.readdirSync(bundleDir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort().map(f => path.join(bundleDir, f));
  } catch (e) { return []; }
}

// Format check: the agent must answer "BUNDLE: <path>" or "ERROR: <reason>".
function isStructured(text) {
  return /^(BUNDLE|ERROR):\s*\S/.test(String(text).trim());
}

// "BUNDLE: <path>\n\n<body>" → { bundleDir, body }, or null.
function parseBundleReply(text) {
  const m = String(text).match(/^BUNDLE:\s*(\S+)\s*\n\s*\n([\s\S]*)$/);
  return m ? { bundleDir: m[1], body: m[2] } : null;
}

// Fail-closed content check: the note's words, in order, must appear in the
// body (case and punctuation ignored, since the prompt allows only that kind
// of cleanup). Catches an invented report that a format check can't.
function bodyKeepsNote(body, note) {
  const norm = (t) => ' ' + String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  return norm(note).trim() !== '' && norm(body).includes(norm(note));
}

// Flip status only after the draft command has actually exited 0.
function markDrafted(bundleDir) {
  const metaPath = path.join(bundleDir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.status = 'DRAFTED';
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
}

module.exports = { STAMP_RE, resolveBundle, readNote, photosIn, isStructured, parseBundleReply, bodyKeepsNote, markDrafted };
