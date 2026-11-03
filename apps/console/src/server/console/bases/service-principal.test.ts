import { expect, test } from "bun:test";
import { basesSystemCaller } from "./context";
import { assertBasesServiceOperation, basesJobCaller, basesServiceIdentity, isBasesServiceProject } from "./service-principal";
const project = { id: "project-a", organizationId: "org-a" };
test("internal job authority is non-serializable and scoped to job/project/base/operation", () => {
  const caller = basesJobCaller("usage-metrics", project, "request-fixture");
  const scope = { caller, project, base: { slug: "uso-dias" } };
  expect(isBasesServiceProject(caller, project)).toBe(true);
  expect(basesServiceIdentity(caller)?.principal).toBe("console-job:usage-metrics");
  expect(() => assertBasesServiceOperation(scope, "rows.create")).not.toThrow();
  for (const forged of [{ ...caller }, JSON.parse(JSON.stringify(caller)), basesSystemCaller(project.organizationId, "request-fixture")]) {
    expect(isBasesServiceProject(forged, project)).toBe(false);
    expect(() => assertBasesServiceOperation({ ...scope, caller: forged }, "rows.create")).toThrow();
  }
  expect(() => assertBasesServiceOperation({ ...scope, project: { ...project, id: "project-b" } }, "rows.create")).toThrow();
  expect(() => assertBasesServiceOperation({ ...scope, project: { ...project, organizationId: "org-b" } }, "rows.create")).toThrow();
  expect(() => assertBasesServiceOperation({ ...scope, base: { slug: "customer-data" } }, "rows.create")).toThrow();
  expect(() => assertBasesServiceOperation(scope)).toThrow();
  expect(caller.source).toEqual({ kind: "system", id: "system" }); // persisted receipt compatibility
});
test("projection cannot use metrics bases, update views, or lifecycle operations", () => {
  const caller = basesJobCaller("shared-chat-projection", project, "projection-fixture");
  const scope = { caller, project, base: { slug: "conversas-pages" } };
  expect(() => assertBasesServiceOperation(scope, "rows.update")).not.toThrow();
  expect(() => assertBasesServiceOperation(scope, "view.update")).toThrow();
  expect(() => assertBasesServiceOperation({ ...scope, base: { slug: "uso-dias" } }, "rows.query")).toThrow();
  expect(() => assertBasesServiceOperation(scope)).toThrow();
});
