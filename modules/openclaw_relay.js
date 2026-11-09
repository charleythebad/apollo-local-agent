// modules/openclaw_relay.js
// Shared core for skills that slot an OpenClaw agent behind a Discord command.
// A new agent slot only needs a thin wrapper with its own opts (see skl_010).
//
// Fences, all enforced here rather than trusted to the agent:
//   - spawn, never exec: arguments are an array, no shell, no injection
//   - minimal child environment: the bot's Discord token and any other
//     secrets in process.env never reach the agent process
//   - hard timeout on every call
//   - principal-locked: only PRINCIPAL_ID can trigger a slot

'use strict';

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');

// OpenClaw needs node >= 22 while the bot may run on an older node, so use
// OPENCLAW_NODE if set, else the newest Homebrew node, else the bot's own.
function resolveNodeBin() {
  if (process.env.OPENCLAW_NODE) return process.env.OPENCLAW_NODE;
  try {
    const cellar = '/opt/homebrew/Cellar/node';
    const newest = fs.readdirSync(cellar)
      .map(v => ({ v, n: v.split('.').map(Number) }))
      .sort((a, b) => (b.n[0] - a.n[0]) || (b.n[1] - a.n[1]) || (b.n[2] - a.n[2]))
      .map(x => cellar + '/' + x.v + '/bin/node')
      .find(p => fs.existsSync(p));
    if (newest) return newest;
  } catch (e) { /* fall through */ }
  return process.execPath;
}

// 15 min default: agent tool loops on local models can run long; simple
// queries come back in under a minute.
function timeoutMs() {
  return Number(process.env.AGENT_TIMEOUT_MS) || 900000;
}

// Only what the agent CLI needs. Everything else in process.env is dropped.
function clawEnv(src = process.env) {
  const env = { HOME: src.HOME, PATH: src.PATH, TMPDIR: src.TMPDIR };
  for (const k of Object.keys(src)) {
    if (k.startsWith('OPENCLAW_')) env[k] = src[k];
  }
  return env;
}

// The CLI's JSON shape differs by transport: the gateway wraps the payload
// under `result`; the embedded fallback returns it flat. Handle both.
function parseAgentReply(stdout) {
  const data = JSON.parse(stdout);
  return data?.result?.payloads?.[0]?.text || data?.payloads?.[0]?.text || '[no response]';
}

// One-shot agent call. A fresh session id per call by default, so one-shot
// calls don't pile history into a single session forever; pass a sessionId
// to continue a call (e.g. a corrective retry that keeps the context).
// Returns { text, sessionId }; throws Error('timeout'), Error('exit N: ...'),
// or Error('parse error: ...').
function callAgent(agentId, message, sessionId) {
  const NODE_BIN = resolveNodeBin();
  const CLAW_BIN = process.env.OPENCLAW_PATH + '/openclaw.mjs';
  const usedSessionId = sessionId || randomUUID();

  return new Promise((resolve, reject) => {
    const args = ['agent', '--agent', agentId, '--session-id', usedSessionId, '--message', message, '--json'];
    const proc = spawn(NODE_BIN, [CLAW_BIN, ...args], { env: clawEnv() });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('timeout'));
    }, timeoutMs());

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('exit ' + code + ': ' + stderr.slice(0, 200)));
      try {
        resolve({ text: parseAgentReply(stdout), sessionId: usedSessionId });
      } catch (e) {
        reject(new Error('parse error: ' + stdout.slice(0, 200)));
      }
    });
  });
}

// opts: command, agentId, channelKey, channelLabel, channelEnvName, skillId, sklTag,
//       delegatingMsg, toPrefix, fromPrefix, timeoutMsg, usageMsg
function makeRelay(opts) {
  return function registerRelay(registeredCommands, touchSkill, log, memory, client, CHANNELS) {
    const PRINCIPAL_ID = process.env.PRINCIPAL_ID;

    registeredCommands[opts.command] = async (msg) => {
      try {
        if (msg.author.id !== PRINCIPAL_ID) {
          await msg.reply('[Apollo] ' + opts.command + ' is principal-locked. Request denied.');
          return;
        }

        const directive = msg.content.slice(msg.content.indexOf(' ') + 1).trim();
        if (!directive || directive === opts.command) {
          await msg.reply('[Apollo] ' + opts.usageMsg);
          return;
        }

        const agentChannel = client.channels.cache.get(CHANNELS[opts.channelKey]);
        if (!agentChannel) {
          await msg.reply('[Apollo] ' + opts.channelLabel + ' channel not found. Check ' + opts.channelEnvName + '.');
          return;
        }

        await msg.reply('[Apollo] ' + opts.delegatingMsg);
        await agentChannel.send(opts.toPrefix + ' ' + directive);
        log.info(opts.sklTag + ' directive dispatched', { directive });

        const { text: reply } = await callAgent(opts.agentId, directive);

        touchSkill(opts.skillId);
        log.info(opts.sklTag + ' reply received', { directive, chars: reply.length });

        // Discord caps a message at 2000 characters
        const chunks = reply.match(/[\s\S]{1,1900}/g) || [reply];
        await agentChannel.send(opts.fromPrefix + '\n' + chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await agentChannel.send(chunks[i]);
        }

      } catch (err) {
        const agentChannel = client.channels.cache.get(CHANNELS[opts.channelKey]);
        if (err.message === 'timeout') {
          log.warn(opts.sklTag + ' timeout', {});
          if (agentChannel) await agentChannel.send('[Apollo] ' + opts.timeoutMsg).catch(() => {});
        } else {
          log.error(opts.sklTag + ' error', { error: err.message });
          if (agentChannel) await agentChannel.send('[Apollo] ' + opts.sklTag + ' error: ' + err.message).catch(() => {});
        }
      }
    };
  };
}

module.exports = { makeRelay, resolveNodeBin, callAgent, clawEnv, parseAgentReply };
