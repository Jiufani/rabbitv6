'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const icon=(name,size)=>window.RHIcons.svg(name,size);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const initials=s=>String(s??'').split(/[\s,-]+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase();
 const safeImage=url=>{
  if(!url)return '';
  // Cover Art Archive and Wikimedia only. No arbitrary remote image URLs.
  try{const u=new URL(url);return u.protocol==='https:'&&/^(coverartarchive\.org|upload\.wikimedia\.org|thumb\.wikimedia\.org|[a-z0-9-]+\.archive\.org)$/.test(u.hostname)?u.href:'';}catch{return '';}
 };
 const imgSrc=url=>{const safe=safeImage(url);return safe?`${API}/api/img?u=${encodeURIComponent(safe)}`:'';};
 const apiMarker='__PORT_3000__';
 const API=apiMarker.startsWith('__')?'':apiMarker;
 const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 const rank={artist:3,producer:2,featured:1,album:0};
 const labelFor={artist:'Artist',producer:'Producer',featured:'Featured artist',album:'Record'};
 const state={nodes:new Map(),edges:new Map(),rootId:null,selectedId:null,featured:[],expanded:new Set(),hidden:new Set(),loading:false,stream:null,loadId:0,searchId:0,searchController:null,results:[],resultIndex:-1,view:'map',theme:window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',exhausted:new Set(),snapshot:null,info:new Map(),infoRequests:new Map()};
 let cy,layoutTimer,searchTimer,toastTimer,statusTimer,currentLayout;

 function hydrate(root){window.RHIcons.hydrate(root);}
 function color(token){return getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();}
 function avatar(name,category='artist',thumb=''){
  const img=imgSrc(thumb);
  return `<span class="avatar ${category==='album'?'record-avatar':''}" style="background:var(--${category})">${img?`<img src="${esc(img)}" alt="" loading="lazy" data-image-fallback="${esc(initials(name))}">`:esc(initials(name))}</span>`;
 }
 // Image failure never leaves an empty or broken image.
 function attachImages(root=document){root.querySelectorAll('img[data-image-fallback]').forEach(img=>{
  if(img.dataset.bound)return;img.dataset.bound='1';
  img.addEventListener('error',()=>{const p=img.parentElement;if(!p)return;
   const text=img.dataset.imageFallback||'♫';
   if(p.classList.contains('root-photo')){img.remove();const span=document.createElement('div');span.className='root-initials';span.textContent=text;p.prepend(span);}
   else if(p.classList.contains('detail-visual')){p.innerHTML=`<span class="detail-initials">${esc(text)}</span>`;}
   else{img.remove();p.textContent=text;}
  },{once:true});
 });}
 function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
 function status(message,type='loading',sticky=false){
  clearTimeout(statusTimer);
  const el=$('map-status');el.className=`map-status ${type}`;el.hidden=false;
  $('status-text').textContent=message;$('cancel-stream').hidden=!state.loading;
  if(!sticky&&type==='done')statusTimer=setTimeout(()=>{if(!state.loading)el.hidden=true;},6000);
 }
 function stopStream(message){
  state.loadId++;
  if(state.stream){state.stream.close();state.stream=null;}
  state.loading=false;
  $('cancel-stream').hidden=true;
  if(message)status(message,'done');
  updateDetailActions();
 }
 function hideSearch(){
  $('search-results').hidden=true;$('artist-search').setAttribute('aria-expanded','false');
  $('artist-search').removeAttribute('aria-activedescendant');state.resultIndex=-1;
 }
 function resetGraph(rootId){
  showWorkspace();stopStream();clearTimeout(layoutTimer);if(currentLayout)currentLayout.stop();
  state.nodes.clear();state.edges.clear();state.rootId=rootId;state.selectedId=null;
  state.expanded.clear();state.exhausted.clear();state.snapshot=null;
  state.hidden.clear();document.querySelectorAll('[data-category]').forEach(b=>b.setAttribute('aria-pressed','true'));
  cy.elements().remove();$('detail-panel').hidden=true;$('empty-map').hidden=true;
  $('artist-search').value='';hideSearch();$('list-search').value='';
  setView('map');
 }

 function cyStyle(){
  const txt=color('graph-text'),bg=color('bg'),edge=color('edge'),green=color('green');
  return [
   {selector:'node',style:{'width':46,'height':46,'background-color':color('artist'),'label':'data(short)','color':txt,'font-size':14,'font-family':'Satoshi, sans-serif','font-weight':500,'text-valign':'bottom','text-margin-y':10,'text-wrap':'wrap','text-max-width':118,'text-outline-color':bg,'text-outline-width':3,'text-outline-opacity':1,'border-width':3,'border-color':color('artist'),'overlay-opacity':0,'background-fit':'cover','background-clip':'node','background-image-opacity':1,'min-zoomed-font-size':7}},
   {selector:'node[imgUrl]',style:{'background-image':'data(imgUrl)'}},
   {selector:'node[category = "producer"]',style:{'background-color':color('producer'),'border-color':color('producer'),'width':38,'height':38}},
   {selector:'node[category = "featured"]',style:{'background-color':color('featured'),'border-color':color('featured'),'width':36,'height':36}},
   {selector:'node[category = "album"]',style:{'shape':'round-rectangle','background-color':color('album'),'border-color':color('album'),'width':54,'height':54,'font-size':13,'font-weight':700,'text-max-width':130,'text-margin-y':8,'min-zoomed-font-size':0}},
   {selector:'node.root',style:{'width':84,'height':84,'z-index':20,'border-width':5,'border-color':color('accent'),'background-color':green,'font-size':16,'font-weight':700,'text-margin-y':12,'text-max-width':160,'min-zoomed-font-size':0}},
   {selector:'edge',style:{'width':1.6,'line-color':edge,'curve-style':'bezier','opacity':.8,'overlay-opacity':0,'line-style':'solid'}},
   {selector:'edge[type = "produced"]',style:{'line-style':'dashed','line-dash-pattern':[4,5]}},
   {selector:'edge[type = "featured"]',style:{'line-style':'dotted','width':1.8}},
   {selector:'.dimmed',style:{'opacity':.14}},
   {selector:'node.highlighted',style:{'border-color':color('accent'),'border-width':3,'z-index':5}},
   {selector:'edge.highlighted',style:{'line-color':color('accent'),'width':2.4,'opacity':1,'z-index':4}},
   {selector:'node.selected',style:{'border-color':color('accent'),'border-width':4,'z-index':10}},
   {selector:'.filtered',style:{'display':'none'}}
  ];
 }
 function initGraph(){
  cy=window.cytoscape({container:$('cy'),elements:[],style:cyStyle(),layout:{name:'preset'},minZoom:.25,maxZoom:2.5,wheelSensitivity:.2,boxSelectionEnabled:false,selectionType:'single',autoungrabify:false,motionBlur:false});
  cy.on('tap','node',event=>selectNode(event.target.id(),true));
  cy.on('tap',event=>{if(event.target===cy)closeDetail();});
  cy.on('mouseover','node',()=>{$('cy').style.cursor='pointer';});
  cy.on('mouseout','node',()=>{$('cy').style.cursor='default';});
 }
 function addNode(data){
  if(!data?.id||!['artist','album','producer','featured'].includes(data.category))return;
  const prev=state.nodes.get(data.id);
  const merged=prev?{...prev,...Object.fromEntries(Object.entries(data).filter(([,v])=>v!==''&&v!=null))}:data;
  if(prev){merged.category=(rank[data.category]??0)>(rank[prev.category]??0)?data.category:prev.category;merged.roles=[...new Set([...(prev.roles??[]),...(data.roles??[])])];}
  merged.label=String(merged.label||'Unknown');
  const img=imgSrc(merged.thumb);
  if(img)merged.imgUrl=img;
  merged.short=merged.label.length>44?`${merged.label.slice(0,41)}…`:merged.label;
  state.nodes.set(data.id,merged);
  const existing=cy.getElementById(data.id);
  if(existing.length){existing.data(merged);}else{
   const neighbor=state.selectedId?cy.getElementById(state.selectedId).position():null;
   const x=(neighbor?.x??cy.width()/2)+(Math.random()-.5)*120;
   const y=(neighbor?.y??cy.height()/2)+(Math.random()-.5)*120;
   cy.add({group:'nodes',data:merged,position:{x,y},classes:data.id===state.rootId?'root':''});
  }
 }
 function addEdge(data){
  if(!data?.id||!state.nodes.has(data.source)||!state.nodes.has(data.target)||state.edges.has(data.id))return;
  state.edges.set(data.id,data);cy.add({group:'edges',data});
 }
 function relayout(fit=true,animate=true){
  clearTimeout(layoutTimer);cy.stop();cy.nodes().stop();
  const elements=cy.elements().not('.filtered');
  if(!elements.length)return;
  const nodes=elements.nodes();
  const before=new Map(nodes.map(n=>[n.id(),{...n.position()}]));
  // Solve the layout synchronously, then widen it to suit the wide map canvas.
  elements.layout({name:'cose',animate:false,fit:false,padding:40,nodeDimensionsIncludeLabels:true,componentSpacing:110,nodeRepulsion:()=>34000,idealEdgeLength:()=>135,edgeElasticity:()=>100,gravity:22,numIter:700,initialTemp:140,coolingFactor:.96,minTemp:1,randomize:!before.size}).run();
  const box=nodes.boundingBox();
  const aspect=cy.width()/Math.max(cy.height(),1);
  const stretch=Math.min(1.9,Math.max(1,(aspect*.88)/Math.max(box.w/Math.max(box.h,1),.1)));
  const cx=(box.x1+box.x2)/2;
  const target=new Map(nodes.map(n=>[n.id(),{x:cx+(n.position('x')-cx)*stretch,y:n.position('y')}]));
  if(animate&&!reducedMotion){
   nodes.forEach(n=>n.position(before.get(n.id())));
   let done=0;
   nodes.forEach(n=>n.animate({position:target.get(n.id())},{duration:500,easing:'ease-out-cubic',complete:()=>{if(++done===nodes.length&&fit)fitMap(true);}}));
  }else{
   nodes.forEach(n=>n.position(target.get(n.id())));
   if(fit)fitMap(false);
  }
 }
 function scheduleLayout(){clearTimeout(layoutTimer);layoutTimer=setTimeout(()=>relayout(!state.selectedId,false),200);}
 function fitMap(animate=true){
  cy.stop();
  const elements=cy.elements().not('.filtered');if(!elements.length)return;
  const mobile=window.innerWidth<701;
  const side=mobile?36:60,top=mobile?44:56,bottom=mobile?150:100;
  const box=elements.boundingBox();
  const zoom=Math.min(1.15,(cy.width()-side*2)/Math.max(box.w,1),(cy.height()-top-bottom)/Math.max(box.h,1));
  const centerY=top+(cy.height()-top-bottom)/2;
  const pan={x:cy.width()/2-((box.x1+box.x2)/2)*zoom,y:centerY-((box.y1+box.y2)/2)*zoom};
  if(animate&&!reducedMotion)cy.animate({zoom,pan,duration:400});else{cy.zoom(zoom);cy.pan(pan);}
 }
 function applyFilters(refit=true){
  cy.batch(()=>{
   cy.nodes().forEach(n=>{const hidden=state.hidden.has(n.data('category'));n.toggleClass('filtered',hidden);});
   cy.edges().forEach(e=>e.toggleClass('filtered',e.source().hasClass('filtered')||e.target().hasClass('filtered')));
  });
  if(state.selectedId&&cy.getElementById(state.selectedId).hasClass('filtered'))closeDetail();
  if(refit)fitMap();
  renderList();
 }
 function stats(){
  $('people-count').textContent=[...state.nodes.values()].filter(n=>n.category!=='album').length;
  $('album-count').textContent=[...state.nodes.values()].filter(n=>n.category==='album').length;
  $('edge-count').textContent=state.edges.size;
 }
 function connected(id){
  const result=new Map();
  for(const e of state.edges.values()){
   const other=e.source===id?e.target:e.target===id?e.source:null;
   if(!other)continue;
   const n=state.nodes.get(other);if(!n)continue;
   const item=result.get(other)??{node:n,types:new Set(),edges:[]};item.types.add(e.type);item.edges.push(e);result.set(other,item);
  }
  return [...result.values()];
 }
 const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
 const trackCount=edges=>new Set(edges.flatMap(e=>(e.tracks||[]).map(t=>t.id||t.title))).size;
 function edgeSentence(a,b){
  const na=state.nodes.get(a),nb=state.nodes.get(b);if(!na||!nb)return '';
  const album=na.category==='album'?na:nb,person=na.category==='album'?nb:na;
  const edges=[...state.edges.values()].filter(e=>(e.source===a&&e.target===b)||(e.source===b&&e.target===a));
  if(!edges.length)return '';
  const tracks=trackCount(edges),has=type=>edges.some(e=>e.type===type);
  const detail=tracks?` on ${plural(tracks,'track')}`:'';
  if(has('produced')&&has('featured'))return `${person.label} produced and performed${detail} on ${album.label}`;
  if(has('produced'))return `${person.label} produced${tracks?` ${plural(tracks,'track')} on`:''} ${album.label}`;
  if(has('featured'))return `${person.label} performed${detail} on ${album.label}`;
  return `${person.label} released ${album.label}`;
 }
 function pathTo(id){
  if(!state.rootId)return [];
  if(id===state.rootId)return [id];
  const queue=[state.rootId],seen=new Set(queue),previous=new Map();
  for(let i=0;i<queue.length;i++){
   for(const {node} of connected(queue[i])){
    if(seen.has(node.id))continue;seen.add(node.id);previous.set(node.id,queue[i]);
    if(node.id===id){const path=[id];while(previous.has(path[0]))path.unshift(previous.get(path[0]));return path;}
    queue.push(node.id);
   }
  }
  return [];
 }
 function updateSidebar(){
  const root=state.nodes.get(state.rootId);if(!root)return;
  $('root-name').textContent=root.label;$('breadcrumb-root').textContent=root.label;
  const albumCount=connected(root.id).filter(({node})=>node.category==='album').length;
  const info=state.info.get(root.mbid);
  const people=[...state.nodes.values()].filter(n=>n.category!=='album'&&n.id!==root.id).length;
  $('root-description').textContent=[info?.type||root.artistType,info?.country||root.country,(root.genres||info?.genres||[]).slice(0,2).join(', ')].filter(Boolean).join(' · ')||`${albumCount} record${albumCount===1?'':'s'} · ${people} collaborators`;
  const photo=$('root-photo'),img=imgSrc(root.thumb);
  const marker='<div class="root-photo-label"><span class="live-dot"></span>YOUR STARTING POINT</div>';
  // Avoid replacing the same image for each streamed update.
  if(photo.dataset.src!==(img||root.label)){
   photo.dataset.src=img||root.label;
   photo.innerHTML=(img?`<img src="${esc(img)}" alt="${esc(root.label)}" data-image-fallback="${esc(initials(root.label))}">`:`<div class="root-initials">${esc(initials(root.label))}</div>`)+marker;
   attachImages(photo);
  }
  const rootAlbums=new Set(connected(root.id).filter(x=>x.node.category==='album').map(x=>x.node.id));
  const candidates=new Map();
  for(const e of state.edges.values()){
   if(!rootAlbums.has(e.target)||e.source===root.id)continue;
   const n=state.nodes.get(e.source);if(!n||n.category==='album')continue;
   const c=candidates.get(n.id)??{n,count:0};c.count++;candidates.set(n.id,c);
  }
  const picks=[...candidates.values()].sort((a,b)=>b.count-a.count).slice(0,3);
  $('connection-picks').innerHTML=picks.length?picks.map(({n,count})=>`<button class="connection-pick" data-select="${esc(n.id)}">${avatar(n.label,n.category,n.thumb)}<span class="pick-text"><strong>${esc(n.label)}</strong><small>${labelFor[n.category]} · ${count} shared credit${count===1?'':'s'}</small></span>${icon('ChevronRight')}</button>`).join(''):'<p class="search-message">More collaborators will appear as you explore the credits.</p>';
  attachImages($('connection-picks'));renderFeaturedPicks();stats();
 }
 function renderFeaturedPicks(){
  const root=state.nodes.get(state.rootId);
  $('featured-picks').innerHTML=state.featured.filter(f=>f.name!==root?.label).slice(0,4).map(f=>`<button class="featured-chip" data-featured="${esc(f.slug)}">${esc(f.name)}</button>`).join('');
 }
 function describeEdge(types,nodeCategory,edges=[]){
  const tracks=trackCount(edges),extra=tracks?` · ${plural(tracks,'track')}`:'';
  if(nodeCategory==='album')return (types.has('produced')?'Produced':types.has('featured')?'Performed on':'Released')+extra;
  return (types.has('produced')?'Producer':types.has('featured')?'Featured artist':'Artist')+extra;
 }
 const formatLength=ms=>{if(!ms)return '';const total=Math.round(ms/1000);return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;};
 function trackCredits(albumId){
  const credits=new Map();
  for(const e of state.edges.values()){
   if(e.target!==albumId||!e.tracks?.length)continue;
   const person=state.nodes.get(e.source);if(!person)continue;
   for(const t of e.tracks){
    const entry=credits.get(t.id)??{produced:[],featured:[]};
    (e.type==='produced'?entry.produced:entry.featured).push(person.label);credits.set(t.id,entry);
   }
  }
  return credits;
 }
 function tracklistHtml(n){
  if(!n.tracklist?.length)return '';
  const credits=trackCredits(n.id);
  const rows=n.tracklist.map((t,i)=>{
   const c=credits.get(t.id)||{produced:[],featured:[]};
   const lines=[c.produced.length?`Produced by ${c.produced.join(', ')}`:'',c.featured.length?`With ${c.featured.join(', ')}`:''].filter(Boolean);
   return `<li><span class="track-num">${esc(t.position||i+1)}</span><span class="track-body"><span class="track-title">${esc(t.title)}</span>${lines.map(l=>`<small>${esc(l)}</small>`).join('')}</span><span class="track-length">${esc(formatLength(t.length))}</span></li>`;
  }).join('');
  return `<div class="detail-divider"></div><h3 class="detail-connections-title">TRACKLIST · ${n.tracklist.length}</h3><ol class="tracklist">${rows}</ol>`;
 }
 function profileHtml(info,loading){
  if(loading)return '<div class="profile-loading"><div class="skeleton line"></div><div class="skeleton line short"></div></div>';
  if(!info)return '<p class="detail-limit">No profile is available for this name yet.</p>';
  const years=info.begin?`${info.begin.slice(0,4)}${info.end?`–${info.end.slice(0,4)}`:info.type==='Person'||info.ended?'':' – present'}`:'';
  const facts=[info.type,info.country||info.area,years,info.disambiguation].filter(Boolean);
  const extract=info.extract.length>420?`${info.extract.slice(0,info.extract.lastIndexOf(' ',420))}…`:info.extract;
  const links=[...(info.wikipedia?[{label:'Wikipedia',url:info.wikipedia}]:[]),...(info.links||[])];
  return `${facts.length?`<p class="detail-facts">${facts.map(esc).join(' · ')}</p>`:''}${extract?`<p class="detail-bio">${esc(extract)}</p>`:''}${info.genres?.length?`<div class="tags">${info.genres.map(g=>`<span class="tag">${esc(g)}</span>`).join('')}</div>`:''}${links.length?`<div class="link-chips">${links.map(l=>`<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}${icon('ExternalLink')}</a>`).join('')}</div>`:''}`;
 }
 function loadProfile(n){
  if(!n?.mbid||n.category==='album')return;
  const cached=state.info.get(n.mbid);
  const apply=info=>{
   if(info&&info.image&&!n.thumb&&state.nodes.has(n.id)){addNode({...state.nodes.get(n.id),thumb:info.image});if(state.view==='list')renderList();updateSidebar();}
   if(state.selectedId===n.id){const slot=$('detail-profile');if(slot){slot.innerHTML=profileHtml(info,false);const visual=document.querySelector('.detail-visual');
    if(info?.image&&visual&&!visual.querySelector('img')){visual.innerHTML=`<img src="${esc(imgSrc(info.image))}" alt="${esc(n.label)}" data-image-fallback="${esc(initials(n.label))}">`;attachImages(visual);}}}
  };
  if(cached!==undefined){apply(cached||null);return;}
  let request=state.infoRequests.get(n.mbid);
  if(!request){request=fetch(`${API}/api/artist/${encodeURIComponent(n.mbid)}`).then(r=>r.ok?r.json():null).catch(()=>null).then(info=>{state.info.set(n.mbid,info||false);state.infoRequests.delete(n.mbid);return info;});state.infoRequests.set(n.mbid,request);}
  request.then(info=>apply(info||null));
 }
 function renderDetail(){
  const n=state.nodes.get(state.selectedId);if(!n)return;
  const people=n.category!=='album';
  const all=connected(n.id).sort((a,b)=>a.node.label.localeCompare(b.node.label));
  const image=imgSrc(n.image)||imgSrc(n.thumb);
  const path=pathTo(n.id);
  const story=path.length>2?`<ol class="path-story">${path.slice(0,-1).map((id,i)=>`<li>${esc(edgeSentence(id,path[i+1]))}</li>`).join('')}</ol>`:'';
  const pathHtml=path.length>1?`<div class="detail-divider"></div><h3 class="path-title">YOUR PATH HERE · ${Math.max(0,path.length-1)} LINK${path.length===2?'':'S'}</h3><div class="path-chips">${path.map((id,i)=>`${i?icon('ChevronRight'):''}<button data-select="${esc(id)}">${esc(state.nodes.get(id)?.label||'')}</button>`).join('')}</div>${story}`:'';
  const roles=Array.isArray(n.roles)&&n.roles.length?n.roles.map(r=>labelFor[r]||r):[labelFor[n.category]];
  const connections=`<div class="detail-divider"></div><h3 class="detail-connections-title">${people?'RECORDS ON THIS MAP':'PEOPLE ON THIS RECORD'} · ${all.length}</h3>${all.map(({node,types,edges})=>`<button class="detail-connection" data-select="${esc(node.id)}"><i class="dot ${node.category}-dot"></i><span class="detail-connection-label">${esc(node.label)}<small>${describeEdge(types,node.category,edges)}${node.year?` · ${esc(node.year)}`:''}</small></span>${icon('ChevronRight')}</button>`).join('')||'<p class="detail-limit">Credits have not been added yet. Dive deeper to open their records.</p>'}`;
  const cached=n.mbid?state.info.get(n.mbid):null;
  $('detail-category').textContent=n.id===state.rootId?'YOUR STARTING POINT':labelFor[n.category]?.toUpperCase()||'CONNECTION';
  const external=people?`https://musicbrainz.org/artist/${encodeURIComponent(n.mbid||'')}`:`https://musicbrainz.org/release-group/${encodeURIComponent(n.releaseGroupId||n.mbid||'')}`;
  $('detail-content').innerHTML=`<div class="detail-body"><div class="detail-visual ${people?'':'album-art'}">${image?`<img src="${esc(image)}" alt="${esc(n.label)}${people?'':' cover'}" data-image-fallback="${esc(initials(n.label))}">`:`<span class="detail-initials">${esc(initials(n.label))}</span>`}</div><h2 class="detail-name">${esc(n.label)}</h2><div class="detail-meta">${people?roles.map(r=>`<span>${esc(r)}</span>`).join('<span>·</span>'):`<span>${esc(n.year||'Year unknown')}</span>${n.tracks?`<span>·</span><span>${esc(n.tracks)} tracks</span>`:''}`}</div>${people?`<div class="detail-actions"><button id="dive-deeper" class="primary-button" data-dive="${esc(n.id)}"></button><button class="secondary-button like-button" data-recommend="${esc(n.id)}" data-mode="${n.category==='producer'?'producer':'artist'}">${icon('Sparkles')}<span>I like this ${n.category==='producer'?'producer':'artist'}</span></button></div><div id="detail-profile">${profileHtml(cached||null,cached===undefined)}</div>`:`${n.artistNames?.length||n.recordLabel?`<p class="detail-description">${n.artistNames?.length?`by ${esc(n.artistNames.join(', '))}`:''}${n.artistNames?.length&&n.recordLabel?'<br>':''}${n.recordLabel?esc(n.recordLabel):''}</p>`:''}<div class="tags">${(n.genres||[]).map(g=>`<span class="tag">${esc(g)}</span>`).join('')}</div>`}${pathHtml}${connections}${people?'':tracklistHtml(n)}<a class="external-reference" href="${esc(external)}" target="_blank" rel="noopener noreferrer">View ${people?'artist':'record'} on MusicBrainz ${icon('ExternalLink')}</a>${!people?'<p class="detail-limit">Credits come from one representative edition and from relationships volunteers have added to MusicBrainz. Different editions can credit different people.</p>':''}</div>`;
  attachImages($('detail-content'));updateDetailActions();loadProfile(n);
 }
 function updateDetailActions(){
  const button=$('dive-deeper');if(!button)return;
  const n=state.nodes.get(state.selectedId);if(!n)return;
  button.disabled=state.loading||state.exhausted.has(n.id)||state.nodes.size>=180;
  if(state.loading)button.innerHTML=`${icon('Loader')}<span>Following the credits...</span>`;
  else if(state.nodes.size>=180)button.innerHTML=`${icon('Info')}<span>This map is full</span>`;
  else if(state.exhausted.has(n.id))button.innerHTML=`${icon('Disc3')}<span>All available records explored</span>`;
  else button.innerHTML=`<span>${state.expanded.has(n.id)?'Explore more records':'Dive deeper'}</span>${icon('ArrowRight')}`;
 }
 function selectNode(id,focus=false){
  const n=state.nodes.get(id);if(!n)return;
  state.selectedId=id;
  const selected=cy.getElementById(id);
  const linked=selected.closedNeighborhood();
  const path=pathTo(id);
  const pathNodes=cy.nodes().filter(x=>path.includes(x.id()));
  const pathEdges=cy.edges().filter(e=>path.some((v,i)=>i<path.length-1&&((e.source().id()===v&&e.target().id()===path[i+1])||(e.target().id()===v&&e.source().id()===path[i+1]))));
  cy.elements().removeClass('selected highlighted dimmed');
  cy.elements().not(linked.union(pathNodes).union(pathEdges)).addClass('dimmed');
  linked.addClass('highlighted');pathEdges.addClass('highlighted');selected.addClass('selected');
  $('detail-panel').hidden=false;renderDetail();
  if(focus&&state.view==='map'){
   const nodePos=selected.position(),mobile=window.innerWidth<701;
   const currentZoom=Math.max(cy.zoom(),.68);
   const pan={x:(mobile?cy.width()/2:cy.width()*.34)-nodePos.x*currentZoom,y:(mobile?cy.height()*.28:cy.height()*.48)-nodePos.y*currentZoom};
   cy.animate({pan,zoom:Math.min(currentZoom,1.25),duration:reducedMotion?0:400});
  }
 }
 function closeDetail(){
  state.selectedId=null;$('detail-panel').hidden=true;cy.elements().removeClass('selected highlighted dimmed');
 }
 function renderList(){
  if(state.view!=='list')return;
  const term=$('list-search').value.trim().toLowerCase();
  const nodes=[...state.nodes.values()].filter(n=>!state.hidden.has(n.category)&&(!term||n.label.toLowerCase().includes(term))).sort((a,b)=>a.category===b.category?a.label.localeCompare(b.label):a.category==='album'?1:b.category==='album'?-1:a.label.localeCompare(b.label));
  $('list-rows').innerHTML=nodes.length?nodes.map(n=>`<button class="list-row" data-select="${esc(n.id)}">${avatar(n.label,n.category,n.thumb)}<span class="list-row-name">${esc(n.label)}<small>${n.category==='album'?`${esc(n.year||'')} · ${esc((n.genres||[]).slice(0,2).join(', '))}`:`${connected(n.id).length} record${connected(n.id).length===1?'':'s'} on this map`}</small></span><span class="list-row-type">${n.id===state.rootId?'Starting artist':labelFor[n.category]}</span>${icon('ChevronRight')}</button>`).join(''):'<p class="list-empty">No matches on this map. Try a different name or turn the filters back on.</p>';
  attachImages($('list-rows'));
 }
 function setView(view){
  state.view=view;$('graph-list').hidden=view!=='list';$('map-stage').classList.toggle('list-mode',view==='list');
  $('map-view').classList.toggle('active',view==='map');$('map-view').setAttribute('aria-pressed',view==='map');
  $('list-view').classList.toggle('active',view==='list');$('list-view').setAttribute('aria-pressed',view==='list');
  document.querySelectorAll('.legend,.canvas-controls,.map-tip,.map-caption,.map-attribution').forEach(el=>el.hidden=view==='list');
  if(view==='list')renderList();else{cy?.resize();}
 }
function setHash(value){try{history.replaceState(null,'',value?`#${value}`:location.pathname+location.search);}catch{/* Some embedded previews block history changes. */}}
 function linkForMap(){
  const root=state.nodes.get(state.rootId);if(!root)return '';
  const base=location.href.split('#')[0];
  if(state.snapshot&&state.currentSlug)return `${base}#f=${encodeURIComponent(state.currentSlug)}`;
  return root.mbid?`${base}#a=${encodeURIComponent(root.mbid)}&n=${encodeURIComponent(root.label)}`:'';
 }
 async function copyLink(){
  const link=linkForMap();if(!link){toast('Open a map first.');return;}
  try{await navigator.clipboard.writeText(link);toast('Link copied. Anyone can open this map.');}
  catch{
   const input=document.createElement('input');input.value=link;input.style.cssText='position:fixed;opacity:0';document.body.appendChild(input);input.select();
   let ok=false;try{ok=document.execCommand('copy');}catch{}input.remove();
   toast(ok?'Link copied. Anyone can open this map.':link);
  }
 }
 async function loadFeatured(slug){
  resetGraph(null);const loadId=++state.loadId;state.currentSlug=slug;
  status('Opening a featured rabbit hole...','loading',true);
  try{
   const response=await fetch(`${API}/api/featured/${encodeURIComponent(slug)}`);
   if(!response.ok)throw new Error('This featured map could not be loaded. Please try another.');
   const graph=await response.json();if(loadId!==state.loadId)return;
   state.rootId=graph.rootId;state.expanded=new Set(graph.expanded||[]);state.snapshot=graph.generatedAt;setHash(`f=${encodeURIComponent(slug)}`);
   cy.batch(()=>{for(const n of graph.nodes||[])addNode(n);for(const e of graph.edges||[])addEdge(e);});
   cy.getElementById(state.rootId).addClass('root');updateSidebar();relayout(true,false);
   $('map-attribution').textContent='MusicBrainz · featured snapshot';
   $("map-caption").textContent=`${graph.name}'s world. Click a person to follow the credits.`;
   {const r=graph.nodes.find(n=>n.id===graph.rootId);rememberArtist({id:r?.mbid||graph.rootId,name:graph.name,thumb:r?.thumb||'',slug});}
    status('Featured map · click a person to go deeper','done');
  }catch(error){
   if(loadId!==state.loadId)return;
   showEmpty('The record skipped.',error.message);status(error.message,'error',true);
  }
 }
 function showEmpty(title,message,retry=false){$('empty-retry').hidden=!retry||!state.lastAttempt;$('empty-title').textContent=title;$('empty-message').textContent=message;$('empty-map').hidden=false;}
 function streamArtist(artist,{newMap=false}={}){
  state.lastAttempt={artist,newMap};
  if(newMap){resetGraph(`artist-${artist.id}`);state.currentSlug=null;rememberArtist({id:artist.id,name:artist.name,thumb:artist.thumb||'',category:artist.category||'artist'});setHash(`a=${encodeURIComponent(artist.id)}&n=${encodeURIComponent(artist.name)}`);}else stopStream();
  if(state.nodes.size>=180){toast('This map is full. Start a fresh artist search to keep exploring.');return;}
  const id=`artist-${artist.id}`;
  if(!state.nodes.has(id))addNode({id,mbid:artist.id,label:artist.name,thumb:artist.thumb||'',category:artist.category||'artist',roles:artist.roles||['artist']});
  const params=new URLSearchParams({id:String(artist.id),name:artist.name,albums:newMap?'4':'3',category:artist.category||'artist'});
  const exclude=[...state.nodes.values()].filter(n=>n.category==='album').map(n=>n.releaseGroupId).filter(Boolean);
  if(exclude.length)params.set('exclude',exclude.join(','));
  const loadId=++state.loadId;state.loading=true;
  status(`Reading ${artist.name}'s discography...`,'loading',true);
  if(newMap){updateSidebar();scheduleLayout();$('map-caption').textContent=`The records & people connected to ${artist.name}`;}
  $('map-attribution').textContent='Live MusicBrainz credits';
  updateDetailActions();
  let hadError=false;
  const eventSource=new EventSource(`${API}/api/graph?${params}`);state.stream=eventSource;
  eventSource.onmessage=event=>{
   if(loadId!==state.loadId)return;
   let update;try{update=JSON.parse(event.data);}catch{return;}
   switch(update.type){
    case 'node':
     if(state.nodes.size<180||state.nodes.has(update.data.id))addNode(update.data);
     updateSidebar();if(state.selectedId)renderDetail();scheduleLayout();break;
    case 'edge':addEdge(update.data);updateSidebar();renderList();scheduleLayout();break;
    case 'progress':if(!hadError)status(update.message||'Following the credits...','loading',true);break;
    case 'error':hadError=true;status(update.message,'error',true);break;
    case 'complete':
     eventSource.close();state.stream=null;state.loading=false;$('cancel-stream').hidden=true;
     if(update.albumsAdded>0)state.expanded.add(id);
     if(update.exhausted||update.reason==='no_albums')state.exhausted.add(id);
     if(!hadError){
      if(update.reason==='not_found')showEmpty('No artist found.','Try another spelling or choose one of the featured maps.');
      else if(update.reason==='limit')status('Exploration paused at the API limit. Your discoveries are saved in this map.','done');
      else if(update.albumsAdded===0)status('No new records found. Try a different connection.','done');
      else status(`Added ${update.albumsAdded} record${update.albumsAdded===1?'':'s'} · keep following the music`,'done');
     }
     if(hadError&&state.nodes.size<=1)showEmpty('Live search needs a moment.','The music service is unavailable. Try again, or choose a featured map to explore.',true);
     applyFilters(false);updateDetailActions();relayout(!state.selectedId,true);renderList();break;
   }
  };
  eventSource.onerror=()=>{
   if(loadId!==state.loadId)return;
   eventSource.close();state.stream=null;state.loading=false;
   status('The connection was interrupted. Your current map is safe. Try the dive again.','error',true);updateDetailActions();
   if(state.nodes.size<=1)showEmpty('Could not reach MusicBrainz.','Try again, or open a featured map.',true);
  };
 }

 function searchSuggestions(){
  state.results=state.featured.map(f=>({...f,featured:true}));state.resultIndex=-1;
  renderSearch('FEATURED RABBIT HOLES');
 }
 function renderSearch(title='CHOOSE AN ARTIST'){
  const box=$('search-results');
  box.innerHTML=`<div class="result-heading">${esc(title)}</div>${state.results.map((r,i)=>`<div class="search-row"><button type="button" class="search-result" role="option" aria-selected="${i===state.resultIndex}" id="search-result-${i}" data-result="${i}">${avatar(r.name,'artist',r.thumb)}<span class="result-text"><span class="result-name">${esc(r.name)}</span><span class="result-sub">${esc(r.featured?'Featured map · opens instantly':[r.type,r.country,r.disambiguation].filter(Boolean).join(' · ')||'MusicBrainz artist')}</span>${r.genres?.length?`<span class="result-tags">${r.genres.slice(0,3).map(g=>`<i>${esc(g)}</i>`).join('')}</span>`:''}</span><span class="result-arrow">${icon('ArrowRight')}</span></button>${(r.mbid||r.id)?`<button type="button" class="like-chip" data-like-result="${i}" aria-label="Find artists like ${esc(r.name)}">${icon('Sparkles',13)}<span>I like this</span></button>`:''}</div>`).join('')}`;
  box.hidden=false;$('artist-search').setAttribute('aria-expanded','true');attachImages(box);
 }
 async function searchArtists(query){
  clearTimeout(searchTimer);
  const q=query.trim();if(q.length<2){searchSuggestions();return;}
  state.searchController?.abort();const controller=new AbortController();state.searchController=controller;
  const searchId=++state.searchId;
  state.results=[];state.resultIndex=-1;
  const box=$('search-results');box.hidden=false;
  $('artist-search').setAttribute('aria-expanded','true');
  box.innerHTML=`<div class="search-message"><span class="status-spinner" style="display:inline-block;margin-right:8px"></span>Looking for ${esc(q)}...</div>`;
  try {
   const res=await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`,{signal:controller.signal});
   const data=await res.json();if(searchId!==state.searchId)return;
   if(!res.ok)throw new Error(data.error||'Artist search is unavailable.');
   state.results=(data.results||[]).map(r=>({...r,featured:false}));
   // Exact-name featured maps are available instantly and retain live diving.
   for(const r of state.results){const f=state.featured.find(f=>f.name.toLowerCase()===r.name.toLowerCase());if(f)Object.assign(r,{featured:true,slug:f.slug});}
   if(!state.results.length){box.innerHTML='<div class="search-message">No matches. Try a different spelling, or search a band name.</div>';return;}
   renderSearch();
  }catch(error){
   if(error.name==='AbortError'||searchId!==state.searchId)return;
   box.innerHTML=`<div class="search-message">${esc(error.message)}<br><button type="button" id="search-featured-fallback" class="secondary-button" style="margin-top:12px">Browse featured maps</button></div>`;
  }
 }
 function chooseResult(index){
  const result=state.results[index];if(!result)return;
  state.searchId++;state.searchController?.abort();hideSearch();$('artist-search').blur();
  if(result.featured)loadFeatured(result.slug);else streamArtist({id:result.id,name:result.name,thumb:result.thumb},{newMap:true});
 }
 function setTheme(theme){
  state.theme=theme;document.documentElement.dataset.theme=theme;
  $('theme-toggle').innerHTML=icon(theme==='dark'?'Sun':'Moon');
  $('theme-toggle').setAttribute('aria-label',`Switch to ${theme==='dark'?'light':'dark'} mode`);
  $('theme-toggle').title=$('theme-toggle').getAttribute('aria-label');
  cy?.style(cyStyle());
 }
 function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function mapFilename(){const root=state.nodes.get(state.rootId);return `rabbithole-${(root?.label||'map').toLowerCase().replace(/[^a-z0-9]+/g,'-')}`;}
 function exportJSON(){
  if(!state.nodes.size){toast('Open a map first.');return;}
  const data={name:state.nodes.get(state.rootId)?.label,rootId:state.rootId,expanded:[...state.expanded],generatedAt:new Date().toISOString(),dataSource:'https://musicbrainz.org/',nodes:[...state.nodes.values()].map(({short,...n})=>n),edges:[...state.edges.values()]};
  downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`${mapFilename()}.json`);
  toast('Graph data exported.');$('export-menu').hidden=true;
 }
 function exportPNG(){
  if(!state.nodes.size){toast('Open a map first.');return;}
  try{
   const blob=cy.png({output:'blob',bg:color('bg'),full:true,scale:2,maxWidth:3000,maxHeight:3000});
   downloadBlob(blob,`${mapFilename()}.png`);toast('Map image exported.');
  }catch{toast('Image export is unavailable in this browser. Try downloading the graph data instead.');}
  $('export-menu').hidden=true;
 }
 function surprise(){
  const options=state.featured.filter(f=>f.name!==state.nodes.get(state.rootId)?.label);
  if(!options.length){toast('Featured maps are still loading. Try again in a moment.');return;}
  loadFeatured(options[Math.floor(Math.random()*options.length)].slug);
 }

 // Home and recommendations preserve the map when you come back home.
 state.page='home';state.homeFilter='all';state.recent=[];state.likes=new Set();
 state.recCache=new Map();state.recId=0;state.recSeed=null;state.recMode='artist';state.recRows=[];
 function showWorkspace(){
  state.page='map';document.body.classList.remove('home-mode');$('home-page').hidden=true;$('workspace').hidden=false;
  const form=$('search-form');if(form.parentElement!==document.querySelector('.app-header')){document.querySelector('.app-header').insertBefore(form,document.querySelector('.top-nav'));form.classList.remove('hero-search');}
  $('artist-search').placeholder='Search for an artist or producer...';cy?.resize();
 }
 function showHome({preserveHash=false}={}){
  state.page='home';stopStream();closeDetail();hideSearch();$('export-menu').hidden=true;
  document.body.classList.add('home-mode');$('workspace').hidden=true;$('home-page').hidden=false;
  const form=$('search-form');$('hero-search-slot').appendChild(form);form.classList.add('hero-search');
  $('artist-search').value='';$('artist-search').placeholder='Start with an artist or producer you love...';
  if(!preserveHash)setHash('home');document.title='RabbitHole — Find your next favorite';renderHome();
 }
 function rememberArtist(artist){
  if(!artist?.id)return;
  state.recent=state.recent.filter(a=>a.id!==artist.id);
  state.recent.unshift(artist);state.recent=state.recent.slice(0,8);
  document.title=`${artist.name} — RabbitHole`;
 }
 function knownArtist(id,name=''){
  const node=[...state.nodes.values()].find(n=>n.mbid===id&&n.category!=='album');
  const featured=state.featured.find(f=>f.mbid===id||f.name.toLowerCase()===name.toLowerCase());
  return {id,name:node?.label||featured?.name||name,thumb:node?.thumb||featured?.thumb||'',slug:featured?.slug};
 }
 function startDiscovery(artist){
  if($('recommend-dialog').open)$('recommend-dialog').close();hideSearch();
  const known=knownArtist(artist.id,artist.name);
  if(known.slug&&artist.category!=='producer')loadFeatured(known.slug);
  else streamArtist({...known,...artist},{newMap:true});
 }
 function renderHome(){
  const featured=state.featured.filter(f=>{
   if(state.homeFilter==='all')return true;
   const tags=(f.genres||[]).join(' ').toLowerCase();
   if(state.homeFilter==='hip hop')return /hip hop|r&b|soul/.test(tags);
   if(state.homeFilter==='electronic')return /electronic|house|dance/.test(tags);
   return /rock|alternative|art pop|experimental/.test(tags);
  });
  $('home-featured').innerHTML=featured.length?featured.map((f,i)=>`<button class="home-artist-card" data-featured="${esc(f.slug)}" aria-label="Explore ${esc(f.name)}"><div class="home-card-photo" style="--card-color:var(--${['artist','producer','featured','green'][i%4]})">${imgSrc(f.thumb)?`<img src="${esc(imgSrc(f.thumb))}" alt="" loading="lazy" data-image-fallback="${esc(initials(f.name))}">`:esc(initials(f.name))}<span class="home-card-number">${String(state.featured.indexOf(f)+1).padStart(2,'0')}</span><span class="home-card-arrow">${icon('ArrowRight')}</span></div><div class="home-card-body"><h3>${esc(f.name)}</h3><p>${esc((f.genres||[]).slice(0,2).join(' / ')||'Explore their world')}</p><small>${esc(f.albums)} records <span>·</span> ${esc(f.people)} people</small></div></button>`).join(''):`<p class="home-loading">No featured maps in this category yet. Try another filter or search for an artist.</p>`;
  const hero=state.featured.find(f=>f.slug==='frank-ocean')||state.featured[0];
  if(hero){
   $('hero-featured').dataset.featured=hero.slug;$('hero-featured').setAttribute('aria-label',`Explore ${hero.name}`);
   $('hero-sleeve-name').textContent=hero.name;
   $('hero-sleeve-photo').innerHTML=imgSrc(hero.thumb)?`<img src="${esc(imgSrc(hero.thumb))}" alt="${esc(hero.name)}" data-image-fallback="${esc(initials(hero.name))}">`:`<span>${esc(initials(hero.name))}</span>`;
  }
  $('home-recent-section').hidden=!state.recent.length;
  $('resume-map').hidden=!state.rootId;
  $('home-recent').innerHTML=state.recent.map(a=>`<button class="recent-chip" data-recent="${esc(a.id)}">${avatar(a.name,a.category||'artist',a.thumb)}<span>${esc(a.name)}${a.category==='producer'?'<small>Producer</small>':''}</span>${icon('ArrowRight')}</button>`).join('');
  attachImages($('home-page'));hydrate($('home-page'));
 }
 function openRecommendations(seed,mode){
  if(!seed?.id)return;
  state.recSeed=seed;state.recTrail=[];state.likes.add(seed.id);
  state.recMode=mode||(seed.category==='producer'?'producer':'artist');
  if(!$('recommend-dialog').open)$('recommend-dialog').showModal();
  loadRecommendations();
 }
 function rootRecommendations(){
  const n=state.nodes.get(state.rootId);
  if(n)openRecommendations({id:n.mbid,name:n.label,category:n.category,roles:n.roles},n.category==='producer'&&n.id!==state.rootId?'producer':'artist');
 }
 async function loadRecommendations({retry=false}={}){
  const seed=state.recSeed,mode=state.recMode;if(!seed)return;
  const requestId=++state.recId;
  $('recommend-title').textContent=`If you like ${seed.name}…`;
  $('recommend-trail').innerHTML=state.recTrail?.length?`<button class="rec-back" data-rec-back>${icon('ChevronRight',14)}<span>Back to ${esc(state.recTrail[state.recTrail.length-1].name)}</span></button>`:'';
  const key=`${mode}:${seed.id}`;
  document.querySelectorAll('[data-recommend-mode]').forEach(b=>{const active=b.dataset.recommendMode===mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});
  $('recommend-subtitle').textContent=mode==='producer'?'More people behind the sound, connected by real production credits.':'Artists whose music is heard alongside your favorite by ListenBrainz listeners.';
  $('recommend-note').innerHTML='';
  $('recommend-results').innerHTML=`<div class="recommend-loading"><span class="status-spinner"></span><div><strong>${mode==='producer'?'Reading the production credits…':'Finding someone new for you…'}</strong><p>${mode==='producer'?'Uncached producers can take up to a minute. We’re checking real records, not guessing.':'Looking for artists listeners play alongside this one.'}</p></div></div>`;
  state.recRows=[];
  try{
   let data=retry?null:state.recCache.get(key);
   if(!data){
    const res=await fetch(`${API}/api/${mode==='producer'?'producers':'similar'}/${encodeURIComponent(seed.id)}`,{signal:AbortSignal.timeout(mode==='producer'?65000:30000)});
    data=await res.json();if(!res.ok)throw new Error(data.error||'Recommendations could not be loaded.');
    state.recCache.set(key,data);
   }
   if(requestId!==state.recId||!$('recommend-dialog').open)return;
   state.recRows=(data.artists||[]).map(a=>({...a,thumb:a.thumb||knownArtist(a.id,a.name).thumb}));
   renderRecommendations();
   const provider=mode==='producer'?'<a href="https://musicbrainz.org/" target="_blank" rel="noopener noreferrer">MusicBrainz</a>':'<a href="https://labs.api.listenbrainz.org/similar-artists" target="_blank" rel="noopener noreferrer">ListenBrainz</a>';
   $('recommend-note').innerHTML=mode==='producer'?`Based on overlapping ${provider} production credits in ${data.coverage==='sampled'?'a sample of live records and our featured maps':'our featured maps'}. A shared credit is a discovery lead, not a guarantee of the same sound.`:`Based on listening patterns from ${provider}, not a prediction that you’ll like every artist. Popular artists can appear more often.`;
  }catch(error){
   if(requestId!==state.recId||!$('recommend-dialog').open)return;
   $('recommend-results').innerHTML=`<div class="recommend-empty">${icon('Wifi',32)}<h3>Discovery needs a moment.</h3><p>${esc(error.name==='TimeoutError'?'The service is taking longer than expected. Try again in a moment.':error.message)}</p><button class="secondary-button" data-rec-retry>Try again ${icon('RotateCcw')}</button></div>`;
  }
 }
function fetchArtistInfo(mbid){
  const cached=state.info.get(mbid);if(cached!==undefined)return Promise.resolve(cached||null);
  let request=state.infoRequests.get(mbid);
  if(!request){request=fetch(`${API}/api/artist/${encodeURIComponent(mbid)}`).then(r=>r.ok?r.json():null).catch(()=>null).then(info=>{state.info.set(mbid,info||false);state.infoRequests.delete(mbid);return info;});state.infoRequests.set(mbid,request);}
  return request.then(info=>info||null);
 }
 const firstSentence=(text,max=150)=>{const t=String(text||'').replace(/\s+/g,' ').trim();if(!t)return '';const m=t.match(/^.*?[.!?](?=\s|$)/);const out=m?m[0]:t;return out.length>max?`${out.slice(0,out.lastIndexOf(' ',max))}…`:out;};
 function hydrateRecommendations(requestId){
  state.recRows.slice(0,8).forEach(row=>{
   fetchArtistInfo(row.id).then(info=>{
    if(requestId!==state.recId||!info)return;
    const card=document.querySelector(`.recommend-card[data-rec-id="${row.id}"]`);if(!card)return;
    const photo=info.image&&!row.thumb?imgSrc(info.image):'';
    if(photo){row.thumb=info.image;const slot=card.querySelector('.avatar');if(slot&&!slot.querySelector('img')){slot.innerHTML=`<img src="${esc(photo)}" alt="" data-image-fallback="${esc(initials(row.name))}">`;attachImages(slot);}}
    const bio=card.querySelector('.recommend-bio');
    if(bio){const text=firstSentence(info.extract);const tags=(info.genres||[]).slice(0,3);bio.classList.remove('loading');bio.innerHTML=`${text?`<p>${esc(text)}</p>`:''}${tags.length?`<div class="tags">${tags.map(g=>`<span class="tag">${esc(g)}</span>`).join('')}</div>`:''}`;if(!text&&!tags.length)bio.remove();}
   });
  });
 }
 function renderRecommendations(){
  const mode=state.recMode;
  if(!state.recRows.length){
   $('recommend-results').innerHTML=`<div class="recommend-empty">${icon('Compass',32)}<h3>No ${mode==='producer'?'production':'listener'} matches yet.</h3><p>${mode==='producer'?'We don’t have enough overlapping production credits to make a useful recommendation. Try another person on the map.':'ListenBrainz has limited listening data for this name. Try the Producers tab for credit-based discoveries, or choose another artist.'}</p><button class="secondary-button" data-rec-featured>Explore a featured map ${icon('ArrowRight')}</button></div>`;return;
  }
  $('recommend-results').innerHTML=state.recRows.slice(0,8).map((a,i)=>`<article class="recommend-card" data-rec-id="${esc(a.id)}"><div class="recommend-card-main">${avatar(a.name,mode==='producer'?'producer':'artist',a.thumb)}<div><span class="recommend-rank">DISCOVERY ${String(i+1).padStart(2,'0')}</span><h3>${esc(a.name)}</h3>${mode==='artist'&&a.note?`<p class="recommend-identity">${esc(a.note)}</p>`:''}</div><button class="icon-button dismiss-recommend" data-rec-dismiss="${esc(a.id)}" title="Not for me" aria-label="Dismiss ${esc(a.name)}">${icon('X',16)}</button></div><p class="recommend-reason">${esc(mode==='producer'?a.reasons?.[0]||'Overlapping production credits.':(i===0?'Most often played alongside ':'Often played alongside ')+state.recSeed.name+'.')}</p><div class="recommend-bio loading" aria-label="About ${esc(a.name)}"><span class="skeleton line"></span><span class="skeleton line short"></span></div>${mode==='producer'&&a.evidence?.length?`<div class="recommend-evidence">${a.evidence.slice(0,1).map(e=>`<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Check the credit on ${esc(e.title)} ${icon('ExternalLink',12)}</a>`).join('')}</div>`:''}<div class="recommend-actions"><button class="recommend-more" data-rec-more="${esc(a.id)}">${icon('Sparkles',15)}<span>More like this</span></button><button class="recommend-explore" data-rec-open="${esc(a.id)}"><span>${mode==='producer'?'See credits':'Explore'}</span>${icon('ArrowRight',16)}</button></div></article>`).join('');
  attachImages($('recommend-results'));hydrate($('recommend-results'));hydrateRecommendations(state.recId);
 }
 function bindDiscovery(){
  $('home-surprise').addEventListener('click',surprise);
  $('resume-map').addEventListener('click',()=>{showWorkspace();setHash(linkForMap().split('#')[1]||'');relayout(true,false);});
  $('root-recommend').addEventListener('click',rootRecommendations);$('map-recommend').addEventListener('click',rootRecommendations);
  $('close-recommend').addEventListener('click',()=>$('recommend-dialog').close());
  $('recommend-dialog').addEventListener('close',()=>state.recId++);
  $('recommend-dialog').addEventListener('click',event=>{if(event.target===$('recommend-dialog')){const r=$('recommend-dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('recommend-dialog').close();}});
  document.addEventListener('click',event=>{
   const mode=event.target.closest('[data-recommend-mode]');if(mode){state.recMode=mode.dataset.recommendMode;loadRecommendations();return;}
   const filter=event.target.closest('[data-home-filter]');if(filter){state.homeFilter=filter.dataset.homeFilter;document.querySelectorAll('[data-home-filter]').forEach(b=>{const active=b===filter;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});renderHome();return;}
   const like=event.target.closest('[data-like-result]');if(like){const r=state.results[Number(like.dataset.likeResult)];const id=r?.mbid||r?.id;if(id){state.searchId++;state.searchController?.abort();hideSearch();$('artist-search').blur();openRecommendations({id,name:r.name,thumb:r.thumb,category:'artist'},'artist');}return;}
   const recommend=event.target.closest('[data-recommend]');if(recommend){const n=state.nodes.get(recommend.dataset.recommend);if(n)openRecommendations({id:n.mbid,name:n.label,category:n.category,roles:n.roles},recommend.dataset.mode);return;}
   const producer=event.target.closest('[data-start-producer]');if(producer){openRecommendations({id:producer.dataset.startProducer,name:producer.dataset.name,category:'producer',roles:['producer']},'producer');return;}
   const recent=event.target.closest('[data-recent]');if(recent){const a=state.recent.find(a=>a.id===recent.dataset.recent);if(a)startDiscovery(a);return;}
   const open=event.target.closest('[data-rec-open]');if(open){const a=state.recRows.find(a=>a.id===open.dataset.recOpen);if(a)startDiscovery({id:a.id,name:a.name,thumb:a.thumb,category:state.recMode==='producer'?'producer':'artist',roles:[state.recMode]});return;}
   const more=event.target.closest('[data-rec-more]');if(more){const a=state.recRows.find(a=>a.id===more.dataset.recMore);if(a){state.recTrail.push(state.recSeed);state.recSeed={id:a.id,name:a.name,thumb:a.thumb,category:state.recMode==='producer'?'producer':'artist'};state.likes.add(a.id);loadRecommendations();$('recommend-dialog').scrollTo({top:0,behavior:'smooth'});}return;}
   if(event.target.closest('[data-rec-back]')){state.recSeed=state.recTrail.pop();loadRecommendations();return;}
   const dismiss=event.target.closest('[data-rec-dismiss]');if(dismiss){state.recRows=state.recRows.filter(a=>a.id!==dismiss.dataset.recDismiss);renderRecommendations();return;}
   if(event.target.closest('[data-rec-retry]'))loadRecommendations({retry:true});
   if(event.target.closest('[data-rec-featured]')){$('recommend-dialog').close();showHome();}
  });
 }

 function bind(){
  $('artist-search').addEventListener('focus',()=>{if(!$('artist-search').value.trim())searchSuggestions();});
  $('artist-search').addEventListener('input',()=>{
   state.searchId++;state.searchController?.abort();clearTimeout(searchTimer);
   const q=$('artist-search').value.trim();
   if(q.length<2){searchSuggestions();return;}
   // Wait briefly for typing to settle; MusicBrainz allows about one request per second.
   const box=$('search-results');box.hidden=false;$('artist-search').setAttribute('aria-expanded','true');
   box.innerHTML=`<div class="search-message"><span class="status-spinner" style="display:inline-block;margin-right:8px"></span>Looking for ${esc(q)}...</div>`;
   searchTimer=setTimeout(()=>searchArtists(q),350);
  });
  $('artist-search').addEventListener('keydown',event=>{
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();if($('search-results').hidden){searchSuggestions();return;}
    if(!state.results.length)return;
    state.resultIndex=(state.resultIndex+(event.key==='ArrowDown'?1:-1)+state.results.length)%state.results.length;
    document.querySelectorAll('[data-result]').forEach((el,i)=>{el.classList.toggle('focused',i===state.resultIndex);el.setAttribute('aria-selected',i===state.resultIndex);});
    $('artist-search').setAttribute('aria-activedescendant',`search-result-${state.resultIndex}`);
    $(`search-result-${state.resultIndex}`)?.scrollIntoView({block:'nearest'});
   }else if(event.key==='Enter'&&state.resultIndex>=0){event.preventDefault();chooseResult(state.resultIndex);}
   else if(event.key==='Escape')hideSearch();
  });
  $('search-form').addEventListener('submit',event=>{event.preventDefault();if(state.resultIndex>=0)chooseResult(state.resultIndex);else searchArtists($('artist-search').value);});
  document.addEventListener('click',event=>{
   const insideSearch=Boolean(event.target.closest('.search-form'));const insideActions=Boolean(event.target.closest('.map-actions'));
   const result=event.target.closest('[data-result]');if(result){chooseResult(Number(result.dataset.result));return;}
   const featured=event.target.closest('[data-featured]');if(featured){loadFeatured(featured.dataset.featured);return;}
   const select=event.target.closest('[data-select]');if(select){selectNode(select.dataset.select,true);return;}
   const dive=event.target.closest('[data-dive]');if(dive){const n=state.nodes.get(dive.dataset.dive);if(n&&!state.loading)streamArtist({id:n.mbid,name:n.label,thumb:n.thumb,category:n.category,roles:n.roles});return;}
   if(event.target.closest('#search-featured-fallback'))searchSuggestions();
   if(!insideSearch)hideSearch();
   if(!insideActions)$('export-menu').hidden=true;
  });
  document.addEventListener('keydown',event=>{
   const typing=/input|textarea/i.test(event.target.tagName)||event.target.isContentEditable;
   if(event.key==='Escape'){hideSearch();closeDetail();$('export-menu').hidden=true;}
   if(typing||$('help-dialog').open)return;
   if(event.key==='/'){event.preventDefault();$('artist-search').focus();}
   if(event.key.toLowerCase()==='f')fitMap();
  });
  $('home').addEventListener('click',showHome);
  $('empty-retry').addEventListener('click',()=>{const a=state.lastAttempt;if(a)streamArtist(a.artist,{newMap:a.newMap});});
  $('copy-link').addEventListener('click',copyLink);$('surprise').addEventListener('click',surprise);$('empty-action').addEventListener('click',surprise);
  $('theme-toggle').addEventListener('click',()=>setTheme(state.theme==='dark'?'light':'dark'));
  $('help').addEventListener('click',()=>$('help-dialog').showModal());
  for(const id of ['close-help','help-done'])$(id).addEventListener('click',()=>$('help-dialog').close());
  $('help-dialog').addEventListener('click',event=>{if(event.target===$('help-dialog')){const r=$('help-dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('help-dialog').close();}});
  $('close-detail').addEventListener('click',closeDetail);
  $('cancel-stream').addEventListener('click',()=>{stopStream('Exploration stopped. Your discoveries are still on the map.');relayout(!state.selectedId,false);});
  $('map-view').addEventListener('click',()=>setView('map'));$('list-view').addEventListener('click',()=>setView('list'));
  $('list-search').addEventListener('input',renderList);
  document.querySelectorAll('[data-category]').forEach(button=>button.addEventListener('click',()=>{
   const category=button.dataset.category;if(state.hidden.has(category))state.hidden.delete(category);else state.hidden.add(category);
   button.setAttribute('aria-pressed',!state.hidden.has(category));applyFilters();
  }));
  $('zoom-in').addEventListener('click',()=>{cy.zoom({level:Math.min(cy.zoom()*1.3,cy.maxZoom()),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});});
  $('zoom-out').addEventListener('click',()=>{cy.zoom({level:Math.max(cy.zoom()/1.3,cy.minZoom()),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});});
  $('fit-map').addEventListener('click',()=>{closeDetail();fitMap();});
  $('relayout').addEventListener('click',()=>{closeDetail();cy.nodes().forEach(n=>n.position({x:Math.random()*cy.width(),y:Math.random()*cy.height()}));relayout(true,true);});
  $('export').addEventListener('click',()=>$('export-menu').hidden=!$('export-menu').hidden);
  $('export-json').addEventListener('click',exportJSON);$('export-png').addEventListener('click',exportPNG);
  new ResizeObserver(()=>{cy.resize();if(!state.selectedId&&!state.loading)fitMap(false);}).observe($('map-stage'));
  window.addEventListener('beforeunload',()=>{state.stream?.close();});
 }
 async function routeHash(initial){
  const hash=new URLSearchParams(location.hash.slice(1));
  const wantedSlug=hash.get('f'),wantedArtist=hash.get('a'),wantedName=hash.get('n');
  if(wantedArtist&&/^[0-9a-f-]{36}$/i.test(wantedArtist)){
   if(initial||state.rootId!==`artist-${wantedArtist}`)streamArtist({id:wantedArtist,name:wantedName||'This artist'},{newMap:true});
  }else if(wantedSlug&&state.featured.some(f=>f.slug===wantedSlug)){
   if(initial||state.currentSlug!==wantedSlug||state.page==='home')await loadFeatured(wantedSlug);
  }else if(initial||state.page!=='home')showHome();
 }
 async function start(){
  hydrate();setTheme(state.theme);
  if(!window.cytoscape){showEmpty('The map library could not load.','Please refresh the page.');status('Please refresh to load the map.','error',true);return;}
  initGraph();bind();bindDiscovery();
  // Render and bind the home screen before the first API request, so search,
  // help and theme controls remain usable even if the API is unavailable.
  showHome({preserveHash:true});
  window.addEventListener('hashchange',()=>{routeHash(false);});
  try{
   const res=await fetch(`${API}/api/featured`);if(!res.ok)throw new Error('Could not load featured maps.');
   const data=await res.json();state.featured=data.featured||[];
   renderFeaturedPicks();
   await routeHash(true);
  }catch(error){
   $('home-featured').innerHTML='<p class="home-loading">Could not load the music collection. Reload the page to try again.</p>';
   toast('Could not connect to the music API. Please reload the page.');
  }
 }
 document.addEventListener('DOMContentLoaded',start);
})();
