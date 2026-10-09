// Credentials are resolved inside the host process, never passed on argv or to the model.
import { pathToFileURL } from 'node:url';
import { createAgentRelayMcpServer } from '../../packages/cli/dist/cli/agent-relay-mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

try {
  if (!/^\d+$/.test(process.argv[3] ?? '')) throw new Error('request');
  process.env.RELAY_ATTEST_SESSION_ID = `owner-chat:${process.argv[3]}`;
  const provider = await import(pathToFileURL(process.argv[2]).href);
  const options = await provider.toolSession();
  const server = createAgentRelayMcpServer({ ...options, sharedSessionTools: [] });
  // The upstream thread tool caps its default page. Bind this read to the exact
  // owner request so a long conversation cannot hide the current prompt.
  server.registerTool('get_owner_turn', { description: 'Read the exact saved owner request and recent conversation context.', inputSchema: {} }, async () => {
    const { toolClient, ownerId, channel } = await provider.chatSession();
    const message = await toolClient.message(process.argv[3]);
    if (message.agentId !== ownerId || message.channelId !== channel.id || message.metadata?.source !== 'owner-chat') {
      throw new Error('Owner request unavailable');
    }
    const rootId = message.threadId ?? message.id;
    let after;
    let parent;
    const replies = [];
    do {
      const page = await toolClient.thread(rootId, { limit: 100, ...(after ? { after } : {}) });
      parent = page.parent;
      replies.push(...page.replies.filter(reply => BigInt(reply.id) <= BigInt(message.id)));
      const next = page.replies.length === 100 ? page.replies.at(-1).id : null;
      if (next === after) throw new Error('Invalid pagination');
      after = next;
    } while (after);
    return { content: [{ type: 'text', text: JSON.stringify({ rootId, request: message, context: [parent, ...replies.slice(-20)] }) }] };
  });
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('Relay MCP connection failed.\n');
  process.exitCode = 1;
}
