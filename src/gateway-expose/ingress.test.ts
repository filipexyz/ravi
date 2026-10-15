import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import {
  accessTeamName,
  buildCloudflaredArgs,
  checkRemoteConfig,
  renderCloudflaredConfig,
  type TunnelIngressTemplate,
} from "./ingress.js";

const TEMPLATE: TunnelIngressTemplate = {
  tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
  hostname: "8b1f0c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f.tun.ravi.bot",
  servicePort: 7790,
  teamName: "ravi",
  accessAud: "a".repeat(64),
};

/** What cloudflared's `/config` reports for the template (local config, version -1). */
function templateConfigBody(template: TunnelIngressTemplate = TEMPLATE, patch: (body: any) => void = () => {}) {
  const body: any = {
    version: -1,
    config: {
      ingress: [
        {
          hostname: template.hostname,
          service: `http://127.0.0.1:${template.servicePort}`,
          path: null,
          originRequest: { access: { required: true, teamName: template.teamName, audTag: [template.accessAud] } },
        },
        { hostname: "", service: "http_status:404", path: null, originRequest: {} },
      ],
      "warp-routing": { enabled: false },
      originRequest: {},
    },
  };
  patch(body);
  return body;
}

describe("cloudflared config template", () => {
  test("renders exactly the two-rule ingress with Access enforced and warp-routing off, no credentials", () => {
    const yaml = renderCloudflaredConfig(TEMPLATE);
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed).toEqual({
      tunnel: TEMPLATE.tunnelId,
      ingress: [
        {
          hostname: TEMPLATE.hostname,
          service: "http://127.0.0.1:7790",
          originRequest: { access: { required: true, teamName: "ravi", audTag: [TEMPLATE.accessAud] } },
        },
        { service: "http_status:404" },
      ],
      "warp-routing": { enabled: false },
    });
    expect(yaml).not.toMatch(/credentials|TunnelSecret|AccountTag/i);
  });

  test("a hostile value cannot add structure to the YAML", () => {
    const yaml = renderCloudflaredConfig({ ...TEMPLATE, teamName: 'x"\n  - service: http://127.0.0.1:4222' });
    const parsed = YAML.parse(yaml) as { ingress: unknown[] };
    expect(parsed.ingress).toHaveLength(2);
  });

  test("teamName is the first label of the Access team domain", () => {
    expect(accessTeamName("ravi.cloudflareaccess.com")).toBe("ravi");
  });

  test("args bind metrics to loopback and carry no secret", () => {
    const args = buildCloudflaredArgs({
      configPath: "/x/cloudflared.yml",
      metricsPort: 20241,
      tunnelId: TEMPLATE.tunnelId,
    });
    expect(args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--grace-period",
      "1s",
      "--config",
      "/x/cloudflared.yml",
      "--metrics",
      "127.0.0.1:20241",
      "run",
      TEMPLATE.tunnelId,
    ]);
    expect(() => buildCloudflaredArgs({ configPath: "/x", metricsPort: 0, tunnelId: TEMPLATE.tunnelId })).toThrow();
  });
});

describe("checkRemoteConfig (drift)", () => {
  test("the template at version -1 is not drift", () => {
    expect(checkRemoteConfig(templateConfigBody(), TEMPLATE)).toEqual({ ok: true });
    expect(
      checkRemoteConfig(
        templateConfigBody(TEMPLATE, (body) => {
          delete body.config["warp-routing"].enabled;
          body.config.ingress[1].hostname = undefined;
        }),
        TEMPLATE,
      ),
    ).toEqual({ ok: true });
  });

  const cases: Array<[string, (body: any) => void, string]> = [
    ["remote version 0", (body) => (body.version = 0), "config_version"],
    ["remote version 3", (body) => (body.version = 3), "config_version"],
    ["missing version", (body) => delete body.version, "config_version"],
    [
      "an extra rule",
      (body) => body.config.ingress.splice(1, 0, { hostname: "x.example", service: "http://127.0.0.1:4222" }),
      "ingress_mismatch",
    ],
    ["service repointed", (body) => (body.config.ingress[0].service = "http://127.0.0.1:4222"), "ingress_mismatch"],
    ["hostname changed", (body) => (body.config.ingress[0].hostname = "other.tun.ravi.bot"), "ingress_mismatch"],
    ["a path matcher", (body) => (body.config.ingress[0].path = "^/api"), "ingress_mismatch"],
    [
      "Access not required",
      (body) => (body.config.ingress[0].originRequest.access.required = false),
      "ingress_mismatch",
    ],
    ["Access removed", (body) => delete body.config.ingress[0].originRequest, "ingress_mismatch"],
    [
      "another audience",
      (body) => (body.config.ingress[0].originRequest.access.audTag = ["b".repeat(64)]),
      "ingress_mismatch",
    ],
    ["catch-all serves", (body) => (body.config.ingress[1].service = "http://127.0.0.1:22"), "ingress_mismatch"],
    ["catch-all with hostname", (body) => (body.config.ingress[1].hostname = "y.example"), "ingress_mismatch"],
    ["warp-routing on", (body) => (body.config["warp-routing"].enabled = true), "warp_routing"],
    ["no config", (body) => delete body.config, "config_unparseable"],
  ];
  for (const [name, patch, reason] of cases) {
    test(`${name} is drift (${reason})`, () => {
      expect(checkRemoteConfig(templateConfigBody(TEMPLATE, patch), TEMPLATE)).toMatchObject({ ok: false, reason });
    });
  }
});
