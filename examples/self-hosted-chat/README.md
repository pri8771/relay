# Open WebUI → Relay → Codex

This small backend mount connects the existing Open WebUI chat to the upstream
Relaycast `AgentClient` and a supplied genuine Codex consumer. It contains no
separate page/server, credentials, model implementation, or legacy Bus routes.
Existing Bus and Open WebUI history stay in place.

Mount `chat.mjs` on the existing Hono app with `mountOwnerChat(app, options)`:

- `ownerClient` and `ownerId`: upstream SDK owner identity, credentials server-side.
- `channel: { name, id }`: the approved owner conversation channel in the trial workspace.
- `target: { toolId: 'codex', label: 'Codex (Mac)', agentId, agentName }`.
- `origin: 'http://127.0.0.1:8787'`.
- `getToolStatus() → { available }`: verify the actual approved receiver binding.
- `runTool({ rootId, promptMessageId, channel, prompt, target, signal }) → { replyId }`:
  wait for the actual tool reply; respect cancellation. Default deadline: 180 seconds.

The host runs a request-bound MCP adapter over the upstream Relaycast SDK with per-request
`RELAY_ATTEST_SESSION_ID=owner-chat:<promptMessageId>`. The adapter stamps
`metadata.session_ref` on its real reply. Custom metadata keys survive SDK casing
verbatim. The adapter matches that exact key, sender id/name, channel and thread,
then rereads the reply through the SDK. The MCP reply tool checks the saved root before writing, so the model cannot target another thread. Callback text is never displayed.

Install `openwebui_pipe.py` as a native Open WebUI Pipe Function restricted to the
existing owner account. It exposes one selectable tool, **Codex (Mac)**, and shows
it offline when the receiver binding is unavailable. Its approved connection is
`http://host.lima.internal:8787` from the existing Mac container, forwarding to the
existing VM Relay endpoint. The Pipe holds no Relay token.

Open WebUI supplies native chat and user-message ids. The API stores these ids in
Relay prompt metadata, finds the same thread for follow-up turns, and returns a
verified stored answer. Retries read the original answer; pending/late replies
remain bound to the original prompt. Open WebUI saves and reopens the conversation
using its native chat persistence. Auxiliary title/tag tasks never invoke Codex.

The host must demonstrate actual model use through the request-bound MCP adapter. SDK test doubles
or merely selecting the tool do not prove enrollment or a usable connection.

`codex-consumer.mjs` runs the installed Codex CLI with isolated per-child settings.
Only `get_owner_turn` and `reply_to_thread` are enabled and approved for this
connection. The owner's global Codex configuration and other tool permissions
stay in place. Each explicit chat turn starts one bounded, read-only model run.

```sh
node --test examples/self-hosted-chat/chat.test.mjs
node --test examples/self-hosted-chat/owner-turn.test.mjs
node --check examples/self-hosted-chat/chat.mjs
```

The Pipe follows the official [Pipe Function](https://docs.openwebui.com/features/extensibility/plugin/functions/pipe/)
and [reserved argument](https://docs.openwebui.com/features/extensibility/plugin/development/reserved-args/)
contracts. It accepts text chat only; errors raise fixed messages rather than
appearing as fabricated assistant answers.

The manually started receiver accepts new prompts only. If it stops before answering a saved prompt, retrying that turn does not redispatch it; send a new explicit turn after restoring the receiver. Saved conversations remain intact.
