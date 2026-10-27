import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DashboardCoordinator, createDashboardServer } from "../src/dashboard.mjs";
import { writeCheckpoint } from "../src/checkpoint.mjs";

const TOKEN = "a".repeat(48);
async function call(port, { path = "/api/status", method = "GET", token = TOKEN, origin, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body===undefined?undefined:JSON.stringify(body);
    const req=request({host:"127.0.0.1",port,method,path,headers:{
      ...(token?{"X-SOXU-Control-Token":token}:{}),
      ...(origin?{Origin:origin}:{}),...(host?{Host:host}:{}),
      ...(payload!==undefined?{"Content-Type":"application/json"}:{})
    }},res=>{const chunks=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>{
      const text=Buffer.concat(chunks).toString();
      resolve({status:res.statusCode,headers:res.headers,body:res.headers["content-type"]?.includes("json")?JSON.parse(text):text});
    });});
    req.on("error",reject);req.end(payload);
  });
}
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"soxu-dashboard-"));
  await mkdir(join(root,"tasks","backlog"),{recursive:true});
  await writeFile(join(root,"tasks","backlog","TASK-001.md"),"# Supervisor\n");
  await writeCheckpoint({issue:{number:1,body:"SECRET PROMPT"},local:false,status:"running",phase:"develop",directory:"F:\\secret",apiKey:"SHOULD_NOT_LEAK"},join(root,".soxu","checkpoints"));
  return root;
}
test("strict localhost auth, read-only status and explicit CSRF checks", async()=>{
  const root=await fixture();
  const coordinator=new DashboardCoordinator({root});
  const {server}=createDashboardServer({root,token:TOKEN,coordinator});
  try{
    await new Promise((ok,fail)=>{server.once("error",fail);server.listen(0,"127.0.0.1",ok)});
    const port=server.address().port, origin=`http://127.0.0.1:${port}`;
    assert.equal((await call(port,{token:null})).status,401);
    assert.equal((await call(port,{token:"b".repeat(48)})).status,401);
    assert.equal((await call(port,{host:"evil.example"})).status,403);
    assert.equal((await call(port,{origin:"https://evil.example"})).status,403);
    assert.equal((await call(port,{path:"/api/run",method:"POST",body:{command:"once"}})).status,403);
    assert.equal((await call(port,{path:"/api/run",method:"POST",origin,body:{command:"rm -rf"}})).status,400);
    assert.equal((await call(port,{path:"/api/stop",method:"POST",origin,body:{}})).status,409);
    const response=await call(port);
    assert.equal(response.status,200);
    assert.equal(response.body.isLive,false);
    assert.equal(response.body.tasks[0].phase,"develop");
    assert.equal(response.body.runner,null);
    for(const secret of ["SECRET PROMPT","SHOULD_NOT_LEAK","F:\\secret"])assert.ok(!JSON.stringify(response.body).includes(secret));
    assert.equal(response.headers["access-control-allow-origin"],undefined);
    const homepage=await call(port,{path:"/",token:null});
    assert.equal(homepage.status,200);
    assert.match(homepage.body,/SOXU/);
  } finally{
    await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
});

test("dashboard only controls its own fork via IPC and rejects overlapping runs",async()=>{
  const root=await fixture(), children=[];
  const spawn=(file,args)=>{const child=new EventEmitter();child.pid=54321;child.connected=true;child.stdout=new PassThrough();child.stderr=new PassThrough();child.messages=[];child.send=msg=>child.messages.push(msg);children.push({file,args,child});return child;};
  const coordinator=new DashboardCoordinator({root,spawn});
  try{
    const result=await coordinator.start("resume");
    assert.equal(result.command,"resume");
    assert.deepEqual(children[0].args,["resume"]);
    await assert.rejects(()=>coordinator.start("once"),error=>error.status===409);
    children[0].child.stdout.write("pi safe log\n");
    children[0].child.stderr.write("token=topsecret\n");
    const state=await coordinator.snapshot();
    assert.equal(state.busy,true);
    assert.ok(!JSON.stringify(state.log).includes("topsecret"));
    assert.equal(coordinator.stop().accepted,true);
    assert.deepEqual(children[0].child.messages,[{type:"soxu:interrupt"}]);
    assert.equal((await coordinator.snapshot()).runner.stopping,true);
    children[0].child.stdout.end();children[0].child.stderr.end();
    children[0].child.emit("exit",0,null);
    assert.equal((await coordinator.snapshot()).runner,null);
    children[0].child.emit("close",0,null);
    assert.equal((await coordinator.snapshot()).log.filter(x => x.message.startsWith("Finished resume")).length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("existing live worktree lock blocks dashboard-owned runner",async()=>{
  const root=await fixture();
  let spawned=0;
  const coordinator=new DashboardCoordinator({root,spawn:()=>{spawned++;throw new Error("unexpected fork");}});
  try{
    await mkdir(join(root,".soxu","locks"),{recursive:true});
    await writeFile(join(root,".soxu","locks","github-issue-1.lock"),JSON.stringify({pid:process.pid}));
    await assert.rejects(()=>coordinator.start("once"),error=>error.status===409);
    assert.equal(spawned,0);
    assert.equal((await coordinator.snapshot()).externalLocks,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
