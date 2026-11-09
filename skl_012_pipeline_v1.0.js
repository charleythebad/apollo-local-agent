// skl_012_pipeline_v1.0.js
// Command: !pipe <pipeline> [input] | !pipe <freeform writing task>
// Multi-agent pipeline runner. Apollo is the orchestrator and agents are
// nodes: each node's reply is passed into the next node's prompt. The agent
// framework blocks agent-to-agent messages by design, so this skill is the
// one sanctioned way to compose agents, and every step is logged.
// Pipelines are data: add an entry to PIPELINES, no new machinery.
//
// Config (.env): PRINCIPAL_EMAIL (the only draft recipient), NOTES_DIR and
// DRAFT_CMD (for the "note" pipeline), AGENT_CHAT_ID / AGENT_EMAIL_ID.
// DRAFT_CMD is an executable called as:
//   DRAFT_CMD --to <addr> --subject <s> --body-file - [--attach <file>]...
// with the body on stdin. It must only create a draft, never send.

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { callAgent } = require('./modules/openclaw_relay');
const notes = require('./modules/note_bundles');

const MAX_FORMAT_RETRIES = 2;

// Only what the draft command needs to find its own tools.
function draftEnv() {
  return { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
}

// Filing the draft is a script call with fully-known inputs, so it runs in
// code. Field incident: given the same directive three times, the email agent
// never once ran the draft script. It chatted instead, then (after a format
// retry) reported a confident "STAGED" with an invented photo count while
// nothing had been staged. No judgment call is left here for a model to make.
function stageDraft(draftCmd, to, subject, body, photos) {
  return new Promise((resolve) => {
    const args = ['--to', to, '--subject', subject, '--body-file', '-'];
    for (const p of photos) args.push('--attach', p);
    const proc = spawn(draftCmd, args, { env: draftEnv() });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => resolve({ ok: code === 0, output: out.trim() }));
    proc.on('error', err => resolve({ ok: false, output: err.message }));
    proc.stdin.on('error', () => {});
    proc.stdin.end(body);
  });
}

function buildPipelines(cfg) {
  return {
    draft: {
      description: 'The chat agent completes a writing task; the email agent stages it as a draft to the principal',
      steps: [
        {
          agentId: cfg.chatAgent, channelKey: 'agentChat', label: 'Chat agent',
          toPrefix: '[Apollo→Agent]', fromPrefix: '[Agent→Apollo]',
          prompt: ({ input }) =>
            'Complete this writing task: ' + input +
            '\nReply with ONLY the finished text: no preamble, no commentary, no sign-off.'
        },
        {
          agentId: cfg.emailAgent, channelKey: 'agentEmail', label: 'Email agent',
          toPrefix: '[Apollo→Email]', fromPrefix: '[Email→Apollo]',
          // The recipient is fixed to the principal, and the no-send shim
          // blocks sending, so this can only ever stage a draft in the
          // principal's own mailbox.
          prompt: ({ prev }) =>
            'Create an email draft to ' + cfg.principalEmail + '. Choose a short subject line that fits ' +
            'the content, and use exactly this body. Stage it immediately, no preview needed:\n\n' + prev
        }
      ]
    },
    note: {
      description: 'The chat agent lightly cleans up the newest field note; Apollo files the draft itself',
      steps: [
        {
          agentId: cfg.chatAgent, channelKey: 'agentChat', label: 'Chat agent',
          toPrefix: '[Apollo→Agent]', fromPrefix: '[Agent→Apollo]',
          prompt: ({ bundleDir, note }) =>
            'Clean up this field note for an email. The note is complete and already read for you; ' +
            'do not open, list or search for any files. It is between the markers:\n<<<NOTE\n' + note + '\nNOTE>>>\n' +
            'The note IS the message: keep it near-verbatim, fixing only punctuation and capitalization. ' +
            'If the note is one sentence, the body is one sentence. Keep every number exactly as written. ' +
            'Do not add a location, coordinates, a photo list, stats, or anything the note does not say. ' +
            'This is an automated call: your reply goes straight to the next stage, so no chat and no offers ' +
            'to help. First line must be exactly "BUNDLE: ' + bundleDir + '", then a blank line, then ONLY ' +
            'the body. If you cannot do this, reply exactly "ERROR: " plus one sentence.',
          validate: notes.isStructured,
          // Retried in the SAME session, so the agent keeps its context and
          // only has to fix the format.
          retryPrompt: ({ bundleDir }) =>
            'Your last reply was commentary, not the deliverable. Use the note from the original message. ' +
            'Reply with ONLY: first line exactly "BUNDLE: ' + bundleDir + '", a blank line, then the cleaned-up ' +
            'body. No chat. Reply "ERROR: " plus one sentence only if you truly cannot.'
        }
      ]
    }
  };
}

