import type { AgentTask, InstalledSkill } from "@openbot/contracts/ipc";
import type { SkillModeSelection, SkillModeState } from "@openbot/contracts/ipc-skill-mode";
import { Button } from "@openbot/ui";
import { AgentThreadView } from "@openbot/ui/features/conversation/threads/AgentThreadView";
import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createConversationController } from "../src/features/conversation/Conversation";
import { ConversationComposer } from "../src/features/conversation/ConversationComposer";
import {
  ConversationControllerProvider,
  useConversationController,
} from "../src/features/conversation/conversation-controller-context";
import { composerDraftKey } from "../src/features/conversation/conversation-keys";
import {
  ConversationViewScopeContext,
  createConversationViewScope,
} from "../src/features/conversation/conversation-scope";
import { type SkillModeCalls, SkillModeControl } from "../src/features/conversation/SkillModeControl";
import { CONVERSATION_STORY_ARGS, StoryAppProviders, StoryConversation } from "./conversation-story-support";
import { STORY_AGENT, STORY_AGENTS } from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const skills: InstalledSkill[] = ["Review", "A deliberately long skill name for a narrow message toolbar"].map(
  (name, index): InstalledSkill => ({
    skillId: `composer-story-skill-${index}`,
    slug: `composer-story-skill-${index}`,
    name,
    installedVersion: 1,
    availableVersion: 1,
    state: "installed",
    enabled: true,
  }),
);
const task: AgentTask = {
  id: "skill-pill-story",
  threadId: "skill-pill-story",
  agentId: STORY_AGENT.id,
  origin: "user",
  title: "Skill pill layout",
  state: "idle",
  outcome: "completed",
  hold: null,
  activeTurnId: null,
  progress: null,
  error: null,
  queuedMessages: [],
  createdAt: "2026-11-18T12:00:00.000Z",
  updatedAt: "2026-11-18T12:00:00.000Z",
  closedAt: null,
};

function selection(id: string | null): SkillModeSelection | null {
  const skill = skills.find((item) => item.skillId === id);
  return skill ? { skillId: skill.skillId, name: skill.name, revision: 1, sha256: "0".repeat(64) } : null;
}

function SkillModeComposerStory(props: {
  selected: string | null;
  width: number;
  expanded?: boolean;
  request?: "loading" | "error";
  switchable?: boolean;
}) {
  const [draft, setDraft] = createSignal(props.expanded ? "Review this change.\nKeep the reply short." : "");
  const [threadId, setThreadId] = createSignal(task.threadId);
  const initial: SkillModeState = {
    agentId: STORY_AGENT.id,
    threadId: task.threadId,
    selection: selection(props.selected),
    inherited: false,
    agentDefault: null,
  };
  const states = new Map<string, SkillModeState>([
    [task.threadId, initial],
    ["other-story-chat", { ...initial, threadId: "other-story-chat", selection: null }],
  ]);
  const api: SkillModeCalls = {
    read: async (input) => {
      if (props.request === "loading") return new Promise<SkillModeState>(() => {});
      if (props.request === "error") throw new Error("Example: the skill selection could not be loaded.");
      return states.get(input.threadId) ?? initial;
    },
    set: async (input) => {
      let state = states.get(input.threadId) ?? initial;
      if (input.scope === "agent") {
        const agentDefault = selection(input.skillId);
        state = { ...state, agentDefault, ...(state.inherited ? { selection: agentDefault } : {}) };
      } else if (input.scope === "inherit") {
        state = { ...state, inherited: true, selection: state.agentDefault ?? null };
      } else {
        state = { ...state, inherited: false, selection: selection(input.skillId) };
      }
      states.set(input.threadId, state);
      return state;
    },
  };
  return (
    <div style={{ width: `${props.width}px`, height: "480px", "max-width": "100%" }}>
      <Show when={props.switchable}>
        <Button onClick={() => setThreadId(threadId() === task.threadId ? "other-story-chat" : task.threadId)}>
          {threadId() === task.threadId ? "Open other example chat" : "Return to first example chat"}
        </Button>
      </Show>
      <AgentThreadView
        task={task}
        limit={2}
        agent={STORY_AGENT}
        agents={STORY_AGENTS}
        messages={[]}
        skills={skills}
        draft={draft()}
        onDraftChange={setDraft}
        onSend={async () => {
          setDraft("");
          return true;
        }}
        onStop={fn()}
        voice={{
          phase: "idle",
          blocked: false,
          liveText: "",
          levels: [],
          elapsedSeconds: 0,
          modelProgress: null,
          onStart: fn(),
          onCancel: fn(),
          onFinish: fn(),
          onSend: fn(),
        }}
        onOpenLink={fn()}
        onPreview={fn()}
        onAttachmentAction={fn()}
        onRespondApproval={async () => true}
        context={{ usedTokens: 3000, windowTokens: 100000, autoCompactAt: null, compacting: false }}
        modeControl={
          <SkillModeControl target={{ agentId: STORY_AGENT.id, threadId: threadId() }} skills={skills} api={api} />
        }
      />
    </div>
  );
}

const meta = {
  title: "Conversation/Skill mode composer",
  parameters: { layout: "centered" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ShortName: Story = {
  render: () => <SkillModeComposerStory selected="composer-story-skill-0" width={480} />,
};
export const LongNameNarrow: Story = {
  render: () => <SkillModeComposerStory selected="composer-story-skill-1" width={300} />,
};
export const Off: Story = { render: () => <SkillModeComposerStory selected={null} width={300} /> };
export const Expanded: Story = {
  render: () => <SkillModeComposerStory selected="composer-story-skill-1" width={480} expanded />,
};

export const Loading: Story = {
  render: () => <SkillModeComposerStory selected={null} width={300} request="loading" />,
};
export const ReadError: Story = {
  render: () => <SkillModeComposerStory selected={null} width={300} request="error" />,
};

export const MainConversation: Story = {
  render: () => (
    <div style={{ width: "480px", height: "600px", "max-width": "100%" }}>
      <StoryConversation messages={[]} />
    </div>
  ),
};

export const ChatSwitching: Story = {
  render: () => <SkillModeComposerStory selected="composer-story-skill-0" width={480} switchable />,
};

function UploadComposer() {
  const controller = useConversationController();
  const mock = createMockOpenBot();
  const previous = window.openbot;
  window.openbot = mock.api;
  onCleanup(() => {
    window.openbot = previous;
    mock.dispose();
  });
  const props = {
    ...CONVERSATION_STORY_ARGS,
    messages: [],
    runtime: {
      agent: mock.api.agent,
      browser: mock.api.browser,
      voice: mock.api.voice,
      openUrl: mock.api.openUrl,
      cancelImportFiles: async () => {
        controller.setImportingDrafts(new Set<string>());
      },
    },
  };
  const scope = createConversationViewScope(props);
  onSettled(() => {
    const agent = props.agent;
    if (agent)
      controller.setImportingDrafts(
        new Set([composerDraftKey({ agentId: agent.id, serverId: props.server?.id ?? "local" })]),
      );
  });
  return (
    <ConversationViewScopeContext value={scope}>
      <ConversationComposer />
    </ConversationViewScopeContext>
  );
}

export const UploadCancellation: Story = {
  render: () => (
    <div style={{ width: "300px", "max-width": "100%" }}>
      <StoryAppProviders>
        <ConversationControllerProvider
          controller={createConversationController({ onTypingChange: CONVERSATION_STORY_ARGS.onTypingChange })}
        >
          <UploadComposer />
        </ConversationControllerProvider>
      </StoryAppProviders>
    </div>
  ),
};
