import {expect,test} from "bun:test";
import {initialPolicy,policySchema} from "./policy";
import {compilePolicy} from "./engine";
import {randomUUID} from "node:crypto";
const org=randomUUID(),project=randomUUID(),installation=randomUUID(),owner=randomUUID(),other=randomUUID();
const capability={permission:"execute",objectType:"executable",objectId:"printf"};
const facts=(userId=owner)=>({organizationId:org,projectOrganizationId:org,projectId:project,userId,active:true,organizationRole:"owner",projectRole:null});
function policy(){return policySchema.parse({...initialPolicy(org,owner),bridgeAgents:[{installationId:installation,projectId:project,agentIds:["bridge-test"]}],
  bridgeRules:[{id:"runtime-owner",installationId:installation,projectId:project,agentId:"bridge-test",principals:[{kind:"user",id:owner}],effect:"allow",capabilities:[capability]}]});}
test("Console publishes literal per-agent grants, deny wins and approval is conditional",async()=>{
 const p=policy();let engine=await compilePolicy(p);
 expect((await engine.bridgeDelegation(facts(),installation))[0]!.capabilities).toEqual([capability]);
 expect((await engine.bridgeDelegation(facts(other),installation))[0]!.capabilities).toEqual([]);
 expect(await engine.bridgeDelegation(facts(),randomUUID())).toEqual([]);
 p.bridgeRules!.push({...p.bridgeRules![0]!,id:"require-approval",effect:"approval"});engine=await compilePolicy(p);
 expect((await engine.bridgeDelegation(facts(),installation))[0]).toMatchObject({capabilities:[],approvalCapabilities:[capability]});
 p.bridgeRules!.push({...p.bridgeRules![0]!,id:"deny",effect:"deny"});engine=await compilePolicy(p);
 expect((await engine.bridgeDelegation(facts(),installation))[0]).toMatchObject({capabilities:[],approvalCapabilities:[]});
 p.bridgeRules=[];engine=await compilePolicy(p);
 expect((await engine.bridgeDelegation(facts(),installation))[0]!.capabilities).toEqual([]);
});
test("no broad wildcard, foreign group or unassigned agent in a managed grant",()=>{
 const p=policy();p.bridgeRules![0]!.capabilities=[{...capability,objectId:"*"}];expect(policySchema.safeParse(p).success).toBe(false);
 p.bridgeRules![0]!.capabilities=[capability];p.bridgeRules![0]!.agentId="other";expect(policySchema.safeParse(p).success).toBe(false);
 p.bridgeRules![0]!.agentId="bridge-test";p.bridgeRules![0]!.principals=[{kind:"group",id:"missing"}];expect(policySchema.safeParse(p).success).toBe(false);
});

test("configuration control is separate from send and does not add execution capabilities", async () => {
  const p = policy();
  p.rules.push({ id: "send-only", effect: "allow", principals: [{ kind: "user", id: owner }], projects: [project], actions: ["bridge.conversations.send"] });
  let engine = await compilePolicy(p);
  expect((await engine.decide(facts(), "bridge.conversations.send")).allowed).toBe(true);
  expect((await engine.decide(facts(), "runtime.sessions.configure")).allowed).toBe(false);
  const before = await engine.bridgeDelegation(facts(), installation);
  p.rules.push({ id: "configure", effect: "allow", principals: [{ kind: "user", id: owner }], projects: [project], actions: ["runtime.sessions.configure"] });
  engine = await compilePolicy(p);
  expect((await engine.decide(facts(), "runtime.sessions.configure")).allowed).toBe(true);
  expect((await engine.decide(facts(other), "runtime.sessions.configure")).allowed).toBe(false);
  expect(await engine.bridgeDelegation(facts(), installation)).toEqual(before);
});
