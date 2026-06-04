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
      if (p && p.text) return p.text;            // best-effort fallback
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
  const input = body.input;
  if (typeof input === 'string') {
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
          const text = extractText(item.content);
          if (text) messages.push({ role: mapRole(item.role), content: text });
          break;
        }
        case 'function_call': {
          log.info('Tool calling not fully supported — converting to assistant message');
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
          log.info('Tool calling not fully supported — converting tool result');
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
          // Unknown item — try text extraction, degrade gracefully
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
  } else if (input != null) {
    messages.push({ role: 'user', content: String(input) });
  }

  // Safety: at least one message
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hello' });
  }

  // 3. Collapse consecutive system messages to head (DeepSeek may reject
  //    system messages not at position 0 for some models)
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
    // Prepend remaining system messages to the very first message
    collapsed.unshift({ role: 'system', content: systemParts.join('\n\n') });
  }

  // 4. Tools — intentionally skipped for now.
  //    DeepSeek tool calling support is limited and untested.
  //    We strip tools so the model always returns plain text.
  //    This ensures simple text tasks succeed reliably.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    log.info(`Tool definitions detected (${body.tools.length}) — stripped (tool calling not fully supported yet)`);
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

  if (body.top_p != null)      chatBody.top_p = body.top_p;
  if (reasoningEffort)         chatBody.reasoning_effort = reasoningEffort;

  return chatBody;
}

module.exports = codexResponsesToDeepseekChat;
