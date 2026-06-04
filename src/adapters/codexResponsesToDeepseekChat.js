// ── Codex Responses API → DeepSeek Chat Completions ───────────
//
// Converts a Codex CLI Responses API request body into the
// Chat Completions format that DeepSeek /chat/completions accepts.
//
// Only fields DeepSeek understands are included. Everything else
// (metadata, store, include, previous_response_id, …) is dropped.

const crypto = require('crypto');
const log    = require('../logger');

// ── helpers ────────────────────────────────────────────────────

function genId(pfx) {
  return `${pfx}_${crypto.randomBytes(12).toString('hex')}`;
}

/** DeepSeek only accepts: system | user | assistant | tool */
function mapRole(role) {
  if (!role) return 'user';
  if (role === 'developer') return 'system';
  if (['system', 'user', 'assistant', 'tool'].includes(role)) return role;
  return 'user';
}

/**
 * Extract plain text from a Responses API content field.
 * - string → as-is
 * - array  → concatenate input_text / output_text / text parts
 * - other  → JSON.stringify
 */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => {
      if (typeof p === 'string') return p;
      if (p && ['input_text', 'output_text', 'text'].includes(p.type)) {
        return p.text || '';
      }
      if (p && p.text) return p.text;
      log.debug(`Unsupported content type: ${p && p.type}`);
      return '';
    }).filter(Boolean).join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

/**
 * Map Codex reasoning effort → DeepSeek reasoning_effort.
 * low/medium → high,  high → high,  xhigh/max → max
 */
function mapReasoningEffort(body) {
  const raw =
    (body.reasoning && body.reasoning.effort) ||
    body.model_reasoning_effort ||
    body.reasoning_effort;
  if (!raw) return null;
  const e = String(raw).toLowerCase();
  if (e === 'low' || e === 'medium' || e === 'high') return 'high';
  if (e === 'xhigh' || e === 'max') return 'max';
  return null;
}

/**
 * Convert Responses API tools to Chat Completions format.
 * Only keeps tools with type "function" and a valid non-empty name.
 * Skips web_search_preview, code_interpreter, mcp, etc.
 */
function convertTools(codexTools) {
  if (!Array.isArray(codexTools)) return null;

  const converted = [];
  const skipped = [];

  for (let i = 0; i < codexTools.length; i++) {
    const t = codexTools[i];

    // Extract name from various possible locations
    const name = t.name || (t.function && t.function.name) || null;

    // Only accept function-type tools with valid names
    if (!name || typeof name !== 'string' || name.trim() === '') {
      skipped.push({ index: i, type: t.type || 'unknown', reason: 'no valid name' });
      continue;
    }

    // Skip non-function tool types
    if (t.type && t.type !== 'function' && !t.function) {
      skipped.push({ index: i, type: t.type, reason: 'not a function tool' });
      continue;
    }

    converted.push({
      type: 'function',
      function: {
        name: name.trim(),
        description: (t.description || (t.function && t.function.description) || '').slice(0, 1024),
        parameters: t.parameters
          || (t.function && t.function.parameters)
          || { type: 'object', properties: {} }
      }
    });
  }

  if (skipped.length > 0) {
    log.info(`Tools: skipped ${skipped.length} invalid: ${skipped.map(s => `[${s.index}]${s.type}(${s.reason})`).join(', ')}`);
  }

  return converted.length > 0 ? converted : null;
}

// ── main converter ─────────────────────────────────────────────

/**
 * @param {object} body  – Codex Responses API request body
 * @returns {object}     – DeepSeek Chat Completions request body
 */
function codexResponsesToDeepseekChat(body) {
  const messages = [];

  // 1. instructions → system message
  if (body.instructions) {
    const text = extractText(body.instructions);
    if (text) messages.push({ role: 'system', content: text });
  }

  // 2. input → messages
  //    Track consecutive function_calls to group them into one assistant message
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    let pendingToolCalls = [];

    const flushToolCalls = () => {
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: pendingToolCalls
        });
        pendingToolCalls = [];
      }
    };

    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      if (typeof item === 'string') {
        flushToolCalls();
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;

      switch (item.type) {
        case 'message': {
          flushToolCalls();
          const text = extractText(item.content);
          if (text) messages.push({ role: mapRole(item.role), content: text });
          break;
        }
        case 'function_call': {
          // Group consecutive function_calls into one assistant message
          pendingToolCalls.push({
            id: item.call_id || genId('call'),
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments || {})
            }
          });
          break;
        }
        case 'function_call_output': {
          flushToolCalls();
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
          flushToolCalls();
          if (item.content) {
            const text = extractText(item.content);
            if (text) {
              messages.push({ role: mapRole(item.role), content: text });
              log.debug(`Degraded item[${i}] type=${item.type || '?'} → text`);
            }
          } else {
            log.debug(`Skipped item[${i}] type=${item.type || '?'} (no content)`);
          }
        }
      }
    }
    flushToolCalls(); // flush any remaining tool calls
  } else if (input != null) {
    messages.push({ role: 'user', content: String(input) });
  }

  // Safety: at least one message
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hello' });
  }

  // 3. Collapse consecutive system messages to head
  const collapsed = [];
  const systemParts = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      if (systemParts.length > 0) {
        collapsed.push({ role: 'system', content: systemParts.join('\n\n') });
        systemParts.length = 0;
      }
      collapsed.push(m);
    }
  }
  if (systemParts.length > 0) {
    collapsed.unshift({ role: 'system', content: systemParts.join('\n\n') });
  }

  // 4. Convert tools (filter out invalid ones)
  const tools = convertTools(body.tools);
  if (tools) {
    log.info(`Tools: ${tools.length} valid function tools passed to DeepSeek`);
  }

  // 5. Reasoning effort
  const reasoningEffort = mapReasoningEffort(body);

  // 6. Build final body — ONLY DeepSeek-compatible fields
  const chatBody = {
    model:      body.model || 'deepseek-chat',
    messages:   collapsed,
    stream:     false,                          // pseudo-stream: always non-stream to DeepSeek
    temperature: body.temperature != null ? body.temperature : 1,
    max_tokens: body.max_output_tokens || body.max_tokens || 4096
  };

  if (body.top_p != null)   chatBody.top_p = body.top_p;
  if (tools)                chatBody.tools = tools;
  if (body.tool_choice)     chatBody.tool_choice = body.tool_choice;
  if (reasoningEffort)      chatBody.reasoning_effort = reasoningEffort;

  return chatBody;
}

module.exports = codexResponsesToDeepseekChat;
