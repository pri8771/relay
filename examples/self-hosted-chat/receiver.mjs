// Manual receiver: emits only owner request identifiers. The actual AI reads through MCP.
import { pathToFileURL } from 'node:url';

const provider = await import(pathToFileURL(process.argv[2]).href);
const { toolClient, ownerId, channel, toolId } = await provider.chatSession();
const seen = new Set();
const started = Date.now();
let stopping = false;
toolClient.connect();
toolClient.on.connected(async () => {
  await provider.setReceiverStatus(true);
  process.stdout.write(JSON.stringify({ type: 'connected' }) + '\n');
});
toolClient.on.disconnected?.(() => void provider.setReceiverStatus(false));
toolClient.subscribe([channel.name], async (event) => {
  if (stopping || !event.message?.id || seen.has(event.message.id)) return;
  try {
    const message = await toolClient.message(event.message.id);
    if (message.agentId !== ownerId || message.channelId !== channel.id ||
        message.metadata?.source !== 'owner-chat' || message.metadata?.toolId !== toolId ||
        Date.parse(message.createdAt) < started) return;
    seen.add(message.id);
    process.stdout.write(JSON.stringify({ type: 'request', rootId: message.threadId ?? message.id,
      promptMessageId: message.id, channel: channel.name }) + '\n');
  } catch { process.stderr.write('Relay request readback failed.\n'); }
});
async function stop() {
  if (stopping) return;
  stopping = true;
  await provider.setReceiverStatus(false);
  await toolClient.disconnect();
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => void stop());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stop());
