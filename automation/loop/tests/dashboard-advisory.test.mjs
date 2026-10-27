import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AdvisoryManager,readLatestReport} from "../src/dashboard-advisory.mjs";
const tick=()=>new Promise(r=>setImmediate(r));
test("manual advisory runs once, disallows overlap and does not auto retry",async()=>{
  let calls=0,reject;
  const manager=new AdvisoryManager({root:"/repo",run:()=>{calls++;return new Promise((_,r)=>{reject=r;});}});
  assert.equal(calls,0);manager.start("product");await tick();assert.equal(calls,1);
  assert.throws(()=>manager.start("quality"),e=>e.status===409);
  reject(Object.assign(new Error("network"),{kind:"network"}));await tick();
  assert.equal(manager.state().active,null);assert.equal(manager.state().last.reason,"network");assert.equal(calls,1);
  assert.throws(()=>manager.start("other"),e=>e.status===400);
});
test("latest lane report is validated, bounded and read-only",async()=>{
  const root=await mkdtemp(join(tmpdir(),"soxu-advisory-"));
  try {
    const dir=join(root,".soxu","advisory","product");await mkdir(dir,{recursive:true});
    const report={lane:"product",summary:"summary",findings:[{title:"finding",recommendation:"action",confidence:"high",evidence:["#1"]}],unknowns:["unknown"],createdAt:"2026-10-27T00:00:00Z",private:"do not return"};
    await writeFile(join(dir,"2026-10-27T00-00-00-000Z-123.json"),JSON.stringify(report));
    const result=await readLatestReport(root,"product");assert.equal(result.summary,"summary");assert.equal(result.findings[0].title,"finding");assert.equal(result.private,undefined);
    assert.equal(await readLatestReport(root,"quality"),null);
    await writeFile(join(dir,"2026-10-28T00-00-00-000Z-123.json"),JSON.stringify({...report,lane:"quality"}));
    await assert.rejects(()=>readLatestReport(root,"product"),e=>e.status===503);
    await assert.rejects(()=>readLatestReport(root,"../product"),e=>e.status===400);
  }finally{await rm(root,{recursive:true,force:true});}
});
