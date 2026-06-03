// Exercises electron/sqlite-store.cjs against a temp DB. Run under Electron's
// Node: ELECTRON_RUN_AS_NODE=1 electron scripts/sqlite-store-test.cjs
const os = require('os');
const path = require('path');
const fs = require('fs');
const store = require('../electron/sqlite-store.cjs');

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  FAIL:', msg); } else console.log('  ok:', msg); };

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-sql-')), 'aios.db');
store.init(dbPath);
const c = store.call.bind(store);

console.log('snippets:');
c('putSnippet', [{ id: 's1', timestamp: 100, category: 'a', text: 'one' }]);
c('putSnippet', [{ id: 's2', timestamp: 300, category: 'b', text: 'two' }]);
c('putSnippet', [{ id: 's3', timestamp: 200, category: 'a', text: 'three' }]);
let snaps = c('getAllSnippets', []);
ok(snaps.length === 3, '3 snippets stored');
ok(snaps[0].id === 's2' && snaps[1].id === 's3' && snaps[2].id === 's1', 'sorted by timestamp DESC');
c('removeSnippet', ['s1']);
ok(c('getAllSnippets', []).length === 2, 'removeSnippet works');

console.log('meta (KV + types):');
c('setMeta', ['board', { cards: [1, 2, 3], updatedAt: 5 }]);
ok(JSON.stringify(c('getMeta', ['board'])) === JSON.stringify({ cards: [1, 2, 3], updatedAt: 5 }), 'object round-trip');
ok(c('getMeta', ['missing']) === null, 'missing key → null');
c('setMeta', ['layout', 'grid']);
ok(c('getMeta', ['layout']) === 'grid', 'string round-trip');

console.log('threads + messages:');
c('putThread', [{ id: 't1', timestamp: 10, title: 'T1' }]);
c('putMessage', [{ id: 'm1', threadId: 't1', content: 'hi' }]);
c('putMessage', [{ id: 'm2', threadId: 't1', content: 'yo' }]);
c('putMessage', [{ id: 'm3', threadId: 't2', content: 'other' }]);
ok(c('getAllThreads', []).length === 1, '1 thread');
ok(c('getMessagesForThread', ['t1']).length === 2, '2 messages for t1');
ok(c('getMessagesForThread', ['t2']).length === 1, '1 message for t2');

console.log('imports (batch + sort + clear-by-provider):');
c('putImports', [[
  { id: 'i1', provider: 'claude', createdAt: 1, updatedAt: 50 },
  { id: 'i2', provider: 'chatgpt', createdAt: 2, updatedAt: 90 },
  { id: 'i3', provider: 'claude', createdAt: 3 },
]]);
let imps = c('getAllImports', []);
ok(imps.length === 3 && imps[0].id === 'i2', 'sorted by updatedAt/createdAt DESC (i2 first)');
c('clearImports', ['chatgpt']);
ok(c('getAllImports', []).every((x) => x.provider === 'claude'), 'clearImports(provider) only removed chatgpt');

console.log('import_chunks (Float32 BLOB + GROUP BY counts):');
c('putImportChunks', [[
  { id: 'i1-c0', conversationId: 'i1', provider: 'claude', text: 'aaa', charCount: 3, embedding: [0.1, 0.2, 0.3] },
  { id: 'i1-c1', conversationId: 'i1', provider: 'claude', text: 'bbb', charCount: 3, embedding: [1, 2, 3, 4] },
  { id: 'i3-c0', conversationId: 'i3', provider: 'claude', text: 'ccc', charCount: 3, embedding: [] },
]]);
let chunks = c('getChunksForConversation', ['i1']);
ok(chunks.length === 2, '2 chunks for i1');
const e0 = chunks.find((x) => x.id === 'i1-c0').embedding;
ok(e0.length === 3 && Math.abs(e0[0] - 0.1) < 1e-6 && Math.abs(e0[2] - 0.3) < 1e-6, 'embedding round-trips (Float32 precision)');
ok(chunks.find((x) => x.id === 'i1-c0').text === 'aaa', 'non-embedding fields preserved');
const counts = c('getConversationChunkCounts', []);
const m = new Map(counts.map((r) => [r.conversationId, r.count]));
ok(m.get('i1') === 2 && m.get('i3') === 1, 'chunk counts grouped correctly');
ok(c('getAllImportChunks', []).length === 3, 'getAllImportChunks total');
c('deleteChunksForConversation', ['i1']);
ok(c('getAllImportChunks', []).length === 1, 'deleteChunksForConversation works');

console.log('agents (UNIQUE slug + sort):');
c('putAgent', [{ id: 'a1', slug: 'alpha', updatedAt: 5 }]);
c('putAgent', [{ id: 'a2', slug: 'beta', updatedAt: 9 }]);
let agents = c('getAllAgents', []);
ok(agents.length === 2 && agents[0].id === 'a2', 'sorted by updatedAt DESC');
c('putAgent', [{ id: 'a1', slug: 'alpha-renamed', updatedAt: 11 }]); // same id, replace OK
ok(c('getAllAgents', [])[0].id === 'a1', 'replace by id works');
let slugThrew = false;
try { c('putAgent', [{ id: 'a3', slug: 'beta', updatedAt: 1 }]); } catch { slugThrew = true; }
ok(slugThrew, 'duplicate slug on a new id is rejected (UNIQUE)');

console.log('runs (sort + by-card):');
c('putRun', [{ id: 'r1', cardId: 'card1', agentId: 'a1', startedAt: 100 }]);
c('putRun', [{ id: 'r2', cardId: 'card1', agentId: 'a1', startedAt: 300 }]);
c('putRun', [{ id: 'r3', cardId: 'card2', agentId: 'a2', startedAt: 200 }]);
ok(c('getAllRuns', [])[0].id === 'r2', 'all runs sorted by startedAt DESC');
const cardRuns = c('getRunsForCard', ['card1']);
ok(cardRuns.length === 2 && cardRuns[0].id === 'r2', 'runs for card1 sorted DESC');

console.log('bulkLoad (migration path):');
const dbPath2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-sql2-')), 'aios.db');
// Re-init a second DB by spawning a fresh store would need a new module; instead
// verify bulkLoad against the same store by loading into existing tables.
c('bulkLoad', [{
  snippets: [{ id: 'bs1', timestamp: 1, text: 'x' }],
  meta: [{ key: 'bk', value: { n: 1 } }],
  agents: [{ id: 'ba1', slug: 'bulk-agent', updatedAt: 1 }],
  importChunks: [{ id: 'bc1', conversationId: 'bcv', provider: 'claude', text: 'z', embedding: [9, 8, 7] }],
}]);
ok(c('getMeta', ['bk']).n === 1, 'bulkLoad meta');
ok(c('getChunksForConversation', ['bcv'])[0].embedding[0] === 9, 'bulkLoad chunk embedding');

console.log('');
console.log(failures === 0 ? 'ALL_STORE_TESTS_PASSED' : `STORE_TESTS_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
