import { ConsoleApiError } from "@/server/console/api-error";
import { pagesSessionActorKind } from "@/server/console/pages/auth";
import {
  normalizeViewerAssertionAudience,
  originMatchesRequestHost,
} from "@/server/console/pages/viewer-assertions/audience";
import { signViewerAssertion, VIEWER_ASSERTION_ACTOR } from "@/server/console/pages/viewer-assertions/jwt";

export type ViewerAssertionAudienceMatch = {
  origins: string[];
};

export async function mintHumanViewerAssertion(input: {
  audience: string;
  env?: NodeJS.ProcessEnv;
  findAudience: (audience: string) => Promise<ViewerAssertionAudienceMatch | null>;
  now?: Date;
  origin: string | null;
  requestHost: string;
  session: {
    issuedFromClaimCodeId: string | null;
    metadataJson: Record<string, unknown>;
    userId: string;
  };
  site: {
    id: string;
    organizationId: string;
    projectId: string;
  };
}) {
  if (pagesSessionActorKind(input.session) !== "human_viewer") {
    throw new ConsoleApiError(403, { error: "viewer_assertion_actor_forbidden" });
  }

  const audience = normalizeViewerAssertionAudience(input.audience);
  const origin = input.origin?.trim() ?? "";
  if (!origin || !originMatchesRequestHost(origin, input.requestHost)) {
    throw new ConsoleApiError(403, { error: "viewer_assertion_origin_forbidden" });
  }

  const registered = await input.findAudience(audience);
  const normalizedOrigin = new URL(origin).origin;
  if (!registered || !registered.origins.includes(normalizedOrigin)) {
    throw new ConsoleApiError(
      403,
      registered
        ? { error: "viewer_assertion_origin_forbidden" }
        : { error: "viewer_assertion_audience_unknown" },
    );
  }

  const signed = await signViewerAssertion({
    audience,
    env: input.env,
    now: input.now,
    projectId: input.site.projectId,
    raviOrgId: input.site.organizationId,
    raviUserId: input.session.userId,
    siteId: input.site.id,
  });

  return {
    auditMetadata: {
      actor: VIEWER_ASSERTION_ACTOR,
      audience,
      expiresAt: signed.expiresAt,
      jti: signed.jti,
      kid: signed.kid,
    },
    output: {
      token: signed.token,
    },
  };
}
