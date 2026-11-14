import { parseSetSkillMode, parseSkillModeTarget } from "@openbot/contracts/ipc-skill-mode";
import { SKILL_MODES_CAPABILITY, SKILL_MODES_ROUTES } from "@openbot/contracts/team-protocol/skill-modes-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAdmin } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin, requireVisibleBodyAgent } from "./request-helpers";

export async function routeSkillModes(
  context: TeamApiRequestContext,
  admin: TeamApiAdmin | undefined,
  hidden: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(SKILL_MODES_ROUTES).some((path) => path === url.pathname)) return "unmatched";
  if (!admin?.skillModes || !capabilities.has(SKILL_MODES_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.agentSettingsUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  requireVisibleBodyAgent(body, hidden);
  if (url.pathname === SKILL_MODES_ROUTES.read)
    return json(200, admin.skillModes.readSkillMode(parseSkillModeTarget(body)));
  return json(200, await runCauseEffect(admin.skillModes.setSkillMode(parseSetSkillMode(body))));
}
