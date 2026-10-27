import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseAdvisory, runAdvisory } from "./advisory.mjs";
import { classifyFailure } from "./errors.mjs";

const VALID = new Set(["product", "quality"]);
function invalid(message,status=400) {return Object.assign(new Error(message),{status});}
export async function readLatestReport(root, lane) {
  if (!VALID.has(lane)) throw invalid("invalid-lane");
  const dir=join(root,".soxu","advisory",lane);
  let names;
  try {names=(await readdir(dir)).filter(x=>/^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+\.json$/.test(x)).sort();}
  catch(error){if(error.code==="ENOENT") return null; throw error;}
  if (!names.length) return null;
  const path=join(dir,names.at(-1)), info=await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size>128000) throw invalid("report-unavailable",503);
  let input; try {input=JSON.parse(await readFile(path,"utf8"));} catch {throw invalid("report-unavailable",503);}
  let result; try {result=parseAdvisory("SOXU_ADVISORY_RESULT:"+JSON.stringify(input),lane);} catch {throw invalid("report-unavailable",503);}
  return {...result,createdAt:typeof input.createdAt==="string" && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : null, origin:"model-proposal-unverified"};
}
export class AdvisoryManager {
  constructor({root,run=runAdvisory,onChange=()=>{}}) {this.root=root;this.run=run;this.onChange=onChange;this.active=null;this.last=null;this.counters={product:0,quality:0};}
  state() {return {active:this.active ? {lane:this.active.lane,startedAt:this.active.startedAt,model:this.active.model ?? null} : null,last:this.last};}
  start(lane) {
    if (!VALID.has(lane)) throw invalid("invalid-lane");
    if (this.active) throw invalid("advisory-busy",409);
    const job={lane,startedAt:new Date().toISOString(),controller:new AbortController()};
    this.active=job;this.onChange();
    Promise.resolve().then(()=>this.run(lane,{root:this.root,signal:job.controller.signal,modelIndex:this.counters[lane]++,onModel:model=>{job.model=model;this.onChange();}})).then(()=>{
      this.last={lane,status:"completed",finishedAt:new Date().toISOString(),reason:null};
    }).catch(error=>{
      const kind=classifyFailure(error).kind;
      this.last={lane,status:"failed",finishedAt:new Date().toISOString(),reason:["quota","network","timeout","interrupted"].includes(kind)?kind:"failure"};
    }).finally(()=>{if(this.active===job)this.active=null;this.onChange();});
    return this.state();
  }
  shutdown() {this.active?.controller.abort();}
}
