// Frozen optional contract. Only an owner/admin can select an installed host skill for a chat.
import { isDynamicRecord } from "../runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  nullable,
  type OptionalRouteCodec,
  oneOf,
} from "./admin-wire";
export const SKILL_MODES_CAPABILITY = "skill-modes-v1";
export const SKILL_MODES_ROUTES = { read: "/v1/admin/skill-modes/read", set: "/v1/admin/skill-modes/set" } as const;
const text =
  (maximum: number): AdminDecoder =>
  (value) => {
    if (typeof value !== "string" || !value.length || value.length > maximum)
      throw new Error("Invalid skill mode text.");
    return value;
  };
const hash: AdminDecoder = (value) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid skill mode hash.");
  return value;
};
const target = { agentId: identifier, threadId: identifier };
const selection = nullable(fields({ skillId: text(256), name: text(1024), revision: count, sha256: hash }));
const response = fields(
  {
    ...target,
    selection,
  },
  { inherited: boolean, agentDefault: selection },
);
export const SKILL_MODES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [SKILL_MODES_ROUTES.read, adminRoute(fields(target), response)],
  [
    SKILL_MODES_ROUTES.set,
    adminRoute(
      fields({ ...target, skillId: nullable(text(256)) }, { scope: oneOf("chat", "agent", "inherit") }),
      response,
    ),
  ],
]);
export type SkillModeEvent = { type: "skill-mode-changed"; agentId: string; threadId: string };
export function skillModeEvent(value: unknown): SkillModeEvent | null {
  if (!isDynamicRecord(value) || value.type !== "skill-mode-changed") return null;
  const agentId = identifier(value.agentId);
  const threadId = identifier(value.threadId);
  if (typeof agentId !== "string" || typeof threadId !== "string") throw new Error("Invalid skill mode event.");
  return { type: "skill-mode-changed", agentId, threadId };
}
