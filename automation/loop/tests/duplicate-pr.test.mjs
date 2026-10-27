import test from "node:test";
import assert from "node:assert/strict";
import { duplicatePrs } from "../src/duplicate-pr.mjs";
test("recognizes explicit open PR evidence without matching other issue numbers", () => {
 const prs=[{number:1,state:"OPEN",baseRefName:"main",body:"Closes #4",url:"a"},
 {number:2,state:"OPEN",baseRefName:"main",body:"Fixes #40",url:"b"},
 {number:3,state:"OPEN",baseRefName:"main",headRefName:"agent/github-issue-4-example"},
 {number:4,state:"CLOSED",baseRefName:"main",body:"Closes #4"},
 {number:5,state:"OPEN",baseRefName:"other",body:"Closes #4"}];
 assert.deepEqual(duplicatePrs(4,prs).map(x=>x.number),[1,3]);
});
test("rejects invalid results instead of assuming no duplicates",()=>{
 assert.throws(()=>duplicatePrs(4,null)); assert.throws(()=>duplicatePrs(0,[]));
});
