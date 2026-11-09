# Apollo — a governed local AI agent

**Apollo is a personal AI agent that runs entirely on local models, governed like
a new team member instead of configured like software.** It has written rules,
scoped access, human approval for anything with real-world effect, and a paper
trail for every change. The running system also has a paper-trading skill
measured against SPY; this repo publishes the governance framework and the core
that enforces it.

> **NFA — not financial advice.** Nothing in this repository, including the
> approval gate, the financial guard, or any trading results, is a
> recommendation to buy, sell, or trade anything. Trading on the running system
> is **paper only**. Trade at your own risk.

> Personal project. Not affiliated with any company or product named Apollo.

-----

## Why this exists

Capable models are cheap now. A 24 GB file gives you an agent that writes code,
reads your email, and runs shell commands. What's scarce is **trust**, and trust
isn't a property of the model. It's something you build around the model.

The design rule throughout: **assume the agent will sometimes be confidently
wrong, and make that not matter.** Anything that must be right is plain code;
the model only handles language. Anything irreversible needs a human. Every rule
an agent could break has a mechanical backstop, not just a sentence in a prompt.

The full reasoning, with the real failures that shaped it, is in
[docs/agent-governance-playbook.md](docs/agent-governance-playbook.md).

## How it's built

```
Principal (you, in Discord — the only identity the bot listens to)
   │
   ▼
bot.js ─ deterministic core: wiring, routing, skill loader (no feature logic)
   │      chat: small model first, escalates to the large model when unsure
   │
   ├── skills (skl_*.js)       one file per feature, fixed 6-arg signature
   │     └── agent slots       a whole agent framework behind one skill
   ├── modules/                pure logic, unit-tested without Discord
   ├── governance/             constitution, roles, manifest, schema
   └── version_index.json      which governing documents are active
```

- **Local only at runtime.** Models run in Ollama on the same machine. No cloud
  inference, no always-on connection to any AI provider.
- **A frontier coding model is the builder, not the runtime.** It writes and
  changes skills only on the principal's instruction, explains each change in
  plain English first, and never approves anything itself.
- **Secrets live only in `.env`.** The manifest holds `${ENV_VAR}` placeholders,
  and the schema rejects a raw channel ID if one sneaks in.

## Slotted agents

