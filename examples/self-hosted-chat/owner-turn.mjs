// The model can read and answer only the saved request bound to this child.
export function bindOwnerTurn({ toolClient, ownerId, channel, toolId }, promptMessageId) {
  async function request() {
    const message = await toolClient.message(promptMessageId);
    if (message.agentId !== ownerId || message.channelId !== channel.id ||
        message.metadata?.source !== 'owner-chat' || message.metadata?.toolId !== toolId) {
      throw new Error('Owner request unavailable');
    }
    return message;
  }
  return {
    async read() {
      const message = await request();
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
      return { rootId, request: message, context: [parent, ...replies.slice(-20)] };
    },
    async reply(messageId, text) {
      const message = await request();
      const rootId = message.threadId ?? message.id;
      if (messageId !== rootId) throw new Error('Reply must target this owner conversation');
      return toolClient.reply(rootId, text, { data: { session_ref: `owner-chat:${promptMessageId}` } });
    },
  };
}
