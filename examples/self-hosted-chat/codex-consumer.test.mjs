import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('same consumer removes host tool features and projects exact successful child completion', async () => {
  // Retain generated diagnostic inputs under the owner no-deletion rule.
  const dir = await mkdtemp(join(tmpdir(), 'relay-consumer-test-'));
  const receipt = join(dir, 'receipts.jsonl');
  const argsPath = join(dir, 'args.json');
  const fakeSsh = join(dir, 'ssh');
  const fakeCodex = join(dir, 'fake-codex');
  const prefix = `#!${process.execPath}\n`;
  await writeFile(fakeSsh, prefix + `console.log(JSON.stringify({type:'request',rootId:'123',promptMessageId:'122',channel:'owner-chat'}));process.stdin.resume();`, { mode: 0o700 });
  const lateEvents = [
    {type:'item.completed',item:{type:'mcp_tool_call',server:'relay',tool:'reply_to_thread',status:'completed',result:{content:[{type:'text',text:JSON.stringify({id:'124',threadId:'123',metadata:{session_ref:'owner-chat:122'}})}]}}},
    {type:'turn.completed',usage:{input_tokens:9,cached_input_tokens:3,output_tokens:7,private:'not projected'}},
  ];
  const delayedOutput = `setTimeout(() => {for(const event of ${JSON.stringify(lateEvents)}) console.log(JSON.stringify(event));},80);`;
  await writeFile(fakeCodex, prefix + `import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';
    writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'relay',tool:'get_owner_turn',status:'completed'}}));
    // Parent exits first; inherited stdout emits the final reply and usage later.
    spawn(process.execPath,['-e',${JSON.stringify(delayedOutput)}],{stdio:['ignore','inherit','ignore']}).unref();process.exit(0);`, { mode: 0o700 });
  const config = join(dir, 'config.mjs');
  await writeFile(config, `export default ${JSON.stringify({ sshArgs: [], receiverCommand: 'unused', mcpCommand: 'unused', channel: 'owner-chat', cwd: dir, receiptPath: receipt, codexCommand: fakeCodex })};`);
  const child = spawn(process.execPath, [resolve('examples/self-hosted-chat/codex-consumer.mjs'), config],
    { env: { ...process.env, PATH: dir + ':' + process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    let completion;
    for (let n = 0; n < 100; n++) {
      try { completion = JSON.parse((await readFile(receipt + '.completion.jsonl', 'utf8')).trim()); break; } catch {}
      await delay(20);
    }
    assert.deepEqual(completion, {rootId:'123',promptMessageId:'122',replyId:'124',model:'gpt-6.1-sol',exitCode:0,
      finishedAt:completion.finishedAt,toolsCompleted:true,usage:{input_tokens:9,cached_input_tokens:3,output_tokens:7}});
    const args = JSON.parse(await readFile(argsPath,'utf8'));
    for (const name of ['shell_tool','apps','plugins','browser_use','computer_use','multi_agent','image_generation','view_image','code_mode_host','goals','hooks','sleep_tool','workspace_dependencies','skill_search']) {
      assert(args.includes(`features.${name}=false`));
    }
    assert(args.includes('web_search="disabled"'));
    assert(args.includes('mcp_servers.relay.enabled_tools=["get_owner_turn","reply_to_thread"]'));
    assert(args.includes('--ignore-user-config'));
    assert(args.includes('--ephemeral'));
    assert(args.includes('read-only'));
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolveExit => child.once('exit',resolveExit));
  }
});
