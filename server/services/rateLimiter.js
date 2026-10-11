'use strict';
// One shared queue for every MusicBrainz request. MusicBrainz asks clients to stay at or below one
// request per second per IP, so requests are spaced apart. Interactive work (search, artist details)
// jumps ahead of long graph expansions so the UI stays responsive.
const {BudgetExceeded}=require('./budget');
const GAP_MS=Number(process.env.MUSICBRAINZ_GAP_MS)||1100;
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(new DOMException('Aborted','AbortError'));
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
 const onAbort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
 signal?.addEventListener('abort',onAbort,{once:true});
});
class ApiError extends Error {constructor(message,status){super(message);this.name='ApiError';this.status=status;}}

const queue=[];let running=false,nextTime=0,sequence=0;
function schedule(job){
 queue.push(job);
 queue.sort((a,b)=>a.priority-b.priority||a.seq-b.seq);
 if(!running)pump();
}
async function pump(){
 running=true;
 while(queue.length){
  const job=queue.shift();
  if(job.budget.signal?.aborted){job.reject(new DOMException('Aborted','AbortError'));continue;}
  if(!job.budget.canRequest()){job.reject(new BudgetExceeded());continue;}
  try{
   const wait=Math.max(0,nextTime-Date.now());
   if(wait>=job.budget.timeLeft()){job.reject(new BudgetExceeded());continue;}
   if(wait)await sleep(wait,job.budget.signal);
  }catch(error){job.reject(error);continue;}
  job.budget.reserveRequest();
  nextTime=Date.now()+GAP_MS;
  try{job.resolve(await execute(job));}catch(error){job.reject(error);}
 }
 running=false;
}
async function execute(job){
 const {url,options,budget}=job;
 const controller=new AbortController();
 const abort=()=>controller.abort();
 budget.signal?.addEventListener('abort',abort,{once:true});
 const timeout=setTimeout(abort,Math.min(Math.max(1000,budget.timeLeft()),20000));
 try{
  const response=await fetch(url,{...options,signal:controller.signal});
  if(response.status===503||response.status===429){
   const retryAfter=Number(response.headers.get('retry-after'));
   const delay=Math.min(15000,Math.max(GAP_MS*2,(Number.isFinite(retryAfter)?retryAfter:0)*1000));
   nextTime=Math.max(nextTime,Date.now()+delay);
   job.attempts=(job.attempts||0)+1;
   if(job.attempts<=2&&budget.timeLeft()>delay+2000&&!budget.signal?.aborted){
    // Bounded backoff after an explicit busy response; retries also consume the budget.
    await sleep(delay,budget.signal);
    budget.reserveRequest();nextTime=Date.now()+GAP_MS;
    return await execute(job);
   }
   throw new ApiError('MusicBrainz is busy right now. Please try again in a moment.',response.status===429?429:503);
  }
  if(response.status===404)throw new ApiError('MusicBrainz could not find that item.',404);
  if(response.status===400)throw new ApiError('MusicBrainz could not understand that request.',400);
  if(!response.ok)throw new ApiError('MusicBrainz is temporarily unavailable. Please try again later.',502);
  try{return await response.json();}
  catch{throw new ApiError('MusicBrainz returned an unreadable response. Please try again in a moment.',502);}
 }catch(error){
  if(error.name==='AbortError'&&!budget.signal?.aborted)throw new ApiError('MusicBrainz took too long to answer. Please try again.',504);
  throw error;
 }finally{clearTimeout(timeout);budget.signal?.removeEventListener('abort',abort);}
}
function rateLimitedFetch(url,options,budget){
 return new Promise((resolve,reject)=>schedule({url,options,budget,resolve,reject,priority:budget.priority??1,seq:++sequence}));
}
module.exports={rateLimitedFetch,ApiError,GAP_MS,queueLength:()=>queue.length};
