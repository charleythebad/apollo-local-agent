// health.js - Apollo V5.1
// Health check and self-recovery logic.
// Depends: logger.js, ollama.js

'use strict';

const fs     = require('fs');
const path   = require('path');
const dns    = require('dns');
const { exec } = require('child_process');
const { log }  = require('./logger');
const { pingOllama } = require('./ollama');
const alerts = require('./modules/health_alerts');

let _identity;
let _channels;
let _root;

function init(identity, channels, root) {
  _identity = identity;
  _channels = channels;
  _root     = root || null;
}

function lineCount(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').length;
  } catch { return 0; }
}

function codeStats() {
  if (!_root) return null;
  try {
    const botLines  = lineCount(path.join(_root, 'bot.js'));
    const skillFiles = fs.readdirSync(_root).filter(f => f.match(/^skl_\d+.*\.js$/));
    const skillLines = skillFiles.reduce((sum, f) => sum + lineCount(path.join(_root, f)), 0);
    return String.fromCodePoint(128202) + ' bot.js: ' + botLines + ' lines | Skills: ' + skillFiles.length + ' files | ' + skillLines + ' lines';
  } catch { return null; }
}

// Nightly backup writes last_run.json; stale or failed status must surface
// in !health because the 03:00 pm2 job otherwise fails silent.
function backupStatus() {
  const dest = process.env.BACKUP_DEST || (process.env.HOME + '/Backups/ApolloBackups');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dest, 'last_run.json'), 'utf8'));
    const ageH = (Date.now() - new Date(j.ts).getTime()) / 3600000;
    const ok = j.status === 'ok' && ageH < 26;
    return String.fromCodePoint(ok ? 9989 : 10060) + ' Nightly backup (' + j.status + ', ' + ageH.toFixed(1) + 'h ago)';
  } catch {
    return String.fromCodePoint(10060) + ' Nightly backup (no status file)';
  }
}

// One list for !health and the down/back alerts, so they always check the same
// things. alertName: shown in alerts; Ollama has none (it has its own recovery).
function serviceList() {
  return [
    { name: 'Ollama',     url: process.env.OLLAMA_URL },
    { name: 'Open WebUI', url: process.env.WEBUI_URL, alertName: 'Open WebUI' },
    ...(process.env.MEMORY_URL ? [{ name: 'Memory', url: process.env.MEMORY_URL, alertName: 'ChromaDB' }] : []),
    ...(process.env.AGENT_GATEWAY_URL ? [{ name: 'Agent gateway', url: process.env.AGENT_GATEWAY_URL, alertName: 'Agent gateway' }] : [])
  ];
}

async function checkServices(services) {
  return Promise.all(services.map(async s => {
    try {
      await fetch(s.url, { signal: AbortSignal.timeout(3000) });
      log.debug('Health OK', { service: s.name });
      return { ...s, ok: true };
    } catch {
      log.warn('Health FAIL', { service: s.name });
      return { ...s, ok: false };
    }
  }));
}

async function healthCheck(touchSkillFn) {
  const checked = await checkServices(serviceList());
  const results = checked.map(s => String.fromCodePoint(s.ok ? 9989 : 10060) + ' ' + s.name);
  results.push(backupStatus());
  const stats = codeStats();
  if (stats) results.push(stats);
  if (touchSkillFn) touchSkillFn('health_monitor');
  return results.join('\n');
}

let recoveryAttempts = 0;

// Down/back alerts (channel_health v1.1). In-memory: a restart starts clean.
const alertState = alerts.newState();

async function serviceAlerts(client) {
  const watched = serviceList().filter(s => s.alertName);
  const checked = await checkServices(watched);
  alerts.step(alertState, checked.map(s => ({ name: s.alertName, ok: s.ok })), Date.now(),
              { prefix: '[' + _identity.system_name + ']' });
  if (!alertState.queue.length) return;
  const r = await alerts.flush(alertState, async text => {
    const ch = await client.channels.fetch(_channels.health);
    await ch.send(text);
    log[text.includes('down (') ? 'warn' : 'info']('Service alert posted', { text });
  });
  if (!r.sent) log.warn('Service alert not posted yet, will retry next loop', { error: r.error, queued: r.left });
}

const TAILSCALE_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function lookupOk(host) {
  return new Promise(resolve => dns.lookup(host, err => resolve(!err)));
}

function execP(cmd) {
  return new Promise(resolve => exec(cmd, err => resolve(!err)));
}

// mDNSResponder can hold a stale negative-cache entry for a single hostname
// (gateway.discord.gg -> ENOTFOUND while other hosts resolve fine); rewriting
// the resolver config via a Tailscale accept-dns toggle flushes it without sudo.
async function fixDnsWedge() {
  if (await lookupOk('gateway.discord.gg')) return false;
  if (!(await lookupOk('discord.com'))) return false; // network-wide outage, not a wedge
  log.warn('DNS wedge detected (gateway.discord.gg ENOTFOUND, discord.com OK) — toggling Tailscale accept-dns', {});
  await execP('"' + TAILSCALE_BIN + '" set --accept-dns=false');
  await new Promise(r => setTimeout(r, 3000));
  await execP('"' + TAILSCALE_BIN + '" set --accept-dns=true');
  await new Promise(r => setTimeout(r, 5000));
  const fixed = await lookupOk('gateway.discord.gg');
  log[fixed ? 'info' : 'warn']('DNS wedge remediation ' + (fixed ? 'succeeded' : 'did not restore resolution'), {});
  return fixed;
}

// client.login has no built-in retry — at boot the mini can come up before
// the network has DNS and the login ENOTFOUNDs, leaving the bot wedged
function loginWithRetry(client, token, attempt = 1) {
  client.login(token).catch(e => {
    const delay = Math.min(15000 * attempt, 120000);
    log.warn('Discord login failed, retrying', { attempt, delayMs: delay, error: e.message });
    setTimeout(() => loginWithRetry(client, token, attempt + 1), delay);
  });
}

async function selfRecovery(client) {
  if (!client.isReady()) {
    log.warn('Gateway disconnected — checking for DNS wedge before restart', {});
    await fixDnsWedge();
    exec('pm2 restart apollo');
    return;
  }
  try { await serviceAlerts(client); }
  catch (err) { log.error('serviceAlerts failed', { error: err.message }); }
  if (await pingOllama()) { recoveryAttempts = 0; return; }
  log.warn('Ollama unresponsive - attempting recovery', { attempt: recoveryAttempts + 1 });
  let ch;
  try {
    ch = await client.channels.fetch(_channels.logs);
    await ch.send('[' + _identity.system_name + '] Ollama unresponsive. Attempting recovery...');
  } catch (err) {
    log.error('selfRecovery: could not reach logs channel', { error: err.message });
    return;
  }
  exec('open -a Ollama', async () => {
    try {
      await new Promise(r => setTimeout(r, 30000));
      if (await pingOllama()) {
        recoveryAttempts = 0;
        log.info('Ollama recovery successful');
        await ch.send('[' + _identity.system_name + '] ' + String.fromCodePoint(9989) + ' Ollama restored.');
      } else {
        recoveryAttempts++;
        log.error('Ollama recovery failed', { attempt: recoveryAttempts });
        if (recoveryAttempts >= 2) {
          const boss = await client.channels.fetch(_channels.boss);
          await boss.send('[' + _identity.system_name + '] Ollama recovery failed ' + recoveryAttempts + ' times. Manual intervention required.');
        }
      }
    } catch (err) {
      log.error('selfRecovery exec callback error', { error: err.message });
    }
  });
}

module.exports = { init, healthCheck, selfRecovery, fixDnsWedge, loginWithRetry };
