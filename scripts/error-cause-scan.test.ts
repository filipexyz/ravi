import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BASELINE_COMMIT,
  BASELINE_PATH,
  FROZEN_PATH,
  checkSurfaceCoverage,
  concreteNoCauseReason,
  makeBaseline,
  renderInventory,
  scanSource,
  scanSources,
  validateAllowlist,
} from "./error-cause-scan.js";

const file = "src/cli/fixture.ts";
const scan = (text: string) => scanSource(file, text);

describe("error cause Git refs", () => {
  let root: string;
  const env = { ...process.env };
  // Hooks export repository paths; fixtures must never write to the caller's repo.
  for (const key of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split("\n")) {
    delete env[key];
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
  const run = (code: string) => Bun.spawnSync([
    process.execPath,
    "--eval",
    `import { baselineAtRef, scanCommit } from ${JSON.stringify(join(import.meta.dir, "error-cause-scan.ts"))}; ${code}`,
  ], { cwd: root, env });
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Ratchet test", "-c", "user.email=ratchet@example.invalid", "commit", "--quiet", "-m", "fixture");
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "error-cause-refs-"));
    git("init", "--quiet");
    mkdirSync(join(root, "scripts"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("missing_immutable_anchor_fails_the_cli_with_fetch_instructions", () => {
    copyFileSync(join(import.meta.dir, "error-cause-scan.ts"), join(root, "scripts/error-cause-scan.ts"));
    symlinkSync(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
    for (const path of [BASELINE_PATH, FROZEN_PATH]) {
      writeFileSync(join(root, path), JSON.stringify(makeBaseline([])));
    }
    const result = Bun.spawnSync([process.execPath, "scripts/error-cause-scan.ts"], { cwd: root, env });
    const stderr = result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain(`cannot resolve Git commit "${BASELINE_COMMIT}" in this clone`);
    expect(stderr).toContain("fetch-depth: 0");
    expect(stderr).toContain("git fetch origin refs/tags/error-cause-baseline:refs/tags/error-cause-baseline");
    expect(stderr).not.toContain("fatal: not a tree object");
  });

  it("missing_comparison_ref_fails_with_the_ref_and_event_recovery_instructions", () => {
    const ref = "0123456789abcdef0123456789abcdef01234567";
    const result = run(`baselineAtRef(process.cwd(), "${ref}");`);
    const stderr = result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain(`cannot resolve Git commit "${ref}" in this clone`);
    expect(stderr).toContain("pull_request.base.sha");
    expect(stderr).toContain("event.before");
    expect(stderr).not.toContain("fatal: not a tree object");
  });

  it("valid_commit_without_baseline_remains_allowed_and_source_can_be_scanned", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/fixture.ts"), "try { work(); } catch {}");
    commit();
    const result = run(`console.log(JSON.stringify({
      absent: baselineAtRef(process.cwd(), "HEAD") === undefined,
      violation: scanCommit(process.cwd(), "HEAD")[0]?.violation,
    }));`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ absent: true, violation: "catch-without-binding" });
  });

  it("malformed_baseline_json_still_fails_in_a_valid_commit", () => {
    writeFileSync(join(root, BASELINE_PATH), "{broken");
    commit();
    const result = run('baselineAtRef(process.cwd(), "HEAD");');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("SyntaxError");
  });
});

