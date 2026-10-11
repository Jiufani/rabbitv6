'use strict';
const mb=require('../requests/musicbrainz');
const {createBudget,BudgetExceeded}=require('./budget');
const {ApiError}=require('./rateLimiter');
const {wikipedia}=require('./artistInfo');
const asArray=v=>Array.isArray(v)?v:[];
const cleanName=s=>String(s??'').trim();
const SKIP=/live|compilation|remix|dj-mix|interview|audiobook|spokenword/i;
const UNKNOWN=new Set(['89ad4ac3-39f7-470e-963a-56509c546377','125ec42a-7229-4250-afc5-e057484327fe']);
const artistCredits=entity=>asArray(entity?.['artist-credit']).map(c=>c.artist).filter(a=>mb.validId(a?.id)&&!UNKNOWN.has(a.id));
const allTracks=release=>asArray(release?.media).flatMap(m=>asArray(m.tracks));
const genres=entity=>asArray(entity?.genres).filter(g=>g.count>0).sort((a,b)=>b.count-a.count).slice(0,5).map(g=>g.name);
const cover=(id,size=250)=>`https://coverartarchive.org/release-group/${id}/front-${size}`;
// Only link artwork that the Cover Art Archive reports for the chosen release; others show a tidy placeholder.
const art=(release,groupId,size)=>release?.['cover-art-archive']?.front?`https://coverartarchive.org/release/${release.id}/front-${size}`:'';

