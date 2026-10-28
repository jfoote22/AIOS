// Lets Hermes act as chief of staff over every model AIOS can reach. AIOS
// serves an MCP endpoint (POST /mcp on the mobile gateway's port) that Hermes
// adds as a tool server; its tools hand a task to a specialist model and
// return the output for Hermes to review and report back.
//
// Roles are ordinary routed tasks (Settings → Models): 'coding' (Claude by
// default), 'general' (Grok), 'planning' (ChatGPT via Codex). Specialists
// answer in text — they don't get tools or file access here.
//
// Transport: MCP "streamable HTTP", stateless, JSON-RPC 2.0. Tool calls reply
// over SSE with keep-alive comments so a long delegation never trips the
// client's read timeout. Auth: its own bearer token (keystore
// 'hermes_bridge_token'), separate from the phone's.

const crypto = require('node:crypto');
const express = require('express');
const { getProviderKey, setProviderKey } = require('./keystore.cjs');
const { bearerToken, tokensEqual } = require('./http-security.cjs');
const router = require('./model-router.cjs');
const routing = require('./model-routing.cjs');

const SERVER_INFO = { name: 'aios', version: '1.0.0' };
const ROLES = ['coding', 'general', 'planning'];

const ROLE_BRIEFS = {
  coding: 'You are the coding specialist on a team run by Hermes, the user\'s chief of staff. Write correct, complete, runnable code and say exactly where it goes and how to verify it. Flag assumptions and risks briefly. You cannot run code or see files beyond what the task includes.',
  general: 'You are the general-purpose specialist on a team run by Hermes, the user\'s chief of staff. Do the task thoroughly and directly; lead with the answer, then the supporting detail Hermes needs.',
  planning: 'You are the organizing and planning specialist on a team run by Hermes, the user\'s chief of staff. Turn the task into a clear plan: goals, ordered steps with owners or tools, dependencies, risks, and what "done" looks like. Use concise headings and checklists.',
};

const INSTRUCTIONS = `AIOS gives you a team of specialist models. Work like a chief of staff: break the user's request into pieces, hand each piece to the right specialist with delegate, review what comes back, and report a short, decision-ready summary to the user (what was done, the result, what needs their call).
- coding → anything involving writing, reviewing or debugging code
- general → research, writing, analysis, everyday questions
- planning → organizing, prioritizing, schedules, project plans
Give each specialist full context; they can't see your conversation. Check their work before passing it on. Use ask_model only when the user names a specific model.`;

const TOOLS = [
  {
    name: 'delegate',
    description: `Hand a task to a specialist model and get its full output back. Roles: "coding" (code: write, review, debug — Claude by default), "general" (research, writing, analysis — Grok by default), "planning" (organizing, prioritizing, plans — ChatGPT/Codex by default). The specialist sees only what you send, so include all needed context. ${INSTRUCTIONS}`,
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ROLES, description: 'Which specialist: coding, general or planning.' },
        task: { type: 'string', description: 'What the specialist should do, stated completely.' },
        context: { type: 'string', description: 'Background, files, constraints or prior results the specialist needs.' },
      },
      required: ['role', 'task'],
    },
  },
  {
    name: 'ask_model',
    description: 'Send a task to one specific model by name, bypassing role routing. Use when the user asks for a particular model. Names come from list_models (e.g. "claude", "grok", "chatgpt", "gemini", or "claude:claude-opus-5").',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Connection or connection:model from list_models.' },
        task: { type: 'string', description: 'What the model should do, stated completely.' },
        context: { type: 'string', description: 'Background the model needs.' },
      },
      required: ['model', 'task'],
    },
  },
  {
    name: 'list_models',
    description: 'List the models AIOS can reach, whether each is ready, and which model each delegate role uses.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── token ────────────────────────────────────────────────────────────────────

function getToken() {
  return getProviderKey('hermes_bridge_token') || '';
}
function ensureToken() {
  let token = getToken();
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    setProviderKey('hermes_bridge_token', token);
  }
  return token;
}
function regenerateToken() {
  const token = crypto.randomBytes(24).toString('hex');
  setProviderKey('hermes_bridge_token', token);
  return token;
}

