'use strict';
// "If you like X" recommendations from ListenBrainz (MetaBrainz): artists that listeners play in the same sessions.
// Free, no key, same MusicBrainz IDs the rest of the app uses.
const {validId}=require('../requests/musicbrainz');
const UA=process.env.MUSICBRAINZ_USER_AGENT||'RabbitHole/3.0 (https://github.com/JordanEvolved/RabbitHole)';
const ENDPOINT='https://labs.api.listenbrainz.org/similar-artists/json';
// The first algorithm is the one MetaBrainz recommends; the second often covers artists the first does not.
const ALGORITHMS=['session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30','session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30'];
const BLOCKED=new Set(['125ec42a-7229-4250-afc5-e057484327fe','89ad4ac3-39f7-470e-963a-56509c546377']);
const TTL=24*60*60*1000;
const cache=new Map();
const inflight=new Map();

function clean(rows,selfId,limit){
 const seen=new Set();
 const list=(Array.isArray(rows)?rows:[]).filter(r=>{
  const id=validId(r?.artist_mbid);
  if(!id||id===selfId||BLOCKED.has(id)||seen.has(id))return false;
  if(!r.name||/^\[.*\]$/.test(r.name)||/^various artists$/i.test(r.name))return false;
  seen.add(id);return true;
 }).map(r=>({id:validId(r.artist_mbid),name:String(r.name),note:String(r.comment||''),type:String(r.type||''),score:Number(r.score)||0}));
 const top=Math.max(1,...list.map(r=>r.score));
 return list.slice(0,limit).map(r=>({...r,match:Math.max(4,Math.round(r.score/top*100))}));
}

async function getSimilar(id,{signal,limit=12}={}){
 const key=String(id).toLowerCase(),hit=cache.get(key);
 if(hit&&hit.expires>Date.now())return hit.value.slice(0,limit);
 let pending=inflight.get(key);
 if(!pending){
  pending=(async()=>{
   let value=[];
   for(const algorithm of ALGORITHMS){
    const url=`${ENDPOINT}?artist_mbids=${encodeURIComponent(key)}&algorithm=${algorithm}`;
    const res=await fetch(url,{headers:{'User-Agent':UA,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
    if(!res.ok){if(value.length)break;throw new Error(`ListenBrainz responded ${res.status}`);}
    value=clean(await res.json(),key,30);
    if(value.length>=5)break;
   }
   cache.set(key,{value,expires:Date.now()+(value.length?TTL:60*60*1000)});
   while(cache.size>500)cache.delete(cache.keys().next().value);
   return value;
  })().finally(()=>inflight.delete(key));
  inflight.set(key,pending);
 }
 const value=await Promise.race([pending,new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))]);
 return value.slice(0,limit);
}
module.exports={getSimilar,clean};
