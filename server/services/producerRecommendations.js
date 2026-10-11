'use strict';
// Producer-only recommendations: explicit production relationships, never artist listener similarity.
const fs=require('node:fs');
const path=require('node:path');
const {expandArtist}=require('./graphBuilder');
const {validId}=require('../requests/musicbrainz');
const DIR=path.join(__dirname,'..','featured');
const liveCache=new Map(),pending=new Map();
let corpus,stamp='',live=0;

function featuredGraphs(){
 let files=[];
 try{files=fs.readdirSync(DIR).filter(f=>f.endsWith('.json')&&f!=='index.json');}catch{return [];}
 const signature=files.map(f=>`${f}:${fs.statSync(path.join(DIR,f)).mtimeMs}`).join('|');
 if(corpus&&signature===stamp)return corpus;
 stamp=signature;
 corpus=files.flatMap(f=>{try{return [JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8'))];}catch{return [];}});
 return corpus;
}

function producerIndex(graphs){
 const people=new Map();
 for(const graph of graphs){
  const nodes=new Map((graph.nodes||[]).map(n=>[n.id,n]));
  for(const e of graph.edges||[]){
   if(e.type!=='produced')continue;
   const n=nodes.get(e.source),album=nodes.get(e.target);
   if(!n||!album||album.category!=='album'||!validId(n.mbid))continue;
   const person=people.get(n.mbid)||{id:n.mbid,name:n.label,thumb:n.thumb||'',albums:new Map(),artists:new Set(),genres:new Set()};
   if(n.thumb)person.thumb=n.thumb;
   person.albums.set(album.releaseGroupId||album.id,{id:album.releaseGroupId||album.mbid,title:album.label});
   for(const name of album.artistNames||[])person.artists.add(name);
   for(const g of album.genres||[])person.genres.add(g.toLowerCase());
   people.set(n.mbid,person);
  }
 }
 return people;
}
const intersect=(a,b)=>[...a].filter(x=>b.has(x));
function recommendProducers(graphs,id,limit=8){
 const people=producerIndex(graphs),seed=people.get(id);
 if(!seed)return [];
 return [...people.values()].filter(p=>p.id!==id).map(p=>{
  const albums=intersect(new Set(seed.albums.keys()),new Set(p.albums.keys()));
  const artists=intersect(seed.artists,p.artists);
  const genres=intersect(seed.genres,p.genres);
  const overlap=genres.length/Math.max(1,new Set([...seed.genres,...p.genres]).size);
  const score=albums.length*20+artists.length*8+overlap*4;
  const reasons=[];
  if(albums.length)reasons.push(`Both credited as producers on ${albums.slice(0,2).map(a=>seed.albums.get(a).title).join(' and ')}.`);
  if(artists.length)reasons.push(`Both have production credits for ${artists.slice(0,2).join(' and ')}.`);
  if(!reasons.length&&genres.length)reasons.push(`Production credits on records tagged ${genres.slice(0,3).join(', ')}.`);
  const evidence=albums.length?albums.map(a=>seed.albums.get(a)): [...p.albums.values()].slice(0,2);
  return {id:p.id,name:p.name,thumb:p.thumb,type:'Producer',score,reasons,genres:genres.slice(0,3),evidence:evidence.slice(0,2).map(a=>({title:a.title,url:`https://musicbrainz.org/release-group/${a.id}`}))};
 }).filter(p=>p.score>0&&p.reasons.length).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,limit);
}

async function getProducerRecommendations(id,{signal,limit=8}={}){
 const graphs=featuredGraphs();
 const baseline=recommendProducers(graphs,id,limit);
 let extra=liveCache.get(id);
 if(!extra||extra.expires<Date.now()){
  let task=pending.get(id);
  if(!task){
   if(live>=2){if(baseline.length)return {artists:baseline,coverage:'featured',source:'MusicBrainz production credits'};throw new Error('busy');}
   live++;
   task=(async()=>{
    const graph={nodes:[],edges:[]},nodes=new Map();
    const done=await expandArtist({id,name:'This producer',category:'producer'},event=>{
     if(event.type==='node')nodes.set(event.data.id,event.data);
     if(event.type==='edge')graph.edges.push(event.data);
    },{albums:3,maxRequests:16,maxTimeMS:45000,photos:false});
    graph.nodes=[...nodes.values()];
    if(done.reason==='error'&&!graph.edges.length)throw new Error('Production credits unavailable');
    const value={graph,expires:Date.now()+24*60*60*1000};
    liveCache.set(id,value);
    while(liveCache.size>100)liveCache.delete(liveCache.keys().next().value);
    return value;
   })().finally(()=>{live--;pending.delete(id);});
   pending.set(id,task);
  }
  try{extra=await task;}
  catch(error){if(baseline.length)return {artists:baseline,coverage:'featured',source:'MusicBrainz production credits'};throw error;}
 }
 if(signal?.aborted)throw new Error('aborted');
 return {artists:recommendProducers([...graphs,extra.graph],id,limit),coverage:'sampled',source:'MusicBrainz production credits'};
}
module.exports={producerIndex,recommendProducers,getProducerRecommendations};
