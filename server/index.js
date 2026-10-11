'use strict';
const path=require('node:path');
const fs=require('node:fs');
const express=require('express');
require('dotenv').config({quiet:true});

const {expandArtist,resolveArtist}=require('./services/graphBuilder');
const {searchArtists,validId}=require('./requests/musicbrainz');
const {getArtistInfo}=require('./services/artistInfo');
const {getSimilar}=require('./services/similar');
const {getProducerRecommendations}=require('./services/producerRecommendations');
const {createBudget}=require('./services/budget');
const {ApiError,queueLength}=require('./services/rateLimiter');

const app=express();
const PORT=Number(process.env.PORT)||3000;
const CLIENT_DIR=path.join(__dirname,'..','client');
const FEATURED_DIR=path.join(__dirname,'featured');
const MAX_ACTIVE_PER_IP=3;
const active=new Map();
const UA=process.env.MUSICBRAINZ_USER_AGENT||'RabbitHole/3.0 (https://github.com/JordanEvolved/RabbitHole)';

app.disable('x-powered-by');
app.set('trust proxy',true);
app.use((req,res,next)=>{
 res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 next();
});

const errorStatus=error=>error instanceof ApiError?(error.status===404?404:error.status===429?429:503):500;
const errorMessage=error=>error instanceof ApiError?error.message:'Could not reach MusicBrainz. Please try again.';
const listFeatured=()=>{try{return JSON.parse(fs.readFileSync(path.join(FEATURED_DIR,'index.json'),'utf8'));}catch{return [];}};
const interactive=signal=>createBudget({maxRequests:3,maxTimeMS:30000,signal,priority:0});
function abortOnClose(req,res){
 const controller=new AbortController();
 res.on('close',()=>{if(!res.writableEnded)controller.abort();});
 return controller;
}

app.get('/api/health',(req,res)=>res.json({ok:true,source:'MusicBrainz',featured:listFeatured().length,queued:queueLength()}));

// Artist autocomplete / disambiguation.
app.get('/api/search',async(req,res)=>{
 const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,100):'';
 if(q.length<2)return res.json({results:[]});
 const controller=abortOnClose(req,res);
 try{
  const results=await searchArtists(q,interactive(controller.signal),8);
  res.json({results:results.map(r=>({id:r.id,name:r.name,type:r.type,country:r.country,disambiguation:r.disambiguation,genres:r.genres,score:r.score}))});
 }catch(error){
  if(controller.signal.aborted)return;
  res.status(errorStatus(error)).json({error:errorMessage(error)});
 }
});

// Rich profile for the detail panel: MusicBrainz facts plus a Wikipedia summary and photo when available.
app.get('/api/artist/:id',async(req,res)=>{
 const id=validId(req.params.id);
 if(!id)return res.status(400).json({error:'That is not a valid MusicBrainz artist ID.'});
 const controller=abortOnClose(req,res);
 try{res.set('Cache-Control','public, max-age=3600').json(await getArtistInfo(id,interactive(controller.signal)));}
 catch(error){if(!controller.signal.aborted)res.status(errorStatus(error)).json({error:errorMessage(error)});}
});

// "If you like this artist" recommendations. Works for artists and producers that listeners play; otherwise returns an empty list.
app.get('/api/similar/:id',async(req,res)=>{
 const id=validId(req.params.id);
 if(!id)return res.status(400).json({error:'That is not a valid MusicBrainz artist ID.'});
 const controller=abortOnClose(req,res);
 const limit=Math.min(24,Math.max(1,Number(req.query.limit)||12));
 try{res.set('Cache-Control','public, max-age=3600').json({source:'ListenBrainz',artists:await getSimilar(id,{signal:controller.signal,limit})});}
 catch(error){if(!controller.signal.aborted)res.status(503).json({error:'Recommendations are unavailable right now. Please try again in a moment.'});}
});

// Producers with overlapping credits, from MusicBrainz production relationships.
app.get('/api/producers/:id',async(req,res)=>{
 const id=validId(req.params.id);
 if(!id)return res.status(400).json({error:'That is not a valid MusicBrainz artist ID.'});
 const controller=abortOnClose(req,res);
 try{res.set('Cache-Control','public, max-age=3600').json(await getProducerRecommendations(id,{signal:controller.signal,limit:8}));}
 catch(error){if(!controller.signal.aborted)res.status(503).json({error:error.message==='busy'?'Reading production credits for other producers right now. Try again in a few seconds.':'Production credits are unavailable right now. Please try again.'});}
});

// Featured maps are pre-built, so the first screen is instant and works even when MusicBrainz is slow.
app.get('/api/featured',(req,res)=>res.json({featured:listFeatured()}));
app.get('/api/featured/:slug',(req,res)=>{
 const slug=String(req.params.slug).replace(/[^a-z0-9-]/gi,'');
 const file=path.join(FEATURED_DIR,`${slug}.json`);
 if(!slug||!fs.existsSync(file))return res.status(404).json({error:'Featured map not found'});
 res.type('json').send(fs.readFileSync(file));
});

