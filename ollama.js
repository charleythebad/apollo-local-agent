// ollama.js — Apollo V4.2
// All Ollama interaction. No Discord, no filesystem, no skill logic.
// Depends: logger.js
//
// Fix V4.2: init guard on ollamaChat, pingOllama uses _endpoint consistently

'use strict';

const { log } = require('./logger');

let _endpoint;
let _models;

function init(endpoint, models) {
  _endpoint = endpoint;
  _models   = models;
  log.info('Ollama module initialized', { endpoint, strength: models.strength, agility: models.agility });
}

async function ollamaChat(messages, model) {
  // Guard: fail clearly if init() was not called
  if (!_endpoint) throw new Error('ollama.init() must be called before ollamaChat()');

  const target = model || _models.strength;
  let res;
  try {
    res = await fetch(_endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: target, messages, stream: false })
    });
  } catch (err) {
    log.error('ollamaChat network error', { model: target, error: err.message });
    throw new Error(`Ollama network error: ${err.message}`);
  }
  if (!res.ok) {
    log.error('ollamaChat HTTP error', { model: target, status: res.status });
    throw new Error(`Ollama HTTP ${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    log.error('ollamaChat parse error', { model: target, error: err.message });
    throw new Error(`Ollama response parse error: ${err.message}`);
  }
  return data.message?.content || '';
}

async function pingOllama() {
  // Use _endpoint base if initialized, fall back to env var for pre-init pings
  const url = _endpoint
    ? _endpoint.replace('/api/chat', '')
    : process.env.OLLAMA_URL;
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

module.exports = { init, ollamaChat, pingOllama };
