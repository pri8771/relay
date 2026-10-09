// Trusted transport only: no model execution and no arbitrary root or prompt.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { bindOwnerTurn } from './owner-turn.mjs';

export async function publishSwarm(session, promptId, input) {
  const turn = bindOwnerTurn(session, promptId);
  const saved = await turn.read();
  const meta = saved.request.metadata;
  if (!meta?.externalConversationId?.startsWith('swarm-task:') ||
      !meta?.requestId?.startsWith('swarm-turn:') || input.rootId !== saved.rootId ||
      input.promptSha256 !== createHash('sha256').update(saved.request.text).digest('hex') ||
      typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000) {
    throw new Error('SWARM_PUBLICATION_REJECTED');
  }
  const reply = await turn.reply(saved.rootId, input.text);
  if (!/^\d+$/.test(reply.id) || reply.threadId !== saved.rootId ||
      reply.metadata?.session_ref !== `owner-chat:${promptId}`) throw new Error('SWARM_REPLY_NOT_VERIFIED');
  return { replyId: reply.id, rootId: saved.rootId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const provider = await import(pathToFileURL(process.argv[2]).href);
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 140000) throw new Error('SWARM_PUBLICATION_REJECTED');
    }
    console.log(JSON.stringify(await publishSwarm(await provider.chatSession(), process.argv[3], JSON.parse(raw))));
    process.exit(0);
  } catch {
    process.stderr.write('SWARM_PUBLICATION_FAILED\n');
    process.exit(1);
  }
}
