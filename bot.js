// bot.js — Apollo core: wiring, Discord events, skill loader. Nothing else.
// Line target: ~400. All feature logic lives in skl_XXX_*.js files or modules/.
// Skills are written by the builder with the principal's approval — bot.js never writes code.
'use strict';

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fs   = require('fs');
const path = require('path');

if (!process.env.APOLLO_ROOT) process.env.APOLLO_ROOT = __dirname;
const { log, rotateLogs } = require('./logger');
const ollama              = require('./ollama');
const skills              = require('./skills');
const health              = require('./health');
const PROMPTS             = require('./prompts');

// ── Manifest (resolved through the version index) ───────────────────────────

const ROOT          = process.env.APOLLO_ROOT;
const VERSION_INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'version_index.json'), 'utf8'));
const MANIFEST      = JSON.parse(fs.readFileSync(path.join(ROOT, VERSION_INDEX.active.manifest), 'utf8'));

// "${CHANNEL_HEALTH}" -> process.env.CHANNEL_HEALTH. IDs and secrets live only in .env.
const fromEnv = v => String(v || '').replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] || '');

const IDENTITY = {
  system_name:   MANIFEST.identity.system_name,
  principal:     MANIFEST.identity.principal,
  version_label: MANIFEST.identity.version_label
};

const CHANNELS = {
  boss:      fromEnv(MANIFEST.channels.command_interface),
  health:    fromEnv(MANIFEST.channels.health),
  logs:      fromEnv(MANIFEST.channels.logs),
  approvals: fromEnv(MANIFEST.channels.approvals)
};

const MODELS = {
  strength: MANIFEST.models.strength_model.name,
  agility:  MANIFEST.models.agility_model.name,
  endpoint: fromEnv(MANIFEST.models.strength_model.endpoint)
};

const PATHS = {
  root:      ROOT,
  lifecycle: fromEnv(MANIFEST.paths.skill_lifecycle),
  events:    fromEnv(MANIFEST.paths.event_log)
};

// ── Module init: ollama, then skills, then health ───────────────────────────

ollama.init(MODELS.endpoint, MODELS);
skills.init(PATHS);
skills.reconcileLifecycle(MANIFEST.skill_registry);
const { registeredCommands, touchSkill } = skills;
health.init(IDENTITY, CHANNELS, ROOT);
const memory = null; // plug a memory layer in here (e.g. a local vector store); skills receive it

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ── SKILL LOADER ─────────────────────────────────────────────────────────────
// One line per skill, canonical 6-arg signature. tools/docs_audit.js checks these
// lines against the manifest registry and the skl_*.js files on disk.

require('./skl_004_log_monitor_v1.1')(registeredCommands, touchSkill, log, memory, client, CHANNELS);
require('./skl_006_version_control_v1.4')(registeredCommands, touchSkill, log, memory, client, CHANNELS);
// END SKILL LOADER

// ── Startup ──────────────────────────────────────────────────────────────────

client.on('clientReady', async () => {
  rotateLogs(MANIFEST.log_rotation?.window_days ?? 7);
  log.info(IDENTITY.system_name + ' online', { version: IDENTITY.version_label });
  skills.logEvent('STARTUP | ' + IDENTITY.version_label + ' | Skills: ' + skills.getActiveSkillCount() + ' active');
  touchSkill('router');
  try {
    const status = await health.healthCheck(touchSkill);
    await (await client.channels.fetch(CHANNELS.health)).send(
      '[' + IDENTITY.system_name + ' ' + IDENTITY.version_label + '] Startup Health:\n' + status);
  } catch (err) { log.error('Startup health post failed', { error: err.message }); }
  setInterval(() => health.selfRecovery(client), 5 * 60 * 1000);
});

// ── Messages: principal only ─────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== process.env.PRINCIPAL_ID) return; // everyone else is ignored, silently

  const ch  = message.channel.id;
  const cmd = message.content.trim();

  if ((ch === CHANNELS.health || ch === CHANNELS.boss) && cmd === '!health') {
    await message.reply('[' + IDENTITY.system_name + '] Health:\n' + await health.healthCheck(touchSkill));
    return;
  }
  if (ch !== CHANNELS.boss) return;

  // Longest registered command that matches wins ("!version save" before "!version").
  const matched = Object.keys(registeredCommands)
    .filter(k => cmd === k || cmd.startsWith(k + ' '))
    .sort((a, b) => b.length - a.length)[0];
  if (matched) { await registeredCommands[matched](message); return; }

  if (cmd === '!status') {
    await message.reply('[' + IDENTITY.system_name + '] ' + IDENTITY.version_label + ' | Active: ' +
      skills.getActiveSkillCount() + ' | Strength: ' + MODELS.strength + ' | Agility: ' + MODELS.agility);
    return;
  }
  // Unknown !commands never reach a model — a typo must not turn into a guess.
  if (cmd.startsWith('!')) {
    const known = ['!health', '!status', ...Object.keys(registeredCommands)].sort().join(' ');
    await message.reply('[' + IDENTITY.system_name + '] Unknown command `' +
      cmd.split(/\s+/)[0].replace(/`/g, '').slice(0, 40) + '`. Available: ' + known);
    return;
  }

  // Chat: the small model answers or says ESCALATE; slow or unsure goes to the big model.
  try {
    let reply, escalated = false;
    try {
      reply = await Promise.race([
        ollama.ollamaChat([{ role: 'system', content: PROMPTS.system +
          '\n\nIf you are not confident you can answer this well, respond with exactly: ESCALATE' },
          { role: 'user', content: cmd }], MODELS.agility),
        new Promise((_, rej) => setTimeout(() => rej(new Error('agility_timeout')), 20000))
      ]);
      if (reply && reply.trim() === 'ESCALATE') escalated = true;
    } catch (err) {
      escalated = true;
      log.warn('Agility timeout/error, escalating', { error: err.message });
    }
    if (escalated) {
      skills.logEvent('ROUTING_ESCALATED | ' + cmd.slice(0, 60));
      reply = await ollama.ollamaChat([{ role: 'system', content: PROMPTS.system },
        { role: 'user', content: cmd }], MODELS.strength);
    }
    await message.reply((reply || 'No response').slice(0, 1900));
  } catch (err) {
    log.error('Chat error', { error: err.message });
    await message.reply('[' + IDENTITY.system_name + '] Error: ' + err.message);
  }
});

health.loginWithRetry(client, process.env.DISCORD_TOKEN);