Skills are slots, and a slot can hold an entire agent, not just a function.
In the running system, a separate agent framework ([OpenClaw](https://github.com/openclaw/openclaw))
sits behind two skills: a chat agent and an email agent. Apollo stays the
orchestrator, and each agent is just another governed slot.

```
Principal ──► Apollo (orchestrator)
                 ├── !oc   ──► chat agent     no tools at all
                 └── !pipe ──► pipeline (run by Apollo)
                                 1. agent A replies
                                 2. Apollo hands that reply to agent B (email: drafts only)
                                 3. plain code files the draft
```

How a slot is fenced:

- **Subprocess, not a shared process.** Each call spawns the agent's CLI with
  `spawn` (no shell) and a minimal environment, so unrelated tokens never reach
  the child. Every call has a timeout.
- **Principal-locked.** Only the principal can trigger a slot. Agents can't call
  each other, and can't call Apollo.
- **Least privilege per agent.** The chat agent has no tools. The email agent
  can write drafts, and sending is blocked by a wrapper around the mail CLI
  (see [`examples/no-send-email-shim.sh`](examples/no-send-email-shim.sh)).
- **One sanctioned hand-off.** Agent-to-agent composition happens only through
  the pipeline skill, where pipelines are data: each node's reply becomes the
  next node's prompt, and Apollo logs every step.
- **Deterministic where the model was unreliable.** When the email agent
  repeatedly failed to stage a draft, that step moved out of the agent and into
  plain code. The agent writes; code does the filing.

Known gap: the email agent's no-send rule is enforced by a wrapper, not an OS
sandbox, so an agent with shell access could go around it. See the playbook's
first lesson, "Constitutions shape; fences enforce."

The code is in this repo: [`modules/openclaw_relay.js`](modules/openclaw_relay.js)
(the fences), [`skl_010_openclaw_v1.0.js`](skl_010_openclaw_v1.0.js) (a slot is
about 20 lines), [`skl_012_pipeline_v1.0.js`](skl_012_pipeline_v1.0.js) and
[`modules/note_bundles.js`](modules/note_bundles.js). The `note` pipeline is the
"code does the filing" example: the agent's reply is refused unless the original
note's words are in it, in order. [`tests/agent_slots.test.js`](tests/agent_slots.test.js)
runs all of it against a fake agent and a fake draft command, including a child
process that must never see the bot's token, an agent that invents a report, and
one that hangs. The rules these follow are in
[`governance/roles.template.md`](governance/roles.template.md) (Tool Worker, Sub-Agent).

## What's in the repo

| Path | What it shows |
|---|---|
| [`governance/constitution.template.md`](governance/constitution.template.md) | 17 articles: hierarchy, guarded expansion categories, approval trail, builder protocol — each with a *why* note |
| [`governance/roles.template.md`](governance/roles.template.md) | Orchestrator, router, chat agent (no tools), tool worker (fenced tools), trading skill (code decides, human approves), builder |
| [`governance/manifest.example.json`](governance/manifest.example.json) · [`schema.example.json`](governance/schema.example.json) | Every proper noun and threshold in one place, with a schema it must match |
| [`tools/docs_audit.js`](tools/docs_audit.js) | Fails if the manifest drifts from the schema, or if the skill registry, `bot.js` and the files on disk disagree |
| [`tools/preflight.sh`](tools/preflight.sh) | Read-only check before any restart: code parses, audit, `.env` present and **not tracked by git**, services, model pin, backup age, jobs, kill switch, tests, uncommitted changes |
| [`skl_014_approval_gate_v1.0.js`](skl_014_approval_gate_v1.0.js) + [`modules/approval_gate.js`](modules/approval_gate.js) | Human approval gate: propose → principal-only ✅ → action, with expiry, a ledger, and crash-safe execution |
| [`modules/openclaw_relay.js`](modules/openclaw_relay.js) · [`skl_010`](skl_010_openclaw_v1.0.js) · [`skl_012`](skl_012_pipeline_v1.0.js) | Agent slots: another agent framework run as a fenced subprocess, and a pipeline where code, not the agent, files the result |
| [`skl_006_version_control_v1.4.js`](skl_006_version_control_v1.4.js) | Snapshot and all-or-nothing rollback of governing docs and skills, auto-committed to git |
| [`modules/jobs_runner.js`](modules/jobs_runner.js) | Cron scheduler: DST-safe matching, one run per job at a time, re-sends a failed post but never re-runs the job |
| [`modules/health_alerts.js`](modules/health_alerts.js) · [`health.js`](health.js) | One "down" alert after two failed checks, one "back" alert, nothing in between; self-recovery for Ollama and a stuck DNS cache (via Tailscale) |
| [`tools/nightly_backup.sh`](tools/nightly_backup.sh) | Build a fresh mirror, verify it, and only then rotate — a failed backup never eats the good one |
| [`examples/no-send-email-shim.sh`](examples/no-send-email-shim.sh) | Wrapper that lets an agent draft email but never send it, and blocks the agent from turning the guard off |

## The approval gate

Anything with real-world effect goes through the same loop:

1. `!propose <text>` — Apollo posts the proposal, with a short ID and an expiry, to the approvals channel.
2. The principal reacts ✅ on **that message** (or `!approve <id>`). ❌ or `!reject <id>` rejects it.
3. Approval from anyone else is ignored and logged. An approval at or after expiry counts as expired.
4. The approved state is saved **before** the action runs, and the action is idempotent, so a crash
   in between is finished on restart — never skipped, never doubled.
5. Every step lands in a ledger: `proposed → approved → executed`, or `rejected` / `expired`.

The example action only writes a text file. On the running system the same
pattern guards paper-trading orders: the code builds the proposal, a human
approves it, and a script places it.

## Run it

Requirements: Node 20+, [Ollama](https://ollama.com) with a large and a small
model pulled, and a Discord bot token.

```bash
git clone https://github.com/charleythebad/apollo-local-agent.git
cd apollo-local-agent
npm install
cp .env.example .env          # fill in token, your Discord user ID, channel IDs
# edit governance/manifest.example.json: your name and the two Ollama model names
npm test                      # unit tests, no network or Discord needed
npm run audit                 # governance drift check
tools/preflight.sh            # full pre-restart check
npm start
```

Commands (command channel, principal only): `!health`, `!status`,
`!propose`, `!approve`, `!reject`, `!proposals`, `!version save|list|rollback`,
`!logreport`, and with agent slots set up, `!oc` and `!pipe`. Unknown `!commands` get a list of real ones back — they never go to
the model, so a typo can't turn into a guess.

## Change ritual

Every change, however small:

1. `!version save <label>-pre` — the rollback point
2. Make the change; `tools/preflight.sh` must pass
3. Restart and test the changed command live
4. `!version save <label>` — then commit

## Limitations

- This is the governance core, not the whole running system. The trading skill,
  email agent's own setup and personal integrations are not published.
- One principal, one machine, Discord as the only interface. Tested on macOS.
- Rules in the constitution shape behavior; only code and configuration enforce it.
  Where a rule has no mechanical backstop, the playbook says so.

## Results

Monthly from December 2026: return and yearly rate per ticker and overall,
versus SPY on the same capital over the same days, plus fill rate and order
counts. Open positions are marked to market, because counting only closed
trades would hide losses. A yearly rate is shown only after 30 days of capital
at work. Percentages only: no dollar amounts, positions or strikes. Paper
account only. **NFA.**

## License

[MIT](LICENSE). NFA — not financial advice.
