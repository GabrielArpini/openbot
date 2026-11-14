import type { InstalledSkill } from "@openbot/contracts/ipc";
import type { SetSkillModeInput, SkillModeState, SkillModeTarget } from "@openbot/contracts/ipc-skill-mode";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createStore, Show } from "solid-js";
import { serverCanAdminister } from "../servers/server-capabilities";
import { conversationPort } from "./conversation-port";
import type { ConversationRuntime } from "./conversation-runtime";
import type { ConversationProps } from "./conversation-types";

export interface SkillModeCalls {
  subscribe?: (listener: (threadId: string) => void) => () => void;
  read(input: SkillModeTarget): Promise<SkillModeState>;
  set(input: SetSkillModeInput): Promise<SkillModeState>;
}
/** The host owns the selection. Switching chats discards all stale reads and saves. */
export function SkillModeControl(props: {
  target: SkillModeTarget;
  skills: readonly InstalledSkill[];
  api: SkillModeCalls;
}) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{ data: SkillModeState | null; busy: boolean; error: string | null }>({
    data: null,
    busy: false,
    error: null,
  });
  let generation = 0;
  let operation = 0;
  createEffect(
    () => [props.target.agentId, props.target.threadId, props.api] as const,
    ([agentId, threadId, api]) => {
      const current = ++generation;
      setState(() => ({ data: null, busy: true, error: null }));
      const refresh = () => {
        const request = ++operation;
        void api
          .read({ agentId, threadId })
          .then((data) => {
            if (current === generation && request === operation) setState(() => ({ data, busy: false, error: null }));
          })
          .catch((error) => {
            if (current === generation && request === operation)
              setState((s) => {
                s.busy = false;
                s.error = errorMessage(error, t("skill.mode.failed"));
              });
          });
      };
      refresh();
      const unsubscribe = api.subscribe?.((changed) => {
        if (changed === threadId) refresh();
      });
      return () => {
        generation++;
        unsubscribe?.();
      };
    },
  );
  const choices = () =>
    props.skills.filter((skill) => skill.enabled !== false && skill.state === "installed" && !skill.problem);
  const label = (id: string) =>
    choices().find((skill) => skill.skillId === id)?.name ?? state.data?.selection?.name ?? id;
  async function change(skillId: string | null, scope: SetSkillModeInput["scope"] = "chat") {
    const current = generation;
    const request = ++operation;
    setState((s) => {
      s.busy = true;
      s.error = null;
    });
    try {
      const data = await props.api.set({ ...props.target, skillId, scope });
      if (current === generation && request === operation) setState(() => ({ data, busy: false, error: null }));
    } catch (error) {
      if (current === generation && request === operation)
        setState((s) => {
          s.busy = false;
          s.error = errorMessage(error, t("skill.mode.failed"));
        });
    }
  }
  return (
    <div class="agent-session-setting">
      <Select<string>
        options={choices().map((skill) => skill.skillId)}
        value={state.data?.selection?.skillId ?? null}
        disabled={state.busy}
        onChange={(id) => {
          if (id) void change(id);
        }}
        itemComponent={(item) => <SelectItem item={item.item}>{label(item.item.rawValue)}</SelectItem>}
      >
        <SelectTrigger aria-label={t("skill.mode.label")} title={t("skill.mode.help")}>
          <SelectValue<string>>
            {() =>
              state.data?.selection ? `${t("skill.mode.label")}: ${state.data.selection.name}` : t("skill.mode.off")
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
      <Show when={state.data?.inherited}>
        <Text>{t("skill.mode.inherited")}</Text>
      </Show>
      <Button disabled={state.busy || state.data?.inherited} onClick={() => void change(null, "inherit")}>
        {t("skill.mode.inherit")}
      </Button>
      <Show when={state.data?.selection}>
        <Button disabled={state.busy} onClick={() => void change(state.data?.selection?.skillId ?? null, "agent")}>
          {t("skill.mode.makeDefault")}
        </Button>
      </Show>
      <Show when={state.data?.agentDefault}>
        <Button disabled={state.busy} onClick={() => void change(null, "agent")}>
          {t("skill.mode.clearDefault")}
        </Button>
      </Show>
      <Show when={state.data?.inherited || state.data?.selection || state.error}>
        <Button disabled={state.busy} onClick={() => void change(null)}>
          {t("skill.mode.off")}
        </Button>
      </Show>
      <Show when={state.error}>
        <Text>{state.error}</Text>
      </Show>
    </div>
  );
}

/** Shared connection adapter for main, task and side chat composers. */
export function ConversationSkillMode(props: {
  target: SkillModeTarget | null;
  skills: readonly InstalledSkill[];
  server: ConversationProps["server"];
  runtime?: ConversationRuntime | undefined;
}) {
  const api = createMemo((): SkillModeCalls => {
    const runtime = props.runtime;
    const serverId = props.server?.id;
    return {
      read: (input) =>
        runtime ? runtime.agent.readSkillMode(input) : conversationPort().agent.readSkillMode(input, serverId),
      set: (input) =>
        runtime ? runtime.agent.setSkillMode(input) : conversationPort().agent.setSkillMode(input, serverId),
      subscribe: (listener) =>
        runtime
          ? (runtime.onSkillModeChanged?.(listener) ?? (() => {}))
          : conversationPort().agent.onScopedEvent((scoped) => {
              if (scoped.serverId === serverId && scoped.event.type === "skill-mode-changed")
                listener(scoped.event.threadId);
            }),
    };
  });
  return (
    <Show when={serverCanAdminister(props.server, "skill-modes-v1") && props.target}>
      {(target) => <SkillModeControl target={target()} skills={props.skills} api={api()} />}
    </Show>
  );
}
