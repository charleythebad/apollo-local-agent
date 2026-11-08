# The Personal Agent Governance Playbook

*Constitution, tombstones, and approval loops: running fallible AI agents with real
access on your own hardware — and trusting the result.*

Distilled from the Apollo/OpenClaw build (Mac mini M4 Pro, local models, Discord,
July 2026). The worked examples are real, including the failures.

---

## 0. Premise

Capable models are now cheap. A 24GB file gives you an agent that writes code,
reads your email, and runs shell commands. What's scarce is **trust** — and trust
is not a model property. It's an engineering artifact you build around the model.

The thesis of this playbook: **govern agents the way you'd govern a new team
member, not the way you'd configure software.** Written rules, scoped access,
supervised probation, earned autonomy, and a paper trail — with one difference
from human teams: assume the agent will confidently claim work is done when it
isn't, and design so that doesn't matter.

Who this is for: one person, one machine, agents with real access (email, money,
files, messages). Everything here runs without a cloud dependency and without
trusting any model's self-restraint.

---

## 1. Architecture: layers are trust boundaries, not agent counts

Adding more agents does not add a layer. A **layer** is defined by a change in
trust domain, capability class, or data scope. If a proposed agent doesn't differ
on one of those axes, it's sprawl — more hands, same brain, more context rent.

The reference stack:

| Layer | Occupant | Defining property |
|---|---|---|
| L0 | The principal (you) | Sole source of authorization |
| L1 | Deterministic core (bot with hand-written skills) | Executes exactly; routes; audits; never improvises |
| L2 | Local agent (LLM with tools) | Judgment + hands, private data, on-machine |
| L3 | Cloud reasoning (frontier API) | Thinks on sanitized briefs; proposes; never touches |

Two infrastructure choices that quietly do most of the governance work:

- **The bus is a chat channel** (Discord here). Every inter-agent message is
  human-readable, timestamped, and audited by default. You review your agents by
  scrolling.
- **The history is git.** Every skill, constitution, config mirror, and memory
  file is version-controlled. Rollback is `git revert`; forensics is `git log`.
  Archive the old version before modifying anything (belt), commit after (suspenders).

L3 note: constitutions do not protect data from a cloud model — **routing does**.
The relay that briefs a cloud agent decides what it sees. Enforce at the bridge,
write the constitution for the remaining 95% of behavior enforcement never sees.

---

## 2. The document set

Seven markdown files in the agent's workspace. Markdown, not a database, for one
decisive reason: **markdown is ambient — injected into every session
automatically. A vector store is opt-in — it only helps if the model decides to
query it, and local models reliably don't.** Passive context beats active
retrieval at this scale.

| File | Contents | Who may edit it |
|---|---|---|
| AGENTS.md | Operating rules, red lines, chain of command | Governor only |
| SOUL.md | Character, judgment norms, boundaries | Governor only |
| IDENTITY.md | Name, emoji, facts (no personality — that's SOUL's) | Governor only |
| USER.md | Principal context, deliberately trimmed to operational needs | Governor only |
| TOOLS.md | Setup-specific facts, per-skill notes | **The agent** (its one writable file) |
| MEMORY.md | Curated lessons and standing facts | Governor only; agent proposes out loud |
| HEARTBEAT.md | Tombstone (see §4) | Nobody |

