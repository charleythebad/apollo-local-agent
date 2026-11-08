// skills.js — Apollo V7.0
// Skill runtime and usage tracking. The skill builder, skill economy and
// retirement commands were retired in V7.0 — Claude builds and retires skills
// (Constitution Art. VIII, XIX).
// Depends: logger.js
//
// Fix V4.2:
//   - path moved to top-level import (was re-required on every saveJSON/logEvent call)
//   - logEvent() catch block now logs error instead of swallowing silently
//   - ollama and prompts moved to top-level requires (consistent with module pattern)
//   - registeredIntervals kept for skill API contract but noted as reserved

'use strict';

const fs           = require('fs');
const path         = require('path');
const { log }      = require('./logger');

let _paths;

function init(paths) {
  _paths = paths;
}

// ─────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────

function loadJSON(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log.warn('loadJSON failed', { filePath, error: err.message });
  }
  return fallback;
}

function saveJSON(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error('saveJSON failed', { filePath, error: err.message });
    throw err;
  }
}

function logEvent(entry) {
  try {
    fs.mkdirSync(path.dirname(_paths.events), { recursive: true });
    const events = loadJSON(_paths.events, { events: [] });
    events.events.push({ timestamp: new Date().toISOString(), entry });
    saveJSON(_paths.events, events);
    log.info('Event logged', { entry });
  } catch (err) {
    // Fix: was silently swallowing errors — now surfaces to structured log
    log.error('logEvent failed', { entry, error: err.message });
  }
}

// ─────────────────────────────────────────
// SKILL RUNTIME
// ─────────────────────────────────────────

const registeredCommands  = {};
const registeredIntervals = []; // Reserved for future interval-based skills


function touchSkill(name) {
  try {
    const lc = loadJSON(_paths.lifecycle, {});
    if (lc[name]) {
      lc[name].lastUsed = new Date().toISOString();
      saveJSON(_paths.lifecycle, lc);
      log.debug('Skill touched', { name });
    }
  } catch (err) {
    log.warn('touchSkill failed', { name, error: err.message });
  }
}

// ─────────────────────────────────────────
// USAGE TRACKING
// ─────────────────────────────────────────

function getActiveSkillCount() {
  return Object.values(loadJSON(_paths.lifecycle, {})).filter(s => !s.retired).length;
}

// Seed missing usage entries from the manifest registry at startup, so every
// registered skill is visible to touchSkill and the active count — additive to
// logs/ only, the manifest is never written (Constitution Art. XIII). Seeded
// lastUsed = now; real touch data takes over from there. Retired entries are
// left untouched.
function reconcileLifecycle(registry) {
  const lc = loadJSON(_paths.lifecycle, {});
  const entries = [...(registry.foundation || []), ...(registry.active || [])];
  const seeded  = entries.filter(s => !lc[s.name]);
  if (!seeded.length) return;
  const now = new Date().toISOString();
  seeded.forEach(s => {
    lc[s.name] = {
      lastUsed:     now,
      acceptedDate: s.deployed_date || s.injected_date || now,
      retired:      false,
      seeded:       true
    };
  });
  saveJSON(_paths.lifecycle, lc);
  logEvent('LIFECYCLE_RECONCILED | seeded: ' + seeded.map(s => s.name).join(', '));
  log.info('Lifecycle reconciled from registry', { seeded: seeded.map(s => s.name) });
}

module.exports = {
  init,
  touchSkill,
  getActiveSkillCount,
  reconcileLifecycle,
  loadJSON,
  saveJSON,
  logEvent,
  registeredCommands,
  registeredIntervals
};
