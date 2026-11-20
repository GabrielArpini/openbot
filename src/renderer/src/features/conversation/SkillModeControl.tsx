import type { InstalledSkill } from "@openbot/contracts/ipc";
import type { SetSkillModeInput, SkillModeState, SkillModeTarget } from "@openbot/contracts/ipc-skill-mode";
import { Button, Check, CircleAlert, DropdownMenu, Text, Tooltip } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, For, Show } from "solid-js";
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
  const [overlay, setOverlay] = createSignal<"closed" | "hover" | "touch" | "menu">("closed");
  let touchActivation: "touch" | "menu" | null = null;
  let pill: HTMLDivElement | undefined;
  createEffect(
    () => overlay(),
    (phase) => {
      if (phase !== "touch") return;
      const dismissOutside = (event: PointerEvent) => {
        if (event.target instanceof Node && !pill?.contains(event.target)) {
          touchActivation = null;
          setOverlay("closed");
        }
      };
      const dismissEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape" || event.key === "Tab") {
          touchActivation = null;
          setOverlay("closed");
        }
      };
      document.addEventListener("pointerdown", dismissOutside);
      document.addEventListener("keydown", dismissEscape);
      return () => {
        document.removeEventListener("pointerdown", dismissOutside);
        document.removeEventListener("keydown", dismissEscape);
      };
    },
  );
  let generation = 0;
  let operation = 0;
  createEffect(
    () => [props.target.agentId, props.target.threadId, props.api] as const,
    ([agentId, threadId, api]) => {
      const current = ++generation;
      setOverlay("closed");
      touchActivation = null;
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
  const label = () =>
    state.data?.selection?.name ?? (state.busy && !state.data ? t("common.loading") : t("skill.mode.off"));
  const description = () => `${t("skill.mode.label")}: ${label()}${state.error ? `. ${state.error}` : ""}`;
  async function change(skillId: string | null, scope: SetSkillModeInput["scope"] = "chat") {
    const current = generation;
    const request = ++operation;
    touchActivation = null;
    setOverlay("closed");
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
    <div ref={pill} class="composer-skill-mode" data-selected={state.data?.selection ? "" : undefined}>
      <DropdownMenu.Root
        open={overlay() === "menu"}
        onOpenChange={(next) => {
          if (next) {
            setOverlay(touchActivation ?? "menu");
          } else if (overlay() === "menu") {
            touchActivation = null;
            setOverlay("closed");
          }
        }}
        placement="top-start"
        gutter={8}
        modal={false}
      >
        <Tooltip.Root
          open={overlay() === "hover" || overlay() === "touch"}
          onOpenChange={(next) => {
            // Solid flushes the next overlay after this click; keep its touch intent through the tooltip hide callback.
            if (overlay() !== "menu" && overlay() !== "touch" && touchActivation !== "touch")
              setOverlay(next ? "hover" : "closed");
          }}
          placement="top-start"
          getAnchorRect={() => pill?.getBoundingClientRect()}
          gutter={8}
          openDelay={250}
          closeDelay={75}
        >
          <DropdownMenu.Trigger
            as={Tooltip.Trigger}
            class="composer-skill-mode-trigger"
            aria-label={description()}
            aria-busy={state.busy}
            onPointerDown={(event) => {
              touchActivation = event.pointerType === "touch" ? (overlay() === "touch" ? "menu" : "touch") : null;
            }}
            onKeyDown={() => {
              touchActivation = null;
            }}
          >
            <Show
              when={state.error}
              fallback={
                <Show when={state.data?.selection}>
                  <span aria-hidden="true">◆</span>
                </Show>
              }
            >
              <CircleAlert aria-hidden="true" />
            </Show>
            <span class="composer-skill-mode-label">
              {state.data?.selection || state.busy ? label() : <>◇ {t("chat.reference.kind.skill")}</>}
            </span>
          </DropdownMenu.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="composer-skill-mode-tooltip">
              <span>{label()}</span>
              <small>{overlay() === "touch" ? t("skill.mode.tapHint") : t("skill.mode.chatHint")}</small>
              <Show when={state.error}>
                <span role="alert">{state.error}</span>
              </Show>
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <Show when={state.data?.selection}>
          <Button
            class="composer-skill-mode-clear"
            variant="ghost"
            aria-label={t("skill.mode.off")}
            disabled={state.busy}
            onClick={() => void change(null)}
          >
            <span aria-hidden="true">✕</span>
          </Button>
        </Show>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="composer-skill-mode-menu" aria-label={t("skill.mode.label")}>
            <div class="composer-skill-mode-summary">
              <Text class="composer-skill-mode-name">{label()}</Text>
              <Show when={state.data?.inherited}>
                <Text>{t("skill.mode.inherited")}</Text>
              </Show>
              <Show when={state.busy}>
                <Text role="status">{t("common.loading")}</Text>
              </Show>
              <Show when={state.error}>
                <Text role="alert">{state.error}</Text>
              </Show>
            </div>
            <DropdownMenu.Separator />
            <DropdownMenu.RadioGroup
              aria-label={t("skill.mode.label")}
              value={state.data?.selection?.skillId ?? ""}
              onChange={(id) => {
                if (id && !state.busy) void change(id);
              }}
            >
              <For each={choices()}>
                {(skill) => (
                  <DropdownMenu.RadioItem value={skill.skillId} disabled={state.busy} closeOnSelect>
                    <span class="composer-skill-mode-check">
                      <Show when={state.data?.selection?.skillId === skill.skillId}>
                        <Check aria-hidden="true" />
                      </Show>
                    </span>
                    <span class="composer-skill-mode-name">{skill.name}</span>
                  </DropdownMenu.RadioItem>
                )}
              </For>
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              disabled={state.busy || state.data?.inherited}
              onSelect={() => void change(null, "inherit")}
            >
              {t("skill.mode.inherit")}
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={state.busy} onSelect={() => void change(null)}>
              {t("skill.mode.off")}
            </DropdownMenu.Item>
            <Show when={state.data?.selection}>
              <DropdownMenu.Item
                disabled={state.busy}
                onSelect={() => void change(state.data?.selection?.skillId ?? null, "agent")}
              >
                {t("skill.mode.makeDefault")}
              </DropdownMenu.Item>
            </Show>
            <Show when={state.data?.agentDefault}>
              <DropdownMenu.Item disabled={state.busy} onSelect={() => void change(null, "agent")}>
                {t("skill.mode.clearDefault")}
              </DropdownMenu.Item>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
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
