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

// Force non-streaming to DeepSeek even when Codex requests stream.
// Set to true after non-streaming is verified working.
const ENABLE_REAL_STREAM = true;

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

// Read a non-streaming response body fully
function readResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    res.on('error', reject);
  });
}

// ── Content extraction helper ──────────────────────────────────

/**
 * Extract plain text from a Responses API content field.
 * Content can be: string, array of { type, text }, or other.
 */
function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => {
        if (typeof p === 'string') return p;
        // Accept all text-like types from Responses API
        if (p && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text')) {
          return p.text || '';
        }
        // Fallback: try .text anyway
        if (p && p.text) return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

/**
 * Map Responses API role → DeepSeek-supported Chat Completions role.
 * DeepSeek only accepts: system, user, assistant, tool
 */
function mapRole(role) {
  if (!role) return 'user';
  if (role === 'developer') return 'system';  // ← key fix
  if (['system', 'user', 'assistant', 'tool'].includes(role)) return role;
  return 'user';  // fallback for any unknown role
}

/**
 * Map Codex reasoning effort to DeepSeek reasoning_effort.
 * medium/low → high,  high → high,  xhigh/max → max
 */
function mapReasoningEffort(body) {
  let effort = null;

  if (body.reasoning && typeof body.reasoning === 'object' && body.reasoning.effort) {
    effort = body.reasoning.effort;
  } else if (body.model_reasoning_effort) {
    effort = body.model_reasoning_effort;
  } else if (body.reasoning_effort) {
    effort = body.reasoning_effort;
  }

  if (!effort) return null;

  const e = String(effort).toLowerCase();
  if (e === 'low' || e === 'medium') return 'high';
  if (e === 'high') return 'high';
  if (e === 'xhigh' || e === 'max') return 'max';
  return null;  // unknown, don't send
}

// ── Request conversion: Responses API → Chat Completions ───────

function responsesToChat(body) {
  const messages = [];

  // 1. System instructions → system message
  if (body.instructions) {
    const text = extractTextContent(body.instructions);
    if (text) messages.push({ role: 'system', content: text });
  }

  // 2. Convert input → messages
  const input = body.input;

  if (typeof input === 'string') {
    // Simple string input
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      const item = input[i];

      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }

      if (!item || typeof item !== 'object') continue;

      switch (item.type) {
        case 'message': {
          const text = extractTextContent(item.content);
          if (text) {
            messages.push({
              role: mapRole(item.role),
              content: text
            });
          }
          break;
        }

        case 'function_call': {
          // Convert Responses function_call → Chat Completions tool_calls
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
          // Convert tool result
          messages.push({
            role: 'tool',
            tool_call_id: item.call_id || '',
            content: typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output || '')
          });
          break;
        }

        default: {
          // Unknown item type — try to extract text, degrade gracefully
          if (item.content) {
            const text = extractTextContent(item.content);
            if (text) {
              const mappedRole = mapRole(item.role);
              messages.push({ role: mappedRole, content: text });
              log(`DEBUG  Degraded item[${i}] type=${item.type || 'none'} role=${item.role} -> role=${mappedRole}`);
            }
          } else {
            log(`DEBUG  Skipped item[${i}] type=${item.type || 'none'} (no extractable content)`);
          }
        }
      }
    }
  } else if (input != null) {
    // input is something unexpected (number, object, etc.)
    messages.push({ role: 'user', content: String(input) });
  }

  // Safety: ensure at least one message
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hello' });
  }

  // 3. Convert tools (only if present)
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

  // 4. Reasoning effort
  const reasoningEffort = mapReasoningEffort(body);

  // 5. Build the DeepSeek body — ONLY fields DeepSeek understands
  const chatBody = {
    model: body.model || 'deepseek-chat',
    messages,
    stream: ENABLE_REAL_STREAM ? (body.stream === true) : false,
    temperature: body.temperature != null ? body.temperature : 1,
    max_tokens: body.max_output_tokens || body.max_tokens || 4096
  };

  if (tools)                chatBody.tools = tools;
  if (body.tool_choice)     chatBody.tool_choice = body.tool_choice;
  if (reasoningEffort)      chatBody.reasoning_effort = reasoningEffort;
  if (body.top_p != null)   chatBody.top_p = body.top_p;

  // Do NOT include: input, instructions, metadata, store, include,
  // previous_response_id, parallel_tool_calls, reasoning (raw object),
  // presence_penalty, frequency_penalty — DeepSeek may reject them.

  return chatBody;
}

