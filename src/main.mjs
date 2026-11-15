import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {createHandler} from './server.mjs';
import {route,authorized} from './app.mjs';
import {createOperatorAuthenticator} from './auth.mjs';
import {createPublicHandler} from '../design/preview-server.mjs';
import {createDraftSettingsListener} from '../http/draft-settings-server.mjs';
import {createDraftSettingsService,createMemoryDraftStore} from '../domain/draft-settings.mjs';
import {renderDraftSettingsEditor} from '../views/draft-settings.mjs';
import {syntheticArchiveResponse} from '../demo/synthetic-archive.mjs';

/** Deployable MMS composition (MMS-01..04 + synthetic MMS-07 preview).
 * Order: health -> producer API -> synthetic demo archive -> static public pages
 * -> authenticated organizer editor -> MMS-01 deny-by-default shell.
 * Applications, discovery, voting, payments and media remain disabled.
 */
const SECURITY={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
 'content-security-policy':"default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
export const APPLICATIONS_OPEN=false;

export function canonicalOrigin(value){
 if(!value)return null;
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.origin===value.replace(/\/$/,'')?u.origin:null}catch{return null}
}

export function createMmsApp({store,ping=async()=>true,persistence='memory',adminToken,tenantId='mms',origin=null,eventId='pilot-event',engine=null,fetchImpl}={}){
 const draftStore=store??createMemoryDraftStore();
 const service=createDraftSettingsService(draftStore);
 const authenticate=createOperatorAuthenticator({token:adminToken,tenantId});
 const api=origin?createDraftSettingsListener({origin,service,authenticate}):null;
 const publicHandler=createPublicHandler();
 const shell=createHandler({authenticate,engine,...(fetchImpl?{fetchImpl}:{})});
 const send=(req,res,status,type,body)=>{res.writeHead(status,{...SECURITY,'content-type':type});res.end(req.method==='HEAD'?'':body)};
 return async function listener(req,res){
  let path;
  try{path=new URL(req.url||'/','http://localhost').pathname}catch{return send(req,res,400,'text/plain; charset=utf-8','Bad request')}
  if(path==='/health'){
   if(!['GET','HEAD'].includes(req.method))return send(req,res,405,'text/plain; charset=utf-8','Method not allowed');
   const database=await ping();
   return send(req,res,200,'application/json',JSON.stringify({status:'ok',service:'mms',persistence,database:database?'ok':'unavailable',applicationsOpen:APPLICATIONS_OPEN,engine:'stub-not-connected',productionReady:false}));
  }
  if(path.startsWith('/api/')){
   if(api)return api(req,res);
   return send(req,res,404,'application/json',JSON.stringify({error:'Not found'}));
  }
  const demo=syntheticArchiveResponse(path);
  if(demo){
   if(!['GET','HEAD'].includes(req.method))return send(req,res,405,'text/plain; charset=utf-8','Method not allowed');
   return send(req,res,demo.status,demo.type,demo.body);
  }
  if(publicHandler(req,res))return;
  const organizer=new RegExp('^/t/'+tenantId+'/organizer$').test(path);
  if(organizer&&['GET','HEAD'].includes(req.method)){
   let session=null;
   try{session=await authenticate(req)}catch{return send(req,res,503,'text/plain; charset=utf-8','Authentication unavailable')}
   if(!authorized(route(path),session))return send(req,res,404,'text/plain; charset=utf-8','Not found');
   let draft;
   try{draft=await service.read({principal:session,tenantId,eventId})}catch{return send(req,res,503,'text/plain; charset=utf-8','Draft store unavailable')}
   const body='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Organizer | MMS</title><link rel="stylesheet" href="/mms.css"></head><body><main class="mms-shell" id="main">'+renderDraftSettingsEditor(draft)+'<p>Edit via <code>PUT /api/t/'+tenantId+'/events/'+eventId+'/draft-settings</code> with the operator bearer token.</p></main></body></html>';
   return send(req,res,200,'text/html; charset=utf-8',body);
  }
  return shell(req,res);
 };
}

export async function createFromEnvironment(env=process.env){
 const tenantId=env.MMS_TENANT_ID||'mms';
 const origin=canonicalOrigin(env.MMS_PUBLIC_ORIGIN||env.RENDER_EXTERNAL_URL||'');
 let store,ping,persistence='memory',close=async()=>{};
 if(env.DATABASE_URL){
  const {default:pg}=await import('pg');
  const {createPgDraftStore}=await import('../storage/pg-draft-store.mjs');
  const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:10000});
  pool.on('error',()=>{});
  store=await createPgDraftStore(pool);ping=store.ping;persistence='postgres';close=()=>pool.end();
 }else if(env.NODE_ENV==='production')throw new Error('DATABASE_URL is required in production');
 const listener=createMmsApp({store,ping,persistence,adminToken:env.MMS_ADMIN_TOKEN,tenantId,origin,engine:env.MMS_ENGINE_ORIGIN||null});
 return {listener,close,origin,persistence};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const {listener,persistence,origin}=await createFromEnvironment();
 const server=createServer((req,res)=>{Promise.resolve(listener(req,res)).catch(()=>{if(!res.headersSent){res.writeHead(503,{'content-type':'text/plain'});res.end('Service unavailable')}else res.destroy()})});
 server.headersTimeout=10000;server.requestTimeout=15000;
 const port=Number(process.env.PORT||3000);
 server.listen(port,()=>console.log(JSON.stringify({msg:'mms listening',port,persistence,apiEnabled:Boolean(origin)})));
}
