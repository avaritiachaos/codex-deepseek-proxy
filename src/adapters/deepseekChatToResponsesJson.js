// ── DeepSeek Chat Completions → Responses API (JSON) ──────────
//
// Converts a DeepSeek /chat/completions JSON response into the
// OpenAI Responses API JSON object that Codex CLI expects when
// stream=false.

const crypto = require('crypto');

function genId(pfx) {
  return `${pfx}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * @param {object} chatResp   – DeepSeek Chat Completions response
 * @param {object} reqBody    – Original Codex request body (for model/usage reference)
 * @returns {object}          – Responses API JSON object
 */
function deepseekChatToResponsesJson(chatResp, reqBody) {
  const choice  = (chatResp.choices && chatResp.choices[0]) || {};
  const message = choice.message || {};
  const output  = [];

  // Text content → message item
  if (message.content) {
    output.push({
      id:     genId('msg'),
      type:   'message',
      status: 'completed',
      role:   'assistant',
      content: [{
        type: 'output_text',
        text: message.content,
        annotations: []
      }]
    });
  }

  // Tool calls → function_call items
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        type:      'function_call',
        id:        genId('fc'),
        status:    'completed',
        call_id:   tc.id || genId('call'),
        name:      (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || '{}'
      });
    }
  }

  // Fallback: empty message if nothing produced
  if (output.length === 0) {
    output.push({
      id:     genId('msg'),
      type:   'message',
      status: 'completed',
      role:   'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }]
    });
  }

  // Determine status and end_turn from finish_reason
  // 'tool_calls' means model wants to call tools → end_turn = false
  // 'stop' means model finished normally → end_turn = true
  // 'length' means truncated → status = incomplete
  const finishReason = choice.finish_reason || 'stop';
  const status = finishReason === 'length' ? 'incomplete' : 'completed';
  const endTurn = finishReason !== 'tool_calls';

  return {
    id:         genId('resp'),
    object:     'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model:      reqBody.model || chatResp.model || 'unknown',
    output,
    usage: {
      input_tokens:  (chatResp.usage && chatResp.usage.prompt_tokens)     || 0,
      output_tokens: (chatResp.usage && chatResp.usage.completion_tokens) || 0,
      total_tokens:  (chatResp.usage && chatResp.usage.total_tokens)      || 0
    },
    temperature:         reqBody.temperature != null ? reqBody.temperature : 1,
    top_p:               reqBody.top_p != null ? reqBody.top_p : 1,
    max_output_tokens:   reqBody.max_output_tokens || null,
    incomplete_details:  status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    error:               null,
    end_turn:            endTurn
  };
}

module.exports = deepseekChatToResponsesJson;
