// skl_010_openclaw_v1.0.js
// Command: !oc <directive>  →  the slotted chat agent, reply in its own channel
// Thin wrapper: all relay logic and fences live in modules/openclaw_relay.js.
// The chat agent itself is configured with no tools (OpenClaw profile "minimal").

'use strict';

const { makeRelay } = require('./modules/openclaw_relay');

module.exports = makeRelay({
  command:        '!oc',
  agentId:        process.env.AGENT_CHAT_ID || 'main',
  channelKey:     'agentChat',
  channelLabel:   'agent-chat',
  channelEnvName: 'CHANNEL_AGENT_CHAT',
  skillId:        'skl_010_openclaw',
  sklTag:         'SKL-010',
  delegatingMsg:  'Delegating to the chat agent...',
  toPrefix:       '[Apollo→Agent]',
  fromPrefix:     '[Agent→Apollo]',
  timeoutMsg:     'The chat agent did not respond within the timeout.',
  usageMsg:       'Usage: !oc <directive>'
});
