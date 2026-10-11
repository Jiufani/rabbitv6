'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {recommendProducers}=require('../server/services/producerRecommendations');

const P1='11111111-1111-4111-8111-111111111111',P2='22222222-2222-4222-8222-222222222222',P3='33333333-3333-4333-8333-333333333333';
const graph={
 nodes:[
  {id:'p1',mbid:P1,label:'Seed Producer',category:'producer'},
  {id:'p2',mbid:P2,label:'Co Producer',category:'producer'},
  {id:'p3',mbid:P3,label:'Stranger',category:'producer'},
  {id:'a1',label:'Shared Record',category:'album',releaseGroupId:'rg1',artistNames:['Star'],genres:['hip hop']},
  {id:'a2',label:'Other Record',category:'album',releaseGroupId:'rg2',artistNames:['Nobody'],genres:['polka']}
 ],
 edges:[
  {source:'p1',target:'a1',type:'produced'},
  {source:'p2',target:'a1',type:'produced'},
  {source:'p3',target:'a2',type:'produced'},
  {source:'p3',target:'a1',type:'wrote'}
 ]
};
test('producers who share records rank first and carry a reason',()=>{
 const out=recommendProducers([graph],P1);
 assert.equal(out[0].id,P2);
 assert.match(out[0].reasons[0],/Shared Record/);
 assert.ok(!out.some(p=>p.id===P1));
});
test('unknown producers return nothing',()=>{assert.deepEqual(recommendProducers([graph],'44444444-4444-4444-8444-444444444444'),[]);});
