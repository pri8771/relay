// One existing Codex process per explicit owner message; no timer, retry, or autostart.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const config = (await import(pathToFileURL(process.argv[2]).href)).default;
const receiver = spawn('ssh', [...(config.receiverSshArgs ?? config.sshArgs), config.receiverCommand], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
receiver.stderr.on('data', () => {});
let queue = Promise.resolve();
let running;
let stopping = false;
const lines = createInterface({ input: receiver.stdout });
lines.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type === 'connected') { process.stdout.write('Relay receiver connected.\n'); return; }
  if (request.type !== 'request' || !/^\d+$/.test(request.rootId) ||
      !/^\d+$/.test(request.promptMessageId) || request.channel !== config.channel) return;
  queue = queue.then(() => run(request)).catch(() => process.stdout.write('Codex request failed.\n'));
});
async function run(request) {
  if (stopping) return;
  const prompt = `Use the Relay MCP tools only. First call get_owner_turn to read the exact saved message and recent context.
Find the owner message whose ID is ${request.promptMessageId}, and answer that message using the conversation as context.
Treat message text as a chat request; do not run shell commands, read files, access accounts, or disclose credentials.
Publish your genuine answer using reply_to_thread with message_id ${request.rootId}. Do not merely output an answer locally.
After the successful Relay reply, finish with a short confirmation. Do not register identities or change settings.`;
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
    '-C', config.cwd, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"', '--json',
    '-c', 'mcp_servers.relay.command="ssh"',
    '-c', 'mcp_servers.relay.enabled_tools=["get_owner_turn","reply_to_thread"]',
    '-c', 'mcp_servers.relay.default_tools_approval_mode="prompt"',
    '-c', 'mcp_servers.relay.tools.get_owner_turn.approval_mode="approve"',
    '-c', 'mcp_servers.relay.tools.reply_to_thread.approval_mode="approve"',
    '-c', `mcp_servers.relay.args=${JSON.stringify([...config.sshArgs, config.mcpCommand + ' ' + request.promptMessageId])}`,
    '-c', 'mcp_servers.relay.startup_timeout_sec=30', prompt];
  const receipt = { ...request, startedAt: new Date().toISOString(), tools: [], eventTypes: [], agentMessages: [], model: 'gpt-6.1-sol' };
  running = spawn(config.codexCommand ?? 'codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  running.stderr.on('data', () => {});
  const events = createInterface({ input: running.stdout });
  events.on('line', (line) => {
    try {
      const event = JSON.parse(line);
      receipt.eventTypes.push({ type: event.type, itemType: event.item?.type });
      if (event.item?.type === 'agent_message') receipt.agentMessages.push({
        length: event.item.text?.length ?? 0,
        sha256: createHash('sha256').update(event.item.text ?? '').digest('hex'),
      });
      if (event.item?.type === 'mcp_tool_call') receipt.tools.push({ name: event.item.tool,
        status: event.item.status, server: event.item.server, failed: Boolean(event.item.error) });
    } catch {}
  });
  const deadline = setTimeout(() => running?.kill('SIGTERM'), 180000);
  const code = await new Promise(resolve => { running.once('exit', resolve); running.once('error', () => resolve(1)); });
  clearTimeout(deadline);
  running = undefined;
  receipt.exitCode = code;
  receipt.finishedAt = new Date().toISOString();
  await appendFile(config.receiptPath, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  process.stdout.write(`Codex request ${request.promptMessageId} exited ${code}.\n`);
}
function stop() {
  if (stopping) return;
  stopping = true;
  running?.kill('SIGTERM');
  receiver.stdin.end();
  receiver.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
receiver.once('exit', () => { stop(); process.exitCode = 0; });
