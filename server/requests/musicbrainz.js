'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {rateLimitedFetch}=require('../services/rateLimiter');
const API='https://musicbrainz.org/ws/2';
const MBID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Vercel's deployment is read-only; only temporary storage is writable.
const CACHE_DIR=process.env.VERCEL?path.join(os.tmpdir(),'rabbithole','musicbrainz'):path.join(__dirname,'..','..','.cache','musicbrainz');
const crypto=require('node:crypto');
const cache=new Map();
const TTL=24*60*60*1000, MAX=1000;
const validId=id=>typeof id==='string'&&MBID.test(id)?id.toLowerCase():null;
const cacheFile=key=>path.join(CACHE_DIR,crypto.createHash('sha256').update(key).digest('hex')+'.json');
function getCache(key){
 let hit=cache.get(key);
 if(!hit){try{hit=JSON.parse(fs.readFileSync(cacheFile(key),'utf8'));}catch{return;}}
 if(hit.expires<Date.now()){cache.delete(key);return;}
 cache.delete(key);cache.set(key,hit);return hit.value;
}
function putCache(key,value){
 const hit={expires:Date.now()+TTL,value};cache.delete(key);cache.set(key,hit);
 while(cache.size>MAX)cache.delete(cache.keys().next().value);
 try{fs.mkdirSync(CACHE_DIR,{recursive:true});fs.writeFileSync(cacheFile(key),JSON.stringify(hit));}catch{}
}
async function request(entity,params,budget){
 const search=new URLSearchParams({...params,fmt:'json'});search.sort();
 const key=`/${entity}?${search}`;
 const cached=getCache(key);if(cached!==undefined){if(budget.signal?.aborted)throw new DOMException('Aborted','AbortError');return cached;}
 const value=await rateLimitedFetch(API+key,{headers:{'User-Agent':process.env.MUSICBRAINZ_USER_AGENT||'RabbitHole/3.0 (https://github.com/JordanEvolved/RabbitHole)',Accept:'application/json'}},budget);
 putCache(key,value);return value;
}
const escapeQuery=q=>String(q).replace(/([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g,'\\$1');
const fold=text=>String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
// Phrase match first, then "all words, last one as a prefix" so partial typing finds people ("mac mil" finds Mac Miller).
function artistQuery(name){
 const words=String(name).trim().split(/\s+/).filter(Boolean).slice(0,6);
 const phrase=escapeQuery(words.join(' '));
 const all=words.map((w,i)=>i===words.length-1&&w.length>=2?`${escapeQuery(w)}*`:escapeQuery(w)).join(' AND ');
 return `artist:"${phrase}"^6 OR alias:"${phrase}"^3 OR sortname:"${phrase}"^3 OR artist:(${all}) OR alias:(${all})`;
}
function rankArtist(a,query){
 const q=fold(query),n=fold(a.name),words=q.split(' ').filter(Boolean);
 let score=Number(a.score)||0;
 if(n===q)score+=60;else if(n.startsWith(q))score+=35;else if(words.every(w=>n.includes(w)))score+=18;
 else if(asArray(a.aliases).some(x=>fold(x.name)===q))score+=30;
 score+=Math.min(30,asArray(a.tags).reduce((sum,t)=>sum+Math.max(0,t.count),0)*1.5);
 if(a.country||a.area)score+=2;if(a.disambiguation)score+=2;
 if(!a.type&&!a.country&&!a.disambiguation&&!asArray(a.tags).length)score-=20;
 return score;
}
const asArray=v=>Array.isArray(v)?v:[];
async function searchArtists(name,budget,limit=8){
 const data=await request('artist',{query:artistQuery(name),limit:'20'},budget);
 return asArray(data.artists).filter(a=>validId(a.id)&&!['89ad4ac3-39f7-470e-963a-56509c546377','125ec42a-7229-4250-afc5-e057484327fe'].includes(a.id))
  .map(a=>({a,rank:rankArtist(a,name)})).sort((x,y)=>y.rank-x.rank).slice(0,limit)
  .map(({a})=>({id:a.id,name:a.name,sortName:a['sort-name'],score:Number(a.score)||0,type:a.type||'',country:a.area?.name||a.country||'',disambiguation:a.disambiguation||'',genres:asArray(a.tags).filter(t=>t.count>0).sort((x,y)=>y.count-x.count).slice(0,3).map(t=>t.name)}));
}
const getArtist=(id,budget)=>request(`artist/${id}`,{inc:'url-rels+recording-rels+genres'},budget);
const getReleaseGroups=(id,budget,offset=0)=>request('release-group',{artist:id,limit:'100',offset:String(offset),inc:'artist-credits+genres+ratings',type:'album|ep'},budget);
// Browse includes the recording relationships, saving a separate release lookup per album.
const getGroupRelease=(id,budget)=>request('release',{'release-group':id,status:'official',limit:'3',inc:'artist-credits+recordings+artist-rels+recording-level-rels+labels+release-groups'},budget);
const getRelease=(id,budget)=>request(`release/${id}`,{inc:'artist-credits+recordings+artist-rels+recording-level-rels+labels+release-groups'},budget);
const getRecording=(id,budget)=>request(`recording/${id}`,{inc:'releases+release-groups+artist-credits+artist-rels'},budget);
module.exports={request,searchArtists,getArtist,getReleaseGroups,getGroupRelease,getRelease,getRecording,validId,escapeQuery};
