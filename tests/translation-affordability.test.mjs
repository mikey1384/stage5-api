// Real desktop retry policy -> relay HTTP -> API billing -> in-memory D1.
// Anthropic and the API HTTP transport are stubbed; billing functions and
// SQLite are real. Every external network request is rejected.
import test, {before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {ensureDatabase, getCredits, registerDeviceApiToken} from '../src/lib/db.ts';
import * as billing from '../src/lib/relay-billing.ts';
import {tokensToCredits} from '../src/lib/pricing.ts';
import {createSqliteD1Database, resetSqliteD1Database} from './helpers/sqlite-d1.mjs';

let workspace=path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(workspace,'translator/package.json'))) {
  const parent=path.dirname(workspace);
  if(parent===workspace) throw new Error('Stage5 workspace required for integration tests');
  workspace=parent;
}
const relay=process.env.CREDIT_HOLDS_RELAY_ROOT || path.join(workspace,'openai-relay');
const relayImport=relative=>import(pathToFileURL(path.join(relay,relative)).href);
const helpers=await relayImport('relay/relay-translation-helpers.ts');
const constants=await relayImport('constants.ts');
const anthropic=await relayImport('anthropic-config.ts');
const http=await relayImport('relay/relay-http.ts');
const {syntheticSubtitleMessages}=await relayImport('tests/fixtures/subtitle-credit-hold.mjs');
const {estimateTranslationPromptTokenReserve}=await relayImport('relay/translation-token-estimator.ts');
const {runWithConcurrencySerialFallback}=await import(pathToFileURL(path.join(workspace,'translator/packages/main/services/subtitle-processing/concurrency.ts')).href);
const {isInsufficientCreditsError,shouldRetrySerialBatch}=await import(pathToFileURL(path.join(workspace,'translator/packages/main/services/subtitle-processing/errors.ts')).href);

const require=createRequire(path.join(workspace,'translator/package.json'));
const {build}=require('esbuild');
const desktop=await build({
  entryPoints:[path.join(workspace,'translator/packages/main/services/subtitle-processing/ai-client.ts')],
  bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'local-provider',setup(b){
    b.onResolve({filter:/^electron-log$|\/ai-provider\.js$/},a=>({path:a.path,namespace:'synthetic'}));
    b.onLoad({filter:/.*/,namespace:'synthetic'},a=>({loader:'js',contents:a.path==='electron-log'
      ? 'export default {debug(){},info(){},warn(){},error(){}};'
      : 'export const getActiveProvider=()=>"stage5"; export const translate=o=>globalThis.__creditHoldTranslate(o); export const translateWithWebSearch=translate;'}));
  }}],
});
const {callAIModel}=await import('data:text/javascript;base64,'+Buffer.from(desktop.outputFiles[0].text).toString('base64'));
const {sqlite,db}=createSqliteD1Database();
const originalFetch=globalThis.fetch;
const oldKey=process.env.ANTHROPIC_API_KEY;
const originalConsole={log:console.log,warn:console.warn,error:console.error};
const CF='http://billing.invalid';
const deviceId='70000000-0000-4000-8000-000000000001';
let server,baseUrl,handler,apiToken,ctx;
let countValue,stopReason,providerCalls,countCalls,refundFailure,finalizeFailures;
let providerGate,providerEntered;
let paidRequests,reserveRequests,httpStatuses;
const content=Array.from({length:40},(_,i)=>`@@SUB_LINE@@ ${i+1}: Verifique el envío ${i+1} y confirme las etiquetas.`).join('\n');
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const balance=async()=> (await getCredits({deviceId})).credit_balance;
const setBalance=value=>sqlite.prepare('INSERT INTO credits(device_id,credit_balance) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET credit_balance=excluded.credit_balance').run(deviceId,value);

