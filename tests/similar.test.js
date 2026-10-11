'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {clean}=require('../server/services/similar');

const row=(id,name,score,extra={})=>({artist_mbid:id,name,score,comment:'',type:'Person',...extra});
const A='381086ea-f511-4aba-bdf9-71c753dc5077',B='164f0d73-1234-4e29-9d71-88b8f7f4cc3a',C='6e0a5b02-1234-4e29-9d71-88b8f7f4cc3a';

test('recommendations drop the artist itself, placeholders and duplicates',()=>{
 const out=clean([row(A,'Kendrick Lamar',500),row('125ec42a-7229-4250-afc5-e057484327fe','[unknown]',900),row(B,'Drake',400),row(B,'Drake',390),row('not-an-id','Bad',100),row(C,'Various Artists',50)],A,12);
 assert.deepEqual(out.map(r=>r.name),['Drake']);
});
test('match is relative to the strongest result and never below the floor',()=>{
 const out=clean([row(B,'Drake',1000),row(C,'SZA',500),row('11111111-1111-4111-8111-111111111111','Tiny',1)],A,12);
 assert.equal(out[0].match,100);assert.equal(out[1].match,50);assert.equal(out[2].match,4);
});
test('garbage input yields an empty list',()=>{assert.deepEqual(clean(null,A,12),[]);assert.deepEqual(clean({oops:1},A,12),[]);});
