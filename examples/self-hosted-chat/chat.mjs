import { z } from 'zod';

const idSchema = z.string().regex(/^[a-zA-Z0-9_:-]{1,100}$/);
const requestSchema = z.object({
  toolId: z.string().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  externalConversationId: idSchema,
  requestId: idSchema,
}).strict();

class ChatError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Backend only: mount on an existing Hono app, without a new browser/server. */
export function mountOwnerChat(app, options) {
  const { ownerClient, ownerId, runTool, channel, target, origin,
    getToolStatus = async () => ({ available: false }), replyTimeoutMs = 180_000,
    path = '/owner-chat' } = options;
  if (!ownerClient || typeof runTool !== 'function' || !ownerId || !channel?.name || !channel?.id ||
      !target?.toolId || !target?.agentId || !target?.agentName || !target?.label ||
      new URL(origin).origin !== origin || !/^\/[a-z0-9/-]+$/.test(path) || path.endsWith('/') ||
      !Number.isFinite(replyTimeoutMs) || replyTimeoutMs < 1) {
    throw new Error('Invalid owner chat configuration');
  }
  const api = `${path}/api`;
  let busy = false;
  const isRoot = (message) => message?.id && message.channelId === channel.id &&
    message.agentId === ownerId && message.threadId === null &&
    message.metadata?.source === 'owner-chat' && message.metadata?.toolId === target.toolId &&
    message.metadata?.externalConversationId;
  const isToolReply = (message, rootId, promptMessageId) => message?.channelId === channel.id &&
    message.threadId === rootId && message.agentId === target.agentId &&
    message.agentName === target.agentName && message.metadata?.session_ref === `owner-chat:${promptMessageId}` &&
    typeof message.text === 'string' && message.text.trim().length > 0;

  async function readThread(rootId) {
    let after;
    let parent;
    const replies = [];
    do {
      const page = await ownerClient.thread(rootId, { limit: 100, ...(after ? { after } : {}) });
      if (!isRoot(page?.parent)) throw new ChatError('CONVERSATION_NOT_FOUND', 404, 'Conversation was not found.');
      parent = page.parent;
      replies.push(...page.replies);
      const next = page.replies.length === 100 ? page.replies.at(-1).id : null;
      if (next === after) throw new Error('Invalid Relay pagination');
      after = next;
    } while (after);
    return { parent, replies };
  }

  async function findConversation(externalId) {
    let before;
    do {
      const messages = await ownerClient.messages(channel.name, { limit: 100, ...(before ? { before } : {}) });
      const root = messages.find((message) => isRoot(message) && message.metadata.externalConversationId === externalId);
      if (root) return readThread(root.id);
      const next = messages.length === 100 ? messages.at(-1).id : null;
      if (next === before) throw new Error('Invalid Relay pagination');
      before = next;
    } while (before);
    return null;
  }

  async function verifiedAnswer(thread, promptMessage, replyId) {
    const reply = thread.replies.find((message) => message.id === replyId);
    if (!isToolReply(reply, thread.parent.id, promptMessage.id)) {
      throw new ChatError('REPLY_NOT_VERIFIED', 502, 'The intended tool did not return a verified saved reply for this message.');
    }
    const persisted = await ownerClient.message(reply.id);
    if (!isToolReply(persisted, thread.parent.id, promptMessage.id) ||
        persisted.id !== reply.id || persisted.text !== reply.text) {
      throw new ChatError('REPLY_NOT_VERIFIED', 502, 'The tool reply could not be read back from Relay.');
    }
    return { conversationId: thread.parent.id, replyId: persisted.id, answer: persisted.text };
  }

  const guarded = (handler) => async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    try { return await handler(c); }
    catch (error) {
      // Never expose SDK/model errors, endpoint arguments or credentials.
      const safe = error instanceof ChatError ? error :
        new ChatError('RELAY_UNAVAILABLE', 502, 'Relay or the selected tool is unavailable. Saved messages remain in Relay.');
      return c.json({ ok: false, error: { code: safe.code, message: safe.message } }, safe.status);
    }
  };

  app.get(`${api}/tools`, guarded(async (c) => {
    const status = await getToolStatus();
    return c.json({ ok: true, data: [{ id: target.toolId, label: target.label, available: status?.available === true }] });
  }));
  app.get(`${api}/conversations/:id`, guarded(async (c) => {
    const id = c.req.param('id');
    if (!idSchema.safeParse(id).success) throw new ChatError('INVALID_INPUT', 400, 'Invalid conversation id.');
    const thread = await readThread(id);
    const prompts = [thread.parent, ...thread.replies].filter((message) => message.agentId === ownerId &&
      message.channelId === channel.id && message.metadata?.source === 'owner-chat' && message.metadata?.toolId === target.toolId);
    return c.json({ ok: true, data: { conversationId: id, messages: [thread.parent, ...thread.replies]
      .filter((message) => prompts.includes(message) || prompts.some((prompt) => isToolReply(message, id, prompt.id)))
      .map((message) => ({ id: message.id, role: message.agentId === ownerId ? 'owner' : 'tool', text: message.text })) } });
  }));
  app.post(`${api}/messages`, guarded(async (c) => {
    if (c.req.header('Origin') !== origin || c.req.header('Sec-Fetch-Site') === 'cross-site') {
      throw new ChatError('SAME_ORIGIN_REQUIRED', 403, 'Use the configured local Relay connection.');
    }
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '') ||
        Number(c.req.header('Content-Length') ?? 0) > 40_000) {
      throw new ChatError('INVALID_INPUT', 400, 'Send a JSON message of 1–8000 characters.');
    }
    const body = await c.req.text();
    let parsed;
    if (Buffer.byteLength(body) <= 40_000) {
      try { parsed = requestSchema.safeParse(JSON.parse(body)); } catch { /* fixed error below */ }
    }
    if (!parsed?.success || parsed.data.toolId !== target.toolId) {
      throw new ChatError('INVALID_INPUT', 400, 'Choose the available tool and enter a message of 1–8000 characters.');
    }
    if (busy) throw new ChatError('TOOL_BUSY', 409, 'The tool is answering another message. Try again when it finishes.');
    busy = true;
    try {
      const { prompt, externalConversationId, requestId } = parsed.data;
      let thread = await findConversation(externalConversationId);
      const oldPrompt = thread && [thread.parent, ...thread.replies].find((message) =>
        message.agentId === ownerId && message.metadata?.requestId === requestId);
      if (oldPrompt) {
        if (oldPrompt.text !== prompt) throw new ChatError('REQUEST_CONFLICT', 409, 'This message id was already used for a different prompt.');
        const oldReply = thread.replies.find((reply) => isToolReply(reply, thread.parent.id, oldPrompt.id));
        if (oldReply) return c.json({ ok: true, data: await verifiedAnswer(thread, oldPrompt, oldReply.id) });
      }
      if ((await getToolStatus())?.available !== true) {
        throw new ChatError('TOOL_OFFLINE', 503, 'Codex is offline. Start the approved request receiver before sending a message.');
      }
      const data = { source: 'owner-chat', toolId: target.toolId, externalConversationId, requestId };
      const promptMessage = oldPrompt ?? (thread
        ? await ownerClient.reply(thread.parent.id, prompt, { data })
        : await ownerClient.send(channel.name, prompt, { data }));
      const rootId = thread?.parent.id ?? promptMessage.id;
      if (promptMessage.agentId !== ownerId || promptMessage.channelId !== channel.id ||
          (thread ? promptMessage.threadId !== rootId : !isRoot(promptMessage))) {
        throw new ChatError('PROMPT_NOT_SAVED', 502, 'Relay did not confirm the saved prompt.');
      }
      const controller = new AbortController();
      let timer;
      let result;
      try {
        result = await Promise.race([
          runTool({ rootId, promptMessageId: promptMessage.id, channel, prompt, toolId: target.toolId,
            target: { agentId: target.agentId, agentName: target.agentName }, signal: controller.signal }),
          new Promise((_, reject) => { timer = setTimeout(() => {
            controller.abort();
            reject(new ChatError('REPLY_PENDING', 504, 'The prompt is saved in Relay, but a verified reply has not arrived yet. Retry this message to read its reply.'));
          }, replyTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
      thread = await readThread(rootId);
      return c.json({ ok: true, data: await verifiedAnswer(thread, promptMessage, result?.replyId) });
    } finally { busy = false; }
  }));
  return { api };
}
