'use strict';
class BudgetExceeded extends Error { constructor(message='Exploration limit reached') { super(message); this.name='BudgetExceeded'; } }
// A budget caps how many requests, nodes and seconds one user action may spend.
function createBudget(options={}) {
 const maxRequests=Math.min(60,Math.max(1,options.maxRequests??20));
 const maxNodes=Math.min(120,Math.max(1,options.maxNodes??70));
 const deadline=Date.now()+Math.min(120000,Math.max(100,options.maxTimeMS??60000));
 return {maxRequests,maxNodes,deadline,requests:0,signal:options.signal,priority:options.priority??1,
  timeLeft(){return Math.max(0,deadline-Date.now());},
  canRequest(){return !this.signal?.aborted && this.requests<maxRequests && this.timeLeft()>0;},
  reserveRequest(){if(!this.canRequest())throw new BudgetExceeded();this.requests++;}
 };
}
module.exports={createBudget,BudgetExceeded};
