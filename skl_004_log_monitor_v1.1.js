// skl_004_log_monitor_v1.1.js - Apollo V6.0
// Branch: Spells | Score: 5 | Retirable: true
// Command: !logreport | Schedule: daily 08:00 MT | Output: CHANNELS.logs
// No external fetch — channel access via client.channels.cache only.
// v1.1 (2026-07-12): SKILL_NAME aligned to the registry name — the old
// 'log_intelligence_monitor' never matched a lifecycle entry, so touchSkill
// silently no-opped and this skill looked permanently unused.

'use strict';

const fs   = require('fs');
const path = require('path');
const dns  = require('dns').promises;

const SKILL_NAME  = 'skl_004_log_monitor';
const DIGEST_HOUR = 8;

// Home connections drop; deliver the digest late
// rather than dropping it (and spamming errors) when 08:00 lands offline
const OFFLINE_RETRY_MS  = 15 * 60 * 1000;
const OFFLINE_MAX_TRIES = 24; // ~6h, then wait for tomorrow's slot

async function isOnline() {
  try { await dns.lookup('discord.com'); return true; } catch { return false; }
}

function getLogPath() {
  const dateStr = new Date().toISOString().slice(0, 10);
  return path.join(process.env.APOLLO_ROOT, 'logs', `apollo_${dateStr}.log`);
}

function parseLogFile(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* LOG_PARSE_ERROR — skip malformed line */ }
  }
  return entries;
}

function buildDigest(entries) {
  const warnCount  = entries.filter(e => e.level === 'warn').length;
  const errorCount = entries.filter(e => e.level === 'error').length;
  const anomalies  = entries
    .filter(e => e.level === 'warn' || e.level === 'error')
    .slice(0, 10)
    .map(e => `${e.level === 'error' ? '🚨' : '⚠️'} ${e.message}${e.error ? ' — ' + e.error : ''}`);
  const date = new Date().toISOString().slice(0, 10);
  let digest = `[Apollo] Daily Log Digest — ${date}\n⚠️ ${warnCount} warnings | 🚨 ${errorCount} errors | 📊 ${entries.length} events\n`;
  digest += anomalies.length ? '\n' + anomalies.join('\n') : '\n✅ No anomalies detected';
  return digest;
}

async function runLogDigest(client, CHANNELS) {
  const ch = client.channels.cache.get(CHANNELS.logs);
  if (!ch) { console.error(`[${SKILL_NAME}] CHANNEL_UNAVAILABLE — CHANNELS.logs not in cache`); return; }

  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) {
    await ch.send(`[Apollo] Log Digest — No log file found for today. (LOG_NOT_FOUND)`);
    return;
  }

  let entries;
  try {
    entries = parseLogFile(logPath);
  } catch (err) {
    await ch.send(`[Apollo] Log Digest — Read failed: ${err.message}`);
    return;
  }

  if (!entries.length) {
    await ch.send(`[Apollo] Log Digest — Log file exists but contains no entries. (EMPTY_LOG)`);
    return;
  }

  await ch.send(buildDigest(entries).slice(0, 1900));
}

module.exports = function registerLogMonitor(registeredCommands, touchSkill, log, memory, client, CHANNELS) {
  registeredCommands['!logreport'] = async (msg) => {
    try {
      await runLogDigest(client, CHANNELS);
      touchSkill(SKILL_NAME);
    } catch (err) {
      const ch = client.channels.cache.get(CHANNELS.logs);
      if (ch) await ch.send(`[Apollo] Log Digest error: ${err.message}`);
    }
  };

  async function runScheduledDigest(attempt = 0) {
    if (!(await isOnline())) {
      if (attempt === 0) console.log(`[${SKILL_NAME}] Offline at digest time — retrying every 15 min`);
      if (attempt < OFFLINE_MAX_TRIES) setTimeout(() => runScheduledDigest(attempt + 1), OFFLINE_RETRY_MS);
      else console.error(`[${SKILL_NAME}] Digest skipped — offline for ${OFFLINE_MAX_TRIES} retries`);
      return;
    }
    try {
      if (attempt > 0) console.log(`[${SKILL_NAME}] Back online — sending digest (${attempt * 15} min late)`);
      await runLogDigest(client, CHANNELS);
      touchSkill(SKILL_NAME);
    } catch (err) {
      console.error(`[${SKILL_NAME}] Scheduled digest error: ${err.message}`);
    }
  }

  function scheduleDailyDigest() {
    const now  = new Date();
    const next = new Date();
    next.setHours(DIGEST_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(async () => {
      await runScheduledDigest();
      setInterval(runScheduledDigest, 24 * 60 * 60 * 1000);
    }, next - now);
  }
  scheduleDailyDigest();
};
