// User-configurable model IDs. Not encrypted (model names aren't secrets) —
// stored as plain JSON at %APPDATA%/AIOS/provider-models.json.
// Slots match ThreadedChat's ModelProvider semantics:
//   openai    — what the OpenAI button calls
//   claude    — Anthropic, variant=opus
//   anthropic — Anthropic, variant=sonnet
//   grok      — xAI

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  openai: 'gpt-4o',
  claude: 'claude-opus-4-8',
  anthropic: 'claude-sonnet-4-6',
  grok: 'grok-4',
  hermes: 'hermes-mac',
};

// Retired model IDs → their replacement. A stored value matching a retired ID
// is auto-upgraded on read (and re-persisted), so users who had the previous
// default don't get pinned to an old model.
const RETIRED = {
  claude: { 'claude-opus-4-7': 'claude-opus-4-8' },
};

function getFilePath() {
  return path.join(app.getPath('userData'), 'provider-models.json');
}

function readStore() {
  try {
    const file = getFilePath();
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const store = { ...DEFAULTS, ...parsed };
    // Upgrade any retired model IDs, persisting the change once.
    let changed = false;
    for (const slot of Object.keys(RETIRED)) {
      const replacement = RETIRED[slot][store[slot]];
      if (replacement) { store[slot] = replacement; changed = true; }
    }
    if (changed) { try { writeStore(store); } catch (_) { /* best effort */ } }
    return store;
  } catch (e) {
    console.error('Failed to read model store:', e);
    return { ...DEFAULTS };
  }
}

function writeStore(store) {
  fs.writeFileSync(getFilePath(), JSON.stringify(store, null, 2), { mode: 0o644 });
}

function getModelId(slot) {
  const store = readStore();
  return store[slot] || DEFAULTS[slot] || '';
}

function setModelId(slot, modelId) {
  if (!DEFAULTS.hasOwnProperty(slot)) throw new Error(`Unknown model slot: ${slot}`);
  const store = readStore();
  store[slot] = (modelId || '').trim() || DEFAULTS[slot];
  writeStore(store);
}

function getAllModels() {
  return readStore();
}

function resetSlot(slot) {
  if (!DEFAULTS.hasOwnProperty(slot)) throw new Error(`Unknown model slot: ${slot}`);
  const store = readStore();
  store[slot] = DEFAULTS[slot];
  writeStore(store);
}

module.exports = { getModelId, setModelId, getAllModels, resetSlot, DEFAULTS };
