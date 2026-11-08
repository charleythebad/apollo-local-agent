// modules/approval_gate.js — human-approval gate, pure logic (no Discord, no clock, no disk).
// A proposal moves one way only:  pending → approved → executed
//                                 pending → rejected | expired
// Only the principal's identity can approve or reject; anyone else is ignored and logged.
// Every transition returns a ledger entry, so the ledger and the channel tell the same story.
'use strict';

const crypto = require('crypto');

const ID_RE = /^[0-9a-f]{6}$/;
const MAX_TEXT = 300;

function newState() { return { proposals: {} }; }

function newId(state, rand = () => crypto.randomBytes(3).toString('hex')) {
  let id;
  do { id = rand(); } while (state.proposals[id]);
  return id;
}

// Returns { proposal, entry } or { error }.
function propose(state, { text, by, nowMs, ttlMs, rand }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { error: 'empty proposal' };
  if (clean.length > MAX_TEXT) return { error: `proposal too long (max ${MAX_TEXT} chars)` };
  const id = newId(state, rand);
  const proposal = { id, text: clean, by, status: 'pending', createdAt: nowMs, expiresAt: nowMs + ttlMs, messageId: null };
  state.proposals[id] = proposal;
  return { proposal, entry: { ts: nowMs, event: 'proposed', id, by, text: clean, expiresAt: proposal.expiresAt } };
}

// decision: 'approve' | 'reject'. Returns { ok, entry, error }.
function decide(state, { id, actor, principal, decision, nowMs }) {
  const p = state.proposals[id];
  if (!ID_RE.test(String(id)) || !p) return { ok: false, error: 'no such proposal' };
  if (actor !== principal) {
    return { ok: false, error: 'not the principal', entry: { ts: nowMs, event: 'ignored', id, actor, decision } };
  }
  if (p.status !== 'pending') return { ok: false, error: `already ${p.status}` };
  if (nowMs >= p.expiresAt) return expireOne(p, nowMs);
  p.status = decision === 'approve' ? 'approved' : 'rejected';
  p.decidedAt = nowMs;
  return { ok: true, entry: { ts: nowMs, event: p.status, id, actor } };
}

function expireOne(p, nowMs) {
  p.status = 'expired'; p.decidedAt = nowMs;
  return { ok: false, error: 'expired', entry: { ts: nowMs, event: 'expired', id: p.id } };
}

// Marks every overdue pending proposal expired. Returns the ledger entries.
function expireDue(state, nowMs) {
  return Object.values(state.proposals)
    .filter(p => p.status === 'pending' && nowMs >= p.expiresAt)
    .map(p => expireOne(p, nowMs).entry);
}

// Approved but not yet executed (e.g. the process died in between). The action
// must be idempotent, so running it again after a crash is safe.
function awaitingExecution(state) {
  return Object.values(state.proposals).filter(p => p.status === 'approved');
}

function markExecuted(state, id, nowMs, result) {
  const p = state.proposals[id];
  if (!p || p.status !== 'approved') return null;
  p.status = 'executed'; p.executedAt = nowMs;
  return { ts: nowMs, event: 'executed', id, result };
}

function findByMessage(state, messageId) {
  return Object.values(state.proposals).find(p => p.messageId === messageId) || null;
}

module.exports = { newState, newId, propose, decide, expireDue, awaitingExecution, markExecuted, findByMessage, ID_RE, MAX_TEXT };
