import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGithubStatus } from "../src/dashboard-github.mjs";

test("PR checks and unresolved dependencies reflect GitHub evidence", () => {
  const catalog=[{id:"TASK-001",dependencies:[]},{id:"TASK-002",dependencies:["TASK-001"]}];
  const issues=[{number:11,title:"[TASK-001] One",state:"OPEN"},{number:22,title:"[TASK-002] Two",state:"OPEN"}];
  const prs=[{number:21,state:"OPEN",baseRefName:"main",body:"Closes #11",mergedAt:null,statusCheckRollup:[{status:"IN_PROGRESS",conclusion:""}]}];
  let snapshot=buildGithubStatus(catalog,issues,prs);
  assert.deepEqual(snapshot["TASK-001"].pr,{number:21,title:"",url:null,state:"open",ci:"pending"});
  assert.deepEqual(snapshot["TASK-002"].missing,["TASK-001"]);
  prs[0].statusCheckRollup=[{status:"COMPLETED",conclusion:"FAILURE"}];
  assert.equal(buildGithubStatus(catalog,issues,prs)["TASK-001"].pr.ci,"failure");
  prs[0].mergedAt="2026-10-27T00:00:00Z"; prs[0].state="MERGED"; issues[0].state="CLOSED";
  snapshot=buildGithubStatus(catalog,issues,prs);
  assert.equal(snapshot["TASK-001"].pr.state,"merged");
  assert.deepEqual(snapshot["TASK-002"].missing,[]);
});

test("roadmap counts all classified issues rather than a fixed backlog",()=>{
  const catalog=[{id:"TASK-001",milestone:"M1",dependencies:[]}];
  const issues=[{number:1,title:"[TASK-001] First",state:"CLOSED",labels:[]},
    {number:90,title:"[M1] Additional work",state:"OPEN",labels:[{name:"agent:in-progress"}]},
    {number:91,title:"New work",state:"OPEN",milestone:{title:"M2 · 多 Agent"},labels:[{name:"agent:blocked"}]},
    {number:92,title:"[M2] Another",state:"OPEN",labels:[{name:"agent:waiting"}]},
    {number:93,title:"Other",state:"OPEN",labels:[{name:"agent:ready"}]}];
  const prs=[{number:21,state:"MERGED",baseRefName:"main",body:"Closes #1",mergedAt:"2026-10-27T00:00:00Z"}];
  const roadmap=buildGithubStatus(catalog,issues,prs).__roadmap;
  assert.deepEqual(roadmap.stages[1].issues,[1,90]);
  assert.equal(roadmap.stages[1].items[0].merged,true);
  assert.equal(roadmap.stages[1].items[1].title,"[M1] Additional work");
  assert.equal(roadmap.stages[2].total,2);assert.equal(roadmap.stages[2].paused,1);assert.equal(roadmap.unclassified,1);
});