// ── tools ────────────────────────────────────────────────────────────────────

function promptFor(task, context) {
  return context && String(context).trim() ? `${task}\n\nContext:\n${context}` : String(task);
}

function listModels() {
  const store = routing.read();
  const conns = router.catalog(store);
  const lines = conns.map((c) => `- ${c.id}${c.available ? '' : ' (not set up)'}: ${c.label} — ${c.models.map((m) => m.id || 'plan default').join(', ')}`);
  const roles = ROLES.map((r) => {
    const { list } = router.candidates(r);
    return `- ${r}: ${list[0]?.label || 'no model available'}`;
  });
  return `Models:\n${lines.join('\n')}\n\nDelegate roles:\n${roles.join('\n')}`;
}

async function callTool(name, args, signal) {
  if (name === 'list_models') return listModels();
  const task = typeof args?.task === 'string' ? args.task.trim() : '';
  if (!task) throw new Error('task is required.');
  if (task.length > 400_000 || String(args.context || '').length > 1_000_000) throw new Error('Task too large.');
  if (name === 'delegate') {
    if (!ROLES.includes(args.role)) throw new Error(`role must be one of ${ROLES.join(', ')}.`);
    const { text, label } = await router.generate({
      task: args.role, system: ROLE_BRIEFS[args.role], prompt: promptFor(task, args.context),
      effort: args.role === 'planning' ? 'medium' : 'low', signal,
    });
    return `${text}\n\n— ${label} (${args.role})`;
  }
  if (name === 'ask_model') {
    const { text, label } = await router.generateOn(String(args.model || ''), {
      prompt: promptFor(task, args.context), signal,
    });
    return `${text}\n\n— ${label}`;
  }
  throw new Error(`Unknown tool "${name}".`);
}

// ── MCP over streamable HTTP ─────────────────────────────────────────────────

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleMessage(msg, signal) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await callTool(params?.name, params?.arguments || {}, signal);
      return rpcResult(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      // Tool failures go back to Hermes as results it can read and act on.
      return rpcResult(id, { content: [{ type: 'text', text: `Failed: ${router.shortError(e)}` }], isError: true });
    }
  }
  return rpcError(id ?? null, -32601, `Method not found: ${method}`);
}

function requireBridgeToken(req, res, next) {
  const token = getToken();
  if (!token || !tokensEqual(bearerToken(req), token)) {
    return res.status(401).json(rpcError(null, -32001, 'Invalid or missing bearer token.'));
  }
  next();
}

/** Express router mounted at /mcp on the gateway. */
function mcpRouter() {
  const r = express.Router();
  r.use(requireBridgeToken);
  r.post('/', express.json({ limit: '4mb' }), async (req, res) => {
    const msg = req.body;
    if (!msg || msg.jsonrpc !== '2.0' || Array.isArray(msg)) {
      return res.status(400).json(rpcError(null, -32600, 'Expected one JSON-RPC 2.0 message.'));
    }
    // Notifications (no id) need no reply.
    if (msg.id === undefined || msg.id === null) return res.status(202).end();

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const wantsSse = String(req.headers.accept || '').includes('text/event-stream');
    if (msg.method !== 'tools/call' || !wantsSse) {
      return res.json(await handleMessage(msg, abort.signal));
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const keepAlive = setInterval(() => { try { res.write(': working\n\n'); } catch {} }, 15000);
    try {
      const reply = await handleMessage(msg, abort.signal);
      if (!abort.signal.aborted) res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } finally { clearInterval(keepAlive); }
  });
  // Stateless server: no server-initiated stream and no sessions to end.
  r.all('/', (_req, res) => res.status(405).set('Allow', 'POST').end());
  return r;
}

module.exports = { mcpRouter, ensureToken, regenerateToken, getToken, callTool, handleMessage, TOOLS, ROLES };
