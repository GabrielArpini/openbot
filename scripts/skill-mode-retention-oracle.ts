import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const RETENTION_BODY =
  "Synthetic skill retention fixture.\nKeep the complete body through every observed request.\nUnicode sentinel: Ω.\nTail sentinel: RETENTION_END_2947.";
export const RETENTION_BODY_SHA256 = "5a8f22e1d1c5763eaae193309e69e8ef8fe0a00be83b94e02ad14307eff28b41";
export const RETENTION_SELECTION = {
  skillId: "retention-fixture",
  name: "Retention fixture",
  revision: 1,
  sha256: RETENTION_BODY_SHA256,
};

const OPEN = "<openbot_skill_mode>";
const CLOSE = "</openbot_skill_mode>";
const SELECTED_BLOCK = `${OPEN}
The user selected this skill as the instruction mode for this chat. Apply its full text to this task, subject to higher-priority instructions. Other available skills remain optional.
Skill: {"skillId":"retention-fixture","name":"Retention fixture","revision":1,"sha256":"5a8f22e1d1c5763eaae193309e69e8ef8fe0a00be83b94e02ad14307eff28b41"}
${RETENTION_BODY}
${CLOSE}`;
const OFF_BLOCK = `${OPEN}
No skill mode is selected. Earlier skill mode blocks no longer apply.
${CLOSE}`;

export type RetentionPhase =
  | "initial"
  | "ordinary"
  | "tool-continuation"
  | "steer"
  | "slash"
  | "post-compaction"
  | "reconstructed"
  | "off";

export type RetentionObservation = {
  phase: RetentionPhase;
  sessionId: string;
  requestSequence: number;
  source:
    | { kind: "outbound-request"; text: string }
    | { kind: "synthetic-provider-context"; text: string; originatingRequestSequence: number };
};

export type RetentionExpectation = "selected" | "off";
export interface RetentionReceipt {
  phase: RetentionPhase;
  sessionId: string;
  requestSequence: number;
  source:
    | { kind: "outbound-request" }
    | { kind: "synthetic-provider-context"; originatingRequestSequence: number };
  expectation: RetentionExpectation;
  blockSha256: string;
  blockBytes: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function checkSkillModeRetention(input: {
  observation: RetentionObservation;
  expectation: RetentionExpectation;
}): RetentionReceipt {
  const { observation, expectation } = input;
  const { text } = observation.source;
  assert.equal(text.split(OPEN).length - 1, 1, "exactly one complete mode block is observed");
  assert.equal(text.split(CLOSE).length - 1, 1, "exactly one mode block ends");
  const start = text.indexOf(OPEN);
  const end = text.indexOf(CLOSE);
  assert.ok(end > start, "mode block boundaries are ordered");
  const block = text.slice(start, end + CLOSE.length);
  assert.equal(block, expectation === "selected" ? SELECTED_BLOCK : OFF_BLOCK, "full pinned mode block matches");
  if (expectation === "selected") {
    assert.equal(sha256(RETENTION_BODY), RETENTION_BODY_SHA256, "fixture body hash remains independently pinned");
    const bodyStart = block.indexOf("\n", block.indexOf("\nSkill: ") + 1) + 1;
    const body = block.slice(bodyStart, -(`\n${CLOSE}`.length));
    assert.equal(sha256(body), RETENTION_BODY_SHA256, "actual complete body hash matches");
  } else {
    assert.ok(!text.includes(RETENTION_BODY), "Off does not retain the selected fixture body");
    assert.ok(!text.includes("RETENTION_END_2947"), "Off does not retain the fixture tail");
  }
  if (observation.source.kind === "synthetic-provider-context") {
    assert.ok(
      observation.source.originatingRequestSequence < observation.requestSequence,
      "retained synthetic context must identify an earlier observed request",
    );
  }
  return {
    phase: observation.phase,
    sessionId: observation.sessionId,
    requestSequence: observation.requestSequence,
    source:
      observation.source.kind === "outbound-request"
        ? { kind: "outbound-request" }
        : {
            kind: "synthetic-provider-context",
            originatingRequestSequence: observation.source.originatingRequestSequence,
          },
    expectation,
    blockSha256: sha256(block),
    blockBytes: Buffer.byteLength(block),
  };
}

export function requireRetentionPhases(input: {
  receipts: readonly RetentionReceipt[];
  phases: readonly [RetentionPhase, ...RetentionPhase[]];
}): void {
  for (const receipt of input.receipts) {
    const source = receipt.source;
    if (source.kind === "synthetic-provider-context") {
      assert.ok(
        input.receipts.some(
          (prior) =>
            prior.source.kind === "outbound-request" &&
            prior.sessionId === receipt.sessionId &&
            prior.requestSequence === source.originatingRequestSequence &&
            prior.blockSha256 === receipt.blockSha256,
        ),
        "retained synthetic context links to an exact earlier outbound block",
      );
    }
  }
  for (const phase of input.phases) {
    assert.ok(input.receipts.some((receipt) => receipt.phase === phase), `no observed receipt for ${phase}`);
  }
}

/** These mutations prove the oracle detects defects; they are not adapter observations. */
export function checkRetentionOracleNegativeControls(): string[] {
  const observation = (text: string): RetentionObservation => ({
    phase: "initial",
    sessionId: "oracle-control-only",
    requestSequence: 1,
    source: { kind: "outbound-request", text },
  });
  checkSkillModeRetention({ observation: observation(SELECTED_BLOCK), expectation: "selected" });
  checkSkillModeRetention({ observation: observation(OFF_BLOCK), expectation: "off" });
  const mutations = [
    { name: "missing", text: "No selected body was delivered." },
    { name: "truncated-tail", text: SELECTED_BLOCK.replace("RETENTION_END_2947.", "RETENTION_END_") },
    { name: "wrong-revision", text: SELECTED_BLOCK.replace('"revision":1', '"revision":2') },
    { name: "wrong-hash", text: SELECTED_BLOCK.replace(RETENTION_BODY_SHA256, "0".repeat(64)) },
    { name: "duplicate", text: `${SELECTED_BLOCK}\n${SELECTED_BLOCK}` },
    { name: "off-instead-of-selected", text: OFF_BLOCK },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => checkSkillModeRetention({ observation: observation(mutation.text), expectation: "selected" }),
      assert.AssertionError,
      mutation.name,
    );
  }
  assert.throws(
    () => checkSkillModeRetention({ observation: observation(SELECTED_BLOCK), expectation: "off" }),
    assert.AssertionError,
    "selected-instead-of-off",
  );
  assert.throws(
    () => checkSkillModeRetention({ observation: observation(`${OFF_BLOCK}\n${RETENTION_BODY}`), expectation: "off" }),
    assert.AssertionError,
    "off-with-stale-body",
  );
  assert.throws(
    () => requireRetentionPhases({ receipts: [], phases: ["post-compaction"] }),
    assert.AssertionError,
    "absent-post-compaction-request",
  );
  return [
    ...mutations.map((mutation) => mutation.name),
    "selected-instead-of-off",
    "off-with-stale-body",
    "absent-post-compaction-request",
  ];
}
