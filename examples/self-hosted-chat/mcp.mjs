// Credentials are resolved inside the host process, never passed on argv or to the model.
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { bindOwnerTurn } from './owner-turn.mjs';

try {
  if (!/^\d+$/.test(process.argv[3] ?? '')) throw new Error('request');
  process.env.RELAY_ATTEST_SESSION_ID = `owner-chat:${process.argv[3]}`;
  const provider = await import(pathToFileURL(process.argv[2]).href);
  const turn = bindOwnerTurn(await provider.chatSession(), process.argv[3]);
  const server = new McpServer({ name: 'relay-owner-turn', version: '0.1.0' });
  // The upstream thread tool caps its default page. Bind this read to the exact
  // owner request so a long conversation cannot hide the current prompt.
  server.registerTool('get_owner_turn', { description: 'Read the exact saved owner request and recent conversation context.', inputSchema: {} }, async () => {
    return { content: [{ type: 'text', text: JSON.stringify(await turn.read()) }] };
  });
  server.registerTool('reply_to_thread', {
    description: 'Publish the answer only to this saved owner conversation.',
    inputSchema: { message_id: z.string(), text: z.string().trim().min(1).max(32000) },
  }, async ({ message_id, text }) => ({
    content: [{ type: 'text', text: JSON.stringify(await turn.reply(message_id, text)) }],
  }));
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('Relay MCP connection failed.\n');
  process.exitCode = 1;
}
