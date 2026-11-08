// skl_014_approval_gate_v1.0.js — Branch: governance
// Commands (command channel): !propose <text>, !approve <id>, !reject <id>, !proposals
// Approval also works as a ✅ (approve) or ❌ (reject) reaction on the proposal message
// in the approvals channel. Only PRINCIPAL_ID counts. Unanswered proposals expire.
// The approved action is deliberately harmless: write the proposal text to
// data/approved/<id>.txt. Swap in your own action — keep it idempotent.
'use strict';

const fs   = require('fs');
const path = require('path');
const G    = require('./modules/approval_gate');

const SKILL_NAME = 'skl_014_approval_gate';
const TTL_MS     = Number(process.env.APPROVAL_TTL_MIN || 60) * 60 * 1000;
const ROOT       = process.env.APOLLO_ROOT || __dirname;
const DATA       = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'approvals_state.json');
const LEDGER     = path.join(DATA, 'approvals_ledger.jsonl');

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return G.newState(); } }
function save(st) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(st, null, 2)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}
function ledger(entry) { if (!entry) return; fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n'); }

// The action. Idempotent: same id → same file, same content.
function execute(p) {
  if (!G.ID_RE.test(p.id)) throw new Error('bad id');
  const dir = path.join(DATA, 'approved'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, p.id + '.txt'), p.text + '\n');
  return 'wrote data/approved/' + p.id + '.txt';
}

module.exports = function registerApprovalGate(registeredCommands, touchSkill, log, memory, client, CHANNELS, opts = {}) {
  const now = opts.now || Date.now;
  const principal = () => process.env.PRINCIPAL_ID;
  const st = load();
  const approvals = async () => client.channels.fetch(CHANNELS.approvals || CHANNELS.boss);

  // Save the state change first, then act, then save again: a crash in between
  // leaves an 'approved' proposal that runAwaiting() finishes on the next start.
  async function runAwaiting() {
    for (const p of G.awaitingExecution(st)) {
      let result;
      try { result = execute(p); } catch (err) { log.error('Approval action failed', { id: p.id, error: err.message }); continue; }
      ledger(G.markExecuted(st, p.id, now(), result)); save(st);
      try { await (await approvals()).send(`[Apollo] ▶️ \`${p.id}\` executed — ${result}`); } catch (e) { log.warn('Post failed', { error: e.message }); }
    }
  }

  async function applyDecision(id, actor, decision, reply) {
    const r = G.decide(st, { id, actor, principal: principal(), decision, nowMs: now() });
    ledger(r.entry); save(st);
    if (r.error === 'not the principal') { log.warn('Approval attempt by non-principal ignored', { id }); return; }
    if (!r.ok) { if (reply) await reply(`[Apollo] \`${id}\`: ${r.error}.`); return; }
    if (reply) await reply(`[Apollo] \`${id}\` ${r.entry.event}.`);
    touchSkill(SKILL_NAME);
    if (r.entry.event === 'approved') await runAwaiting();
  }

  registeredCommands['!propose'] = async (msg) => {
    const r = G.propose(st, { text: msg.content.slice('!propose'.length), by: msg.author.id, nowMs: now(), ttlMs: TTL_MS });
    if (r.error) { await msg.reply('[Apollo] ' + r.error + '.'); return; }
    ledger(r.entry); save(st);
    const mins = Math.round(TTL_MS / 60000);
    const sent = await (await approvals()).send(
      `[Apollo] 📝 Proposal \`${r.proposal.id}\`: ${r.proposal.text}\nReact ✅ to approve or ❌ to reject (or \`!approve ${r.proposal.id}\`). Expires in ${mins} min.`);
    r.proposal.messageId = sent.id; save(st);
    touchSkill(SKILL_NAME);
    await msg.reply(`[Apollo] Proposal \`${r.proposal.id}\` posted for approval.`);
  };
  registeredCommands['!approve'] = (msg) => applyDecision(msg.content.split(/\s+/)[1], msg.author.id, 'approve', t => msg.reply(t));
  registeredCommands['!reject']  = (msg) => applyDecision(msg.content.split(/\s+/)[1], msg.author.id, 'reject', t => msg.reply(t));
  registeredCommands['!proposals'] = async (msg) => {
    const open = Object.values(st.proposals).filter(p => p.status === 'pending');
    await msg.reply(open.length ? '[Apollo] Pending:\n' + open.map(p => `\`${p.id}\` ${p.text.slice(0, 80)}`).join('\n') : '[Apollo] No pending proposals.');
  };

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();
      const p = G.findByMessage(st, reaction.message.id);
      if (!p) return;
      const decision = reaction.emoji.name === '✅' ? 'approve' : reaction.emoji.name === '❌' ? 'reject' : null;
      if (decision) await applyDecision(p.id, user.id, decision, t => reaction.message.reply(t));
    } catch (err) { log.error('Reaction handling failed', { error: err.message }); }
  });

  async function sweep() {
    const expired = G.expireDue(st, now());
    if (!expired.length) return;
    expired.forEach(ledger); save(st);
    try { await (await approvals()).send('[Apollo] ⌛ Expired unapproved: ' + expired.map(e => '`' + e.id + '`').join(', ')); } catch (e) { log.warn('Post failed', { error: e.message }); }
  }
  if (!opts.noTimers) { setInterval(sweep, 60 * 1000); setTimeout(runAwaiting, 5000); }
  return { sweep, runAwaiting, state: st };
};