// Real MusicBrainz artist relationships, plus recording artist credits. No inferred names or
// fuzzy artist matching. All the evidence points to the exact recording/release MBID.
function collectCredits(release,limits={producer:7,featured:9}){
 const main=new Set(artistCredits(release).map(a=>a.id));
 const tally=new Map();
 const add=(artist,kind,role,track)=>{
  if(!mb.validId(artist?.id)||UNKNOWN.has(artist.id))return;
  const key=`${kind}:${artist.id}`;
  const hit=tally.get(key)||{id:artist.id,name:artist.name,kind,roles:new Set(),tracks:new Map(),score:0};
  hit.roles.add(role);
  if(track?.id&&!hit.tracks.has(track.id)){hit.tracks.set(track.id,{id:track.id,title:track.title});hit.score++;}
  else if(!track)hit.score+=3;
  tally.set(key,hit);
 };
 const relationships=(entity,track)=>{
  for(const r of asArray(entity?.relations)){
   if(r['target-type']!=='artist'||!r.artist)continue;
   const attrs=asArray(r.attributes);
   if(r.type==='producer'&&!attrs.includes('executive'))add(r.artist,'producer',attrs.includes('co')?'Co-producer':'Producer',track);
   const guest=attrs.includes('guest')||attrs.includes('additional');
   if(!main.has(r.artist.id)&&(r.type==='vocal'||(['instrument','performer'].includes(r.type)&&guest))){
    const role=r.type==='vocal'?(attrs.includes('background vocals')?'Backing vocals':'Vocals'):r.type==='instrument'?(attrs.filter(a=>!['guest','additional','solo','co','original'].includes(a)).join(', ')||'Instrument'):'Performer';
    add(r.artist,'featured',role,track);
   }
  }
 };
 relationships(release,null);
 for(const t of allTracks(release)){
  const rec=t.recording||{};
  const track={id:rec.id,title:t.title||rec.title||''};
  const ac=artistCredits(t).length?artistCredits(t):artistCredits(rec);
  for(const a of ac)if(!main.has(a.id))add(a,'featured','Recording artist',track);
  relationships(rec,track);
 }
 const sorted=[...tally.values()].sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).map(h=>({...h,roles:[...h.roles],tracks:[...h.tracks.values()]}));
 return {producers:sorted.filter(c=>c.kind==='producer').slice(0,limits.producer??7),featured:sorted.filter(c=>c.kind==='featured').slice(0,limits.featured??9)};
}
function scoreGroup(g){
 const votes=Number(g.rating?.['votes-count'])||0;
 const count=asArray(g.genres).reduce((sum,t)=>sum+Math.max(0,Number(t.count)||0),0);
 let score=votes*3+count+3;
 if(g['primary-type']==='Album')score+=10;
 if(asArray(g['secondary-types']).some(t=>SKIP.test(t)))score*=.06;
 if(asArray(g['secondary-types']).includes('Mixtape/Street'))score*=.3;
 return score;
}
// A release group has many editions. Prefer one with cover art and rich credits, without choosing a bloated deluxe edition.
function bestRelease(releases){
 const rank=r=>{
  const rels=allTracks(r).reduce((n,t)=>n+asArray(t.recording?.relations).length,0);
  return (r['cover-art-archive']?.front?1000:0)+Math.min(rels,350)-allTracks(r).length*1.5;
 };
 return [...releases].sort((a,b)=>rank(b)-rank(a))[0];
}
async function pickAlbums(artist,exclude,budget,wanted,profile,progress=()=>{}){
 let sampled=false;
 const listing=await mb.getReleaseGroups(artist.id,budget);
 let groups=asArray(listing['release-groups']);
 if((listing['release-group-count']||0)>100&&budget.canRequest()){
  const more=await mb.getReleaseGroups(artist.id,budget,100);
  groups.push(...asArray(more['release-groups']));
 }
 const candidates=new Map();
 const add=(g,extra={})=>{if(mb.validId(g?.id)&&!exclude.has(g.id)&&!candidates.has(g.id))candidates.set(g.id,{...g,...extra});};
 groups.sort((a,b)=>scoreGroup(b)-scoreGroup(a)||String(b['first-release-date']).localeCompare(String(a['first-release-date']))).forEach(g=>add(g));
 // Producers and other behind-the-scenes performers often have no discography under their own
 // name. Follow explicit recording relationships to official studio releases instead.
 if(artist.category==='producer'||candidates.size<wanted){
  const relations=asArray(profile?.relations).filter(r=>r.recording&&['producer','vocal','instrument','performer','remixer'].includes(r.type)&&!asArray(r.attributes).includes('executive'));
  const seen=new Set();const recordings=relations.filter(r=>!seen.has(r.recording.id)&&seen.add(r.recording.id));
  // Deterministic spread rather than simply taking the first few titles from a large catalogue.
  // Each repeat dive starts from a different place in the catalogue, so "Explore more" finds new records.
  const sample=[],spots=Math.min(recordings.length,8),offset=(exclude.size*5)%Math.max(recordings.length,1);
  for(let i=0;i<spots;i++)sample.push(recordings[(Math.floor(i*recordings.length/spots)+offset)%recordings.length]);
  sampled=recordings.length>0;
  let found=0;
  for(const r of sample){
   if(found>=wanted||!budget.canRequest())break;
   progress(`Following the credit on ${r.recording.title}`);
   const rec=await mb.getRecording(r.recording.id,budget);
   const releases=asArray(rec.releases).filter(v=>v.status==='Official'&&v['release-group']&&['Album','EP'].includes(v['release-group']['primary-type'])&&!asArray(v['release-group']['secondary-types']).some(t=>SKIP.test(t)));
   const rel=releases.sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999')))[0];
   if(rel&&!exclude.has(rel['release-group'].id)&&!candidates.has(rel['release-group'].id)){
    add(rel['release-group'],{title:rel['release-group'].title||rel.title,'first-release-date':rel['release-group']['first-release-date']||rel.date,related:true,releaseId:rel.id});found++;
   }
  }
 }
 const picked=[...candidates.values()].sort((a,b)=>(b.related?1000:0)+scoreGroup(b)-(a.related?1000:0)-scoreGroup(a)).slice(0,wanted*3);
 picked.sampled=sampled;return picked;
}
async function expandArtist(artist,emit=()=>{},options={}){
 const budget=createBudget({maxRequests:options.maxRequests??20,maxNodes:options.maxNodes??75,maxTimeMS:options.maxTimeMS??90000,signal:options.signal});
 const wanted=Math.min(5,Math.max(1,Number(options.albums)||3));
 const exclude=new Set(asArray(options.exclude).filter(mb.validId));
 const rootId=`artist-${artist.id}`;
 const nodes=new Map(),edges=new Set();let albumsAdded=0,reason='finished',exhausted=false,warnings=0;
 const node=data=>{
  if(!nodes.has(data.id)&&nodes.size>=budget.maxNodes)return false;
  const prev=nodes.get(data.id);
  if(prev){const rank={artist:3,producer:2,featured:1,album:0};data={...prev,...data,roles:[...new Set([...(prev.roles||[]),...(data.roles||[])])],category:rank[prev.category]>rank[data.category]?prev.category:data.category};}
  nodes.set(data.id,data);emit({type:'node',data});return true;
 };
 const edge=(source,target,type,evidence={})=>{
  if(!nodes.has(source)||!nodes.has(target))return;
  const id=`${source}>${target}:${type}`;if(edges.has(id))return;edges.add(id);
  emit({type:'edge',data:{id,source,target,type,...evidence}});
 };
 const progress=message=>emit({type:'progress',message,requests:budget.requests,maxRequests:budget.maxRequests,nodes:nodes.size});
 let category=['artist','producer','featured'].includes(artist.category)?artist.category:'artist';
 node({id:rootId,mbid:artist.id,label:cleanName(artist.name)||'Artist',category,roles:artist.roles?.length?artist.roles:[category],thumb:''});
 try{
  progress('Finding the artist in MusicBrainz');
  const profile=await mb.getArtist(artist.id,budget);
  artist={...artist,name:profile.name,category};
  const wiki=options.photos===false?{}:await wikipedia(profile,options.signal);
  node({id:rootId,mbid:artist.id,label:profile.name,category,roles:artist.roles||[category],artistType:profile.type||'',country:profile.country||profile.area?.name||'',disambiguation:profile.disambiguation||'',genres:genres(profile),thumb:wiki.image||'',url:`https://musicbrainz.org/artist/${artist.id}`});
  progress(`Reading ${artist.name}’s discography`);
  const candidates=await pickAlbums(artist,exclude,budget,wanted,profile,progress);
  if(!candidates.length){exhausted=true;reason='no_albums';}
  for(const candidate of candidates){
   if(albumsAdded>=wanted)break;
   if(!budget.canRequest()||nodes.size>=budget.maxNodes-1){reason='limit';break;}
   progress(`Reading the track credits on ${candidate.title}`);
   let release;
   try{
    if(candidate.releaseId)release=await mb.getRelease(candidate.releaseId,budget);
    else release=bestRelease(asArray((await mb.getGroupRelease(candidate.id,budget)).releases));
   }catch(error){
    if(error instanceof ApiError&&[404,400].includes(error.status)){warnings++;continue;}
    throw error;
   }
   if(!release)continue;
   const all=collectCredits(release,{producer:1000,featured:1000});
   const main=artistCredits(release);
   const rootMain=main.some(a=>a.id===artist.id);
   const rootProduced=all.producers.find(p=>p.id===artist.id);
   const rootPerformed=all.featured.find(p=>p.id===artist.id);
   if(!rootMain&&!rootProduced&&!rootPerformed)continue;
   const albumId=`album-${candidate.id}`,tracks=allTracks(release);
   const album={id:albumId,category:'album',label:candidate.title,year:Number(String(candidate['first-release-date']||release.date||'').slice(0,4))||null,mbid:candidate.id,releaseGroupId:candidate.id,releaseId:release.id,genres:genres(candidate),recordLabel:asArray(release['label-info']).map(l=>l.label?.name).filter(Boolean).slice(0,2).join(' · '),tracks:tracks.length,tracklist:tracks.map(t=>({id:t.recording?.id,title:t.title||t.recording?.title||'',position:t.position,length:t.length||t.recording?.length||null})),thumb:art(release,candidate.id,250),image:art(release,candidate.id,500),url:`https://musicbrainz.org/release-group/${candidate.id}`,artistNames:main.map(a=>a.name)};
   if(!node(album))break;albumsAdded++;
   if(rootMain)edge(rootId,albumId,'released',{roles:['Album artist'],releaseId:release.id});
   const credit=(person,kind,type)=>{
    const id=`artist-${person.id}`;
    if(node({id,mbid:person.id,label:person.name,category:kind,roles:[kind],thumb:'',url:`https://musicbrainz.org/artist/${person.id}`}))edge(id,albumId,type,{roles:person.roles||['Album artist'],tracks:person.tracks||[],releaseId:release.id});
   };
   for(const a of main)if(a.id!==artist.id)credit(a,'artist','released');
   const limited=collectCredits(release,options.limits);
   if(rootProduced&&!limited.producers.some(c=>c.id===artist.id))limited.producers.unshift(rootProduced);
   if(rootPerformed&&!limited.featured.some(c=>c.id===artist.id))limited.featured.unshift(rootPerformed);
   for(const p of limited.producers)credit(p,'producer','produced');
   for(const p of limited.featured)credit(p,'featured','featured');
   album.creditCount=limited.producers.length+limited.featured.length;node(album);
   progress(`Added ${candidate.title} · ${album.creditCount} collaborators`);
  }
  // Only claim a catalogue is exhausted when we read all of it, not when we sampled a producer's credits.
  if(albumsAdded<wanted&&reason==='finished'&&!candidates.sampled)exhausted=true;
  if(albumsAdded===0&&reason==='finished')exhausted=true;
 }catch(error){
  if(options.signal?.aborted||error.name==='AbortError')reason='cancelled';
  else if(error instanceof BudgetExceeded)reason='limit';
  else{reason='error';emit({type:'error',message:error instanceof ApiError?error.message:'MusicBrainz could not be reached. Please try again.',status:error.status||503});if(!(error instanceof ApiError))console.error(error);}
 }
 const done={type:'complete',reason,artistId:rootId,albumsAdded,exhausted,nodes:nodes.size,edges:edges.size,requests:budget.requests,warnings};
 emit(done);return done;
}
async function resolveArtist(name,signal){
 const results=await mb.searchArtists(name,createBudget({maxRequests:3,maxTimeMS:30000,signal,priority:0}),8);
 const exact=name.trim().toLocaleLowerCase();
 return results.find(a=>a.name.toLocaleLowerCase()===exact)||results[0]||null;
}
module.exports={collectCredits,cleanName,scoreGroup,expandArtist,resolveArtist,pickAlbums,artistCredits,allTracks,genres,cover};