describe("error cause AST gate", () => {
  it("rejects_new_catch_without_binding", () => {
    const empty = makeBaseline([]);
    const sites = scan("try { work(); } catch { contractFail('op','FAILED','Failed'); }");
    expect(sites[0]?.violation).toBe("catch-without-binding");
    expect(validateAllowlist(sites, empty, empty).some((message) => message.includes("Unlisted masking site"))).toBe(
      true,
    );
  });

  it("rejects_new_rejection_without_binding", () => {
    expect(scan("work().catch(() => fail('Failed')); ")[0]?.violation).toBe("rejection-without-binding");
    expect(scan("work()['catch'](function () { return { success:false }; });")[0]?.violation).toBe(
      "rejection-without-binding",
    );
  });

  it("rejects_ignored_binding_when_surface_is_emitted", () => {
    expect(scan("try { work(); } catch (error) { return errorResponse(500, 'Failed'); }")[0]?.violation).toBe(
      "unused-binding-at-surface",
    );
    expect(scan("work().catch((error) => ({ success:false, error:'Failed' }));")[0]?.violation).toBe(
      "unused-binding-at-surface",
    );
    expect(scan("try { work(); } catch (error) { throw new Error('Failed'); }")[0]?.violation).toBe(
      "unused-binding-at-surface",
    );
  });

  it("passes_cause_forwarding_and_concrete_no_cause_annotation", () => {
    expect(
      scan("try { work(); } catch (error) { return userFailure({cause:error,context:{operation:'op'}}); }")[0]?.state,
    ).toBe("fixed");
    expect(
      scan("try { work(); } catch { // no-cause: Optional cache miss falls back to disk\n return undefined; }")[0]
        ?.state,
    ).toBe("no-cause");
    expect(
      scan("work().catch(() => { // no-cause: Best effort cleanup has no caller response\n return undefined; });")[0]
        ?.state,
    ).toBe("no-cause");
    expect(
      scan("try { work(); } catch { // no-cause: TODO fix this later\n return undefined; }")[0]?.violation,
    ).toBeDefined();
    expect(concreteNoCauseReason("ignored")).toBe(false);
  });

  it("does_not_count_a_shadowed_identifier_as_the_caught_binding", () => {
    const sites = scan(
      "try { work(); } catch (error) { (() => { const error = 'other'; log(error); })(); return errorResponse(500, 'Failed'); }",
    );
    expect(sites[0]?.violation).toBe("unused-binding-at-surface");
    expect(scan("try { work(); } catch (error) { return userFailure({cause:error}); }")[0]?.state).toBe("fixed");
  });

  it("rejects_logging_the_cause_then_emitting_an_unrelated_diagnostic", () => {
    const site = scan(`try { work(); } catch (error) {
      logger.error(error);
      contractFail('op', 'FAILED', 'Failed', {diagnostic:errorDiagnostic('literal', {operation:'op'})});
    }`)[0];
    expect(site?.bindingUsed).toBe(true);
    expect(site?.violation).toBe("cause-not-forwarded-at-surface");
  });

  it("requires_the_caught_cause_in_the_diagnostic_argument_not_message_or_options", () => {
    expect(
      scan(`try {} catch (error) {
      contractFail('op','FAILED',String(error), {
        asJson:Boolean(error), diagnostic:errorDiagnostic('literal',{operation:String(error)})
      });
    }`)[0]?.violation,
    ).toBe("cause-not-forwarded-at-surface");
    expect(
      scan(`try {} catch (error) {
      throw new ContractError('op','FAILED',String(error),1,errorDiagnostic('literal'));
    }`)[0]?.violation,
    ).toBe("cause-not-forwarded-at-surface");
  });

  it("passes_local_aliases_that_forward_the_caught_diagnostic", () => {
    expect(
      scan(`try {} catch (error) {
      const diagnostic = errorDiagnostic(error, {operation:'op'});
      const options = {diagnostic};
      contractFail('op','FAILED','Failed',options);
    }`)[0]?.state,
    ).toBe("fixed");
  });

  it("rejects_raw_returned_envelopes_even_when_they_contain_the_cause", () => {
    for (const expression of ["{error}", "{success:false,cause:error}", "{ok:false,message:String(error)}"]) {
      expect(scan(`try {} catch (error) { return ${expression}; }`)[0]?.violation).toBe("surface-bypasses-constructor");
      expect(scan(`try {} catch (error) { const response = ${expression}; return response; }`)[0]?.violation).toBe(
        "surface-bypasses-constructor",
      );
    }
  });

  it("rejects_http_envelopes_and_no_cause_annotations_that_bypass_the_constructor", () => {
    const annotatedBypass = scan(`try {} catch (error) {
      // no-cause: Expected remote denial becomes a caller response
      return new Response(JSON.stringify({error:'failed'}));
    }`)[0];
    expect(annotatedBypass?.violation).toBe("surface-bypasses-constructor");
    expect(annotatedBypass?.state).toBe("triaged-follow-up");
    expect(scan(`try {} catch (error) { response.json({success:false,error}); }`)[0]?.violation).toBe(
      "surface-bypasses-constructor",
    );
  });

  it("does_not_treat_logging_metadata_as_a_manufactured_response", () => {
    expect(
      scan(`try {} catch (error) {
      logger.error({error});
      contractFail('op','FAILED','Failed',{diagnostic:errorDiagnostic(error)});
    }`)[0]?.state,
    ).toBe("fixed");
  });

  it("enumerates_dynamic_rejection_handlers_instead_of_silently_skipping_them", () => {
    expect(scan("work().catch(handleFailure);")[0]).toMatchObject({
      kind: "rejection",
      violation: "rejection-without-binding",
    });
  });

  it("ignores_test_and_fixture_sources_but_enumerates_all_production_handlers", () => {
    const text = "try {} catch {}";
    expect(
      scanSources([
        { file: "src/foo.test.ts", text },
        { file: "src/__tests__/foo.ts", text },
        { file: "src/test/foo.ts", text },
        { file: "src/foo.ts", text },
      ]),
    ).toHaveLength(1);
  });

  it("keeps_fingerprint_stable_across_line_and_comment_changes", () => {
    const original = scan("function run() { try { work(); } catch { fail('lost'); } }");
    const shifted = scan(
      "\n\n// file comment\nfunction run() { try { work(); } catch { /* explanation */ fail('lost'); } }",
    );
    expect(original[0]?.id).toBe(shifted[0]?.id);
  });

  it("ratchet_rejects_allowlist_additions_and_count_increases", () => {
    const sites = scan("try {} catch {} ");
    const frozen = makeBaseline(sites);
    expect(validateAllowlist(sites, frozen, frozen)).toEqual([]);
    const newSites = scan("try {} catch {}\ntry {} catch { fail('new'); }");
    expect(
      validateAllowlist(newSites, makeBaseline(newSites), frozen).some((message) =>
        message.includes("addition forbidden"),
      ),
    ).toBe(true);
    const repeated = scan("try {} catch {}\ntry {} catch {}");
    expect(
      validateAllowlist(repeated, makeBaseline(repeated), frozen).some((message) => message.includes("count increase")),
    ).toBe(true);
  });

  it("ratchet_requires_fix_before_removal_and_rejects_reintroductions", () => {
    const sites = scan("try {} catch {} ");
    const frozen = makeBaseline(sites);
    const empty = makeBaseline([]);
    expect(validateAllowlist(sites, empty, frozen).some((message) => message.includes("Unlisted"))).toBe(true);
    expect(validateAllowlist([], empty, frozen, frozen)).toEqual([]);
    expect(
      validateAllowlist(sites, frozen, frozen, empty).some((message) => message.includes("addition forbidden")),
    ).toBe(true);
    expect(validateAllowlist([], frozen, frozen).some((message) => message.includes("Stale allowance"))).toBe(true);
  });

  it("ratchet_rejects_metadata_and_total_tampering", () => {
    const sites = scan("try {} catch {} ");
    const frozen = makeBaseline(sites);
    const altered = structuredClone(frozen);
    altered.totals.violations = 0;
    expect(validateAllowlist(sites, altered, frozen)).toContain("Allowlist totals do not match current violations");
    altered.baselineCommit = "wrong";
    expect(validateAllowlist(sites, altered, frozen)).toContain("Invalid baseline identity/version");
    expect(frozen.baselineCommit).toBe(BASELINE_COMMIT);
  });

  it("coverage_harness_rejects_missing_boundary_row", () => {
    const sites = scanSources([
      { file: "src/cli/commands/media.ts", text: "try{}catch(e){fail('x')}" },
      { file: "src/transcribe/openai.ts", text: "try{}catch(e){throw e}" },
    ]);
    expect(checkSurfaceCoverage(sites, ["media-send"])).toEqual(["transcription"]);
    expect(checkSurfaceCoverage(sites, ["media-send", "transcription"])).toEqual([]);
  });

  it("inventory_has_a_row_for_every_site_and_public_totals", () => {
    const sites = scan("try {} catch {}\nwork().catch((e)=>fail(e));");
    const text = renderInventory(sites, makeBaseline(sites));
    expect(text).toContain("Total enumerated: **2**");
    for (const site of sites) expect(text).toContain(site.id);
    expect(text).toContain("triaged-follow-up");
    expect(text).toContain("fixed");
  });
});