("Governor" = the layer above: the principal, or the deterministic core acting
with the principal's approval.)

Rules that make the set work:

- **Ownership is the point.** The failure mode of agent memory isn't the file
  format — it's unsupervised self-curation. An agent that edits its own soul
  drifts. Fixed ownership + proposals-out-loud + approved diffs = evolution with
  a paper trail.
- **One fact, one home.** Personality lives in SOUL, facts in IDENTITY, setup in
  TOOLS. Duplication is how documents rot.
- **Keep MEMORY.md small.** It rides in every session's context. Lessons and
  standing facts, not logs. High-volume data (events, rides, records) goes to
  the vector store — that's what vectors are for.

---

## 3. The ten working principles

**1. Constitutions shape; fences enforce.** A written rule changes what the model
*tends* to do. It does not change what the model *can* do. For every red line,
know its mechanical backstop: tool allowlists, OAuth scopes, exec approvals,
routing. Where no backstop exists (they're often binary-granular, not
verb-granular), know that the line is held by obedience plus your review — and
supervise accordingly. *Worked example: the agent honored "writes only in the
sandbox" for project files, then scratch-wrote to /tmp the same night. Letter
violated, spirit intact, lesson recorded.*

**2. Code for the mechanical, model for the marginal.** Anything expressible as
a deterministic script must be one. The model's jobs: translating intent into
script parameters, judging ambiguous cases, and recovering from surprises.
*Worked example: Gmail triage. The model's freeform report was a confident
template with no data in it; the deterministic rewrite could not produce that
failure, and the model still shined at judgment ("these two senders are legit
local venues, not junk").*

**3. Recoverable verbs only.** Trash, never delete. Propose, never apply.
Archive, never overwrite. Every destructive path needs an undo window (Gmail's
trash gives 30 days free). If an action can't be made recoverable, it requires
the principal's hands, not the agent's.

**4. The autonomy ladder.** Capabilities are promoted, never granted:
report-only → human-approved execution ("reply *go*") → scheduled report with
human-triggered execution → scheduled execution (rarely reached, and only for
recoverable verbs). Each rung requires a clean record on the rung below.
Demotion is instant on any surprise.

**5. Tombstones for removed capabilities.** An absent file is an invitation — a
model trained on the framework's defaults will helpfully recreate it. A
deliberately-empty file stating *why* it's empty forecloses that: the reasoning
is at the point of curiosity. Same for config: disable the mechanism AND
document the decision in the file the mechanism reads.

**6. Verify behavior, not configuration.** After every governance change, test
the agent's understanding, not the file's existence: ask "what are your red
lines?" in a fresh session and check the answer against the current documents.
Config says what should happen; only behavior says what does. *Worked example:
the recitation test caught nothing wrong — and that's the point; it converts
"deployed" into "absorbed."*

**7. Idempotency is a safety property.** Every action script must be safely
rerunnable: operate only on what still matches, so a timeout, crash, or double
invocation costs nothing. Then "it died partway" has a one-word runbook: rerun.
*Worked example: a 2,882-message sweep survived a mid-run exec timeout because
the rerun matched only what remained.*

**8. Context is a consumable; fresh sessions are load-bearing.** Local models
degrade near their context limits — first slow (multi-minute prefills that look
like death), then wrong (malformed output, invented structure), then silent.
Budget context like disk: curate always-loaded skills (each enabled skill's
metadata rides in every session), start big tasks in fresh sessions, and treat
"session reset before heavy work" as maintenance, not emergency response.

**9. Rate the honest need.** Before building: has the pain been *felt*, or
merely measured? Optimizations that fix a measurement wait; those that fix an
experience get built. Most "obvious" improvements are a 2/10 on this scale and
should be parked with their design notes attached, so "not yet" is cheap and
"now" is fast. One-off scripts stay one-offs; a tool earns a home in the repo by
having a recurring decision to inform.

**10. Surprises surface; failures are lessons within the hour.** When the
dashboard disagrees with the disk, when a count doesn't reconcile, when the
agent does something clever you didn't ask for — stop and explain it before
proceeding. Every genuine incident becomes a MEMORY.md entry the agent reads in
every future session. The goal is an agent that has *ambiently absorbed* its own
history of mistakes. *Worked example: 54 "unexplained" surviving messages turned
out to be the important-mail guard working — a discrepancy chased to a
reassuring root cause instead of shrugged off.*

---

## 4. The failure catalog (what local agents actually do)

Observed in production, one day, one well-configured 35B MoE:

| Failure | What it looked like | What caught it |
|---|---|---|
| No self-verification | "60s all-core stress test ✅" that ran 2s of load and 58s of sleep | Independent measurement (load averages) |
| Premature completion | Placeholder report ("**Sender** — Count" ×20) posted mid-run | Verbatim-relay rule + deterministic rewrite |
| Scenic routes | Chose C over Python, burned 40 min on compiler errors | Tight brief with explicit constraints ("bash and Python only") |
| Invented API surface | Queried Gmail categories that don't exist | Deterministic script owns all queries |
| Context rot | Format failures, 10-min silent prefills, "couldn't generate a response" | Fresh session; session-reset runbook |
| Letter-vs-spirit | Scratch files written outside the sandbox | Review + explicit carve-out decision |
| Stale self-knowledge | "That skill isn't installed" (it was, post-session) | Agent's own resourcefulness (searched disk, found it, proceeded correctly) |

None of these were dangerous, because **the architecture assumed all of them in
advance.** That's the entire trick.

---

## 5. Starter kit

Day one:
1. Deterministic core first — a bot whose skills are hand-written code with no
   model in the loop. This is your L1 and your audit surface.
2. Git-init everything. Check the repo's history for secrets before it ever
   grows a remote; `.gitignore` the env file and verify it isn't already tracked.
3. Stand up the agent with the seven documents, written by you, owned per §2.
4. Behavioral verification: fresh session, "what are your rules?"

First week:
5. First skill: read-only, real data, report-only. Watch the logs while it runs.
6. Curate the always-loaded skill list down to what's used.
7. Kill idle machinery (heartbeats polling nothing burn context and compute 48
   times a day). Tombstone what you remove.
8. Nightly backup: plain-file mirror, built alongside the current snapshot,
   verified, then atomically swapped — a failed backup must never eat the good
   one. Off-machine when hardware allows.

First month:
9. Promote one skill up the autonomy ladder on evidence.
10. Seed MEMORY.md with the agent's own incidents. Re-run the behavioral test
    after every document change.
11. Only then consider a second agent — and only if it claims a new trust
    domain, capability class, or data scope (§1).

---

## 6. Why this works

Every mechanism above has the same shape: **move trust from the model to the
structure.** The model is allowed to be brilliant and unreliable at the same
time, because brilliance is captured by judgment-shaped work and unreliability
is absorbed by deterministic scaffolding, recoverable verbs, human gates, and
ambient memory.

The result is not a safer model. It's a system in which the model's failures
are boring.

---

*Built and field-tested on: OpenClaw + Ollama (local MoE model) + discord.js +
pm2 + git, governed by the documents and principles above. Model-agnostic by
construction — swap the brain, keep the government.*
