// ================================================================
// codex-deepseek-proxy  –  OpenAI Responses API → DeepSeek proxy
// Designed for Codex CLI.  Zero npm dependencies (Node built-ins only).
// ================================================================

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

// ── Auto-load .env (zero dependencies) ─────────────────────────
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (val && !process.env[key]) {
      process.env[key] = val;
    }
  }
})();

// ── Configuration ──────────────────────────────────────────────
const HOST         = '127.0.0.1';
const PORT         = parseInt(process.env.PROXY_PORT || '11435', 10);
const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_PATH = '/chat/completions';
const REQUEST_TIMEOUT_MS = 300000;          // 5 min (match Codex stream_idle_timeout)
const MAX_RETRIES        = 3;
const RETRY_DELAY_MS     = 1000;

const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');

// ── Utilities ──────────────────────────────────────────────────

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function maskKey(k) {
  if (!k) return '(not set)';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(msg) {
  ensureLogDir();
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) { /* ignore */ }
  // Console: never print full API key
  console.log(line.trimEnd());
}

function logError(msg, err) {
  const detail = err ? (err.stack || err.message || String(err)) : '';
  log(`ERROR  ${msg}${detail ? '\n  ' + detail : ''}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Request conversion: Responses API → Chat Completions ───────

function responsesToChat(body) {
  const messages = [];

  // System / developer instructions
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // Walk input items
  const items = Array.isArray(body.input) ? body.input : [];
  for (const item of items) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }

    switch (item.type) {
      case 'message': {
        const parts = Array.isArray(item.content) ? item.content : [];
        const text  = parts
          .filter(p => p.type === 'output_text' || p.type === 'input_text' || p.type === 'text')
          .map(p => p.text || '')
          .join('\n');
        if (text) {
          messages.push({ role: item.role || 'user', content: text });
        }
        break;
      }
      case 'function_call': {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id || genId('call'),
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments || {})
            }
          }]
        });
        break;
      }
      case 'function_call_output': {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || '',
          content: item.output || ''
        });
        break;
      }
      default: {
        // Fallback: try to extract text
        if (item.content) {
          const text = Array.isArray(item.content)
            ? item.content.map(p => p.text || '').join('\n')
            : String(item.content);
          if (text) messages.push({ role: item.role || 'user', content: text });
        }
      }
    }
  }

  // Safety: ensure at least one message
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hello' });
  }

  // Tools
  let tools;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = body.tools.map(t => {
      const params = t.parameters
        || (t.function && t.function.parameters)
        || { type: 'object', properties: {} };
      return {
        type: 'function',
        function: {
          name: t.name || (t.function && t.function.name) || '',
          description: t.description || (t.function && t.function.description) || '',
          parameters: params
        }
      };
    });
  }

  const chatBody = {
    model: body.model || 'deepseek-chat',
    messages,
    stream: body.stream === true,
    temperature: body.temperature != null ? body.temperature : 1,
    max_tokens: body.max_output_tokens || body.max_tokens || 4096
  };

  if (tools) chatBody.tools = tools;

  // Pass-through: top_p, presence/frequency_penalty
  if (body.top_p != null)              chatBody.top_p = body.top_p;
  if (body.presence_penalty != null)   chatBody.presence_penalty = body.presence_penalty;
  if (body.frequency_penalty != null)  chatBody.frequency_penalty = body.frequency_penalty;

  return chatBody;
}

// ── Response conversion: Chat Completions → Responses API ──────

function chatToResponse(chatResp, requestBody) {
  const choice  = (chatResp.choices && chatResp.choices[0]) || {};
  const message = choice.message || {};
  const output  = [];
  const msgId   = genId('msg');

  // Text content
  const textItems = [];
  if (message.content) {
    const itemId = genId('item');
    textItems.push({
      type: 'message',
      id: itemId,
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: message.content,
        annotations: []
      }]
    });
  }

  // Tool calls
  const toolItems = [];
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      toolItems.push({
        type: 'function_call',
        id: genId('fc'),
        call_id: tc.id || genId('call'),
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || '{}'
      });
    }
  }

  // Build output: tool calls first (Codex expects them before text), then text
  output.push(...toolItems, ...textItems);

  // Fallback: at least one message
  if (output.length === 0) {
    output.push({
      type: 'message',
      id: genId('item'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }]
    });
  }

  return {
    id: genId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestBody.model || chatResp.model || 'unknown',
    output,
    usage: {
      input_tokens:  (chatResp.usage && chatResp.usage.prompt_tokens)     || 0,
      output_tokens: (chatResp.usage && chatResp.usage.completion_tokens) || 0,
      total_tokens:  (chatResp.usage && chatResp.usage.total_tokens)      || 0
    },
    temperature: requestBody.temperature || 1,
    top_p: requestBody.top_p || 1,
    max_output_tokens: requestBody.max_output_tokens || null,
    incomplete_details: null,
    error: null,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: requestBody.tools || []
  };
}

// ── Streaming conversion ───────────────────────────────────────

class StreamEmitter {
  constructor(res, responseId, model) {
    this.res        = res;
    this.responseId = responseId;
    this.model      = model;
    this.createdAt  = Math.floor(Date.now() / 1000);
    this.outputIdx  = 0;
    this.started    = false;
    this.currentItemId = null;

    // Accumulated state
    this.textContent    = '';
    this.toolCalls      = {};   // index → { id, name, arguments }
    this.emittedTextItem = false;
    this.finalized       = false;
  }

  _send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.res.write(payload);
  }

  _emitResponseCreated() {
    if (this.started) return;
    this.started = true;
    this._send('response.created', {
      type: 'response.created',
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'in_progress',
        model: this.model,
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        incomplete_details: null,
        error: null
      }
    });
  }

  // Ensure a text message item has been emitted
  _ensureTextItem() {
    this._emitResponseCreated();
    if (this.emittedTextItem) return;
    this.emittedTextItem = true;
    this.currentItemId   = genId('item');

    this._send('response.output_item.added', {
      type: 'response.output_item.added',
      response_id: this.responseId,
      output_index: this.outputIdx,
      item: {
        type: 'message',
        id: this.currentItemId,
        status: 'in_progress',
        role: 'assistant',
        content: []
      }
    });
    this._send('response.content_part.added', {
      type: 'response.content_part.added',
      response_id: this.responseId,
      item_id: this.currentItemId,
      output_index: this.outputIdx,
      content_index: 0,
      part: { type: 'output_text', text: '' }
    });
  }

  // Close the current text message item
  _closeTextItem() {
    if (!this.emittedTextItem) return;
    this._send('response.content_part.done', {
      type: 'response.content_part.done',
      response_id: this.responseId,
      item_id: this.currentItemId,
      output_index: this.outputIdx,
      content_index: 0,
      part: { type: 'output_text', text: this.textContent, annotations: [] }
    });
    this._send('response.output_item.done', {
      type: 'response.output_item.done',
      response_id: this.responseId,
      output_index: this.outputIdx,
      item: {
        type: 'message',
        id: this.currentItemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.textContent, annotations: [] }]
      }
    });
    this.outputIdx++;
    this.emittedTextItem = false;
    this.currentItemId   = null;
  }

  // Process a streaming delta
  onDelta(delta) {
    // Handle text content
    if (delta.content != null && delta.content !== '') {
      this._ensureTextItem();
      this.textContent += delta.content;
      this._send('response.output_text.delta', {
        type: 'response.output_text.delta',
        response_id: this.responseId,
        item_id: this.currentItemId,
        output_index: this.outputIdx,
        content_index: 0,
        delta: delta.content
      });
    }

    // Handle tool_calls
    if (Array.isArray(delta.tool_calls)) {
      // Close text item first if open
      if (this.emittedTextItem) this._closeTextItem();

      for (const tc of delta.tool_calls) {
        const idx = tc.index != null ? tc.index : 0;
        if (!this.toolCalls[idx]) {
          this.toolCalls[idx] = {
            id: tc.id || genId('call'),
            name: '',
            arguments: ''
          };
        }
        if (tc.function) {
          if (tc.function.name)      this.toolCalls[idx].name      += tc.function.name;
          if (tc.function.arguments) this.toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  // Finish streaming and emit completion events
  finalize() {
    if (this.finalized) return;
    this.finalized = true;

    this._emitResponseCreated();

    // Close text item if still open
    if (this.emittedTextItem) {
      this._send('response.output_text.done', {
        type: 'response.output_text.done',
        response_id: this.responseId,
        item_id: this.currentItemId,
        output_index: this.outputIdx,
        content_index: 0,
        text: this.textContent
      });
      this._closeTextItem();
    }

    // Emit tool call items
    const indices = Object.keys(this.toolCalls).sort((a, b) => a - b);
    for (const idx of indices) {
      const tc     = this.toolCalls[idx];
      const itemId = genId('fc');
      this._send('response.output_item.added', {
        type: 'response.output_item.added',
        response_id: this.responseId,
        output_index: this.outputIdx,
        item: {
          type: 'function_call',
          id: itemId,
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }
      });
      this._send('response.output_item.done', {
        type: 'response.output_item.done',
        response_id: this.responseId,
        output_index: this.outputIdx,
        item: {
          type: 'function_call',
          id: itemId,
          status: 'completed',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }
      });
      this.outputIdx++;
    }

    // If nothing was emitted at all, emit an empty message
    if (this.outputIdx === 0) {
      const itemId = genId('item');
      this._send('response.output_item.added', {
        type: 'response.output_item.added',
        response_id: this.responseId,
        output_index: 0,
        item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] }
      });
      this._send('response.output_item.done', {
        type: 'response.output_item.done',
        response_id: this.responseId,
        output_index: 0,
        item: {
          type: 'message', id: itemId, status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: '', annotations: [] }]
        }
      });
    }

    // response.completed
    this._send('response.completed', {
      type: 'response.completed',
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'completed',
        model: this.model,
        output: [],  // Codex should have collected items from streamed events
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        incomplete_details: null,
        error: null
      }
    });

    this.res.end();
  }

  emitError(message) {
    this._emitResponseCreated();
    this._send('response.failed', {
      type: 'response.failed',
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'failed',
        model: this.model,
        output: [],
        error: { type: 'server_error', message }
      }
    });
    this.res.end();
    this.finalized = true;
  }
}

// ── DeepSeek API call ──────────────────────────────────────────

function callDeepSeek(chatBody, apiKey, attempt = 1) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(chatBody);

    const options = {
      hostname: DEEPSEEK_HOST,
      port: 443,
      path: DEEPSEEK_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: REQUEST_TIMEOUT_MS
    };

    log(`DeepSeek request  model=${chatBody.model}  stream=${chatBody.stream}  msgs=${chatBody.messages.length}  attempt=${attempt}`);

    const req = https.request(options, (res) => {
      resolve(res);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`DeepSeek request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Read a non-streaming response body fully
function readResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    res.on('error', reject);
  });
}

