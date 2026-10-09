import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDiagnostic } from './safe-diagnostic.mjs';

test('operational diagnostics redact credentials, paths, URLs, emails and opaque values', () => {
  const result = safeDiagnostic('MCP initialization failed /Users/owner/private.cfg C:\\private\\file token=hidden password="hidden value" Bearer hiddenkey https://host/path?key=hidden person@example.com abcdef1234567890abcdef1234567890');
  assert.equal(result.category,'MCP_STARTUP');
  for (const fragment of ['owner','private.cfg','hidden','example.com','abcdef1234']) assert(!result.message.includes(fragment));
});
test('diagnostics never retain task text, additional lines or unbounded payloads', () => {
  const result = safeDiagnostic('error public task\nPRIVATE CONTEXT','public task');
  assert(!result.message.includes('public task'));
  assert(!result.message.includes('PRIVATE'));
  assert(safeDiagnostic('x '.repeat(1000)).message.length<=512);
  assert.equal(safeDiagnostic({secret:'not serialized'}).message,'No structured error message');
});
test('prefixed credential keys, full authorization values and task excerpts are suppressed', () => {
  for (const line of ['OPENAI_API_KEY=shortsecret', 'access_token=shortsecret', 'Authorization: Basic c2VjcmV0', 'Cookie: session=shortsecret; other=shortsecret']) {
    const result = safeDiagnostic(line);
    assert(!result.message.includes('shortsecret'));
    assert(!result.message.includes('c2VjcmV0'));
  }
  assert(!safeDiagnostic('failure "/Users/owner/private folder/file"').message.includes('private folder'));
  const task='first public task line\nLong controlled task fragment that must never be echoed into diagnostic evidence.';
  for (const excerpt of ['first public task line','controlled task fragment that must never']) {
    assert.equal(safeDiagnostic('failure echo '+excerpt,task).message,'[task diagnostic redacted]');
  }
});
