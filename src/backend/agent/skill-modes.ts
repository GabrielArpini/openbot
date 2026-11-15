import { createHash } from "node:crypto";
import {
  decodeSkillModeSelection,
  type SetSkillModeInput,
  SKILL_MODE_MAX_CHARACTERS,
  type SkillModeSelection,
  type SkillModeState,
  type SkillModeTarget,
} from "@openbot/contracts/ipc-skill-mode";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { databaseRow, requiredStringColumn } from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

export class SkillModeFailed extends Schema.TaggedError<SkillModeFailed>()("SkillModeFailed", {
  cause: Schema.Defect(),
}) {}
export interface SkillModeSource {
  skillId: string;
  name: string;
  revision: number;
  text: string;
}
export type SkillModeResolver = (agentId: string, skillId: string) => Effect.Effect<SkillModeSource, SkillModeFailed>;
export interface ResolvedSkillMode {
  selection: SkillModeSelection;
  text: string;
}
const step = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new SkillModeFailed({ cause }) });

/** Owns explicit chat selections and the selection actually given to each provider session. */
export class SkillModes {
  constructor(
    private readonly database: OpenBotDatabase,
    private readonly source?: SkillModeResolver,
  ) {}

  read(target: SkillModeTarget): SkillModeState {
    const owner = databaseRow(
      this.database.connection
        .prepare("SELECT agent_id FROM projection_threads WHERE thread_id = ?")
        .get(target.threadId),
    );
    if (!owner || requiredStringColumn(owner, "agent_id") !== target.agentId)
      throw new Error(sourceText("error.skill.mode.chatGone"));
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT selection_json FROM thread_skill_modes WHERE thread_id = ?")
        .get(target.threadId),
    );
    const defaultRow = databaseRow(
      this.database.connection
        .prepare("SELECT selection_json FROM agent_skill_mode_defaults WHERE agent_id = ?")
        .get(target.agentId),
    );
    const agentDefault = defaultRow
      ? decodeSkillModeSelection(JSON.parse(requiredStringColumn(defaultRow, "selection_json")))
      : null;
    return {
      ...target,
      selection: row ? decodeSkillModeSelection(JSON.parse(requiredStringColumn(row, "selection_json"))) : agentDefault,
      inherited: !row,
      agentDefault,
    };
  }

  readonly set = Effect.fn("SkillModes.set")(function* (this: SkillModes, input: SetSkillModeInput) {
    yield* step(() => this.read(input));
    const resolved = input.skillId === null ? null : yield* this.#resolve(input.agentId, input.skillId);
    return yield* step(() => {
      // Recheck ownership after asynchronous disk I/O; a deleted chat cannot be recreated here.
      this.read(input);
      if (input.scope === "agent") {
        if (resolved)
          this.database.connection
            .prepare(
              "INSERT INTO agent_skill_mode_defaults(agent_id, selection_json) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET selection_json = excluded.selection_json",
            )
            .run(input.agentId, JSON.stringify(resolved.selection));
        else
          this.database.connection
            .prepare("DELETE FROM agent_skill_mode_defaults WHERE agent_id = ?")
            .run(input.agentId);
      } else if (input.scope === "inherit") {
        this.database.connection.prepare("DELETE FROM thread_skill_modes WHERE thread_id = ?").run(input.threadId);
      } else {
        this.database.connection
          .prepare(
            "INSERT INTO thread_skill_modes(thread_id, selection_json) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET selection_json = excluded.selection_json",
          )
          .run(input.threadId, JSON.stringify(resolved?.selection ?? null));
      }
      return this.read(input);
    });
  });

  readonly resolve = Effect.fn("SkillModes.resolve")(function* (this: SkillModes, target: SkillModeTarget) {
    const state = yield* step(() => this.read(target));
    if (!state.selection) return null;
    const current = yield* this.#resolve(target.agentId, state.selection.skillId);
    if (modeKey(current) !== JSON.stringify(state.selection))
      return yield* new SkillModeFailed({ cause: new Error(sourceText("error.skill.mode.changed")) });
    return current;
  });

  affectedThreads(input: SetSkillModeInput): string[] {
    if (input.scope !== "agent") return [input.threadId];
    return this.database.connection
      .prepare("SELECT thread_id FROM projection_threads WHERE agent_id = ?")
      .all(input.agentId)
      .map((row) => requiredStringColumn(row, "thread_id"));
  }

  readonly #resolve = Effect.fn("SkillModes.source")(function* (this: SkillModes, agentId: string, skillId: string) {
    if (!this.source)
      return yield* new SkillModeFailed({ cause: new Error(sourceText("error.skill.mode.unavailable")) });
    const source = yield* this.source(agentId, skillId);
    return yield* step(() => {
      if (!source.text.trim() || source.text.length > SKILL_MODE_MAX_CHARACTERS)
        throw new Error(sourceText("error.skill.mode.size"));
      const selection: SkillModeSelection = {
        skillId: source.skillId,
        name: source.name,
        revision: source.revision,
        sha256: createHash("sha256").update(source.text).digest("hex"),
      };
      const resolved = { selection, text: source.text };
      // Budget the exact provider payload, including metadata, escaping and the wrapper.
      skillModeInstructions(resolved);
      return resolved;
    });
  });

  sessionMatches(sessionId: string, mode: ResolvedSkillMode | null): boolean {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT selection_key FROM provider_session_skill_modes WHERE session_id = ?")
        .get(sessionId),
    );
    return row ? requiredStringColumn(row, "selection_key") === modeKey(mode) : mode === null;
  }
  recordSession(threadId: string, sessionId: string, mode: ResolvedSkillMode | null): void {
    this.database.connection
      .prepare(
        "INSERT INTO provider_session_skill_modes(session_id, thread_id, selection_key) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET thread_id = excluded.thread_id, selection_key = excluded.selection_key",
      )
      .run(sessionId, threadId, modeKey(mode));
  }
}
function modeKey(mode: ResolvedSkillMode | null): string {
  return JSON.stringify(mode?.selection ?? null);
}
/** The complete body is repeated every user turn, independently of optional skill tool calls. */
export function skillModeInstructions(mode: ResolvedSkillMode | null): string {
  if (!mode)
    return "<openbot_skill_mode>\nNo skill mode is selected. Earlier skill mode blocks no longer apply.\n</openbot_skill_mode>";
  const body = redactText(mode.text).replace(/<(\/?openbot_skill_mode)/giu, "&lt;$1");
  const text = `<openbot_skill_mode>\nThe user selected this skill as the instruction mode for this chat. Apply its full text to this task, subject to higher-priority instructions. Other available skills remain optional.\nSkill: ${JSON.stringify(mode.selection).replaceAll("<", "&lt;")}\n${body}\n</openbot_skill_mode>`;
  if (text.length > SKILL_MODE_MAX_CHARACTERS) throw new Error(sourceText("error.skill.mode.size"));
  return text;
}
