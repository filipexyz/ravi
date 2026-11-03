import {expect,test} from "bun:test";
import {commandDecision} from "../../src/server/console/fleet/gateway";
import type {GatewayCommand} from "../../src/server/console/fleet/gateway-ssh";
function command(resource:string,action:string,kind:"read"|"mutate",scope:"session"|"installation"):GatewayCommand {
  return {fullName:`${resource}.${action}`,path:`/api/v1/${resource.replaceAll(".","/")}/${action}`,scope:"resource",access:{resource,action,kind,consoleScope:scope}};
}
test("Desktop maps conversation, configuration and installation actions to distinct existing policy decisions",()=>{
  expect(commandDecision(command("desktop.work","list","read","session"))).toBe("read");
  expect(commandDecision(command("desktop.session","configure","mutate","session"))).toBe("configure");
  expect(commandDecision(command("desktop.computer","read","read","session"))).toBe("installation-read");
  expect(commandDecision(command("desktop.loops","list","read","installation"))).toBe("installation-read");
  expect(commandDecision(command("desktop.channels","set-enabled","mutate","installation"))).toBe("installation-manage");
  expect(()=>commandDecision(command("desktop.computer","read","read","installation"))).toThrow("gateway_access_denied");
  expect(()=>commandDecision(command("desktop.loops","set-enabled","read","installation"))).toThrow("gateway_access_denied");
  expect(()=>commandDecision(command("desktop.shell","execute","mutate","installation"))).toThrow("gateway_access_denied");
});
