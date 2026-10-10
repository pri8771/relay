// Operational error text only. Never serialize event payloads or configuration.
export function safeDiagnostic(value, knownPrompt = '') {
  if (typeof value !== 'string') return { category: 'UNCLASSIFIED', message: 'No structured error message' };
  const category = /code.mode.*unavailable.*host.*disabled/i.test(value) ? 'CODE_MODE_HOST_DISABLED' :
    /mcp|tool.*initializ/i.test(value) ? 'MCP_STARTUP' :
    /unauthori[sz]ed|authentication|credential/i.test(value) ? 'AUTH' :
    /sandbox|permission denied/i.test(value) ? 'SANDBOX' :
    /configuration|unknown feature|invalid.*config/i.test(value) ? 'CONFIGURATION' :
    /rate.limit|quota/i.test(value) ? 'RATE_LIMIT' :
    /connection|stream|timeout/i.test(value) ? 'TRANSPORT' : 'UNCLASSIFIED';
  let message = value;
  if (knownPrompt) {
    message = message.split(knownPrompt).join('[task redacted]');
    // Suppress error lines echoing known task lines or substantial fragments.
    for (const line of knownPrompt.split(/\r?\n/).filter(line => line.length >= 8)) {
      if (message.includes(line)) message = '[task diagnostic redacted]';
      for (let offset = 0; offset + 24 <= line.length; offset++) {
        if (message.includes(line.slice(offset, offset + 24))) message = '[task diagnostic redacted]';
      }
    }
  }
  message = message.split(/\r?\n/)[0].slice(0, 4096)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:authorization|(?:set-)?cookie)\s*[:=]\s*[^\r\n]+/gi, '[credential header redacted]')
    .replace(/\b[A-Z0-9_-]*(?:token|api[_-]?key|password|secret|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '[credential redacted]')
    .replace(/https?:\/\/\S+/gi, '[URL redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/["'](?:[A-Z]:\\|\/)[^"']*["']/gi, '[path redacted]')
    .replace(/(?:[A-Z]:\\|\/)[^\s"'<>),;]+/gi, '[path redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|[A-Za-z0-9_+\/=-]{24,})\b/g, '[opaque redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
  return { category, message };
}