before(async()=>{
  for(const key of Object.keys(originalConsole))console[key]=()=>{};
  resetSqliteD1Database(sqlite);
  await ensureDatabase({DB:db});
  process.env.ANTHROPIC_API_KEY='synthetic-provider-key';
  ctx={
    ...helpers,...constants,...http,CF_API_BASE:CF,RELAY_SECRET:'synthetic-relay-secret',
    countClaudeTranslationPromptTokens:anthropic.countClaudeTranslationPromptTokens,
    translateWithClaude:anthropic.translateWithClaude,
    readJsonBody:async req=>{const parts=[];for await(const part of req)parts.push(part);return JSON.parse(Buffer.concat(parts).toString());},
    translateWithClaudeWebSearch:()=>{throw new Error('No web search in this fixture');},
    makeOpenAI:()=>{throw new Error('No OpenAI in this fixture');},
  };
  server=createServer((req,res)=>handler(req,res,ctx).then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(error=>{res.statusCode=500;res.end(String(error));}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  baseUrl=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.startsWith(baseUrl))return originalFetch(input,init);
    const body=JSON.parse(init.body);
    if(url.startsWith(CF)){
      const route=url.slice(CF.length);
      const functions={
        '/auth/authorize':billing.authorizeRelayApiKey,
        '/auth/reserve':billing.reserveRelayCredits,
        '/auth/finalize':billing.finalizeRelayCredits,
        '/auth/release':billing.releaseRelayCredits,
        '/auth/persist':billing.persistRelayReservationMeta,
        '/auth/confirm':billing.confirmRelayReservation,
      };
      assert.ok(functions[route],`Unexpected billing endpoint ${route}`);
      if(route==='/auth/reserve')reserveRequests.push(body);
      if(route==='/auth/release'&&refundFailure)return response({error:'synthetic unavailable'},503);
      if(route==='/auth/finalize'&&finalizeFailures-- >0)return response({error:'synthetic unavailable'},503);
      const result=await functions[route](body);
      return response(result,result.ok?200:result.status);
    }
    if(url==='https://api.anthropic.com/v1/messages/count_tokens'){
      countCalls++;
      if(countValue instanceof Error)throw countValue;
      return response({input_tokens:countValue});
    }
    if(url==='https://api.anthropic.com/v1/messages'){
      providerCalls++;
      paidRequests.push(body);
      providerEntered?.();
      if(providerGate)await providerGate;
      // Keep sibling holds overlapping, and assert coverage before producing output.
      await new Promise(resolve=>setTimeout(resolve,15));
      const reserve=reserveRequests.findLast(item=>item.maxCompletionTokens===body.max_tokens);
      assert.ok(reserve);
      assert(body.max_tokens<=reserve.maxCompletionTokens);
      const actualPrompt=2107, actualOutput=stopReason==='max_tokens'?body.max_tokens:1200;
      assert(tokensToCredits({prompt:actualPrompt,completion:actualOutput,model:body.model})<=billing.estimateTranslationReservationCredits(reserve));
      return response({id:'synthetic',type:'message',role:'assistant',model:body.model,stop_reason:stopReason,content:[{type:'text',text:content}],usage:{input_tokens:actualPrompt,output_tokens:actualOutput}});
    }
    throw new Error('External network access prohibited in this test');
  };
  globalThis.__creditHoldTranslate=async options=>{
    const res=await originalFetch(baseUrl+'/translate-direct',{method:'POST',headers:{authorization:`Bearer ${apiToken}`,'Content-Type':'application/json','Idempotency-Key':options.idempotencyKey},body:JSON.stringify(options)});
    const data=await res.json();
    httpStatuses.push(res.status);
    if(!res.ok){const error=new Error(res.status===402?'insufficient-credits':`Request failed with status code ${res.status}`);error.response={status:res.status,data};throw error;}
    return data;
  };
});

