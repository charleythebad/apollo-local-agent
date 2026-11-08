// logger.js — Apollo V4.2
// Structured logger. No dependencies outside Node core.
// JSON lines → logs/apollo_YYYY-MM-DD.log
// Rotation window from manifest.log_rotation.window_days
// LOG_LEVEL env var controls minimum level (default: info)
//
// Fix V4.2: APOLLO_ROOT undefined guard on startup

'use strict';

const fs   = require('fs');
const path = require('path');

// Guard: fail fast if APOLLO_ROOT is not set
if (!process.env.APOLLO_ROOT) {
  console.error('[APOLLO][LOGGER] FATAL: APOLLO_ROOT is not set. Check .env');
  process.exit(1);
}

const LOG_LEVELS  = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_MIN     = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const LOG_DIR     = process.env.APOLLO_ROOT + '/logs';
const SYSTEM_NAME = 'Apollo';

function logger(level, message, meta = {}) {
  if ((LOG_LEVELS[level] ?? 0) < LOG_MIN) return;
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  const line  = JSON.stringify(entry);
  console.log(line);
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(LOG_DIR, `apollo_${dateStr}.log`);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile, line + '\n');
  } catch (err) {
    console.error(`[${SYSTEM_NAME}][LOGGER] File write failed: ${err.message}`);
  }
}

function rotateLogs(windowDays = 7) {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - windowDays * 86400000;
    fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('apollo_') && f.endsWith('.log'))
      .forEach(f => {
        const fullPath = path.join(LOG_DIR, f);
        if (fs.statSync(fullPath).mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          console.log(`[${SYSTEM_NAME}][LOGGER] Rotated: ${f}`);
        }
      });
  } catch (err) {
    console.error(`[${SYSTEM_NAME}][LOGGER] Rotation failed: ${err.message}`);
  }
}

const log = {
  debug: (msg, meta) => logger('debug', msg, meta),
  info:  (msg, meta) => logger('info',  msg, meta),
  warn:  (msg, meta) => logger('warn',  msg, meta),
  error: (msg, meta) => logger('error', msg, meta),
};

module.exports = { log, rotateLogs };
