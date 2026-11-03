import { notFound } from "next/navigation";

import { getConsoleAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  assertPlatformOperator,
  isPlatformOperator,
  platformOperatorPageOutcome,
} from "@/server/console/platform-operator";
import { getConsoleUserFromAuth } from "@/server/console/workspace";

export { platformOperatorPageOutcome };

export async function requirePlatformOperatorPage() {
  const auth = await getConsoleAuthState();
  const user = await getConsoleUserFromAuth(auth);
  if (platformOperatorPageOutcome(await isPlatformOperator(user)) === "not_found") notFound();
  return { auth, user };
}

export async function requirePlatformOperatorApi(auth: Parameters<typeof getConsoleUserFromAuth>[0]) {
  const user = await getConsoleUserFromAuth(auth);
  try {
    await assertPlatformOperator(user);
  } catch (error) {
    if (error instanceof ConsoleApiError) throw error;
    throw error;
  }
  return user;
}
