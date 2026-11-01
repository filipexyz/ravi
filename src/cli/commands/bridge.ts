import "reflect-metadata";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Arg, CliOnly, Command, CommandAccess, Group, Option } from "../decorators.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
import { bridgeStateDir, getBridgeStore } from "../../bridge/store.js";
import { enrollmentSchema, runtimeIdentity } from "../../bridge/auth.js";

@Group({ name: "bridge", description: "Enroll the private Console human bridge", scope: "superadmin" })
export class BridgeCommands {
  @Command({
    name: "init",
    description: "Create a local bridge identity and print only its public enrollment material",
  })
  @CommandAccess({ kind: "mutate", resource: "bridge", action: "init", risk: "medium" })
  @CliOnly()
  init(@Option({ flags: "--json", description: "Machine output" }) _json?: boolean) {
    mkdirSync(bridgeStateDir(), { recursive: true, mode: 0o700 });
    const { runtimeId, publicKey } = runtimeIdentity(bridgeStateDir());
    console.log(JSON.stringify({ success: true, runtimeId, publicKey }));
  }
  @Command({
    name: "enroll",
    description: "Pin the Console authority for a managed installation from a JSON file",
  })
  @CommandAccess({ kind: "mutate", resource: "bridge", action: "enroll", risk: "high", requiresConfirmation: true })
  @CliOnly()
  enroll(
    @Arg("file", { description: "Enrollment JSON path", required: true }) file: string,
    @Option({ flags: "--json", description: "Machine output" }) _json?: boolean,
    @Option({ flags: "--execute", description: "Apply the reviewed local enrollment" }) execute?: boolean,
  ) {
    const parsed = enrollmentSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) contractFail("bridge enroll", "INVALID_ENROLLMENT", "Enrollment document is invalid");
    if (!existsSync(join(bridgeStateDir(), "identity.json")))
      contractFail("bridge enroll", "IDENTITY_REQUIRED", "Run bridge init first");
    const identity = runtimeIdentity(bridgeStateDir()),
      enrollment = parsed.data;
    if (enrollment.runtimeId !== identity.runtimeId)
      contractFail("bridge enroll", "RUNTIME_MISMATCH", "Enrollment targets another runtime");
    if (!execute)
      contractDryRun("bridge enroll", {
        enrollmentId: enrollment.id,
        authority: enrollment.issuer,
        epoch: enrollment.epoch,
      });
    const store = getBridgeStore(),
      previous = store.enrollment(enrollment.id);
    if (previous && enrollment.epoch <= previous.epoch)
      contractFail("bridge enroll", "EPOCH_REQUIRED", "Replacement enrollment must increase its epoch");
    const active = store.db
      .query<{ document: string }, []>("SELECT document FROM enrollments")
      .all()
      .map((row) =>
        enrollmentSchema.pick({ id: true, orgId: true, active: true }).strip().parse(JSON.parse(row.document)),
      );
    if (enrollment.active && active.some((item) => item.active && item.orgId !== enrollment.orgId))
      contractFail(
        "bridge enroll",
        "ORGANIZATION_MISMATCH",
        "Revoke the previous organization before enrolling another",
      );
    store.putEnrollment(enrollment);
    console.log(
      JSON.stringify({
        success: true,
        enrollmentId: enrollment.id,
        epoch: enrollment.epoch,
        active: enrollment.active,
      }),
    );
  }
  @Command({ name: "revoke", description: "Disable an enrollment and expire its active human contexts" })
  @CommandAccess({ kind: "mutate", resource: "bridge", action: "revoke", risk: "medium" })
  @CliOnly()
  revoke(
    @Arg("id", { description: "Enrollment UUID", required: true }) id: string,
    @Option({ flags: "--json", description: "Machine output" }) _json?: boolean,
  ) {
    const store = getBridgeStore(),
      value = store.enrollment(id);
    if (!value) contractFail("bridge revoke", "NOT_FOUND", "Enrollment not found");
    store.putEnrollment({ ...value, active: false, epoch: value.epoch + 1 });
    console.log(JSON.stringify({ success: true, enrollmentId: id, active: false }));
  }
}
