import test from 'node:test';
import assert from 'node:assert/strict';
import { bindOwnerTurn } from './owner-turn.mjs';
function fixture(overrides = {}) {
  const writes = [];
  const message = { id: '300', threadId: '1', agentId: 'owner', channelId: 'channel',
    metadata: { source: 'owner-chat', toolId: 'codex' }, ...overrides };
  const replies = Array.from({ length: 150 }, (_, i) => ({ id: String(i + 2), text: `context ${i}` }));
  replies.push(message, { id: '301', text: 'future answer excluded' });
  const toolClient = {
    message: async () => message,
    thread: async (id, { after }) => ({ parent: { id: '1' }, replies: replies.slice(after ? replies.findIndex(r => r.id === after) + 1 : 0, (after ? replies.findIndex(r => r.id === after) + 1 : 0) + 100) }),
    reply: async (...args) => { writes.push(args); return { id: '400' }; },
  };
  return { turn: bindOwnerTurn({ toolClient, ownerId: 'owner', channel: { id: 'channel' }, toolId: 'codex' }, '300'), writes };
}
test('reads exact request and bounded recent context beyond first page, excludes future answers', async () => {
  const { turn } = fixture();
  const read = await turn.read();
  assert.equal(read.request.id, '300');
  assert.equal(read.context.length, 21);
  assert.equal(read.context.at(-1).id, '300');
  assert(!read.context.some(r => r.id === '301'));
});
test('rejects another root before any write and attests the allowed reply to exact request', async () => {
  const { turn, writes } = fixture();
  await assert.rejects(turn.reply('999', 'answer'));
  assert.equal(writes.length, 0);
  await turn.reply('1', 'answer');
  assert.deepEqual(writes, [['1', 'answer', { data: { session_ref: 'owner-chat:300' } }]]);
});
for (const [name, overrides] of Object.entries({ sender: { agentId: 'other' }, channel: { channelId: 'other' }, tool: { metadata: { source: 'owner-chat', toolId: 'other' } } })) {
  test(`rejects wrong ${name} on both read and write`, async () => {
    const { turn, writes } = fixture(overrides);
    await assert.rejects(turn.read());
    await assert.rejects(turn.reply('1', 'answer'));
    assert.equal(writes.length, 0);
  });
}
