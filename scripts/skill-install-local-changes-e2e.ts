import { runCauseEffect } from "../src/backend/effect-boundary";
// Run: bun scripts/skill-install-local-changes-e2e.ts
// Report: .openbot-build/skill-install-local-changes-e2e.json; exit 0 = all pass.
// Drives the real local skill library and skill service in a temporary workspace (#7072).
// A copy with no unsaved edits installs the next revision: a Finder `.DS_Store`, the text before a
// save put quotes in the frontmatter, or the files of a newer saved revision than the lock.
// A copy with an edit that no revision has still refuses, and the user's replace still installs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import { zipSync } from "fflate";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { localSkillTools } from "../src/main/local-skill-tools";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";
import { readSkillModeBundle } from "../src/main/skill-mode-bundle";

const AGENT_ID = "agent-7072";
const REFUSED = sourceText("error.skill.replaceModified");

interface Context {
  workspace: string;
  library: LocalSkillLibrary;
  service: SkillMarketplaceService;
  tools: ReturnType<typeof localSkillTools>;
  skillId: string;
  slug: string;
}

function skillMarkdown(description: string, body: string): string {
  return `---\nname: Demo Skill\ndescription: ${description}\n---\n\n${body}\n`;
}

async function failure<A, E extends { cause: unknown }>(effect: Effect.Effect<A, E>): Promise<string | null> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return null;
  const cause = result.failure.cause;
  return cause instanceof Error ? cause.message : String(cause);
}

async function installedState(context: Context): Promise<string> {
  const [skill] = await Effect.runPromise(context.service.listInstalled(AGENT_ID));
  assert.ok(skill, "The agent has the skill.");
  return `${skill.state}@${skill.installedVersion}`;
}

async function writeCopies(context: Context, file: string, text: string): Promise<void> {
  for (const folder of [".agents/skills", ".claude/skills"])
    await writeFile(join(context.workspace, folder, context.slug, file), text);
}

async function reviseFrom(context: Context, expectedRevision: number, sourcePath: string): Promise<string | null> {
  return failure(context.tools.revise({ agentId: AGENT_ID, skillId: context.skillId, expectedRevision, sourcePath }));
}

const report: Array<{ name: string; passed: boolean; result?: Record<string, string | null>; error?: string }> = [];

