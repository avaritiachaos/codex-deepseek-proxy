// ── DeepSeek Chat Completions → Responses API (SSE) ───────────
//
// "Pseudo-streaming" implementation: takes a COMPLETE DeepSeek
// Chat Completions JSON response and emits it as a valid
// Responses API SSE event stream that Codex CLI can consume.
//
// Event sequence (fixed order):
//   1. response.created
//   2. response.in_progress
//   3. response.output_item.added
//   4. response.content_part.added
//   5. response.output_text.delta  (×N, chunked 20-80 chars)
//   6. response.output_text.done
//   7. response.content_part.done
//   8. response.output_item.done
//   9. response.completed
//  10. data: [DONE]
//
// Inspiration: farion1231/cc-switch streaming_codex_chat.rs
// (MIT License — see NOTICE file)

const crypto = require('crypto');
const log    = require('../logger');

function genId(pfx) {
  return `${pfx}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Split text into chunks of 20–80 characters for realistic streaming.
 * Tries to break on whitespace/punctuation for natural-looking deltas.
 */
function chunkText(text) {
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 80) {
      chunks.push(remaining);
      break;
    }
    // Find a good break point between 20 and 80 chars
    let cut = 60;
    // Try to break on space, newline, comma, period, etc.
    for (let i = 79; i >= 20; i--) {
      const ch = remaining[i];
      if (ch === ' ' || ch === '\n' || ch === ',' || ch === '.' ||
          ch === ';' || ch === ':' || ch === ')' || ch === ']' || ch === '}') {
        cut = i + 1;
        break;
      }
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

/**
 * Write a single SSE event to the response stream.
 */
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Emit a complete DeepSeek Chat response as Responses API SSE events.
 *
 * @param {http.ServerResponse} res        – Node HTTP response
 * @param {object}              chatResp   – DeepSeek Chat Completions JSON
 * @param {object}              reqBody    – Original Codex request body
 * @param {object}              respObj    – Pre-built Responses API JSON (from deepseekChatToResponsesJson)
 */
function deepseekChatToResponsesSse(res, chatResp, reqBody, respObj) {
  const responseId = respObj.id;
  const model      = respObj.model;
  const createdAt  = respObj.created_at;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Extract text from the response object
  const messageItem = (respObj.output || []).find(o => o.type === 'message');
  const fullText = messageItem
    ? (messageItem.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('')
    : '';

  const msgId = messageItem ? messageItem.id : genId('msg');

  // ── 1. response.created ──────────────────────────────────
  sseWrite(res, 'response.created', {
    type: 'response.created',
    response: {
      id:         responseId,
      object:     'response',
      created_at: createdAt,
      status:     'in_progress',
      model,
      output:     [],
      usage:      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      incomplete_details: null,
      error:      null
    }
  });

  // ── 2. response.in_progress ──────────────────────────────
  sseWrite(res, 'response.in_progress', {
    type: 'response.in_progress',
    response: {
      id:         responseId,
      object:     'response',
      created_at: createdAt,
      status:     'in_progress',
      model,
      output:     [],
      usage:      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      incomplete_details: null,
      error:      null
    }
  });

  // ── 3. response.output_item.added ────────────────────────
  sseWrite(res, 'response.output_item.added', {
    type:         'response.output_item.added',
    response_id:  responseId,
    output_index: 0,
    item: {
      id:      msgId,
      type:    'message',
      status:  'in_progress',
      role:    'assistant',
      content: []
    }
  });

  // ── 4. response.content_part.added ───────────────────────
  sseWrite(res, 'response.content_part.added', {
    type:           'response.content_part.added',
    response_id:    responseId,
    item_id:        msgId,
    output_index:   0,
    content_index:  0,
    part: { type: 'output_text', text: '' }
  });

  // ── 5. response.output_text.delta (chunked) ──────────────
  const chunks = chunkText(fullText);
  for (const chunk of chunks) {
    sseWrite(res, 'response.output_text.delta', {
      type:           'response.output_text.delta',
      response_id:    responseId,
      item_id:        msgId,
      output_index:   0,
      content_index:  0,
      delta:          chunk
    });
  }

  // ── 6. response.output_text.done ─────────────────────────
  sseWrite(res, 'response.output_text.done', {
    type:           'response.output_text.done',
    response_id:    responseId,
    item_id:        msgId,
    output_index:   0,
    content_index:  0,
    text:           fullText
  });

  // ── 7. response.content_part.done ────────────────────────
  sseWrite(res, 'response.content_part.done', {
    type:           'response.content_part.done',
    response_id:    responseId,
    item_id:        msgId,
    output_index:   0,
    content_index:  0,
    part: {
      type:        'output_text',
      text:        fullText,
      annotations: []
    }
  });

  // ── 8. response.output_item.done ─────────────────────────
  sseWrite(res, 'response.output_item.done', {
    type:         'response.output_item.done',
    response_id:  responseId,
    output_index: 0,
    item: {
      id:      msgId,
      type:    'message',
      status:  'completed',
      role:    'assistant',
      content: [{
        type:        'output_text',
        text:        fullText,
        annotations: []
      }]
    }
  });

  // ── 9. response.completed (MUST be sent before closing) ──
  sseWrite(res, 'response.completed', {
    type: 'response.completed',
    response: {
      ...respObj,
      status: 'completed'
    }
  });

  log.debug('SSE response.completed emitted');

  // ── 10. [DONE] ───────────────────────────────────────────
  res.write('data: [DONE]\n\n');

  // Close the connection
  res.end();
}

module.exports = deepseekChatToResponsesSse;
