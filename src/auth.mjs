import {createHash,timingSafeEqual} from 'node:crypto';

/** Prototype operator authentication (STUB for the upstream session contract).
 *
 * Live-Competition-Engine's session API is not available to this deployment, so a
 * single operator bearer token (env MMS_ADMIN_TOKEN) stands in for a verified
 * producer session scoped to one tenant. It never grants the industry role and it
 * never derives identity from client-chosen headers other than the bearer secret.
 * Missing or short secrets fail closed: every private route stays unavailable.
 */
export const OPERATOR_ROLES=Object.freeze(['producer','member']);
const digest=value=>createHash('sha256').update(value,'utf8').digest();
function bearer(req){
 const raw=typeof req?.headers?.get==='function'?req.headers.get('authorization'):req?.headers?.authorization;
 if(typeof raw!=='string')return null;
 const match=/^Bearer ([A-Za-z0-9._~+\/-]{32,512}={0,2})$/.exec(raw);
 return match?match[1]:null;
}
export function createOperatorAuthenticator({token,tenantId}={}){
 if(typeof tenantId!=='string'||!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(tenantId))throw new TypeError('Invalid operator tenant');
 if(typeof token!=='string'||token.length<32)return async()=>null;
 const expected=digest(token);
 return async req=>{
  const presented=bearer(req);
  if(!presented||!timingSafeEqual(digest(presented),expected))return null;
  return {verified:true,subject:'mms-operator',tenantId,roles:new Set(OPERATOR_ROLES)};
 };
}
