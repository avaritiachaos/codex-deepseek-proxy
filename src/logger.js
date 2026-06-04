// ── Logger ─────────────────────────────────────────────────────
// Writes to logs/proxy.log and stdout. Never leaks API keys.

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function ts() { return new Date().toISOString(); }

function write(line) {
  ensureDir();
  const entry = `[${ts()}] ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch (_) {}
  console.log(entry.trimEnd());
}

function info(msg)  { write(msg); }
function error(msg, detail) {
  const d = detail ? `\n  ${typeof detail === 'string' ? detail : (detail.stack || detail.message || String(detail))}` : '';
  write(`ERROR  ${msg}${d}`);
}
function debug(msg) { write(`DEBUG  ${msg}`); }

/** Mask an API key for safe logging */
function maskKey(k) {
  if (!k) return '(not set)';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

module.exports = { info, error, debug, maskKey };
