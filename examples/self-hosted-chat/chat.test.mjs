import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mountOwnerChat } from './chat.mjs';

const origin = 'http://127.0.0.1:8787';
const target = { toolId: 'codex', agentId: 'codex-id', agentName: 'codex-mac-relay', label: 'Codex (Mac)' };
const channel = { name: 'owner-chat', id: 'channel-id' };
function fixture(overrides = {}) {
  const store = overrides.store ?? new Map();
  let sequence = store.size + 1000;
  let toolRuns = 0;
  let available = true;
  const save = (text, threadId, agentId, agentName, metadata = {}) => {
    const message = { id: String(++sequence), text, threadId, channelId: channel.id,
      agentId, agentName, metadata, createdAt: new Date().toISOString() };
    store.set(message.id, message);
    return structuredClone(message);
  };
  const ownerClient = {
    send: async (_channel, prompt, opts) => save(prompt, null, 'owner-id', 'owner', opts.data),
    reply: async (rootId, prompt, opts) => save(prompt, rootId, 'owner-id', 'owner', opts.data),
    messages: async (_channel, opts) => [...store.values()].filter((m) => m.threadId === null &&
      (!opts.before || BigInt(m.id) < BigInt(opts.before))).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, opts.limit),
    thread: async (id, opts) => ({ parent: structuredClone(store.get(id)), replies: [...store.values()]
      .filter((m) => m.threadId === id && (!opts.after || BigInt(m.id) > BigInt(opts.after)))
      .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, opts.limit).map((m) => structuredClone(m)) }),
    message: async (id) => structuredClone(store.get(id)),
  };
  const toolReply = (request, changes = {}) => {
    const message = save('Actual tool answer', request.rootId, target.agentId, target.agentName,
      { session_ref: `owner-chat:${request.promptMessageId}` });
    Object.assign(store.get(message.id), changes);
    return { replyId: message.id };
  };
  const runTool = async (request) => {
    toolRuns++;
    return overrides.runTool ? overrides.runTool(request, { store, toolReply, ownerClient }) : toolReply(request);
  };
  const mount = () => {
    const app = new Hono();
    mountOwnerChat(app, { ownerClient, ownerId: 'owner-id', channel, target, origin, runTool,
      getToolStatus: async () => ({ available }), replyTimeoutMs: overrides.replyTimeoutMs ?? 1000 });
    return app;
  };
  const app = mount();
  const post = (body = {}, headers = {}) => app.request(`${origin}/owner-chat/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify({ toolId: 'codex', prompt: 'Hello tool', externalConversationId: 'webui-chat', requestId: 'turn-1', ...body }),
  });
  return { app, store, ownerClient, mount, post, save, toolReply,
    runs: () => toolRuns, offline: () => { available = false; } };
}

test('actual persisted reply is read back and native conversation mapping survives restart', async () => {
  const f = fixture();
  const response = await f.post();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.answer, 'Actual tool answer');
  const prompt = f.store.get(result.data.conversationId);
  assert.deepEqual(prompt.metadata, { source: 'owner-chat', toolId: 'codex', externalConversationId: 'webui-chat', requestId: 'turn-1' });
  const reopened = await f.mount().request(`${origin}/owner-chat/api/conversations/${prompt.id}`);
  assert.deepEqual((await reopened.json()).data.messages.map((m) => m.role), ['owner', 'tool']);
  const retried = await f.post();
  assert.deepEqual((await retried.json()).data, result.data);
  assert.equal(f.runs(), 1);
  f.offline();
  assert.equal((await f.post()).status, 200, 'saved answer remains readable while tool is offline');
});

test('follow-up prompt and reply remain in the same Relay thread', async () => {
  const f = fixture();
  const first = (await (await f.post()).json()).data;
  const second = (await (await f.post({ requestId: 'turn-2', prompt: 'Another question' })).json()).data;
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(f.store.get(second.replyId).threadId, first.conversationId);
  assert.notEqual(second.replyId, first.replyId);
  const reopened = await f.app.request(`${origin}/owner-chat/api/conversations/${first.conversationId}`);
  assert.equal((await reopened.json()).data.messages.length, 4);
});

for (const [label, change] of [
  ['wrong sender id', { agentId: 'other-agent' }],
  ['wrong sender name', { agentName: 'pretender' }],
  ['wrong channel', { channelId: 'other-channel' }],
  ['wrong thread', { threadId: 'other-thread' }],
  ['wrong prompt session', { metadata: { session_ref: 'owner-chat:old-prompt' } }],
  ['empty answer', { text: '   ' }],
]) {
  test(`rejects ${label}`, async () => {
    const f = fixture({ runTool: (request, { toolReply }) => toolReply(request, change) });
    const response = await f.post();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'REPLY_NOT_VERIFIED');
  });
}

test('missing or fabricated callback reply is rejected', async () => {
  const f = fixture({ runTool: () => ({ replyId: 'fiction', answer: 'Fabricated text' }) });
  const response = await f.post();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'REPLY_NOT_VERIFIED');
});

test('a previous reply cannot answer a follow-up prompt', async () => {
  let previous;
  const f = fixture({ runTool: (request, { toolReply }) => {
    if (previous) return previous;
    previous = toolReply(request); return previous;
  } });
  assert.equal((await f.post()).status, 200);
  const response = await f.post({ requestId: 'turn-2' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'REPLY_NOT_VERIFIED');
});

test('direct persisted read must match thread reply', async () => {
  const f = fixture({ runTool: (request, { toolReply, ownerClient }) => {
    const result = toolReply(request);
    ownerClient.message = async () => ({ ...f.store.get(result.replyId), text: 'Changed after thread read' });
    return result;
  } });
  assert.equal((await f.post()).status, 502);
});

test('pending reply times out honestly, aborts waiter, and late reply is recovered without reexecution', async () => {
  let captured;
  const f = fixture({ replyTimeoutMs: 5, runTool: (request) => {
    captured = request;
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('wait aborted'))));
  } });
  const pending = await f.post();
  assert.equal(pending.status, 504);
  assert.equal((await pending.json()).error.code, 'REPLY_PENDING');
  assert.equal(captured.signal.aborted, true);
  f.toolReply(captured);
  assert.equal((await f.post()).status, 200);
  assert.equal(f.runs(), 1);
});

test('offline tool is reported and cannot receive a new prompt', async () => {
  const f = fixture(); f.offline();
  const tools = await f.app.request(`${origin}/owner-chat/api/tools`);
  assert.equal((await tools.json()).data[0].available, false);
  const response = await f.post();
  assert.equal(response.status, 503);
  assert.equal(f.store.size, 0);
  assert.equal(f.runs(), 0);
});

for (const [label, body, headers] of [
  ['blank prompt', { prompt: '  ' }, {}],
  ['oversized prompt', { prompt: 'x'.repeat(8001) }, {}],
  ['unknown tool', { toolId: 'grokbot' }, {}],
  ['invalid native chat id', { externalConversationId: '../private' }, {}],
  ['extra field', { unexpected: true }, {}],
  ['foreign origin', {}, { Origin: 'https://foreign.example' }],
  ['missing origin', {}, { Origin: '' }],
  ['cross-site browser', {}, { 'Sec-Fetch-Site': 'cross-site' }],
  ['wrong content type', {}, { 'Content-Type': 'text/plain' }],
]) {
  test(`rejects ${label} before changing Relay`, async () => {
    const f = fixture();
    const response = await f.post(body, headers);
    assert.ok([400, 403].includes(response.status));
    assert.equal(f.store.size, 0);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });
}

test('native turn id cannot be reused with a different prompt', async () => {
  const f = fixture(); await f.post();
  const response = await f.post({ prompt: 'Changed text' });
  assert.equal(response.status, 409);
  assert.equal(f.runs(), 1);
});

test('SDK/model errors never leak into the API', async () => {
  const f = fixture({ runTool: () => { throw new Error('private credential value'); } });
  const response = await f.post();
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private credential/);
});

test('legacy and unrelated conversations cannot be reopened', async () => {
  const f = fixture();
  const root = f.save('Historic original Bus conversation', null, 'owner-id', 'owner');
  const response = await f.app.request(`${origin}/owner-chat/api/conversations/${root.id}`);
  assert.equal(response.status, 404);
  assert.equal(f.store.get(root.id).text, root.text);
});

test('conversations longer than 100 replies survive persisted reload', async () => {
  const f = fixture();
  const first = (await (await f.post()).json()).data;
  for (let i = 0; i < 110; i++) {
    f.save(`Follow-up ${i}`, first.conversationId, 'owner-id', 'owner', { source: 'owner-chat', toolId: 'codex' });
  }
  const response = await f.mount().request(`${origin}/owner-chat/api/conversations/${first.conversationId}`);
  assert.equal((await response.json()).data.messages.length, 112);
});

test('installed upstream SDK preserves custom owner metadata and raw MCP session_ref', async () => {
  const { camelizeKeys, decamelizeKeys } = await import('../../node_modules/@relaycast/sdk/dist/casing.js');
  const data = { source: 'owner-chat', toolId: 'codex', externalConversationId: 'webui-chat', requestId: 'turn-1' };
  assert.deepEqual(decamelizeKeys({ data }), { data });
  const metadata = { ...data, session_ref: 'owner-chat:1001' };
  assert.deepEqual(camelizeKeys({ agent_id: 'codex-id', metadata }), { agentId: 'codex-id', metadata });
});
