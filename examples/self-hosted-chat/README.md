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

For authorized programmatic text generation, `text_client.py` uses this same existing local adapter; it starts no listener and accepts no credentials or alternate endpoint. Import `generate_text(prompt, conversation_id="swarm-task:<unique-task-id>", request_id="swarm-turn:<unique-iteration-id>")` using keyword arguments. It returns the exact saved `{conversationId, replyId, answer}` receipt. The caller owns parsing, tool execution and artifact verification; returned text never runs in this client. One global request can run at a time; `TextGenerationError.code` reports busy/offline/pending/conflict. Use a separate conversation per task, unchanged request IDs only for identical retries, and a new request ID for each changed prompt. Inputs are 1–8000 characters and IDs match `[a-zA-Z0-9_:-]{1,100}`; responses are capped at32000 characters. Caller timeout195s; existing server/child deadline180s. Actual configured runtime is installed Codex0.160.1, gpt-6.1-sol low, ephemeral read-only child with only the two request-bound MCP tools. Native CLI auth stays opaque. This local owner adapter is not a multi-user API.

```sh
python3 -B -m unittest discover -s examples/self-hosted-chat -p 'text_client_test.py'
```

For a caller that owns tool execution, use `require_completion=True` and optionally `max_answer_chars=3072`. The latter rejects oversized saved answers without truncation or another dispatch; it does not enforce a generation or token cap. The former waits on the fixed local scalar completion ledger until the exact returned Relay root/reply match a successful exited child and both MCP tools completed. Total local deadline remains195s from invocation; incomplete/missing projection fails with `COMPLETION_PENDING`, never resubmits. `completion` returns `{promptMessageId, model, exitCode, toolsCompleted, finishedAt, usage}`; usage contains only CLI-emitted nonnegative integer input/cached/output token counters or `None`. Internal physical model-request count is unknown. Replies saved before exit alone do not prove completion. This feature is native-Mac only and uses the retained local receipt path, not browser credentials.

Per-child features disable shell, app/plugin, browser/computer, image/view-image, code host, multi-agent, goals/hooks, sleep, workspace-dependency and skill-search tools; web search is disabled. These settings are child arguments only; owner configuration and the approved listener stay in place. Official shell flag: https://learn.chatgpt.com/docs/config-file/config-reference#features-shell-tool . Installed CLI feature-list validation is retained in execution evidence. The child still reads only its bound MCP conversation and publishes the saved reply. Parent-level SSH/MCP connection is not model-controlled execution.

Authorized Swarm reuse is a supervised finite, instruction-scoped public/synthetic text task. It is not a proved capability-isolated sandbox, and the full installed builtin tool inventory remains unknown. The retained feature restrictions narrow the child; observable tool events enforce acceptance. Any item outside ordinary text/reasoning/error or the two named Relay MCP tools marks scopeTracePassed false, stops child continuation, and rejects caller acceptance. The first live completion-ledger check belongs to Swarm's fresh finite granted real step, not another test prompt. Swarm owns actions/artifacts and continuation after receipt, trace, parser and resource review.

Successful completion additionally returns `scopeTracePassed: true`, safe `toolEvents` (name/server/status/failed only) and `itemTypes`. The client rejects unknown tool names/servers, failed tools and unexpected item types even if an answer was saved and exitCode was zero. No capability-exclusion claim follows from a passing observed trace.

Swarm-only final text mode uses saved `swarm-task:` conversation and
`swarm-turn:` request metadata. The receiver passes that saved public/synthetic
prompt directly to the existing restricted child, without model-facing MCP.
The consumer waits for actual child close and a completed turn, rejects error
items and all observed tool calls, and sends only the last completed final
agent message to the trusted `publish-swarm.mjs` transport. That transport
rechecks saved owner/tool/channel, Swarm metadata, root and prompt digest before
publishing through the existing SDK with the exact session correlation.
Ordinary owner chat keeps its existing MCP behavior.

Callers select `completion_mode='swarm-final-text'` together with
`require_completion=True`. The scalar receipt must explicitly show that mode,
`textCompleted=true`, `toolsCompleted=false`, an empty tool trace, no error
items, exit zero and the exact saved reply. Character limits remain acceptance
limits; numeric CLI usage includes its internal context and does not represent
only the submitted task. No capability isolation or physical request count is
claimed. A new independently reviewed finite grant is needed after a failed
attempt; this mode does not retry or continue automatically.

For explicitly admitted Swarm text attempts, the consumer also saves a separate
`receiptPath + '.diagnostics.jsonl'` after child close. It contains bound IDs,
native thread ID when emitted, exit/time, and at most four structured error
messages plus four stderr ERROR/WARN lines. Messages are limited to a redacted
512-character first line; task text, paths, URLs, emails, credential assignments
and opaque values are removed. Raw events, stderr, prompts, configuration and
final responses are not retained there. An error category is diagnostic data;
it does not establish severity or permit continuation. Ordinary MCP chat has
no added diagnostic capture. Existing ephemeral attempts cannot be diagnosed
retroactively if their error text was discarded.
