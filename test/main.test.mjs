import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createMmsApp,canonicalOrigin,APPLICATIONS_OPEN} from '../src/main.mjs';
import {createOperatorAuthenticator} from '../src/auth.mjs';
import {MMS_DEFAULTS} from '../domain/defaults.mjs';
import {SYNTHETIC_EVENTS} from '../demo/synthetic-archive.mjs';

const TOKEN='t'.repeat(40),origin='https://mms.test',api='/api/t/mms/events/pilot-event/draft-settings';
async function serve(t,options={}){
 const server=createServer(createMmsApp({adminToken:TOKEN,origin,...options}));
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
 return 'http://127.0.0.1:'+server.address().port;
}
const auth={authorization:'Bearer '+TOKEN};

test('health is liveness only and states that applications are closed',async t=>{
 const base=await serve(t);const r=await fetch(base+'/health');assert.equal(r.status,200);
 const body=await r.json();assert.equal(body.status,'ok');assert.equal(body.applicationsOpen,false);assert.equal(body.productionReady,false);assert.equal(APPLICATIONS_OPEN,false);
 assert.equal((await fetch(base+'/health',{method:'POST'})).status,405);
});
test('public design pages and stylesheet are served by the composed app',async t=>{
 const base=await serve(t);
 for(const p of ['/','/watch','/apply','/vote','/archive','/sponsor','/experience/industry','/mms.css']){const r=await fetch(base+p);assert.equal(r.status,200,p)}
 const apply=await (await fetch(base+'/apply')).text();assert.match(apply,/Applications are not open/);assert.doesNotMatch(apply,/<form/);
});
test('brand never expands the MMS acronym on any served page',async t=>{
 const base=await serve(t);
 for(const p of ['/','/watch','/t/demo','/t/demo/archive']){const html=await (await fetch(base+p)).text();assert.match(html,/MMS/);assert.doesNotMatch(html,/M[a-z]+ M[a-z]+ S[a-z]+/)}
});
test('synthetic archive is clearly labelled and never shows unpublished events',async t=>{
 const base=await serve(t);
 for(const p of ['/t/demo','/t/demo/watch','/t/demo/archive','/t/demo/apply','/t/demo/vote','/t/demo/sponsor','/t/demo/events/synthetic-spring-final']){
  const r=await fetch(base+p);assert.equal(r.status,200,p);const html=await r.text();assert.match(html,/Synthetic demonstration data/);assert.doesNotMatch(html,/Never shown|Unpublished draft/);
 }
 assert.equal((await fetch(base+'/t/demo/events/synthetic-unpublished')).status,404);
 assert.equal((await fetch(base+'/t/demo/archive',{method:'POST'})).status,405);
 assert.ok(SYNTHETIC_EVENTS.every(e=>/synthetic/i.test(e.title)));
 assert.equal((await fetch(base+'/archive.css')).status,200);
});
test('organizer editor and API require the operator token and exact tenant',async t=>{
 const base=await serve(t);
 assert.equal((await fetch(base+'/t/mms/organizer')).status,404);
 assert.equal((await fetch(base+'/t/mms/organizer',{headers:{authorization:'Bearer '+'x'.repeat(40)}})).status,404);
 assert.equal((await fetch(base+'/t/other/organizer',{headers:auth})).status,404);
 assert.equal((await fetch(base+'/t/mms/industry',{headers:auth})).status,404,'operator never receives the industry role');
 const page=await fetch(base+'/t/mms/organizer',{headers:auth});assert.equal(page.status,200);assert.match(await page.text(),/Competition draft settings/);
 assert.equal((await fetch(base+api)).status,401);
 assert.equal((await fetch(base+api.replace('/t/mms/','/t/other/'),{headers:auth})).status,403);
});
test('draft settings round-trip through the composed API with optimistic versions',async t=>{
 const base=await serve(t);
 const put=(expectedVersion,settings,headers={})=>fetch(base+api,{method:'PUT',headers:{...auth,origin,'content-type':'application/json',...headers},body:JSON.stringify({expectedVersion,settings})});
 let r=await put(0,MMS_DEFAULTS);assert.equal(r.status,200);assert.equal((await r.json()).draft.version,1);
 r=await put(0,MMS_DEFAULTS);assert.equal(r.status,409);
 r=await put(1,{...MMS_DEFAULTS,battlesEnabled:true});assert.equal(r.status,400,'optional modes cannot be enabled without a verified capability');
 r=await put(1,MMS_DEFAULTS,{origin:'https://evil.test'});assert.equal(r.status,403);
 r=await put(1,{...MMS_DEFAULTS,qualifierSeconds:120});assert.equal(r.status,200);
 r=await fetch(base+api,{headers:auth});const draft=(await r.json()).draft;assert.equal(draft.version,2);assert.equal(draft.settings.qualifierSeconds,120);assert.equal(draft.settings.battlesEnabled,false);
});
test('API is disabled without a canonical HTTPS origin and private routes fail closed without a token',async t=>{
 const base=await serve(t,{origin:null,adminToken:undefined});
 assert.equal((await fetch(base+api,{headers:auth})).status,404);
 assert.equal((await fetch(base+'/t/mms/organizer',{headers:auth})).status,404);
 assert.equal((await fetch(base+'/organizer',{headers:auth})).status,404);
});
test('canonical origin and authenticator validation',async()=>{
 assert.equal(canonicalOrigin('https://mms-x.onrender.com'),'https://mms-x.onrender.com');
 assert.equal(canonicalOrigin('https://mms-x.onrender.com/'),'https://mms-x.onrender.com');
 for(const bad of ['http://mms.test','https://u:p@mms.test','https://mms.test/path','nonsense',''])assert.equal(canonicalOrigin(bad),null);
 assert.throws(()=>createOperatorAuthenticator({token:TOKEN,tenantId:'Bad Tenant'}));
 const weak=createOperatorAuthenticator({token:'short',tenantId:'mms'});assert.equal(await weak({headers:{authorization:'Bearer short'}}),null);
 const ok=createOperatorAuthenticator({token:TOKEN,tenantId:'mms'});
 const principal=await ok({headers:{authorization:'Bearer '+TOKEN}});assert.equal(principal.tenantId,'mms');assert.ok(principal.roles.has('producer'));assert.ok(!principal.roles.has('industry'));
 assert.equal(await ok({headers:{authorization:'Bearer '+TOKEN+'x'}}),null);
 assert.equal(await ok({headers:{'x-user-id':'mms-operator'}}),null);
});
