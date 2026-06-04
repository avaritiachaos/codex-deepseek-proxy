// ── DeepSeek Chat Completions → Responses API (SSE) ───────────
//
// "Pseudo-streaming" implementation: takes a COMPLETE DeepSeek
// Chat Completions JSON response and emits it as a valid
// Responses API SSE event stream that Codex CLI can consume.
//
// Supports both text message output and function_call output.
//
// Event sequence per output item:
//   message:
//     output_item.added → content_part.added →
//     output_text.delta (×N) → output_text.done →
//     content_part.done → output_item.done
//   function_call:
//     output_item.added →
//     function_call_arguments.delta (×N) → function_call_arguments.done →
//     output_item.done
//
// Final events:
//   response.completed → data: [DONE]
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
    let cut = 60;
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
 * Split a JSON arguments string into small chunks for streaming.
 * Chunks are smaller (10-40 chars) since JSON is dense.
 */
function chunkArguments(argsStr) {
  if (!argsStr || argsStr === '{}') return [argsStr || '{}'];
  const chunks = [];
  let remaining = argsStr;
  while (remaining.length > 0) {
    if (remaining.length <= 40) {
      chunks.push(remaining);
      break;
    }
    // Try to break after a comma or colon for readability
    let cut = 30;
    for (let i = 39; i >= 10; i--) {
      const ch = remaining[i];
      if (ch === ',' || ch === ':' || ch === ' ') {
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
 * Emit a text message output item as SSE events.
 * Returns the number of events emitted.
 */
function emitMessageItem(res, responseId, outputIndex, item) {
  const msgId = item.id || genId('msg');
  const fullText = (item.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text || '')
    .join('');

  // output_item.added
  sseWrite(res, 'response.output_item.added', {
    type:         'response.output_item.added',
    response_id:  responseId,
    output_index: outputIndex,
    item: {
      id:      msgId,
      type:    'message',
      status:  'in_progress',
      role:    'assistant',
      content: []
    }
  });

  // content_part.added
  sseWrite(res, 'response.content_part.added', {
    type:           'response.content_part.added',
    response_id:    responseId,
    item_id:        msgId,
    output_index:   outputIndex,
    content_index:  0,
    part: { type: 'output_text', text: '' }
  });

  // output_text.delta (chunked)
  const chunks = chunkText(fullText);
  for (const chunk of chunks) {
    sseWrite(res, 'response.output_text.delta', {
      type:           'response.output_text.delta',
      response_id:    responseId,
      item_id:        msgId,
      output_index:   outputIndex,
      content_index:  0,
      delta:          chunk
    });
  }

  // output_text.done
  sseWrite(res, 'response.output_text.done', {
    type:           'response.output_text.done',
    response_id:    responseId,
    item_id:        msgId,
    output_index:   outputIndex,
    content_index:  0,
    text:           fullText
  });

  // content_part.done
  sseWrite(res, 'response.content_part.done', {
    type:           'response.content_part.done',
    response_id:    responseId,
    item_id:        msgId,
    output_index:   outputIndex,
    content_index:  0,
    part: {
      type:        'output_text',
      text:        fullText,
      annotations: []
    }
  });

  // output_item.done
  sseWrite(res, 'response.output_item.done', {
    type:         'response.output_item.done',
    response_id:  responseId,
    output_index: outputIndex,
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
}

/**
 * Emit a function_call output item as SSE events.
 */
function emitFunctionCallItem(res, responseId, outputIndex, item) {
  const fcId   = item.id      || genId('fc');
  const callId = item.call_id || genId('call');
  const name   = item.name    || '';
  const args   = item.arguments || '{}';

  // output_item.added
  sseWrite(res, 'response.output_item.added', {
    type:         'response.output_item.added',
    response_id:  responseId,
    output_index: outputIndex,
    item: {
      type:      'function_call',
      id:        fcId,
      call_id:   callId,
      name:      name,
      arguments: '',
      status:    'in_progress'
    }
  });

  // function_call_arguments.delta (chunked)
  const argChunks = chunkArguments(args);
  for (const chunk of argChunks) {
    sseWrite(res, 'response.function_call_arguments.delta', {
      type:         'response.function_call_arguments.delta',
      response_id:  responseId,
      item_id:      fcId,
      output_index: outputIndex,
      delta:        chunk
    });
  }

  // function_call_arguments.done
  sseWrite(res, 'response.function_call_arguments.done', {
    type:         'response.function_call_arguments.done',
    response_id:  responseId,
    item_id:      fcId,
    output_index: outputIndex,
    arguments:    args
  });

  // output_item.done
  sseWrite(res, 'response.output_item.done', {
    type:         'response.output_item.done',
    response_id:  responseId,
    output_index: outputIndex,
    item: {
      type:      'function_call',
      id:        fcId,
      call_id:   callId,
      name:      name,
      arguments: args,
      status:    'completed'
    }
  });
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
  const outputItems = respObj.output || [];

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no'
  });

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

  // ── 3. Emit each output item ────────────────────────────
  for (let i = 0; i < outputItems.length; i++) {
    const item = outputItems[i];

    if (item.type === 'function_call') {
      emitFunctionCallItem(res, responseId, i, item);
      log.debug(`SSE: emitted function_call[${i}] name=${item.name} call_id=${item.call_id}`);
    } else {
      // Default: treat as message
      emitMessageItem(res, responseId, i, item);
    }
  }

  // Log summary
  const msgCount = outputItems.filter(o => o.type !== 'function_call').length;
  const fcCount  = outputItems.filter(o => o.type === 'function_call').length;
  log.debug(`SSE: emitted ${msgCount} message(s) + ${fcCount} function_call(s), end_turn=${respObj.end_turn}`);

  // ── 4. response.completed ────────────────────────────────
  sseWrite(res, 'response.completed', {
    type: 'response.completed',
    response: {
      ...respObj,
      status: 'completed'
    }
  });

  log.debug('SSE response.completed emitted');

  // ── 5. [DONE] ────────────────────────────────────────────
  res.write('data: [DONE]\n\n');

  // Close the connection
  res.end();
}

module.exports = deepseekChatToResponsesSse;
