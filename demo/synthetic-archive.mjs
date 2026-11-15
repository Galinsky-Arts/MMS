import {publicEventProjection} from '../domain/archive.mjs';
import {renderPublicSite,PUBLIC_CSS} from '../views/public-site.mjs';

/** SYNTHETIC DEMONSTRATION CONTENT ONLY.
 * These records are invented fixtures that exercise the MMS-07 public projection
 * and page renderer. They are not real events, performers, results or recordings,
 * and contain no applicant data. Nothing here is fetched from the engine.
 */
export const DEMO_TENANT='demo';
const RAW=Object.freeze([
 {eventId:'synthetic-spring-final',title:'Spring Monologue Final (synthetic demo)',status:'completed',published:true,championDisplayName:'Demo Performer A (fictional)',recordingUrl:null},
 {eventId:'synthetic-summer-qualifier',title:'Summer Qualifier (synthetic demo)',status:'scheduled',published:true,championDisplayName:null,recordingUrl:null},
 {eventId:'synthetic-winter-showcase',title:'Winter Showcase (synthetic demo)',status:'cancelled',published:true,championDisplayName:null,recordingUrl:null},
 {eventId:'synthetic-unpublished',title:'Unpublished draft (synthetic demo)',status:'completed',published:false,championDisplayName:'Never shown',recordingUrl:null},
]);
const EVENTS=Object.freeze(RAW.map(publicEventProjection).filter(Boolean)
 .map(e=>Object.freeze({...e,captions:null,liveUrl:null})));
const BANNER='<p class="mms-card" role="note"><strong>Synthetic demonstration data.</strong> Every event, name and result on this page is fictional and exists only to preview the MMS public archive. No real competition, performer or recording is shown.</p>';
const PAGES=new Set(['watch','archive','apply','vote','sponsor']);

/** Returns {status,type,body} for /t/demo/* and /archive.css, otherwise null. */
export function syntheticArchiveResponse(path){
 if(path==='/archive.css')return {status:200,type:'text/css; charset=utf-8',body:PUBLIC_CSS};
 const base='/t/'+DEMO_TENANT;
 if(path!==base&&!path.startsWith(base+'/'))return null;
 const rest=path.slice(base.length);
 let html;
 if(rest==='')html=renderPublicSite({tenantId:DEMO_TENANT,page:'home',events:[...EVENTS]});
 else if(PAGES.has(rest.slice(1))){
  const page=rest.slice(1);
  const events=page==='watch'?EVENTS.filter(e=>e.status!=='cancelled'):page==='archive'?EVENTS.filter(e=>e.status==='completed'):[];
  html=renderPublicSite({tenantId:DEMO_TENANT,page,events});
 }else{
  const match=/^\/events\/([a-zA-Z0-9_-]{1,128})$/.exec(rest);
  if(!match)return null;
  const event=EVENTS.find(e=>e.eventId===match[1])??null;
  html=renderPublicSite({tenantId:DEMO_TENANT,page:'event',event});
  if(!event)return {status:404,type:'text/html; charset=utf-8',body:addBanner(html)};
 }
 return {status:200,type:'text/html; charset=utf-8',body:addBanner(html)};
}
function addBanner(html){return html.replace('<main id="main" tabindex="-1">','<main id="main" tabindex="-1">'+BANNER)}
export const SYNTHETIC_EVENTS=EVENTS;
