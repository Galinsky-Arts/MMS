import {validateMmsDefaults,MMS_DEFAULTS} from '../domain/defaults.mjs';

/** Postgres (Neon) adapter for producer draft settings.
 * Same contract as the SQLite adapter: read + atomic version compare-and-swap.
 * It stores drafts only; it cannot publish rules or grant engine capabilities.
 */
const ALL_CAPABILITIES=new Set(Object.keys(MMS_DEFAULTS).filter(k=>typeof MMS_DEFAULTS[k]==='boolean'));
const validVersion=v=>Number.isSafeInteger(v)&&v>=0&&v<2147483647;
function scope(tenant,event){
 if(typeof tenant!=='string'||!/^[a-z0-9-]{1,64}$/.test(tenant)||typeof event!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(event))
  throw new TypeError('Invalid tenant or event');
}
function checkedRow(row){
 if(!row||typeof row!=='object'||!Number.isSafeInteger(row.version)||row.version<1)throw new Error('Invalid stored draft');
 return {version:row.version,settings:validateMmsDefaults(row.settings,{enabledCapabilities:ALL_CAPABILITIES})};
}
export const DRAFT_SCHEMA=`CREATE TABLE IF NOT EXISTS mms_draft_settings (
 tenant TEXT NOT NULL CHECK (tenant ~ '^[a-z0-9-]{1,64}$'),
 event TEXT NOT NULL CHECK (event ~ '^[a-zA-Z0-9_-]{1,128}$'),
 version INTEGER NOT NULL CHECK (version > 0),
 settings JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant, event))`;

export async function createPgDraftStore(pool){
 if(!pool||typeof pool.query!=='function')throw new TypeError('Postgres pool required');
 await pool.query(DRAFT_SCHEMA);
 return {
  async read(tenant,event){
   scope(tenant,event);
   const {rows}=await pool.query('SELECT version,settings FROM mms_draft_settings WHERE tenant=$1 AND event=$2',[tenant,event]);
   return rows.length?checkedRow({version:rows[0].version,settings:structuredClone(rows[0].settings)}):null;
  },
  async compareAndSwap(tenant,event,expected,next){
   scope(tenant,event);
   if(!validVersion(expected))throw new TypeError('Invalid expected version');
   const checked=checkedRow(next);
   if(checked.version!==expected+1)throw new TypeError('Invalid next version');
   const json=JSON.stringify(checked.settings);
   const result=expected===0
    ?await pool.query('INSERT INTO mms_draft_settings(tenant,event,version,settings) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT (tenant,event) DO NOTHING',[tenant,event,checked.version,json])
    :await pool.query('UPDATE mms_draft_settings SET version=$1,settings=$2::jsonb,updated_at=now() WHERE tenant=$3 AND event=$4 AND version=$5',[checked.version,json,tenant,event,expected]);
   return result.rowCount===1;
  },
  async ping(){try{await pool.query('SELECT 1');return true}catch{return false}},
 };
}
