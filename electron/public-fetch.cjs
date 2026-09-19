// Research-only HTTP transport. This must never be used for provider/local
// agent connections, which have their own explicit endpoint configuration.
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const deniedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) deniedV4.addSubnet(address, prefix, 'ipv4');
deniedV4.addAddress('168.63.129.16', 'ipv4'); // Azure platform virtual IP
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new net.BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  deniedV6.addSubnet(address, prefix, 'ipv6');
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) return !deniedV4.check(address, 'ipv4');
  if (net.isIPv6(address)) return globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
  return false;
}

async function resolvePublicUrl(raw, lookup = dns.lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Research supports only HTTP(S) URLs without credentials.');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Research supports only web ports 80 and 443.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const answers = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) {
    throw new Error('Refusing to fetch a private, loopback, or reserved network address.');
  }
  return { url, address: answers[0].address, family: answers[0].family };
}

function requestPage(target, { method, headers, signal, maxBytes, headersOnly }) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? https : http;
    const request = transport.request(target.url, {
      method, signal, agent: false, maxHeaderSize: 16384,
      headers: { ...headers, 'Accept-Encoding': 'identity' },
      // Pin the approved DNS answer to the connection, preserving Host/SNI
      // and normal TLS certificate verification. No second DNS resolution.
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address: target.address, family: target.family }])
        : callback(null, target.address, target.family),
    }, response => {
      const status = response.statusCode || 0;
      const result = { status, headers: new Headers(Object.entries(response.headers)
        .filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)])) };
      response.on('error', reject);
      if (headersOnly || [301, 302, 303, 307, 308].includes(status)) {
        resolve({ ...result, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy();
        reject(new Error('Unexpected compressed research response.'));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error('Research response exceeds the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ ...result, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.on('upgrade', (_response, socket) => {
      socket.destroy(); reject(new Error('Protocol upgrades are not supported for research.'));
    });
    request.end();
  });
}

// Dependency injection is for deterministic adversarial tests, not API input.
function createPublicFetcher({ lookup = dns.lookup, request = requestPage } = {}) {
  return async function publicFetch(raw, { method = 'GET', headers = {}, timeoutMs = 20000,
    maxBytes = 4 * 1024 * 1024, headersOnly = false, signal: externalSignal } = {}) {
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Unsupported research method.');
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('Research request timed out.')), timeoutMs);
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = () => reject(signal.reason || new Error('Research canceled.')); });
    signal.addEventListener('abort', rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
    try {
      let current = raw;
      for (let hop = 0; hop <= 5; hop++) {
        const target = await Promise.race([resolvePublicUrl(current, lookup), aborted]);
        if (signal.aborted) throw signal.reason;
        const result = await Promise.race([request(target, { method, headers, signal, maxBytes, headersOnly }), aborted]);
        if ([301, 302, 303, 307, 308].includes(result.status)) {
          const location = result.headers.get('location');
          if (!location) throw new Error('Redirect has no destination.');
          // Validate the next destination BEFORE any bytes are sent to it.
          current = new URL(location, target.url).href;
          continue;
        }
        return {
          ok: result.status >= 200 && result.status < 300, status: result.status,
          url: target.url.href, headers: result.headers,
          text: async () => result.body.toString('utf8'),
        };
      }
      throw new Error('Too many research redirects.');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rejectAbort);
    }
  };
}

module.exports = { isPublicAddress, resolvePublicUrl, createPublicFetcher, publicFetch: createPublicFetcher() };
