// tools/docs_audit.js — governance drift check (manual utility, not a skill)
// Validates the ACTIVE manifest against the ACTIVE schema, both resolved from
// version_index.json — no hardcoded versions (same rule as skl_006).
// Two-way: flags manifest keys the schema never declared (drift) AND required
// schema fields the manifest is missing. Also checks types, pinned values,
// patterns, and that every version_index active pointer resolves to a real file.
// Registry-vs-reality: cross-checks bot.js require lines, skl_*.js files on
// disk, and skill_registry.active three ways, so a skill deployed outside the
// pipeline (how skl_011/012 went unregistered for a week) is caught.
// Usage: node tools/docs_audit.js   (exit 0 = clean, 1 = drift found)

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.APOLLO_ROOT || path.join(__dirname, '..');
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'version_index.json'), 'utf8'));

const problems = [];

// ── Active pointers all resolve to real files ────────────────────────────────
const pointers = { ...idx.active, ...idx.active.channel_constitutions };
for (const [key, val] of Object.entries(pointers)) {
  if (typeof val !== 'string' || !val.includes('/')) continue; // versions, dates, nested blocks
  if (!fs.existsSync(path.join(ROOT, val)) && !fs.existsSync(val)) {
    problems.push(`POINTER: active.${key} -> ${val} does not exist`);
  }
}

// ── Manifest vs schema, two-way ──────────────────────────────────────────────
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, idx.active.schema), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, idx.active.manifest), 'utf8'));

function checkObj(declared, actual, at) {
  for (const key of Object.keys(actual)) {
    if (!declared[key]) problems.push(`UNDECLARED: ${at}${key} exists in manifest but not schema`);
  }
  for (const [key, spec] of Object.entries(declared)) {
    const val = actual[key];
    if (val === undefined) {
      if (spec.required) problems.push(`MISSING: required ${at}${key} absent from manifest`);
      continue;
    }
    const t = Array.isArray(val) ? 'array'
      : typeof val === 'number' ? (Number.isInteger(val) ? 'integer' : 'number')
      : typeof val;
    if (!(spec.type === 'number' && (t === 'integer' || t === 'number')) && spec.type !== t) {
      problems.push(`TYPE: ${at}${key} is ${t}, schema says ${spec.type}`);
    }
    if (spec.value !== undefined && val !== spec.value) {
      problems.push(`VALUE: ${at}${key} = ${JSON.stringify(val)}, schema pins ${JSON.stringify(spec.value)}`);
    }
    if (spec.pattern && typeof val === 'string' && !new RegExp(spec.pattern).test(val)) {
      problems.push(`PATTERN: ${at}${key} = ${val} fails ${spec.pattern}`);
    }
    if (spec.fields && t === 'object') checkObj(spec.fields, val, `${at}${key}.`);
    if (spec.items && spec.items.fields && t === 'array') {
      val.forEach((item, i) => checkObj(spec.items.fields, item, `${at}${key}[${i}].`));
    }
  }
}

checkObj(schema.fields, manifest, '');

// ── Registry vs reality: bot.js requires ↔ files on disk ↔ registry ─────────
const botSrc = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8');
const required = [...botSrc.matchAll(/require\('\.\/(skl_[^']+?)(?:\.js)?'\)/g)].map(m => m[1] + '.js');
const onDisk = fs.readdirSync(ROOT).filter(f => /^skl_\d+.*\.js$/.test(f));
const registry = manifest.skill_registry.active;

for (const req of required) {
  if (!onDisk.includes(req)) problems.push(`REQUIRE: bot.js requires ${req} but the file is not on disk`);
  if (!registry.some(e => e.filename === req)) {
    problems.push(`REGISTRY: ${req} is loaded by bot.js but has no skill_registry.active entry`);
  }
}
for (const e of registry) {
  if (!e.filename) continue; // pre-V6 naming — "not yet migrated" is a legitimate state (build protocol §8)
  if (!onDisk.includes(e.filename)) problems.push(`REGISTRY: ${e.name} -> ${e.filename} is not on disk`);
  if (e.type === 'utility_module') continue; // imported by skills.js, not loaded via bot.js
  if (!required.includes(e.filename)) {
    problems.push(`REGISTRY: ${e.name} is registered but ${e.filename} is not required in bot.js`);
  }
}
for (const f of onDisk) {
  if (!required.includes(f) && !registry.some(e => e.filename === f)) {
    problems.push(`ORPHAN: ${f} is on disk but neither required in bot.js nor registered`);
  }
}

// ── Schema-version agreement ─────────────────────────────────────────────────
if (manifest._schema_version !== schema._schema_version) {
  problems.push(`VERSION: manifest._schema_version ${manifest._schema_version} != schema ${schema._schema_version}`);
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\nDRIFT: ${problems.length} problem(s). Per schema conflict_resolution: flag to principal, suspend manifest writes.`);
  process.exit(1);
}
console.log(`CLEAN: manifest v${manifest._manifest_version} conforms to schema v${schema._schema_version}; all active pointers resolve.`);
