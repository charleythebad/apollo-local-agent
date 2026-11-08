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

## What's in the repo

| Path | What it shows |
|---|---|
| [`governance/constitution.template.md`](governance/constitution.template.md) | 17 articles: hierarchy, guarded expansion categories, approval trail, builder protocol — each with a *why* note |
| [`governance/roles.template.md`](governance/roles.template.md) | Orchestrator, router, chat agent (no tools), tool worker (fenced tools), trading skill (code decides, human approves), builder |
| [`governance/manifest.example.json`](governance/manifest.example.json) · [`schema.example.json`](governance/schema.example.json) | Every proper noun and threshold in one place, with a schema it must match |
| [`tools/docs_audit.js`](tools/docs_audit.js) | Fails if the manifest drifts from the schema, or if the skill registry, `bot.js` and the files on disk disagree |
| [`tools/preflight.sh`](tools/preflight.sh) | Read-only check before any restart: code parses, audit, `.env` present and **not tracked by git**, services, model pin, backup age, jobs, kill switch, tests, uncommitted changes |
| [`skl_014_approval_gate_v1.0.js`](skl_014_approval_gate_v1.0.js) + [`modules/approval_gate.js`](modules/approval_gate.js) | Human approval gate: propose → principal-only ✅ → action, with expiry, a ledger, and crash-safe execution |
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
`!logreport`. Unknown `!commands` get a list of real ones back — they never go to
the model, so a typo can't turn into a guess.

## Change ritual

Every change, however small:

1. `!version save <label>-pre` — the rollback point
2. Make the change; `tools/preflight.sh` must pass
3. Restart and test the changed command live
4. `!version save <label>` — then commit

## Limitations

- This is the governance core, not the whole running system. The trading skill,
  email agent and personal integrations are not published.
- One principal, one machine, Discord as the only interface. Tested on macOS.
- Rules in the constitution shape behavior; only code and configuration enforce it.
  Where a rule has no mechanical backstop, the playbook says so.

## Results

Monthly paper-trading results versus SPY will be published here: percent
returns, win rate, max drawdown and trade count. No dollar amounts, and closed
positions only. **NFA.**
