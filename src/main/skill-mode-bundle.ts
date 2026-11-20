import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_MODE_MAX_CHARACTERS } from "@openbot/contracts/ipc-skill-mode";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { SkillModeFailed } from "../backend/agent/skill-modes";
import { isPathInside } from "../backend/path-containment";

interface BundleNode {
  sha256: string;
  revision: string | null;
  dependencies: { path: string; when: string }[];
}
const invalid = (path: string) => new Error(sourceText("error.skill.mode.bundle", { path }));
function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}
function nodesOf(value: unknown): Map<string, BundleNode> {
  if (!isDynamicRecord(value) || value.version !== 1 || value.root !== "SKILL.md" || !isDynamicRecord(value.nodes))
    throw invalid("mode-context.json");
  const entries = Object.entries(value.nodes);
  if (!entries.length || entries.length > 64) throw invalid("mode-context.json");
  const nodes = new Map<string, BundleNode>();
  for (const [path, node] of entries) {
    if (
      !safePath(path) ||
      !isDynamicRecord(node) ||
      typeof node.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(node.sha256) ||
      !(node.revision === null || (typeof node.revision === "string" && node.revision.length <= 128)) ||
      !Array.isArray(node.dependencies) ||
      node.dependencies.length > 64
    )
      throw invalid(path);
    const dependencies = node.dependencies.map((edge) => {
      if (
        !isDynamicRecord(edge) ||
        !safePath(edge.path) ||
        typeof edge.when !== "string" ||
        !edge.when.trim() ||
        edge.when.length > 1024
      )
        throw invalid(path);
      return { path: edge.path, when: edge.when };
    });
    nodes.set(path, { sha256: node.sha256, revision: node.revision, dependencies });
  }
  return nodes;
}

/** Reads only explicit package-local instructions. Markdown links never cause file or URL reads. */
export function readSkillModeBundle(directory: string, rootText: string): Effect.Effect<string, SkillModeFailed> {
  return Effect.tryPromise({
    try: async () => {
      const root = await realpath(directory);
      async function read(path: string): Promise<string> {
        const file = await realpath(join(root, path));
        if (!isPathInside(root, file)) throw invalid(path);
        const handle = await open(file, "r");
        try {
          const stat = await handle.stat();
          const limit = SKILL_MODE_MAX_CHARACTERS * 4;
          if (!stat.isFile() || stat.size > limit) throw invalid(path);
          const bytes = Buffer.alloc(limit + 1);
          let total = 0;
          while (total < bytes.length) {
            const chunk = await handle.read(bytes, total, bytes.length - total, total);
            if (chunk.bytesRead === 0) break;
            total += chunk.bytesRead;
          }
          if (total > limit) throw invalid(path);
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total));
        } finally {
          await handle.close();
        }
      }
      try {
        await lstat(join(root, "mode-context.json"));
      } catch (error) {
        if (isDynamicRecord(error) && error.code === "ENOENT") return rootText;
        throw error;
      }
      const manifest = await read("mode-context.json");
      const nodes = nodesOf(JSON.parse(manifest));
      const active = new Set<string>();
      const done = new Set<string>();
      const parts: string[] = [];
      let length = 0;
      function append(text: string) {
        length += text.length + (parts.length ? 2 : 0);
        if (length > SKILL_MODE_MAX_CHARACTERS) throw new Error(sourceText("error.skill.mode.size"));
        parts.push(text);
      }
      async function visit(path: string): Promise<void> {
        if (active.has(path)) throw invalid(path);
        if (done.has(path)) return;
        const node = nodes.get(path);
        if (!node) throw invalid(path);
        active.add(path);
        const body = path === "SKILL.md" ? rootText : await read(path);
        if (createHash("sha256").update(body).digest("hex") !== node.sha256) throw invalid(path);
        append(`## Skill source: ${JSON.stringify({ path, revision: node.revision, sha256: node.sha256 })}\n\n${body}`);
        for (const edge of node.dependencies) {
          append(`Dependency: ${JSON.stringify({ from: path, ...edge })}`);
          await visit(edge.path);
        }
        active.delete(path);
        done.add(path);
      }
      await visit("SKILL.md");
      if (done.size !== nodes.size) throw invalid("mode-context.json");
      return parts.join("\n\n");
    },
    catch: (cause) => new SkillModeFailed({ cause }),
  });
}
