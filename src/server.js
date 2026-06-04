// ── codex-deepseek-proxy  v2.0.0 ──────────────────────────────
//
// Minimal local proxy that translates Codex CLI's Responses API
// requests into DeepSeek Chat Completions and returns properly
// formatted Responses API responses (JSON or pseudo-streaming SSE).
//
// Zero npm dependencies — uses only Node.js built-ins.
//
// Routes:
//   GET  /health           → health check
//   POST /v1/responses     → Responses API endpoint
//   POST /responses        → Responses API endpoint (no prefix)

const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');

const log = require('./logger');

// ── Adapters ───────────────────────────────────────────────────
const codexToDeepseek  = require('./adapters/codexResponsesToDeepseekChat');
const chatToRespJson   = require('./adapters/deepseekChatToResponsesJson');
const chatToRespSse    = require('./adapters/deepseekChatToResponsesSse');

// ── Configuration ──────────────────────────────────────────────
const HOST              = '127.0.0.1';
const PORT              = parseInt(process.env.PROXY_PORT || '11435', 10);
const DEEPSEEK_HOST     = 'api.deepseek.com';
const DEEPSEEK_PATH     = '/chat/completions';
const REQUEST_TIMEOUT   = 300000;  // 5 min
const MAX_RETRIES       = 3;
const RETRY_BASE_DELAY  = 1000;    // ms

// ── .env loader (zero deps) ────────────────────────────────────
(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (val && !process.env[key]) process.env[key] = val;
  }
})();

// ── HTTP helpers ───────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    res.on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── DeepSeek API call ──────────────────────────────────────────

function callDeepSeek(chatBody, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(chatBody);

    const opts = {
      hostname: DEEPSEEK_HOST,
      port:     443,
      path:     DEEPSEEK_PATH,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Length':  Buffer.byteLength(payload)
      },
      timeout: REQUEST_TIMEOUT
    };

    log.debug(`DeepSeek → model=${chatBody.model} msgs=${chatBody.messages.length} stream=${chatBody.stream} size=${Buffer.byteLength(payload)}B`);

    const req = https.request(opts, resolve);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Core request handler ───────────────────────────────────────

async function handleResponses(req, res, body) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'server_error', message: 'DEEPSEEK_API_KEY not set' }
    }));
    return;
  }

  const codexWantsStream = body.stream === true;
  const model = body.model || 'deepseek-chat';

  // ── Convert request ──────────────────────────────────────
  const chatBody = codexToDeepseek(body);

  // Log conversion details (no API key!)
  log.debug(`Codex → model=${model} stream=${codexWantsStream} ` +
    `input=${Array.isArray(body.input) ? `array[${body.input.length}]` : typeof body.input} ` +
    `instructions=${body.instructions ? 'yes' : 'no'} ` +
    `tools=${Array.isArray(body.tools) ? body.tools.length : 0}`);

  chatBody.messages.forEach((m, i) => {
    const preview = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .slice(0, 120).replace(/\n/g, ' ');
    log.debug(`  msg[${i}] role=${m.role} len=${(m.content || '').length} "${preview}"`);
  });

  log.debug(`DeepSeek body keys: [${Object.keys(chatBody).join(', ')}]`);

  // ── Call DeepSeek with retries ───────────────────────────
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        log.info(`Retry ${attempt}/${MAX_RETRIES} for ${model}`);
        await sleep(RETRY_BASE_DELAY * (attempt - 1));
      }

      const dsRes = await callDeepSeek(chatBody, apiKey);
      const rawText = await readResponse(dsRes);

      // Log response status
      log.debug(`DeepSeek ← status=${dsRes.statusCode} body_len=${rawText.length}`);

      // ── Error from DeepSeek ──────────────────────────────
      if (dsRes.statusCode !== 200) {
        // ALWAYS log the full error body for debugging (no key in response)
        log.error(`DeepSeek returned ${dsRes.statusCode}`, rawText.slice(0, 3000));

        if (dsRes.statusCode >= 500 && attempt < MAX_RETRIES) {
          lastError = new Error(`HTTP ${dsRes.statusCode}`);
          continue;  // retry on server errors
        }

        // 4xx: return error to Codex
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type:    'upstream_error',
            message: `DeepSeek API error: ${dsRes.statusCode}`,
            detail:  rawText.slice(0, 1000)
          }
        }));
        return;
      }

      // ── Parse DeepSeek response ──────────────────────────
      let chatResp;
      try {
        chatResp = JSON.parse(rawText);
      } catch (e) {
        log.error('Failed to parse DeepSeek JSON', rawText.slice(0, 500));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'server_error', message: 'Invalid JSON from DeepSeek' }
        }));
        return;
      }

      // Log success preview
      const textPreview = (chatResp.choices && chatResp.choices[0] &&
        chatResp.choices[0].message && chatResp.choices[0].message.content || '').slice(0, 200);
      log.debug(`DeepSeek OK  text_preview="${textPreview.replace(/\n/g, ' ')}"`);

      // ── Build Responses API object ───────────────────────
      const respObj = chatToRespJson(chatResp, body);
      log.info(`Done  model=${respObj.model} ` +
        `tokens=${respObj.usage.input_tokens}+${respObj.usage.output_tokens} ` +
        `output_items=${respObj.output.length} ` +
        `stream_mode=${codexWantsStream ? 'sse-pseudo' : 'json'}`);

      // ── Return to Codex ──────────────────────────────────
      if (!codexWantsStream) {
        // JSON response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respObj));
      } else {
        // Pseudo-streaming: wrap complete response as SSE events
        chatToRespSse(res, chatResp, body, respObj);
      }
      return;

    } catch (err) {
      log.error(`Attempt ${attempt} failed`, err);
      lastError = err;
      if (res.headersSent) return;
      if (attempt >= MAX_RETRIES) break;
    }
  }

  // All retries exhausted
  const errMsg = lastError ? lastError.message : 'Unknown error';
  log.error('All retries exhausted', errMsg);
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'server_error', message: `Proxy error after ${MAX_RETRIES} attempts: ${errMsg}` }
  }));
}

// ── HTTP Server ────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /health
  if (method === 'GET' && (url === '/health' || url === '/health/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      proxy:   'codex-deepseek-proxy',
      version: '2.0.0',
      key:     log.maskKey(process.env.DEEPSEEK_API_KEY),
      mode:    'pseudo-stream'
    }));
    return;
  }

  // POST /v1/responses or /responses
  if (method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
    try {
      const body = await readBody(req);
      log.info(`═══ ${method} ${url}  model=${body.model || '?'}  stream=${body.stream} ═══`);
      await handleResponses(req, res, body);
    } catch (err) {
      log.error('Request handler error', err);
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request', message: err.message }
      }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: url }));
});

// ── Start ──────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  log.info('═══════════════════════════════════════════════════');
  log.info('  codex-deepseek-proxy v2.0.0');
  log.info(`  http://${HOST}:${PORT}`);
  log.info(`  Key: ${log.maskKey(process.env.DEEPSEEK_API_KEY)}`);
  log.info(`  Mode: pseudo-stream (non-stream → SSE wrap)`);
  log.info('═══════════════════════════════════════════════════');
  if (!process.env.DEEPSEEK_API_KEY) {
    log.info('WARNING: DEEPSEEK_API_KEY not set! Set it in .env');
  }
});

// Graceful shutdown
function shutdown(sig) {
  log.info(`${sig} received, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', e => log.error('Uncaught', e));
process.on('unhandledRejection', e => log.error('Unhandled', e));