// Stream a graph expansion as Server-Sent Events.
app.get('/api/graph',async(req,res)=>{
 const id=req.query.id?validId(String(req.query.id)):null;
 const name=typeof req.query.name==='string'?req.query.name.trim().slice(0,100):'';
 if(req.query.id&&!id)return res.status(400).json({error:'That is not a valid MusicBrainz artist ID.'});
 if(!id&&!name)return res.status(400).json({error:'Artist name or id is required'});

 const ip=req.ip||'unknown';
 if((active.get(ip)??0)>=MAX_ACTIVE_PER_IP)return res.status(429).json({error:'Too many maps are loading at once. Let one finish first.'});
 active.set(ip,(active.get(ip)??0)+1);

 res.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
 res.flushHeaders();
 const controller=new AbortController();
 res.on('close',()=>controller.abort());
 const emit=update=>{if(!res.destroyed&&!res.writableEnded)res.write(`data: ${JSON.stringify(update)}\n\n`);};
 const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': ping\n\n');},12000);
 const exclude=String(req.query.exclude??'').split(',').map(validId).filter(Boolean).slice(0,300);
 const albums=Math.min(5,Math.max(1,Number(req.query.albums)||3));
 try{
  const category=['artist','producer','featured'].includes(req.query.category)?req.query.category:'artist';
  let artist={id,name,category};
  if(!id){
   const found=await resolveArtist(name,controller.signal);
   if(!found){emit({type:'complete',reason:'not_found',nodes:0,edges:0,requests:0});return;}
   artist={id:found.id,name:found.name,category};
  }
  await expandArtist(artist,emit,{albums,exclude,signal:controller.signal});
 }catch(error){
  if(!controller.signal.aborted){
   if(!(error instanceof ApiError))console.error(error);
   emit({type:'error',message:errorMessage(error)});
   emit({type:'complete',reason:'error',nodes:0,edges:0,requests:0});
  }
 }finally{
  clearInterval(heartbeat);
  const left=(active.get(ip)??1)-1;left>0?active.set(ip,left):active.delete(ip);
  res.end();
 }
});

// Same-origin image proxy: artwork loads reliably, is cached, and can be exported from the canvas.
const imageCache=new Map();
const IMAGE_HOSTS=[/^coverartarchive\.org$/,/^(?:[a-z0-9-]+\.)*archive\.org$/,/^(?:upload|thumb)\.wikimedia\.org$/];
const allowedImage=url=>url.protocol==='https:'&&IMAGE_HOSTS.some(rule=>rule.test(url.hostname));
let imageSlots=0;const imageWaiters=[];
const acquire=()=>imageSlots<6?(imageSlots++,Promise.resolve()):new Promise(resolve=>imageWaiters.push(resolve));
const release=()=>{const next=imageWaiters.shift();if(next)next();else imageSlots--;};
async function fetchImage(startUrl){
 let url=new URL(startUrl);
 for(let hop=0;hop<5;hop++){
  if(!allowedImage(url))return null;
  const upstream=await fetch(url,{redirect:'manual',headers:{'User-Agent':UA,Accept:'image/*'},signal:AbortSignal.timeout(12000)});
  if([301,302,303,307,308].includes(upstream.status)){
   const location=upstream.headers.get('location');if(!location)return null;
   url=new URL(location,url);continue;
  }
  const type=upstream.headers.get('content-type')||'';
  if(!upstream.ok||!type.startsWith('image/'))return null;
  const body=Buffer.from(await upstream.arrayBuffer());
  return body.length>4e6?null:{type,body};
 }
 return null;
}
app.get('/api/img',async(req,res)=>{
 let url;
 try{url=new URL(String(req.query.u||''));}catch{return res.status(400).end();}
 if(!allowedImage(url))return res.status(400).end();
 const key=url.href;
 let hit=imageCache.get(key);
 if(!hit){
  await acquire();
  try{
   hit=imageCache.get(key)||await fetchImage(key);
   hit=hit||{missing:true};
   imageCache.set(key,hit);
   while(imageCache.size>400)imageCache.delete(imageCache.keys().next().value);
  }catch{release();return res.status(502).end();}
  release();
 }
 if(hit.missing)return res.set('Cache-Control','public, max-age=3600').status(404).end();
 res.set({'Content-Type':hit.type,'Cache-Control':'public, max-age=86400'}).send(hit.body);
});

app.use('/api',(req,res)=>res.status(404).json({error:'Not found'}));
app.use(express.static(CLIENT_DIR,{extensions:['html'],etag:true,setHeaders:res=>res.setHeader('Cache-Control','no-cache')}));
app.use((req,res)=>res.status(404).sendFile(path.join(CLIENT_DIR,'index.html')));

if(require.main===module){
 app.listen(PORT,'0.0.0.0',()=>{
  console.log(`RabbitHole running on http://localhost:${PORT}`);
  console.log('Data from MusicBrainz, Cover Art Archive and Wikipedia. No API key needed.');
 });
}
module.exports=app;
