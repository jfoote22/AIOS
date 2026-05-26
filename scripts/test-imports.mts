// Smoke test for Claude / ChatGPT import parsers.
// Run: npx tsx scripts/test-imports.mjs
//
// Bypasses IndexedDB by only calling the pure parser functions
// (detectProvider, parseClaude, parseChatGPT).

const mod = await import('../src/lib/imports.ts');
const { detectProvider, parseClaude, parseChatGPT, chunkConversation } = mod;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── Claude fixture ────────────────────────────────────────────────────────────
const claudeFixture = [
  {
    uuid: 'c1-aaaa',
    name: 'Vector DB picks',
    created_at: '2026-01-10T12:00:00Z',
    updated_at: '2026-01-11T08:30:00Z',
    chat_messages: [
      {
        uuid: 'm1', sender: 'human', created_at: '2026-01-10T12:00:00Z',
        content: [{ type: 'text', text: 'Which vector DB should I use?' }],
      },
      {
        uuid: 'm2', sender: 'assistant', created_at: '2026-01-10T12:00:30Z',
        content: [
          { type: 'text', text: 'Depends on scale.' },
          { type: 'text', text: 'For under 1M vectors, sqlite-vec is fine.' },
        ],
      },
      // Edge case: empty content array — should be dropped
      { uuid: 'm3', sender: 'human', content: [], text: '' },
    ],
  },
  {
    uuid: 'c2-bbbb',
    name: '',
    created_at: '2026-02-01T00:00:00Z',
    chat_messages: [
      // Edge case: text-only field, no content array
      { uuid: 'm1', sender: 'human', text: 'Hello (legacy text field)', created_at: '2026-02-01T00:00:00Z' },
      { uuid: 'm2', sender: 'assistant', text: 'Hi back.', created_at: '2026-02-01T00:00:10Z' },
    ],
  },
];

console.log('\nClaude parser');
ok('detects claude', detectProvider(claudeFixture) === 'claude');
const claudeOut = parseClaude(claudeFixture);
ok('returns 2 conversations', claudeOut.length === 2, `got ${claudeOut.length}`);
ok('first id prefixed claude-', claudeOut[0].id === 'claude-c1-aaaa');
ok('title preserved', claudeOut[0].title === 'Vector DB picks');
ok('untitled fallback', claudeOut[1].title === '(untitled)');
ok('user role mapped', claudeOut[0].messages[0].role === 'user');
ok('assistant role mapped', claudeOut[0].messages[1].role === 'assistant');
ok('multi-part text joined', claudeOut[0].messages[1].content.includes('Depends on scale.') && claudeOut[0].messages[1].content.includes('sqlite-vec'));
ok('empty messages dropped', claudeOut[0].messages.length === 2);
ok('legacy text field works', claudeOut[1].messages[0].content === 'Hello (legacy text field)');
ok('createdAt parsed to ms', typeof claudeOut[0].createdAt === 'number' && claudeOut[0].createdAt > 1700000000000);

// ── ChatGPT fixture ───────────────────────────────────────────────────────────
const chatgptFixture = [
  {
    id: 'g1-xxxx',
    title: 'Rust ownership question',
    create_time: 1736510400, // unix seconds
    update_time: 1736510500,
    current_node: 'n3',
    mapping: {
      'root': { id: 'root', parent: null, children: ['n1'], message: null },
      'n1':   { id: 'n1', parent: 'root', children: ['n2'],
                message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['You are helpful.'] } } },
      'n2':   { id: 'n2', parent: 'n1', children: ['n3'],
                message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Explain &str vs String'] },
                           create_time: 1736510410 } },
      'n3':   { id: 'n3', parent: 'n2', children: [],
                message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['&str is a borrowed slice; String owns.'] },
                           create_time: 1736510480 } },
      // Branch that should NOT be walked because current_node is n3
      'n2b':  { id: 'n2b', parent: 'n1', children: [],
                message: { author: { role: 'user' }, content: { parts: ['IGNORED BRANCH'] } } },
    },
  },
  {
    id: 'g2-yyyy',
    title: 'No current_node — deepest-leaf fallback',
    create_time: 1736600000,
    mapping: {
      'root': { id: 'root', parent: null, children: ['a'], message: null },
      'a':    { id: 'a', parent: 'root', children: ['b'],
                message: { author: { role: 'user' }, content: { parts: ['ping'] } } },
      'b':    { id: 'b', parent: 'a', children: [],
                message: { author: { role: 'assistant' }, content: { parts: ['pong'] } } },
    },
  },
];