const DEFAULT_PIPELINE = 'draft';

module.exports = function registerPipeline(registeredCommands, touchSkill, log, memory, client, CHANNELS) {
  const PRINCIPAL_ID = process.env.PRINCIPAL_ID;
  const cfg = {
    principalEmail: process.env.PRINCIPAL_EMAIL || '',
    notesDir:       process.env.NOTES_DIR || '',
    draftCmd:       process.env.DRAFT_CMD || '',
    chatAgent:      process.env.AGENT_CHAT_ID || 'main',
    emailAgent:     process.env.AGENT_EMAIL_ID || 'email'
  };
  const PIPELINES = buildPipelines(cfg);
  const usageMsg = 'Usage: !pipe <pipeline> [input], or !pipe <freeform writing task> (runs "' +
    DEFAULT_PIPELINE + '"). Pipelines: ' + Object.keys(PIPELINES).join(', ');

  async function sendChunked(channel, prefix, text) {
    const chunks = text.match(/[\s\S]{1,1900}/g) || [text];
    await channel.send(prefix + '\n' + chunks[0]);
    for (let i = 1; i < chunks.length; i++) await channel.send(chunks[i]);
  }

  registeredCommands['!pipe'] = async (msg) => {
    const fail = async (where, text, extra = {}) => {
      log.error('SKL-012 pipeline failed', { where, error: text, ...extra });
      await msg.reply('[Apollo] ' + text);
    };
    try {
      if (msg.author.id !== PRINCIPAL_ID) {
        await msg.reply('[Apollo] !pipe is principal-locked. Request denied.');
        return;
      }

      const rest = msg.content.slice('!pipe'.length).trim();
      if (!rest) { await msg.reply('[Apollo] ' + usageMsg); return; }
      const first = rest.split(/\s+/)[0];
      const name = PIPELINES[first] ? first : DEFAULT_PIPELINE;
      const input = PIPELINES[first] ? rest.slice(first.length).trim() : rest;
      if (name === 'draft' && !input) { await msg.reply('[Apollo] ' + usageMsg); return; }
      if (name === 'draft' && !cfg.principalEmail) { await msg.reply('[Apollo] Set PRINCIPAL_EMAIL first.'); return; }
      const pipeline = PIPELINES[name];

      // Note pipeline: find and read the bundle in code, before any agent
      // runs, and fail fast if there is nothing to work with.
      const ctx = { input };
      if (name === 'note') {
        if (!cfg.notesDir || !cfg.draftCmd || !cfg.principalEmail) {
          await msg.reply('[Apollo] Set NOTES_DIR, DRAFT_CMD and PRINCIPAL_EMAIL first.');
          return;
        }
        const firstWord = input.split(/\s+/)[0];
        const bundle = notes.resolveBundle(cfg.notesDir, notes.STAMP_RE.test(firstWord) ? firstWord : null);
        if (!bundle) { await msg.reply('[Apollo] No matching note bundle found. Nothing to pipe.'); return; }
        ctx.note = notes.readNote(bundle.dir);
        if (!ctx.note) { await msg.reply('[Apollo] Bundle "' + bundle.stamp + '" has an empty note.'); return; }
        ctx.bundleDir = bundle.dir;
        ctx.stamp = bundle.stamp;
      }

      // Resolve every step's channel up front, so nothing runs half-wired
      const stepChannels = [];
      for (const step of pipeline.steps) {
        const ch = client.channels.cache.get(CHANNELS[step.channelKey]);
        if (!ch) { await msg.reply('[Apollo] ' + step.label + ' channel not found (CHANNELS.' + step.channelKey + ').'); return; }
        stepChannels.push(ch);
      }

      await msg.reply('[Apollo] Running pipeline "' + name + '" (' + pipeline.steps.map(s => s.label).join(' → ') + ')...');
      log.info('SKL-012 pipeline started', { pipeline: name, input });

      let prev = '';
      for (let i = 0; i < pipeline.steps.length; i++) {
        const step = pipeline.steps[i];
        const nodeTag = 'node ' + (i + 1) + '/' + pipeline.steps.length + ' (' + step.label + ')';
        const directive = step.prompt({ ...ctx, prev });
        await sendChunked(stepChannels[i], step.toPrefix, directive);

        let result;
        try {
          result = await callAgent(step.agentId, directive);
          let attempt = 0;
          while (step.validate && attempt < MAX_FORMAT_RETRIES && !step.validate(result.text)) {
            attempt++;
            log.info('SKL-012 format retry', { pipeline: name, node: nodeTag, attempt });
            result = await callAgent(step.agentId, step.retryPrompt({ ...ctx, prev }), result.sessionId);
          }
        } catch (err) {
          const why = err.message === 'timeout' ? 'no reply within the timeout' : err.message;
          await stepChannels[i].send('[Apollo] ' + step.label + ': ' + why).catch(() => {});
          return fail(nodeTag, 'Pipeline "' + name + '" failed at ' + nodeTag + ': ' + why);
        }

        prev = result.text;
        await sendChunked(stepChannels[i], step.fromPrefix, prev);
        log.info('SKL-012 node complete', { pipeline: name, node: nodeTag, chars: prev.length });

        // A reply that still fails its format check, or reports ERROR, must
        // not be piped onward as if it were valid.
        if (step.validate && !step.validate(prev)) {
          return fail(nodeTag, 'Pipeline "' + name + '" stopped at ' + nodeTag + ': wrong format after retries. Nothing was staged.');
        }
        if (/^ERROR:/.test(prev.trim())) {
          return fail(nodeTag, 'Pipeline "' + name + '" stopped at ' + nodeTag + ': ' + prev.trim());
        }
      }

      if (name === 'note') {
        const parsed = notes.parseBundleReply(prev);
        if (!parsed || path.resolve(parsed.bundleDir) !== path.resolve(ctx.bundleDir) || !notes.bodyKeepsNote(parsed.body, ctx.note)) {
          return fail('stage', 'Pipeline "note" stopped: the reply does not contain the note (or names the wrong bundle), likely invented. Nothing was staged.');
        }
        const photos = notes.photosIn(ctx.bundleDir);
        const subject = 'Field note: ' + ctx.stamp;
        const staged = await stageDraft(cfg.draftCmd, cfg.principalEmail, subject, parsed.body, photos);
        if (!staged.ok) return fail('stage', 'Pipeline "note" failed at staging: ' + staged.output);
        try {
          notes.markDrafted(ctx.bundleDir);
        } catch (e) {
          return fail('stage', 'Draft staged, but updating meta.json failed (' + e.message + '). Re-running would pick this bundle again.');
        }
        touchSkill('skl_012_pipeline');
        await msg.reply('[Apollo] Pipeline "note" complete. Draft staged: "' + subject + '", ' + photos.length + ' photo(s). Review and send it yourself.');
        return;
      }

      touchSkill('skl_012_pipeline');
      await msg.reply('[Apollo] Pipeline "' + name + '" complete.');

    } catch (err) {
      log.error('SKL-012 error', { error: err.message });
      await msg.reply('[Apollo] SKL-012 error: ' + err.message).catch(() => {});
    }
  };
};

module.exports.stageDraft = stageDraft;
