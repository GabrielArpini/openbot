import { teamProtocolCapabilityLimit } from "@openbot/contracts/team-protocol/capability-limits";
import { type TeamCurrentCapability, teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { SKILL_MODES_CAPABILITY } from "@openbot/contracts/team-protocol/skill-modes-v1";
import { TEAM_LONG_CAPABILITY_LISTS_CAPABILITY, TEAM_PROTOCOL_V9 } from "@openbot/contracts/team-protocol/v9";

export function skillModePeerCapabilities(
  protocol: number | null | undefined,
  advertised: ReadonlySet<string>,
): readonly TeamCurrentCapability[] {
  const baseline = teamCapabilitiesForProtocol(protocol);
  if (
    protocol !== TEAM_PROTOCOL_V9 ||
    !advertised.has(SKILL_MODES_CAPABILITY) ||
    !advertised.has(TEAM_LONG_CAPABILITY_LISTS_CAPABILITY) ||
    advertised.size > teamProtocolCapabilityLimit(TEAM_PROTOCOL_V9)
  )
    return baseline;
  // Custom V9 hosts shipped this optional contract before V10. Keep only mutual capabilities
  // so the extension fits the host's validated 256-name list without changing the frozen baseline.
  return [...baseline.filter((name) => advertised.has(name)), SKILL_MODES_CAPABILITY];
}
