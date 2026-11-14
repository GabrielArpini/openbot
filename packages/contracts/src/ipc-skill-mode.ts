import { isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord } from "./runtime-values";

/** The budget includes the complete resolved body and its provider instruction wrapper. */
export const SKILL_MODE_MAX_CHARACTERS = 32_000;
export interface SkillModeTarget {
  agentId: string;
  threadId: string;
}
export interface SetSkillModeInput extends SkillModeTarget {
  skillId: string | null;
  scope?: "chat" | "agent" | "inherit";
}
export interface SkillModeSelection {
  skillId: string;
  name: string;
  revision: number;
  sha256: string;
}
export interface SkillModeState extends SkillModeTarget {
  selection: SkillModeSelection | null;
  inherited?: boolean;
  agentDefault?: SkillModeSelection | null;
}
export function parseSkillModeTarget(value: unknown): SkillModeTarget {
  if (!isDynamicRecord(value) || !isIdentifier(value.agentId) || !isIdentifier(value.threadId))
    throw new Error("Invalid skill mode target.");
  return { agentId: value.agentId, threadId: value.threadId };
}
export function parseSetSkillMode(value: unknown): SetSkillModeInput {
  const target = parseSkillModeTarget(value);
  if (
    !isDynamicRecord(value) ||
    !(
      value.skillId === null ||
      (typeof value.skillId === "string" && value.skillId.length > 0 && value.skillId.length <= 256)
    )
  )
    throw new Error("Invalid skill mode selection.");
  if (value.scope !== undefined && value.scope !== "chat" && value.scope !== "agent" && value.scope !== "inherit")
    throw new Error("Invalid skill mode scope.");
  if (value.scope === "inherit" && value.skillId !== null) throw new Error("Invalid inherited skill mode.");
  return {
    ...target,
    skillId: value.skillId,
    ...(value.scope === undefined ? {} : { scope: value.scope }),
  };
}
export function decodeSkillModeSelection(value: unknown): SkillModeSelection | null {
  if (value === null) return null;
  if (
    !isDynamicRecord(value) ||
    typeof value.skillId !== "string" ||
    !value.skillId ||
    value.skillId.length > 256 ||
    typeof value.name !== "string" ||
    !value.name ||
    value.name.length > 1024 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== "number" ||
    value.revision < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    throw new Error("Invalid skill mode selection.");
  return { skillId: value.skillId, name: value.name, revision: value.revision, sha256: value.sha256 };
}
export function decodeSkillModeState(value: unknown): SkillModeState {
  const target = parseSkillModeTarget(value);
  if (!isDynamicRecord(value)) throw new Error("Invalid skill mode state.");
  if (value.inherited !== undefined && typeof value.inherited !== "boolean")
    throw new Error("Invalid skill mode inheritance.");
  return {
    ...target,
    selection: decodeSkillModeSelection(value.selection),
    ...(value.inherited === undefined ? {} : { inherited: value.inherited }),
    ...(value.agentDefault === undefined ? {} : { agentDefault: decodeSkillModeSelection(value.agentDefault) }),
  };
}