async function scenario(name: string, run: (context: Context) => Promise<Record<string, string | null>>) {
  const root = await mkdtemp(join(tmpdir(), "openbot-skill-7072-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "source"), { recursive: true });
    const agent: AgentSummary = {
      id: AGENT_ID,
      name: "Skill Agent",
      title: "",
      description: "",
      notifications: false,
      provider: "codex",
      model: "gpt-5",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: workspace,
      preview: "",
      updatedAt: null,
      avatarSeed: AGENT_ID,
      avatarHue: null,
      avatarUrl: null,
    };
    const agents = () => [agent];
    const library = new LocalSkillLibrary(join(root, "library"), agents);
    const auth = new CentralAuthManager({
      apiUrl: "https://example.invalid",
      storagePath: join(root, "auth.json"),
      canPersist: () => false,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString("utf8"),
    });
    const service = new SkillMarketplaceService(auth, agents, () => Effect.void, library);
    const tools = localSkillTools(service);
    await writeFile(join(workspace, "source/SKILL.md"), skillMarkdown("First.", "Revision 1."));
    const created = await Effect.runPromise(tools.create({ agentId: AGENT_ID, sourcePath: "source" }));
    const result = await run({ workspace, library, service, tools, skillId: created.id, slug: created.slug });
    report.push({ name, passed: true, result });
  } catch (error) {
    report.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await scenario("A Finder file in an installed copy is not a local change", async (context) => {
  await writeFile(join(context.workspace, ".agents/skills", context.slug, ".DS_Store"), "finder");
  const before = await installedState(context);
  assert.equal(before, "installed@1");
  await writeFile(join(context.workspace, "source/SKILL.md"), skillMarkdown("First.", "Revision 2."));
  const revise = await reviseFrom(context, 1, "source");
  assert.equal(revise, null);
  const after = await installedState(context);
  assert.equal(after, "installed@2");
  return { before, revise, after };
});

await scenario("B A save from the installed copy that quotes the frontmatter installs", async (context) => {
  await writeCopies(context, "SKILL.md", skillMarkdown("Use when: the user asks.", "Revision 1."));
  const revise = await reviseFrom(context, 1, `.agents/skills/${context.slug}`);
  assert.equal(revise, null);
  const after = await installedState(context);
  assert.equal(after, "installed@2");
  return { revise, after };
});

await scenario("C A copy with a newer saved revision than the lock installs", async (context) => {
  await mkdir(join(context.workspace, "other"), { recursive: true });
  await writeFile(join(context.workspace, "other/SKILL.md"), skillMarkdown("First.", "Revision 2."));
  await Effect.runPromise(context.library.revise(AGENT_ID, context.skillId, 1, "other"));
  await writeCopies(context, "SKILL.md", skillMarkdown("First.", "Revision 2."));
  const before = await installedState(context);
  assert.equal(before, "modified@1");
  await writeFile(join(context.workspace, "source/SKILL.md"), skillMarkdown("First.", "Revision 3."));
  const revise = await reviseFrom(context, 2, "source");
  assert.equal(revise, null);
  const after = await installedState(context);
  assert.equal(after, "installed@3");
  return { before, revise, after };
});

await scenario("D An edit that no revision has still refuses, and the user's replace installs", async (context) => {
  await writeCopies(context, "SKILL.md", skillMarkdown("First.", "An edit that is not saved."));
  await writeFile(join(context.workspace, "source/SKILL.md"), skillMarkdown("First.", "Revision 2."));
  const revise = await reviseFrom(context, 1, "source");
  assert.ok(revise?.includes(REFUSED), "The edit stops the install.");
  const retry = await failure(context.tools.install({ agentId: AGENT_ID, skillId: context.skillId, revision: 2 }));
  assert.equal(retry, REFUSED);
  const replace = await failure(
    context.service.install({ agentId: AGENT_ID, skillId: context.skillId, replaceModified: true }),
  );
  assert.equal(replace, null);
  const after = await installedState(context);
  assert.equal(after, "installed@2");
  return { revise, retry, replace, after };
});

await scenario("E A folder that a save leaves out still refuses", async (context) => {
  const folder = join(context.workspace, ".agents/skills", context.slug, "node_modules");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tool.js"), "export {};\n");
  await writeFile(join(context.workspace, "source/SKILL.md"), skillMarkdown("First.", "Revision 2."));
  const revise = await reviseFrom(context, 1, "source");
  assert.ok(revise?.includes(REFUSED), "The extra folder stops the install.");
  return { revise };
});

await scenario("F A quoted frontmatter with another unsaved edit still refuses", async (context) => {
  await writeCopies(context, "SKILL.md", skillMarkdown("Use when: the user asks.", "An edit that is not saved."));
  await writeFile(join(context.workspace, "source/SKILL.md"), skillMarkdown("Use when: the user asks.", "Revision 1."));
  const revise = await reviseFrom(context, 1, "source");
  assert.ok(revise?.includes(REFUSED), "The edit stops the install.");
  return { revise };
});

await scenario("G Copies at the new revision and at another saved revision install", async (context) => {
  await mkdir(join(context.workspace, "other"), { recursive: true });
  await writeFile(join(context.workspace, "other/SKILL.md"), skillMarkdown("First.", "Revision 2."));
  await Effect.runPromise(context.library.revise(AGENT_ID, context.skillId, 1, "other"));
  const skillFile = (folder: string) => join(context.workspace, folder, context.slug, "SKILL.md");
  await writeFile(skillFile(".claude/skills"), skillMarkdown("First.", "Revision 2."));
  await writeFile(skillFile(".agents/skills"), skillMarkdown("First.", "Revision 3."));
  await writeFile(join(context.workspace, "source/SKILL.md"), skillMarkdown("First.", "Revision 3."));
  const revise = await reviseFrom(context, 2, "source");
  assert.equal(revise, null);
  const after = await installedState(context);
  assert.equal(after, "installed@3");
  return { revise, after };
});

await scenario(
  "H Mode source resolves full installed body and rejects disabled or modified copies",
  async (context) => {
    const original = await runCauseEffect(context.service.readModeSource(AGENT_ID, context.skillId));
    assert.equal(
      original.text,
      await readFile(join(context.workspace, ".agents/skills", context.slug, "SKILL.md"), "utf8"),
    );
    assert.equal(original.revision, 1);
    await Effect.runPromise(
      context.service.setEnabled({ agentId: AGENT_ID, skillId: context.skillId, enabled: false }),
    );
    assert.ok(await failure(context.service.readModeSource(AGENT_ID, context.skillId)));
    await Effect.runPromise(context.service.setEnabled({ agentId: AGENT_ID, skillId: context.skillId, enabled: true }));
    await writeCopies(context, "SKILL.md", skillMarkdown("First.", "Unregistered edit."));
    assert.ok(await failure(context.service.readModeSource(AGENT_ID, context.skillId)));
    assert.ok(await failure(context.service.readModeSource(AGENT_ID, "local-skill-missing")));
    return { fullBody: "passed", disabledRefused: "passed", modifiedRefused: "passed", missingRefused: "passed" };
  },
);

await scenario("I Declared bundle loads recursively and rejects graph or source changes", async (context) => {
  const source = join(context.workspace, "source");
  const root = await readFile(join(source, "SKILL.md"), "utf8");
  const child = `\uFEFF${skillMarkdown("Conditional method.", "UNIQUE_DEPENDENCY_BODY")}`;
  await mkdir(join(source, "method"));
  await writeFile(join(source, "method/SKILL.md"), child);
  const hash = (body: string) => createHash("sha256").update(body).digest("hex");
  const childDependencies: { path: string; when: string }[] = [];
  const manifest = {
    version: 1,
    root: "SKILL.md",
    nodes: {
      "SKILL.md": {
        sha256: hash(root),
        revision: null,
        dependencies: [
          { path: "method/SKILL.md", when: "Only for code changes" },
          { path: "method/SKILL.md", when: "Also for review" },
        ],
      },
      "method/SKILL.md": { sha256: hash(child), revision: null, dependencies: childDependencies },
    },
  };
  let revision = 1;
  const save = async () => {
    await writeFile(join(source, "mode-context.json"), JSON.stringify(manifest));
    assert.equal(await reviseFrom(context, revision++, "source"), null);
  };
  await save();
  const loaded = await runCauseEffect(context.service.readModeSource(AGENT_ID, context.skillId));
  assert.equal(loaded.text.split("UNIQUE_DEPENDENCY_BODY").length, 2, "shared body included once");
  assert.ok(loaded.text.includes("Only for code changes") && loaded.text.includes("Also for review"));
  manifest.nodes["method/SKILL.md"].dependencies.push({ path: "SKILL.md", when: "Cycle" });
  await save();
  assert.ok(await failure(context.service.readModeSource(AGENT_ID, context.skillId)), "cycle refused");
  manifest.nodes["method/SKILL.md"].dependencies = [];
  manifest.nodes["method/SKILL.md"].sha256 = "0".repeat(64);
  await save();
  assert.ok(await failure(context.service.readModeSource(AGENT_ID, context.skillId)), "hash drift refused");
  manifest.nodes["method/SKILL.md"].sha256 = hash(child);
  const firstEdge = manifest.nodes["SKILL.md"].dependencies[0];
  assert.ok(firstEdge);
  firstEdge.path = "../outside.md";
  await save();
  assert.ok(await failure(context.service.readModeSource(AGENT_ID, context.skillId)), "path escape refused");
  firstEdge.path = "missing/SKILL.md";
  await save();
  assert.ok(await failure(context.service.readModeSource(AGENT_ID, context.skillId)), "missing node refused");
  firstEdge.path = "method/SKILL.md";
  const largeChild = skillMarkdown("Conditional method.", "x".repeat(31800));
  await writeFile(join(source, "method/SKILL.md"), largeChild);
  manifest.nodes["method/SKILL.md"].sha256 = hash(largeChild);
  await save();
  assert.ok(await failure(context.service.readModeSource(AGENT_ID, context.skillId)), "aggregate overflow refused");
  await rm(join(source, "mode-context.json"));
  await symlink("absent-manifest.json", join(source, "mode-context.json"));
  assert.ok(await failure(readSkillModeBundle(source, root)), "dangling manifest is not treated as absent");
  return {
    recursiveBody: "passed",
    deduplication: "passed",
    conditions: "passed",
    cycle: "refused",
    drift: "refused",
    escape: "refused",
    missing: "refused",
    aggregateOverflow: "refused",
    bomHash: "passed",
    danglingManifest: "refused",
  };
});

await mkdir(".openbot-build", { recursive: true });
await writeFile(".openbot-build/skill-install-local-changes-e2e.json", `${JSON.stringify(report, null, 2)}\n`);
if (report.some((entry) => !entry.passed)) process.exitCode = 1;
