// Process-lifetime credential. Never persisted, returned to a renderer, or logged.
const crypto = require('node:crypto');
const localToken = crypto.randomBytes(32).toString('hex');

function bearerToken(req) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  return match ? match[1] : '';
}

function tokensEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function localAuthHeaders() {
  return { Authorization: `Bearer ${localToken}` };
}

function localApiGuard({ development = false } = {}) {
  const origins = new Set(['null', ...(development ? ['http://localhost:3000'] : [])]);
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // An IP-literal Host prevents DNS-rebinding against loopback listeners.
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) {
      return res.status(403).json({ error: 'Invalid API host.' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return res.status(403).json({ error: 'Untrusted API origin.' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!tokensEqual(bearerToken(req), localToken)) {
      return res.status(401).json({ error: 'Local API authentication required.' });
    }
    next();
  };
}

// Exact method/path pairs only. Never expose filesystem, credentials, config,
// arbitrary agent execution, or cancellation of other clients' runs.
const MOBILE_PROXY_POST = new Set([
  'agents/draft', 'skills/draft', 'research/find-links', 'research/find-videos',
]);
function mobileProxyAllowed(method, path) {
  return method === 'POST' && MOBILE_PROXY_POST.has(path);
}

module.exports = { bearerToken, tokensEqual, localAuthHeaders, localApiGuard, mobileProxyAllowed };