// ── Request handler ────────────────────────────────────────────

async function handleResponsesRequest(req, res, body) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'server_error', message: 'DEEPSEEK_API_KEY environment variable not set' }
    }));
    return;
  }

  const chatBody   = responsesToChat(body);
  const isStream   = body.stream === true;
  const responseId = genId('resp');
  const model      = body.model || chatBody.model;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        log(`Retry attempt ${attempt} for ${model}`);
        await sleep(RETRY_DELAY_MS * (attempt - 1));
      }

      const dsRes = await callDeepSeek(chatBody, apiKey, attempt);

      // ── Non-streaming ──────────────────────────────────────
      if (!isStream) {
        if (dsRes.statusCode !== 200) {
          const errBody = await readResponse(dsRes);
          logError(`DeepSeek returned ${dsRes.statusCode}`, errBody);
          if (dsRes.statusCode >= 500 && attempt < MAX_RETRIES) {
            lastError = new Error(`HTTP ${dsRes.statusCode}`);
            continue;  // retry
          }
          res.writeHead(dsRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'upstream_error', message: `DeepSeek API error: ${dsRes.statusCode}`, detail: errBody }
          }));
          return;
        }

        const raw     = await readResponse(dsRes);
        let chatResp;
        try { chatResp = JSON.parse(raw); }
        catch (e) {
          logError('Failed to parse DeepSeek response', raw.slice(0, 500));
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'Invalid JSON from DeepSeek' } }));
          return;
        }

        const responseObj = chatToResponse(chatResp, body);
        log(`DeepSeek OK  model=${responseObj.model}  tokens=${responseObj.usage.input_tokens}+${responseObj.usage.output_tokens}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseObj));
        return;
      }

      // ── Streaming ──────────────────────────────────────────
      if (dsRes.statusCode !== 200) {
        const errBody = await readResponse(dsRes);
        logError(`DeepSeek stream returned ${dsRes.statusCode}`, errBody);
        if (dsRes.statusCode >= 500 && attempt < MAX_RETRIES) {
          lastError = new Error(`HTTP ${dsRes.statusCode}`);
          continue;
        }
        res.writeHead(dsRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: `DeepSeek API error: ${dsRes.statusCode}` } }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const emitter  = new StreamEmitter(res, responseId, model);
      let streamOk   = true;

      // Line-by-line SSE parser
      let buffer = '';
      dsRes.setEncoding('utf-8');

      await new Promise((resolveStream) => {
        dsRes.on('data', (chunk) => {
          if (!streamOk) return;
          buffer += chunk;

          let nlIdx;
          while ((nlIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nlIdx).trim();
            buffer = buffer.slice(nlIdx + 1);

            if (!line || line.startsWith(':')) continue;  // comment or empty

            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                emitter.finalize();
                resolveStream();
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const delta  = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) || {};
                emitter.onDelta(delta);
              } catch (e) {
                logError('SSE parse error', e);
              }
            }
          }
        });

        dsRes.on('end', () => {
          if (!emitter.finalized) emitter.finalize();
          resolveStream();
        });

        dsRes.on('error', (e) => {
          logError('DeepSeek stream error', e);
          streamOk = false;
          if (!emitter.finalized) emitter.emitError('Stream error from DeepSeek');
          resolveStream();
        });
      });

      log(`DeepSeek stream OK  model=${model}`);
      return;  // success, no retry needed

    } catch (err) {
      logError(`Attempt ${attempt} failed`, err);
      lastError = err;

      // For streaming, if headers already sent we cannot retry
      if (isStream && res.headersSent) {
        if (!res.writableEnded) {
          const emitter = new StreamEmitter(res, responseId, model);
          emitter.emitError(err.message);
        }
        return;
      }

      if (attempt >= MAX_RETRIES) break;
    }
  }

  // All retries exhausted
  const errMsg = lastError ? lastError.message : 'Unknown error';
  logError('All retries exhausted', errMsg);
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
  const url = req.url;
  const method = req.method;

  // CORS headers (just in case)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /health
  if (method === 'GET' && (url === '/health' || url === '/health/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      proxy: 'codex-deepseek-proxy',
      version: '1.0.0',
      deepseek_key: maskKey(process.env.DEEPSEEK_API_KEY)
    }));
    return;
  }

  // POST /v1/responses  or  POST /responses
  if (method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
    try {
      const body = await readBody(req);
      log(`Incoming request  ${method} ${url}  model=${body.model || '?'}  stream=${body.stream}`);
      await handleResponsesRequest(req, res, body);
    } catch (err) {
      logError('Request handling error', err);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request', message: err.message }
      }));
    }
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: url }));
});

// ── Start ──────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  log('═══════════════════════════════════════════════════════');
  log('  codex-deepseek-proxy v1.0.0');
  log(`  Listening on http://${HOST}:${PORT}`);
  log(`  Health check: http://${HOST}:${PORT}/health`);
  log(`  DeepSeek API key: ${maskKey(process.env.DEEPSEEK_API_KEY)}`);
  log(`  DEEPSEEK_HOST: ${DEEPSEEK_HOST}`);
  log('═══════════════════════════════════════════════════════');

  if (!process.env.DEEPSEEK_API_KEY) {
    log('WARNING: DEEPSEEK_API_KEY is not set! Requests will fail.');
    log('Set it via: setx DEEPSEEK_API_KEY "your-key"');
  }
});

// Graceful shutdown
function shutdown(signal) {
  log(`Received ${signal}, shutting down…`);
  server.close(() => {
    log('Server closed.');
    process.exit(0);
  });
  // Force close after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logError('Uncaught exception', err);
});
process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection', reason);
});
