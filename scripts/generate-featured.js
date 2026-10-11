'use strict';
// Builds the cached "featured" maps shipped with the app.
//   node scripts/generate-featured.js                  rebuild the default set
//   node scripts/generate-featured.js "Mac Miller"     build or refresh one artist
// Uses the same one-request-per-second MusicBrainz queue as the server. Expect about 2 minutes per artist.
require('dotenv').config({quiet:true});
const fs=require('node:fs');
const path=require('node:path');
const {expandArtist,resolveArtist}=require('../server/services/graphBuilder');
const {getArtistInfo}=require('../server/services/artistInfo');
const {createBudget}=require('../server/services/budget');

const OUT=path.join(__dirname,'..','server','featured');
const DEFAULT=['Kendrick Lamar','Frank Ocean','Tyler, the Creator','Daft Punk','Fleetwood Mac','Beyoncé','Björk','Radiohead'];
const RANK={artist:3,producer:2,featured:1,album:0};
const slugify=s=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

function collector(){
 const nodes=new Map(),edges=new Map();
 return {nodes,edges,emit(m){
  if(m.type==='node'){
   const prev=nodes.get(m.data.id);
   if(!prev){nodes.set(m.data.id,{...m.data,roles:[...(m.data.roles??[])]});return;}
   const roles=[...new Set([...(prev.roles??[]),...(m.data.roles??[])])];
   const category=(RANK[m.data.category]??0)>(RANK[prev.category]??0)?m.data.category:prev.category;
   nodes.set(m.data.id,{...prev,...Object.fromEntries(Object.entries(m.data).filter(([,v])=>v!==''&&v!=null)),category,roles});
  }else if(m.type==='edge')edges.set(m.data.id,m.data);
  else if(m.type==='error')console.warn('  !',m.message);
 }};
}

(async()=>{
 fs.mkdirSync(OUT,{recursive:true});
 const names=process.argv.slice(2).length?process.argv.slice(2):DEFAULT;
 const indexFile=path.join(OUT,'index.json');
 const index=fs.existsSync(indexFile)?JSON.parse(fs.readFileSync(indexFile,'utf8')):[];
 for(const name of names){
  console.log(`\n== ${name}`);
  const root=await resolveArtist(name);
  if(!root){console.warn('  not found');continue;}
  const rootNode=`artist-${root.id}`,c=collector();
  const first=await expandArtist({id:root.id,name:root.name},c.emit,{albums:4,maxRequests:24,maxNodes:90});
  if(!first.albumsAdded){console.warn('  no records found, skipping');continue;}
  const degree=new Map();
  for(const e of c.edges.values())degree.set(e.source,(degree.get(e.source)??0)+1);
  const targets=[...c.nodes.values()].filter(n=>n.category!=='album'&&n.id!==rootNode).sort((a,b)=>(degree.get(b.id)??0)-(degree.get(a.id)??0)).slice(0,2);
  const expanded=[rootNode];
  for(const t of targets){
   console.log('  dive ->',t.label);
   const exclude=[...c.nodes.values()].filter(n=>n.releaseGroupId).map(n=>n.releaseGroupId);
   const r=await expandArtist({id:t.mbid,name:t.label,category:t.category,roles:t.roles},c.emit,{albums:2,maxRequests:16,maxNodes:70,exclude});
   if(r.albumsAdded)expanded.push(t.id);
  }
  console.log('  adding photos and profiles');
  for(const n of c.nodes.values()){
   if(n.category==='album'||n.thumb)continue;
   try{
    const info=await getArtistInfo(n.mbid,createBudget({maxRequests:2,maxTimeMS:20000,priority:1}));
    if(info.image)n.thumb=info.image;
    if(info.type&&!n.artistType)n.artistType=info.type;
   }catch(error){/* A missing photo is fine. */}
  }
  const nodes=[...c.nodes.values()],edges=[...c.edges.values()];
  const rootData=c.nodes.get(rootNode);
  const slug=slugify(root.name);
  fs.writeFileSync(path.join(OUT,`${slug}.json`),JSON.stringify({slug,rootId:rootNode,expanded,name:root.name,source:'MusicBrainz',nodes,edges,generatedAt:new Date().toISOString()}));
  const entry={slug,mbid:rootData?.mbid||'',name:root.name,thumb:rootData?.thumb||'',genres:rootData?.genres||[],albums:nodes.filter(n=>n.category==='album').length,people:nodes.filter(n=>n.category!=='album').length};
  const i=index.findIndex(x=>x.slug===slug);i>=0?index[i]=entry:index.push(entry);
  fs.writeFileSync(indexFile,JSON.stringify(index,null,1));
  console.log(`  saved ${slug}: ${nodes.length} nodes, ${edges.length} edges, ${nodes.filter(n=>n.thumb&&n.category!=='album').length} photos`);
 }
})().catch(e=>{console.error(e);process.exit(1);});
