import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftSettingsService} from '../domain/draft-settings.mjs';
import {MMS_DEFAULTS} from '../domain/defaults.mjs';

// Runs against a real Postgres when TEST_DATABASE_URL is set (CI service container).
const url=process.env.TEST_DATABASE_URL;
const principal={verified:true,subject:'p1',tenantId:'tenant-a',roles:new Set(['producer'])};
const args={principal,tenantId:'tenant-a',eventId:'event-1'};

test('postgres draft store round-trips, isolates tenants and has one concurrent winner',{skip:!url&&'TEST_DATABASE_URL not set'},async t=>{
 const {default:pg}=await import('pg');
 const {createPgDraftStore}=await import('../storage/pg-draft-store.mjs');
 const pool=new pg.Pool({connectionString:url,max:4});t.after(()=>pool.end());
 await pool.query('DROP TABLE IF EXISTS mms_draft_settings');
 const store=await createPgDraftStore(pool);await createPgDraftStore(pool);
 assert.equal(await store.ping(),true);
 const service=createDraftSettingsService(store);
 assert.equal(await service.read(args),null);
 const saved=await service.save({...args,expectedVersion:0,settings:MMS_DEFAULTS});
 assert.deepEqual(await service.read(args),saved);
 await assert.rejects(service.save({...args,expectedVersion:0,settings:MMS_DEFAULTS}),/Version conflict/);
 assert.equal(await service.read({...args,eventId:'event-2'}),null);
 assert.equal(await service.read({...args,tenantId:'tenant-b',principal:{...principal,tenantId:'tenant-b'}}),null);
 await assert.rejects(service.read({...args,tenantId:'tenant-b'}),/Not authorized/);
 const results=await Promise.allSettled([1,2,3].map(n=>service.save({...args,expectedVersion:1,settings:{...MMS_DEFAULTS,entrantWindowDays:10+n}})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await service.read(args)).version,2);
 await assert.rejects(store.compareAndSwap("x'; DROP TABLE mms_draft_settings; --",'e',0,{version:1,settings:MMS_DEFAULTS}),/Invalid tenant/);
 await pool.query("UPDATE mms_draft_settings SET settings=jsonb_set(settings,'{battlesEnabled}','\"yes\"') WHERE tenant='tenant-a'");
 await assert.rejects(service.read(args),/Invalid optional setting/);
});