console.log('\nChatGPT parser');
ok('detects chatgpt', detectProvider(chatgptFixture) === 'chatgpt');
const gptOut = parseChatGPT(chatgptFixture);
ok('returns 2 conversations', gptOut.length === 2, `got ${gptOut.length}`);
ok('first id prefixed chatgpt-', gptOut[0].id === 'chatgpt-g1-xxxx');
ok('walks current_node path', gptOut[0].messages.length === 3, `got ${gptOut[0].messages.length}`);
ok('system → user → assistant order', gptOut[0].messages.map(m => m.role).join(',') === 'system,user,assistant');
ok('ignores sibling branch', !JSON.stringify(gptOut[0].messages).includes('IGNORED BRANCH'));
ok('unix seconds → ms', gptOut[0].createdAt === 1736510400 * 1000);
ok('falls back to deepest leaf', gptOut[1].messages.length === 2 && gptOut[1].messages[1].content === 'pong');

// ── Detection ────────────────────────────────────────────────────────────────
console.log('\nDetection');
ok('rejects empty array', detectProvider([]) === null);
ok('rejects non-array', detectProvider({ foo: 1 }) === null);
ok('rejects unknown shape', detectProvider([{ foo: 1 }]) === null);

// ── Chunking ─────────────────────────────────────────────────────────────────
console.log('\nChunking');

const chunkA = chunkConversation({
  id: 'claude-x', provider: 'claude', title: 'Pairs',
  createdAt: 1, updatedAt: 2,
  messages: [
    { role: 'user', content: 'Hi.' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'How are you?' },
    { role: 'assistant', content: 'Good.' },
  ],
});
ok('two pairs → two chunks', chunkA.length === 2, `got ${chunkA.length}`);
ok('pair contains both USER and ASSISTANT', chunkA[0].text.includes('USER:') && chunkA[0].text.includes('ASSISTANT:'));
ok('turn indexes 0,1', chunkA[0].turnIndex === 0 && chunkA[1].turnIndex === 1);
ok('chunk ids include conv id', chunkA[0].id === 'claude-x-c0');

// Orphan user (no assistant follow) becomes its own chunk
const chunkB = chunkConversation({
  id: 'g-y', provider: 'chatgpt', title: 'Orphans',
  createdAt: 1, updatedAt: 2,
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Lone Q' },
    { role: 'assistant', content: 'Lone A' },
    { role: 'assistant', content: 'Trailing A with no prior Q' },
  ],
});
ok('system + pair + trailing assistant → 3 chunks', chunkB.length === 3, `got ${chunkB.length}`);
ok('first is SYSTEM', chunkB[0].text.startsWith('SYSTEM:'));
ok('second is paired', chunkB[1].text.includes('USER:') && chunkB[1].text.includes('ASSISTANT:'));
ok('third is lone ASSISTANT', chunkB[2].text.startsWith('ASSISTANT:'));

// Oversized pair → split into multiple chunks
const giant = 'x '.repeat(4000); // 8000 chars
const chunkC = chunkConversation({
  id: 'big', provider: 'claude', title: 'Big',
  createdAt: 1, updatedAt: 2,
  messages: [
    { role: 'user', content: giant },
    { role: 'assistant', content: giant },
  ],
});
ok('oversized pair splits into multiple chunks', chunkC.length >= 4, `got ${chunkC.length}`);
ok('no chunk exceeds cap', chunkC.every(c => c.charCount <= 3500), `max was ${Math.max(...chunkC.map(c => c.charCount))}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
