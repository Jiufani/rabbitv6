'use strict';
// Artist profile: MusicBrainz facts + Wikipedia summary/photo when MusicBrainz links Wikidata.
const mb=require('../requests/musicbrainz');
const UA=process.env.MUSICBRAINZ_USER_AGENT||'RabbitHole/3.0 (https://github.com/JordanEvolved/RabbitHole)';
const cache=new Map();
const TTL=24*60*60*1000;
const asArray=v=>Array.isArray(v)?v:[];
async function json(url,signal){
 const res=await fetch(url,{headers:{'User-Agent':UA,Accept:'application/json'},signal:AbortSignal.any([AbortSignal.timeout(9000),...(signal?[signal]:[])])});
 if(!res.ok)throw new Error(String(res.status));return res.json();
}
function linksFrom(profile){
 const out=[];
 for(const r of asArray(profile.relations)){
  const url=r.url?.resource;if(!url||!/^https?:\/\//.test(url))continue;
  const host=(()=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}})();
  if(r.type==='official homepage')out.push({label:'Official site',url});
  else if(r.type==='social network'){
   const label=/instagram/.test(host)?'Instagram':/twitter|x\.com/.test(host)?'X':/facebook/.test(host)?'Facebook':/youtube/.test(host)?'YouTube':/bandcamp/.test(host)?'Bandcamp':'';
   if(label)out.push({label,url});
  }else if(r.type==='streaming'||r.type==='free streaming'){
   const label=/spotify/.test(host)?'Spotify':/apple/.test(host)?'Apple Music':/deezer/.test(host)?'Deezer':'';
   if(label&&!out.some(l=>l.label===label))out.push({label,url});
  }
 }
 const seen=new Set();return out.filter(l=>!seen.has(l.label)&&seen.add(l.label)).slice(0,5);
}
async function wikipedia(profile,signal){
 const wikidata=asArray(profile.relations).find(r=>r.type==='wikidata')?.url?.resource;
 const qid=wikidata?.match(/\/(Q\d+)$/)?.[1];if(!qid)return {};
 try{
  const entity=await json(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`,signal);
  const title=entity.entities?.[qid]?.sitelinks?.enwiki?.title;if(!title)return {};
  const page=await json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g,'_'))}`,signal);
  return {extract:page.extract||'',image:page.thumbnail?.source||'',wikipedia:page.content_urls?.desktop?.page||`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`};
 }catch{return {};}
}
function summarize(profile,wiki){
 const begin=profile['life-span']?.begin||'',end=profile['life-span']?.end||'';
 return {id:profile.id,name:profile.name,type:profile.type||'',country:profile.country||profile.area?.name||'',area:profile.area?.name||'',begin,end,ended:Boolean(profile['life-span']?.ended),disambiguation:profile.disambiguation||'',genres:asArray(profile.genres).filter(g=>g.count>0).sort((a,b)=>b.count-a.count).slice(0,5).map(g=>g.name),links:linksFrom(profile),extract:wiki.extract||'',image:wiki.image||'',wikipedia:wiki.wikipedia||'',musicbrainz:`https://musicbrainz.org/artist/${profile.id}`};
}
async function getArtistInfo(id,budget){
 const key=String(id).toLowerCase(),hit=cache.get(key);
 if(hit&&hit.expires>Date.now())return hit.value;
 const profile=await mb.getArtist(key,budget);
 const value=summarize(profile,await wikipedia(profile,budget.signal));
 cache.set(key,{value,expires:Date.now()+TTL});
 while(cache.size>600)cache.delete(cache.keys().next().value);
 return value;
}
module.exports={getArtistInfo,summarize,wikipedia,linksFrom};