// ── Debug: log both sides of the conversion ────────────────────

function logRequestDebug(codexBody, chatBody) {
  log(`DEBUG  Codex → model=${codexBody.model}  stream=${codexBody.stream}  ` +
      `input_type=${Array.isArray(codexBody.input) ? `array[${codexBody.input.length}]` : typeof codexBody.input}  ` +
      `instructions=${codexBody.instructions ? 'yes' : 'no'}  ` +
      `tools=${Array.isArray(codexBody.tools) ? codexBody.tools.length : 0}  ` +
      `max_output_tokens=${codexBody.max_output_tokens || 'n/a'}  ` +
      `reasoning=${JSON.stringify(codexBody.reasoning || null)}`);

  // Log messages summary (not full text — may be huge)
  chatBody.messages.forEach((m, i) => {
    const preview = typeof m.content === 'string'
      ? m.content.slice(0, 120).replace(/\n/g, ' ')
      : String(m.content).slice(0, 120);
    log(`DEBUG  msg[${i}] role=${m.role}  len=${(m.content || '').length}  preview="${preview}"${m.tool_calls ? '  [tool_calls]' : ''}`);
  });

  // Log the body structure (redact Authorization)
  const redacted = { ...chatBody };
  log(`DEBUG  DeepSeek body keys: [${Object.keys(redacted).join(', ')}]`);
  log(`DEBUG  DeepSeek body (no auth): ${JSON.stringify(redacted).slice(0, 2000)}`);
}

// ── Response conversion: Chat Completions → Responses API ──────

