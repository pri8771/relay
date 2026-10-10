import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { publishSwarm } from './publish-swarm.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
test('trusted publisher binds saved Swarm prompt, root, and session before write', async () => {
  let writes = 0;
  const request = {id:'122',threadId:'123',agentId:'owner',channelId:'channel',text:'public task',
    metadata:{source:'owner-chat',toolId:'codex',externalConversationId:'swarm-task:x',requestId:'swarm-turn:x'}};
  const session = {ownerId:'owner',channel:{id:'channel'},toolId:'codex',toolClient:{
    message:async()=>request,thread:async()=>({parent:request,replies:[]}),
    reply:async(root,text,options)=>{writes++;return {id:'124',threadId:root,metadata:options.data};}}};
  const input = {rootId:'123',text:'final',promptSha256:digest(request.text)};
  for (const bad of [{...input,rootId:'999'},{...input,promptSha256:'bad'},{...input,text:''}]) {
    await assert.rejects(publishSwarm(session,'122',bad));
  }
  request.metadata.externalConversationId='ordinary';
  await assert.rejects(publishSwarm(session,'122',input));
  assert.equal(writes,0);
  request.metadata.externalConversationId='swarm-task:x';
  assert.deepEqual(await publishSwarm(session,'122',input),{replyId:'124',rootId:'123'});
  assert.equal(writes,1);
});

for (const failure of ['none','error','tool','nonzero','unfinished','oversize']) {
  test(`direct text publication waits for close and rejects ${failure}`, async () => {
    const dir = await mkdtemp(join(tmpdir(),'relay-final-text-test-'));
    const receipt = join(dir,'receipts');
    const argsPath = join(dir,'args.json');
    const published = join(dir,'published.json');
    const fakeCodex = join(dir,'fake-codex');
    const prefix = `#!${process.execPath}\n`;
    await writeFile(join(dir,'ssh'),prefix+`import{writeFileSync}from'node:fs';
      if(process.argv.some(arg=>arg.startsWith('publish '))){let input='';for await(const c of process.stdin)input+=c;
        writeFileSync(${JSON.stringify(published)},input);console.log(JSON.stringify({rootId:'123',replyId:'124'}));}
      else{console.log(JSON.stringify({type:'request',rootId:'123',promptMessageId:'122',channel:'owner-chat',mode:'swarm-final-text',prompt:'public task'}));process.stdin.resume();}`,{mode:0o700});
    const events = [
      {type:'thread.started',thread_id:'11111111-1111-1111-1111-111111111111'},
      ...(failure==='error'?[{type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}}]:[]),
      {type:'turn.started'},
      {type:'item.completed',item:{type:'agent_message',text:'working commentary'}},
      ...(failure==='tool'?[{type:'item.completed',item:{type:'mcp_tool_call',server:'relay',tool:'get_owner_turn',status:'completed'}}]:[]),
      {type:'item.completed',item:{type:'agent_message',text:failure==='oversize'?'x'.repeat(32001):'{"action":"final"}'}},
      ...(failure==='unfinished'?[]:[{type:'turn.completed',usage:{input_tokens:9,output_tokens:7}}]),
    ];
    await writeFile(fakeCodex,prefix+`import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';
      writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv.slice(2)));
      spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>{for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));},80)`)}],{stdio:['ignore','inherit','ignore']}).unref();process.exit(${failure==='nonzero'?1:0});`,{mode:0o700});
    const config = join(dir,'config.mjs');
    await writeFile(config,`export default ${JSON.stringify({sshArgs:[],receiverCommand:'receive',swarmPublishCommand:'publish',mcpCommand:'unused',channel:'owner-chat',cwd:dir,receiptPath:receipt,codexCommand:fakeCodex})};`);
    const child = spawn(process.execPath,[resolve('examples/self-hosted-chat/codex-consumer.mjs'),config],{
      env:{...process.env,PATH:dir+':'+process.env.PATH},stdio:['ignore','ignore','ignore']});
    try {
      let completion;
      for(let n=0;n<100;n++){
        try{completion=JSON.parse((await readFile(receipt+'.completion.jsonl','utf8')).trim());break;}catch{}
        await delay(20);
      }
      assert(completion);
      assert.equal(completion.mode,'swarm-final-text');
      assert.equal(completion.textCompleted,failure==='none');
      assert.equal(completion.toolsCompleted,false);
      const args=JSON.parse(await readFile(argsPath,'utf8'));
      assert(args.at(-1).includes('public task'));
      assert(!args.some(arg=>arg.startsWith('mcp_servers.')));
      for(const flag of ['code_mode','code_mode_only','code_mode_host'])assert(args.includes(`features.${flag}=false`));
      const privateReceipt=await readFile(receipt,'utf8');
      assert(!privateReceipt.includes('public task'));
      const diagnostic=JSON.parse((await readFile(receipt+'.diagnostics.jsonl','utf8')).trim());
      assert.equal(diagnostic.nativeThreadId,'11111111-1111-1111-1111-111111111111');
      assert.equal(diagnostic.diagnostics.length,failure==='error'?1:0);
      if(failure==='error')assert.equal(diagnostic.diagnostics[0].category,'CODE_MODE_HOST_DISABLED');
      if(failure==='none'){
        assert.equal(completion.replyId,'124');
        assert.equal(completion.failureCode,null);
        assert.deepEqual(JSON.parse(await readFile(published,'utf8')),{rootId:'123',text:'{"action":"final"}',promptSha256:digest('public task')});
      }else{
        await assert.rejects(readFile(published));
        assert.equal(completion.replyId,null);
        assert(completion.failureCode);
      }
    }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
  });
}