beforeEach(async()=>{
  resetSqliteD1Database(sqlite);
  setBalance(215);
  apiToken=await registerDeviceApiToken({deviceId});
  handler=(await import(pathToFileURL(path.join(relay,'relay/relay-routes-translation.ts')).href+'?test='+randomUUID())).handleTranslationRoutes;
  countValue=2107;stopReason='end_turn';providerCalls=0;countCalls=0;refundFailure=false;finalizeFailures=0;
  paidRequests=[];reserveRequests=[];httpStatuses=[];
  providerGate=undefined;providerEntered=undefined;
  ctx.countClaudeTranslationPromptTokens=anthropic.countClaudeTranslationPromptTokens;
});
after(async()=>{
  globalThis.fetch=originalFetch;
  if(oldKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=oldKey;
  delete globalThis.__creditHoldTranslate;
  await new Promise(resolve=>server.close(resolve));
  Object.assign(console,originalConsole);
  sqlite.close();
});

test('job details sent to the relay reach the hold\'s credit record, validated',async()=>{
  setBalance(5000);
  const details={sourceLanguage:'es',targetLanguage:'korean',videoSeconds:1800,sourceSite:'vimeo.com'};
  const send=(key,headers)=>originalFetch(baseUrl+'/translate-direct',{method:'POST',headers:{authorization:`Bearer ${apiToken}`,'Content-Type':'application/json','Idempotency-Key':key,...headers},body:JSON.stringify({messages:syntheticSubtitleMessages(),model:'claude-haiku-5-5',translationPhase:'draft'})});
  assert.equal((await send('with-details',{'X-Stage5-Job-Details':JSON.stringify({...details,title:'not kept'})})).status,200);
  assert.equal((await send('without-details',{})).status,200);
  assert.equal((await send('oversized',{'X-Stage5-Job-Details':JSON.stringify({...details,pad:'x'.repeat(600)})})).status,200);
  const jobs=sqlite.prepare("SELECT json_extract(meta,'$.job') job FROM credit_ledger WHERE device_id=? AND reason='TRANSLATE_RESERVE' ORDER BY id").all(deviceId).map(row=>row.job===null?null:JSON.parse(row.job));
  assert.deepEqual(jobs,[details,null,null]);
});

function call(operationId='single',overrides={}){
  return callAIModel({messages:syntheticSubtitleMessages(),model:'claude-haiku-5-5',translationPhase:'draft',operationId,retryAttempts:1,...overrides});
}
async function pool(taskCount,operationPrefix){
  const outputs=[];
  await runWithConcurrencySerialFallback({taskCount,concurrency:4,
    runTask:async i=>{outputs[i]=await call(operationPrefix+i);},
    isDeferrable:isInsufficientCreditsError,
    serialRetry:{shouldRetry:shouldRetrySerialBatch,delayMs:1,maxAttempts:2}});
  return outputs;
}

test('250 credits: old530 hold fails again serially; counted229 hold completes for57 synthetic credits',async()=>{
  setBalance(250);
  assert.equal(estimateTranslationPromptTokenReserve({model:'claude-haiku-5-5',messages:syntheticSubtitleMessages()}),6405);
  ctx.countClaudeTranslationPromptTokens=undefined;
  await assert.rejects(pool(1,'old'),/insufficient-credits/);
  assert.equal(providerCalls,0);
  assert.equal(reserveRequests.length,2);
  assert.equal(billing.estimateTranslationReservationCredits(reserveRequests[0]),530);
  assert.equal(await balance(),250);
  const rejections=sqlite.prepare('SELECT requested_spend,meta FROM billing_rejections').all();
  assert.equal(rejections.length,2);
  assert.equal(JSON.parse(rejections[0].meta).requestKey,JSON.parse(rejections[1].meta).requestKey);
  ctx.countClaudeTranslationPromptTokens=anthropic.countClaudeTranslationPromptTokens;
  const result=await pool(1,'new');
  assert.equal(result[0],content);
  assert.equal(billing.estimateTranslationReservationCredits(reserveRequests.at(-1)),229);
  assert.equal(paidRequests[0].max_tokens,5238);
  assert.equal(await balance(),193);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM billing_reservations WHERE status='settled'").get().n,1);
});

test('215 credits still cannot fund the improved hold, even after serial fallback',async()=>{
  // The free live provider count for this synthetic fixture was 2,107.
  // Its 229-credit hold must still be covered before any paid request.
  await assert.rejects(pool(1,'still-conservative'),/insufficient-credits/);
  assert.equal(reserveRequests.length,2);
  assert.equal(reserveRequests[0].maxCompletionTokens,5238);
  assert.equal(billing.estimateTranslationReservationCredits(reserveRequests[0]),229);
  assert.equal(providerCalls,0);assert.equal(await balance(),215);
});

test('parallel parts that remain affordable after partial success finish through serial fallback',async()=>{
  setBalance(600);
  ctx.countClaudeTranslationPromptTokens=undefined;
  await assert.rejects(pool(4,'before'),/insufficient-credits/);
  assert.equal(providerCalls,2);
  assert.equal(await balance(),486);
  // A fresh synthetic job compares the same starting balance with the fix.
  resetSqliteD1Database(sqlite);setBalance(600);apiToken=await registerDeviceApiToken({deviceId});
  providerCalls=0;reserveRequests=[];httpStatuses=[];
  ctx.countClaudeTranslationPromptTokens=anthropic.countClaudeTranslationPromptTokens;
  const result=await pool(4,'after');
  assert.equal(result.length,4);assert(result.every(text=>text===content));
  assert.equal(providerCalls,4);assert.equal(await balance(),372);
  assert(httpStatuses.includes(402),'concurrent pressure exercised the serial fallback');
});

test('same-key concurrent calls and settled replay generate and bill once',async()=>{
  setBalance(1000);
  const result=await Promise.all([call('shared'),call('shared')]);
  assert.deepEqual(result,[content,content]);
  assert.equal(await call('shared'),content);
  assert.equal(providerCalls,1);assert.equal(countCalls,1);assert.equal(await balance(),943);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM billing_reservations').get().n,1);
  // Discard the relay's local replay cache, as a different machine would.
  handler=(await import(pathToFileURL(path.join(relay,'relay/relay-routes-translation.ts')).href+'?test='+randomUUID())).handleTranslationRoutes;
  assert.equal(await call('shared'),content);
  assert.equal(providerCalls,1);assert.equal(await balance(),943);
});

test('pending finalization replays persisted output without a second provider call',async()=>{
  setBalance(1000);finalizeFailures=1;
  await assert.rejects(call('finalize'),/status code 503/);
  assert.equal(providerCalls,1);assert.equal(await balance(),771);
  assert.equal(await call('finalize'),content);
  assert.equal(providerCalls,1);assert.equal(await balance(),943);
});

test('another relay instance cannot execute an active duplicate',async()=>{
  setBalance(1000);
  let finishProvider;
  providerGate=new Promise(resolve=>{finishProvider=resolve;});
  const entered=new Promise(resolve=>{providerEntered=resolve;});
  const first=call('cross-instance');
  await entered;
  try {
    handler=(await import(pathToFileURL(path.join(relay,'relay/relay-routes-translation.ts')).href+'?test='+randomUUID())).handleTranslationRoutes;
    await assert.rejects(call('cross-instance'),/status code 409/);
    assert.equal(providerCalls,1);assert.equal(await balance(),771);
  } finally {
    finishProvider();
  }
  assert.equal(await first,content);
  assert.equal(providerCalls,1);assert.equal(await balance(),943);
});

test('count failures and malformed counts retain the covered conservative allowance',async()=>{
  for(const value of [new Error('synthetic timeout'),0,1.5,'2107',null]){
    countValue=value;
    await assert.rejects(call('fallback-'+String(value)),/insufficient-credits/);
    assert.equal(reserveRequests.at(-1).maxCompletionTokens,13834);
    assert.equal(reserveRequests.at(-1).meta.outputAllowanceSource,'conservative-fallback');
  }
  assert.equal(providerCalls,0);assert.equal(await balance(),215);
});

test('a count above the conservative reserve cannot enlarge the previous cap',async()=>{
  countValue=100000;
  await assert.rejects(call('count-too-high'),/insufficient-credits/);
  assert.equal(reserveRequests[0].promptTokens,6405);
  assert.equal(reserveRequests[0].maxCompletionTokens,13834);
  assert.equal(providerCalls,0);assert.equal(await balance(),215);
});

test('deep reasoning and non-subtitle requests retain the previous output policy',async()=>{
  setBalance(10000);
  await call('deep',{reasoning:{effort:'high'}});
  await call('general',{translationPhase:undefined});
  assert.equal(countCalls,0);
  assert.equal(reserveRequests[0].maxCompletionTokens,32000);
  assert.equal(reserveRequests[1].maxCompletionTokens,13834);
});

test('incomplete output is not retried by the desktop and returns the full hold',async()=>{
  for(const reason of ['max_tokens','refusal']){
    setBalance(1000);stopReason=reason;
    const before=providerCalls;
    await assert.rejects(call('incomplete-'+reason,{retryAttempts:3}),/status code 422/);
    assert.equal(providerCalls,before+1);
    assert.equal(await balance(),1000);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM billing_reservations WHERE status='reserved'").get().n,0);
  }
});

test('unconfirmed release remains held and duplicate recovery cannot execute again',async()=>{
  setBalance(1000);stopReason='max_tokens';refundFailure=true;
  await assert.rejects(call('release-failure'),/status code 503/);
  assert.equal(await balance(),771);assert.equal(providerCalls,1);
  await assert.rejects(call('release-failure'),/status code 409/);
  assert.equal(providerCalls,1);
  refundFailure=false;
  const request=reserveRequests[0];
  const result=await billing.releaseRelayCredits({deviceId,service:'translation',requestKey:request.requestKey});
  assert.equal(result.ok,true);assert.equal(await balance(),1000);
});
