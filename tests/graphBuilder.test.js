'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {collectCredits,scoreGroup}=require('../server/services/graphBuilder');
const {createBudget,BudgetExceeded}=require('../server/services/budget');
const {validId,escapeQuery}=require('../server/requests/musicbrainz');

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const person=(n,name)=>({id:id(n),name});
const rel=(type,artist,attributes=[])=>({'target-type':'artist',type,artist,attributes});
const release={
 id:id(900),'artist-credit':[{artist:person(1,'Lead')}],
 media:[{tracks:[
  {title:'One',recording:{id:id(101),title:'One','artist-credit':[{artist:person(1,'Lead')},{artist:person(2,'Guest')}],relations:[rel('producer',person(3,'Ace')),rel('producer',person(4,'Boss'),['executive']),rel('vocal',person(5,'Singer'),['guest'])]}},
  {title:'Two',recording:{id:id(102),title:'Two','artist-credit':[{artist:person(1,'Lead')}],relations:[rel('producer',person(3,'Ace')),rel('producer',person(6,'Beat'),['co']),rel('instrument',person(7,'Session'),['bass']),rel('instrument',person(8,'Horns'),['guest','trumpet'])]}}
 ]}]
};

test('collectCredits separates producers from featured performers',()=>{
 const credits=collectCredits(release);
 assert.deepEqual(credits.producers.map(p=>p.name),['Ace','Beat']);
 assert.equal(credits.producers[0].tracks.length,2);
 assert.ok(credits.producers.find(p=>p.name==='Beat').roles.includes('Co-producer'));
 assert.deepEqual(credits.featured.map(p=>p.name).sort(),['Guest','Horns','Singer']);
});

test('executive producers, the album artist and unnamed session players are not shown as collaborators',()=>{
 const names=[...collectCredits(release).producers,...collectCredits(release).featured].map(p=>p.name);
 for(const hidden of ['Boss','Lead','Session'])assert.ok(!names.includes(hidden),hidden);
});

test('collectCredits respects limits and tolerates missing data',()=>{
 assert.deepEqual(collectCredits({}),{producers:[],featured:[]});
 assert.equal(collectCredits(release,{producer:1,featured:1}).producers.length,1);
});

test('release groups rank rated studio albums above live and compilation releases',()=>{
 const studio={'primary-type':'Album','secondary-types':[],rating:{'votes-count':20},genres:[{count:5}]};
 const live={...studio,'secondary-types':['Live']};
 const mixtape={...studio,'secondary-types':['Mixtape/Street']};
 assert.ok(scoreGroup(studio)>scoreGroup(mixtape));
 assert.ok(scoreGroup(mixtape)>scoreGroup(live));
});

test('MusicBrainz identifiers are validated and search text is escaped',()=>{
 assert.equal(validId('381086EA-F511-4ABA-BDF9-71C753DC5077'),'381086ea-f511-4aba-bdf9-71c753dc5077');
 assert.equal(validId('../etc/passwd'),null);
 assert.equal(escapeQuery('AC/DC (live)'),'AC\\/DC \\(live\\)');
});

test('budget enforces request limits and deadlines',()=>{
 const budget=createBudget({maxRequests:2,maxTimeMS:5000});
 budget.reserveRequest();budget.reserveRequest();
 assert.equal(budget.canRequest(),false);
 assert.throws(()=>budget.reserveRequest(),BudgetExceeded);
 assert.equal(createBudget({maxRequests:9999}).maxRequests,60);
});
