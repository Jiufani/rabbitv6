'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const app=require('../server/index');

let server,base;
test.before(()=>new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base=`http://127.0.0.1:${server.address().port}`;resolve();});}));
test.after(()=>new Promise(resolve=>server.close(resolve)));

test('serves the app shell',async()=>{
 const res=await fetch(base+'/');
 assert.equal(res.status,200);
 assert.match(await res.text(),/RabbitHole/);
});
test('health reports the data source and featured maps',async()=>{
 const body=await (await fetch(base+'/api/health')).json();
 assert.equal(body.ok,true);
 assert.equal(body.source,'MusicBrainz');
 assert.ok(body.featured>=1);
});
test('featured maps are valid graphs',async()=>{
 const {featured}=await (await fetch(base+'/api/featured')).json();
 assert.ok(featured.length>=3);
 for(const f of featured){
  const g=await (await fetch(`${base}/api/featured/${f.slug}`)).json();
  const ids=new Set(g.nodes.map(n=>n.id));
  assert.ok(ids.has(g.rootId),`${f.slug} root exists`);
  assert.equal(ids.size,g.nodes.length,`${f.slug} has unique nodes`);
  for(const e of g.edges)assert.ok(ids.has(e.source)&&ids.has(e.target),`${f.slug} edge endpoints exist`);
 }
});
test('rejects bad input',async()=>{
 assert.equal((await fetch(base+'/api/graph')).status,400);
 assert.equal((await fetch(base+'/api/graph?id=12345')).status,400);
 assert.equal((await fetch(base+'/api/artist/not-an-id')).status,400);
 assert.equal((await fetch(base+'/api/featured/..%2Fsecret')).status,404);
 assert.deepEqual(await (await fetch(base+'/api/search?q=a')).json(),{results:[]});
 assert.equal((await fetch(base+'/api/img?u='+encodeURIComponent('https://example.com/a.png'))).status,400);
 assert.equal((await fetch(base+'/api/nope')).status,404);
});

test('similar-artist endpoint rejects bad ids',async()=>{
 const res=await fetch(base+'/api/similar/not-an-id');
 assert.equal(res.status,400);
});

test('Vercel entry exports the complete API app without opening a port',()=>{
 assert.equal(require('../api/index'),app);
});

test('browser scripts, stylesheet and map library return their real asset types',async()=>{
 for(const [file,type] of [['/graph.js',/javascript/],['/icons.js',/javascript/],['/vendor/cytoscape.min.js',/javascript/],['/style.css',/css/]]){
  const res=await fetch(base+file);
  assert.equal(res.status,200,file);
  assert.match(res.headers.get('content-type'),type,file);
 }
});

test('image proxy returns and caches a missing image as 404 rather than crashing',async t=>{
 const nativeFetch=global.fetch;
 let calls=0;
 t.mock.method(global,'fetch',async()=>{calls++;return new Response('',{status:404});});
 const url=base+'/api/img?u='+encodeURIComponent('https://coverartarchive.org/release/test-missing/front-250');
 for(let i=0;i<2;i++)assert.equal((await nativeFetch(url)).status,404);
 assert.equal(calls,1);
});

test('image proxy follows allowed redirects and returns cacheable image bytes',async t=>{
 const nativeFetch=global.fetch;
 const bytes=Buffer.from([137,80,78,71]);
 let calls=0;
 t.mock.method(global,'fetch',async()=>{
  calls++;
  return calls===1?new Response(null,{status:302,headers:{location:'https://ia800100.us.archive.org/cover.png'}}):new Response(bytes,{headers:{'content-type':'image/png'}});
 });
 const res=await nativeFetch(base+'/api/img?u='+encodeURIComponent('https://coverartarchive.org/release/test-valid/front-250'));
 assert.equal(res.status,200);
 assert.equal(res.headers.get('content-type'),'image/png');
 assert.match(res.headers.get('cache-control'),/max-age=86400/);
 assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes);
 assert.equal(calls,2);
});

test('graph endpoint streams nodes and a final completion event',async t=>{
 const mb=require('../server/requests/musicbrainz');
 const id='e520459c-dff4-491d-a6e4-c97be35e0044';
 t.mock.method(mb,'getArtist',async()=>({id,name:'Frank Ocean',relations:[]}));
 t.mock.method(mb,'getReleaseGroups',async()=>({'release-groups':[]}));
 const res=await fetch(base+'/api/graph?id='+id+'&name=Frank%20Ocean');
 assert.equal(res.status,200);
 assert.match(res.headers.get('content-type'),/text\/event-stream/);
 const messages=(await res.text()).split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
 assert.ok(messages.some(m=>m.type==='node'&&m.data.mbid===id));
 assert.equal(messages.at(-1).type,'complete');
 assert.equal(messages.at(-1).reason,'no_albums');
});

test('an upstream HTML response produces a retryable API error',async t=>{
 const nativeFetch=global.fetch;
 t.mock.method(global,'fetch',async()=>new Response('<html>Unavailable</html>',{headers:{'content-type':'text/html'}}));
 const res=await nativeFetch(base+'/api/search?q=upstream-response-regression');
 assert.equal(res.status,503);
 assert.match((await res.json()).error,/unreadable response/);
});