function chatToResponse(chatResp, requestBody) {
  const choice  = (chatResp.choices && chatResp.choices[0]) || {};
  const message = choice.message || {};
  const output  = [];

  // Text content
  if (message.content) {
    output.push({
      type: 'message',
      id: genId('msg'),
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
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: genId('fc'),
        call_id: tc.id || genId('call'),
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || '{}'
      });
    }
  }

  // Fallback: at least one message
  if (output.length === 0) {
    output.push({
      type: 'message',
      id: genId('msg'),
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
    tool_choice: requestBody.tool_choice || 'auto',
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

    this.textContent    = '';
    this.toolCalls      = {};
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

  onDelta(delta) {
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

    if (Array.isArray(delta.tool_calls)) {
      if (this.emittedTextItem) this._closeTextItem();
      for (const tc of delta.tool_calls) {
        const idx = tc.index != null ? tc.index : 0;
        if (!this.toolCalls[idx]) {
          this.toolCalls[idx] = { id: tc.id || genId('call'), name: '', arguments: '' };
        }
        if (tc.function) {
          if (tc.function.name)      this.toolCalls[idx].name      += tc.function.name;
          if (tc.function.arguments) this.toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  /** Emit a complete response from a non-streaming result as SSE events */
  emitFromComplete(responseObj) {
    this._emitResponseCreated();

    const output = responseObj.output || [];
    for (const item of output) {
      if (item.type === 'message') {
        this.currentItemId = item.id || genId('item');
        this.emittedTextItem = true;

        this._send('response.output_item.added', {
          type: 'response.output_item.added',
          response_id: this.responseId,
          output_index: this.outputIdx,
          item: { ...item, status: 'in_progress', content: [] }
        });
        this._send('response.content_part.added', {
          type: 'response.content_part.added',
          response_id: this.responseId,
          item_id: this.currentItemId,
          output_index: this.outputIdx,
          content_index: 0,
          part: { type: 'output_text', text: '' }
        });

        // Extract full text
        const text = (item.content || [])
          .filter(p => p.type === 'output_text')
          .map(p => p.text || '')
          .join('');
        this.textContent = text;

        this._send('response.output_text.delta', {
          type: 'response.output_text.delta',
          response_id: this.responseId,
          item_id: this.currentItemId,
          output_index: this.outputIdx,
          content_index: 0,
          delta: text
        });

        this._closeTextItem();
      } else if (item.type === 'function_call') {
        this._send('response.output_item.added', {
          type: 'response.output_item.added',
          response_id: this.responseId,
          output_index: this.outputIdx,
          item
        });
        this._send('response.output_item.done', {
          type: 'response.output_item.done',
          response_id: this.responseId,
          output_index: this.outputIdx,
          item: { ...item, status: 'completed' }
        });
        this.outputIdx++;
      }
    }

    // response.completed with full output
    this._send('response.completed', {
      type: 'response.completed',
      response: {
        ...responseObj,
        status: 'completed'
      }
    });

    this.res.end();
    this.finalized = true;
  }

  finalize() {
    if (this.finalized) return;
    this.finalized = true;

    this._emitResponseCreated();

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

    const indices = Object.keys(this.toolCalls).sort((a, b) => a - b);
    for (const idx of indices) {
      const tc     = this.toolCalls[idx];
      const itemId = genId('fc');
      this._send('response.output_item.added', {
        type: 'response.output_item.added',
        response_id: this.responseId,
        output_index: this.outputIdx,
        item: { type: 'function_call', id: itemId, call_id: tc.id, name: tc.name, arguments: tc.arguments }
      });
      this._send('response.output_item.done', {
        type: 'response.output_item.done',
        response_id: this.responseId,
        output_index: this.outputIdx,
        item: { type: 'function_call', id: itemId, status: 'completed', call_id: tc.id, name: tc.name, arguments: tc.arguments }
      });
      this.outputIdx++;
    }

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
        item: { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] }
      });
    }

    this._send('response.completed', {
      type: 'response.completed',
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'completed',
        model: this.model,
        output: [],
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

    log(`DeepSeek →  model=${chatBody.model}  stream=${chatBody.stream}  msgs=${chatBody.messages.length}  attempt=${attempt}  body_size=${Buffer.byteLength(payload)}B`);

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

  // Convert Codex Responses API → DeepSeek Chat Completions
  const chatBody = responsesToChat(body);

  // Debug: log both sides
  logRequestDebug(body, chatBody);

  const codexWantsStream = body.stream === true;
  const responseId       = genId('resp');
  const model            = body.model || chatBody.model;

  // If real streaming is disabled, force non-streaming to DeepSeek
  if (!ENABLE_REAL_STREAM) {
    chatBody.stream = false;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        log(`Retry attempt ${attempt} for ${model}`);
        await sleep(RETRY_DELAY_MS * (attempt - 1));
      }

      const dsRes = await callDeepSeek(chatBody, apiKey, attempt);

      // ── Real streaming path ──────────────────────────────
      if (ENABLE_REAL_STREAM && codexWantsStream && chatBody.stream) {
        if (dsRes.statusCode !== 200) {
          const errBody = await readResponse(dsRes);
          log(`DeepSeek ←  stream_error status=${dsRes.statusCode}`);
          log(`DeepSeek ←  error_body=${errBody.slice(0, 2000)}`);
          if (dsRes.statusCode >= 500 && attempt < MAX_RETRIES) {
            lastError = new Error(`HTTP ${dsRes.statusCode}`);
            continue;
          }
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'upstream_error', message: `DeepSeek API error: ${dsRes.statusCode}`, detail: errBody.slice(0, 1000) }
          }));
          return;
        }

        // SSE stream from DeepSeek → convert to Responses API SSE → Codex
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        const emitter = new StreamEmitter(res, responseId, model);
        let buffer = '';
        dsRes.setEncoding('utf-8');

        await new Promise((resolveStream) => {
          dsRes.on('data', (chunk) => {
            buffer += chunk;
            let nlIdx;
            while ((nlIdx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, nlIdx).trim();
              buffer = buffer.slice(nlIdx + 1);
              if (!line || line.startsWith(':')) continue;
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                  emitter.finalize();
                  resolveStream();
                  return;
                }
                try {
                  const parsed = JSON.parse(data);
                  const delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) || {};
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
            if (!emitter.finalized) emitter.emitError('Stream error from DeepSeek');
            resolveStream();
          });
        });

        log(`DeepSeek stream OK  model=${model}`);
        return;
      }

      // ── Non-streaming path ───────────────────────────────
      const rawText = await readResponse(dsRes);

      log(`DeepSeek ←  status=${dsRes.statusCode}  body_len=${rawText.length}`);
      if (dsRes.statusCode !== 200) {
        log(`DeepSeek ←  error_body=${rawText.slice(0, 2000)}`);
      } else {
        log(`DeepSeek ←  body_preview=${rawText.slice(0, 500)}`);
      }

      // ── Error handling ──────────────────────────────────────
      if (dsRes.statusCode !== 200) {
        if (dsRes.statusCode >= 500 && attempt < MAX_RETRIES) {
          lastError = new Error(`HTTP ${dsRes.statusCode}`);
          continue;  // retry on server errors
        }
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'upstream_error',
            message: `DeepSeek API error: ${dsRes.statusCode}`,
            detail: rawText.slice(0, 1000)
          }
        }));
        return;
      }

      // ── Parse DeepSeek response ─────────────────────────────
      let chatResp;
      try { chatResp = JSON.parse(rawText); }
      catch (e) {
        logError('Failed to parse DeepSeek JSON', rawText.slice(0, 500));
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'server_error', message: 'Invalid JSON from DeepSeek' }
        }));
        return;
      }

      // ── Convert to Responses API format ─────────────────────
      const responseObj = chatToResponse(chatResp, body);
      log(`DeepSeek OK  model=${responseObj.model}  ` +
          `tokens=${responseObj.usage.input_tokens}+${responseObj.usage.output_tokens}  ` +
          `output_items=${responseObj.output.length}`);

      // ── Return to Codex ─────────────────────────────────────
      if (!codexWantsStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseObj));
        return;
      }

      // Codex wants stream but we used non-streaming → wrap as SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const emitter = new StreamEmitter(res, responseId, model);
      emitter.emitFromComplete(responseObj);
      log(`Codex ←  SSE wrapped (non-stream → stream)  model=${model}`);
      return;

    } catch (err) {
      logError(`Attempt ${attempt} failed`, err);
      lastError = err;

      if (res.headersSent) {
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

  // CORS headers
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
      version: '1.1.0',
      deepseek_key: maskKey(process.env.DEEPSEEK_API_KEY),
      stream_mode: ENABLE_REAL_STREAM ? 'real' : 'non-stream-to-deepseek'
    }));
    return;
  }

  // POST /v1/responses  or  POST /responses
  if (method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
    try {
      const body = await readBody(req);
      log(`═══ Incoming  ${method} ${url}  model=${body.model || '?'}  stream=${body.stream} ═══`);
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
  log('  codex-deepseek-proxy v1.1.0');
  log(`  Listening on http://${HOST}:${PORT}`);
  log(`  Health check: http://${HOST}:${PORT}/health`);
  log(`  DeepSeek API key: ${maskKey(process.env.DEEPSEEK_API_KEY)}`);
  log(`  DEEPSEEK_HOST: ${DEEPSEEK_HOST}`);
  log(`  Stream mode: ${ENABLE_REAL_STREAM ? 'real streaming' : 'non-stream → SSE wrap'}`);
  log('═══════════════════════════════════════════════════════');

  if (!process.env.DEEPSEEK_API_KEY) {
    log('WARNING: DEEPSEEK_API_KEY is not set! Requests will fail.');
    log('Set it in .env or via: setx DEEPSEEK_API_KEY "your-key"');
  }
});

// Graceful shutdown
function shutdown(signal) {
  log(`Received ${signal}, shutting down…`);
  server.close(() => {
    log('Server closed.');
    process.exit(0);
  });
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
