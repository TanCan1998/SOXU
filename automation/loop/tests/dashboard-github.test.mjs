import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGithubStatus } from "../src/dashboard-github.mjs";

test("PR checks and unresolved dependencies reflect GitHub evidence", () => {
  const catalog=[{id:"TASK-001",dependencies:[]},{id:"TASK-002",dependencies:["TASK-001"]}];
  const issues=[{number:11,title:"[TASK-001] One",state:"OPEN"},{number:22,title:"[TASK-002] Two",state:"OPEN"}];
  const prs=[{number:21,state:"OPEN",baseRefName:"main",body:"Closes #11",mergedAt:null,statusCheckRollup:[{status:"IN_PROGRESS",conclusion:""}]}];
  let snapshot=buildGithubStatus(catalog,issues,prs);
  assert.deepEqual(snapshot["TASK-001"].pr,{number:21,state:"open",ci:"pending"});
  assert.deepEqual(snapshot["TASK-002"].missing,["TASK-001"]);
  prs[0].statusCheckRollup=[{status:"COMPLETED",conclusion:"FAILURE"}];
  assert.equal(buildGithubStatus(catalog,issues,prs)["TASK-001"].pr.ci,"failure");
  prs[0].mergedAt="2026-10-27T00:00:00Z"; prs[0].state="MERGED"; issues[0].state="CLOSED";
  snapshot=buildGithubStatus(catalog,issues,prs);
  assert.equal(snapshot["TASK-001"].pr.state,"merged");
  assert.deepEqual(snapshot["TASK-002"].missing,[]);
});
