import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Typography } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";
import { useUniwind } from "uniwind";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import { SettingsPicker } from "@/features/settings/components/settings-controls";
import {
  useMobileWorkspaceActions,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { useText } from "@/shared/lib/text";

export function SkillModeControl({
  agentId,
  serverId,
  threadId,
}: {
  agentId: string;
  serverId: string;
  threadId: string;
}) {
  const { t, errorMessage } = useText();
  const { theme } = useUniwind();
  const scope = useQueryScope();
  const allowed = useMobileWorkspaceSelector((state) => state.canUseSkillModes(serverId));
  const { readSkillMode, setSkillMode, loadAgentSkills } = useMobileWorkspaceActions();
  const client = useQueryClient();
  const key = [...scope, serverId, agentId, threadId, "skill-mode"];
  const mode = useQuery({
    queryKey: key,
    queryFn: () => readSkillMode({ agentId, threadId }, serverId),
    enabled: allowed,
    retry: false,
    staleTime: 0,
  });
  const skills = useQuery({
    queryKey: [...scope, serverId, agentId, "mode-skill-options"],
    queryFn: () => loadAgentSkills(agentId, serverId, false),
    enabled: allowed,
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(value: string, defaultScope = false) {
    setBusy(true);
    setError(null);
    try {
      const saved = await setSkillMode(
        {
          agentId,
          threadId,
          skillId: value.startsWith("skill:") ? value.slice(6) : null,
          scope: defaultScope ? "agent" : value === "inherit" ? "inherit" : "chat",
        },
        serverId,
      );
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData(key, saved);
    } catch (cause) {
      setError(errorMessage(cause, t("mobile.chat.skillMode.failed")));
    } finally {
      setBusy(false);
    }
  }
  if (!allowed) return null;
  return (
    <View>
      <Typography.Paragraph type="body-xs">{t("mobile.chat.skillMode.label")}</Typography.Paragraph>
      <SettingsPicker
        label={t("mobile.chat.skillMode.label")}
        value={mode.data?.inherited ? "inherit" : mode.data?.selection ? `skill:${mode.data.selection.skillId}` : ""}
        options={[
          { value: "inherit", label: t("mobile.chat.skillMode.inherit") },
          { value: "", label: t("mobile.chat.skillMode.off") },
          ...(skills.data ?? [])
            .filter((skill) => skill.enabled !== false && skill.state === "installed" && !skill.problem)
            .map((skill) => ({ value: `skill:${skill.skillId}`, label: skill.name })),
        ]}
        enabled={!busy && !mode.isLoading}
        dark={theme === "dark"}
        onChange={(value) => void save(value)}
      />
      <SettingsPicker
        label={t("mobile.chat.skillMode.agentDefault")}
        value={mode.data?.agentDefault ? `skill:${mode.data.agentDefault.skillId}` : ""}
        options={[
          { value: "", label: t("mobile.chat.skillMode.off") },
          ...(skills.data ?? [])
            .filter((skill) => skill.enabled !== false && skill.state === "installed" && !skill.problem)
            .map((skill) => ({ value: `skill:${skill.skillId}`, label: skill.name })),
        ]}
        enabled={!busy && !mode.isLoading}
        dark={theme === "dark"}
        onChange={(value) => void save(value, true)}
      />
      {mode.data?.selection ? (
        <Typography.Paragraph type="body-xs">{mode.data.selection.name}</Typography.Paragraph>
      ) : null}
      {error || mode.isError || skills.isError ? (
        <Typography.Paragraph type="body-xs">{error ?? t("mobile.chat.skillMode.failed")}</Typography.Paragraph>
      ) : null}
    </View>
  );
}
