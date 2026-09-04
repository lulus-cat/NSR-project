import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import type { ComponentProps, ReactNode } from "react";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import {
  DEFAULT_RECORDING_POLICY,
  DEFAULT_TEMPLATES,
  type ShiftCode,
  type ShiftTemplate,
} from "@nsr/core";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Badge, Body, Button, Card, Divider, Heading, Row, Small } from "../../src/components/ui";
import { CONTENT_MAX, TOUCH_MIN, radius, space, type, useTheme } from "../../src/theme";
import { useApp } from "../../src/state/AppContext";
import { getSetting, resetDbHandle, setSetting, totalStorageBytes } from "../../src/db";
import {
  SETTINGS_KEYS,
  loadDutyTemplates,
  platformCapability,
  saveDutyTemplateOverride,
} from "../../src/services/scheduler";
import { deleteAllRecordings } from "../../src/services/files";
import {
  clearWorkplace,
  geofenceEnabled,
  getWorkplace,
  searchWorkplace,
  setGeofence,
  setWorkplaceHere,
  setWorkplacePlace,
  type PlaceHit,
  type Workplace,
} from "../../src/services/geofence";
import { MODEL_CHOICES, getApiKey, getCustomServer, getModelFor, getProvider, setApiKey, setCustomServer, setModelFor, setProvider, testConnection, type LlmProvider } from "../../src/services/llm";
import { AI_PATHS, getAiPath, setAiPath, type AiPath } from "../../src/services/pipeline";
import {
  MASKABLE_KINDS,
  loadPrivacySettings,
  savePrivacySettings,
  type PrivacySettings,
} from "../../src/services/export";
import { getServerModel } from "@nsr/core";
import {
  RELEASE_REPO,
  autoCheckEnabled,
  checkForUpdate,
  currentVersion,
  downloadAndInstall,
  setAutoCheck,
  skipVersion,
  type UpdateCheck,
} from "../../src/services/update";
import type { PiiKind } from "@nsr/core";
import { buildIssueUrl, clearDebugLog, readDebugLog, type DebugEntry } from "../../src/services/debug";

/** 값을 누르면 프리셋 칩이 펼쳐지는 행. 숫자 설정을 손으로 고르는 자리다. */
function PresetRow({
  label,
  hint,
  value,
  unit,
  options,
  onSelect,
  format,
}: {
  label: string;
  hint?: string;
  value: number;
  unit: string;
  options: number[];
  onSelect: (v: number) => void;
  /** 값 표시를 바꿔야 할 때 (예: 음수를 "후 30분"으로). 없으면 `${v}${unit}`. */
  format?: (v: number) => string;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const show = (v: number) => (format ? format(v) : `${v}${unit}`);
  return (
    <View>
      <Row label={label} value={`${show(value)} ›`} onPress={() => setOpen((o) => !o)} />
      {open ? (
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingBottom: space.sm }}
        >
          {options.map((o) => (
            <Pressable
              key={o}
              accessibilityRole="button"
              onPress={() => {
                onSelect(o);
                setOpen(false);
              }}
              style={({ pressed }) => ({
                paddingHorizontal: space.lg,
                paddingVertical: space.sm,
                borderRadius: radius.full,
                backgroundColor: o === value ? t.accent : t.surfaceAlt,
                transform: [{ scale: pressed ? 0.95 : 1 }],
              })}
            >
              <Text
                style={[type.small, { color: o === value ? "#FFFFFF" : t.text, fontWeight: "600" }]}
              >
                {show(o)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {hint ? <Small>{hint}</Small> : null}
    </View>
  );
}

function Toggle({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ paddingVertical: space.sm, gap: space.xs }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: space.md,
        }}
      >
        <Text style={[type.body, { color: t.text, flexShrink: 1 }]}>{label}</Text>
        <Switch value={value} onValueChange={onChange} disabled={disabled} />
      </View>
      {description ? <Small>{description}</Small> : null}
    </View>
  );
}


/** 삼성 설정처럼 색 원 아이콘 + 제목으로 묶음을 연다. */
function GroupHead({
  icon,
  color,
  title,
  badge,
}: {
  icon: ComponentProps<typeof Ionicons>["name"];
  color: string;
  title: string;
  badge?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: color,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={17} color="#FFFFFF" />
      </View>
      <Heading>{title}</Heading>
      {badge}
    </View>
  );
}

export default function Settings() {
  const t = useTheme();
  const app = useApp();
  const [appLock, setAppLock] = useState(false);
  const [iosContinuous, setIosContinuous] = useState(false);
  const [workplace, setWorkplace] = useState<Workplace | null>(null);
  const [geoOn, setGeoOn] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  // 근무지가 아직 없는 사람이 '근무지'를 눌렀을 때 — 지정 UI 를 먼저 보여줘야 한다.
  const [geoSetup, setGeoSetup] = useState(false);
  const [hospitalQuery, setHospitalQuery] = useState("");
  const [hospitalHits, setHospitalHits] = useState<PlaceHit[]>([]);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("anthropic");
  const [llmModel, setLlmModel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverModel, setServerModel] = useState("");
  const [connectionMsg, setConnectionMsg] = useState<string | null>(null);
  const [storageMb, setStorageMb] = useState(0);
  const [privacy, setPrivacy] = useState<PrivacySettings>({
    enabled: true,
    disabled: ["location"],
    extraTerms: [],
  });
  const [newTerm, setNewTerm] = useState("");
  const [modelSummary, setModelSummary] = useState("확인 중");
  // 필수 기능(AI) — 두 경로 중 하나를 반드시 고른다.
  const [aiPath, setAiPathState] = useState<AiPath | null>(null);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [hasPathKey, setHasPathKey] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [pathKeyInput, setPathKeyInput] = useState("");
  useEffect(() => {
    void (async () => {
      const path = await getAiPath();
      setAiPathState(path);
      setHasGeminiKey((await getApiKey("gemini")) !== null);
      if (path) {
        setHasPathKey((await getApiKey(path === "claude" ? "anthropic" : "openai")) !== null);
      }
    })();
  }, [aiPath]);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [checking, setChecking] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [updatePct, setUpdatePct] = useState<number | null>(null);

  const load = useCallback(async () => {
    setAppLock(await getSetting<boolean>(SETTINGS_KEYS.appLock, false));
    setIosContinuous(await getSetting<boolean>(SETTINGS_KEYS.iosContinuousSession, false));
    setWorkplace(await getWorkplace());
    setGeoOn(await geofenceEnabled());
    setLlmEnabled(await getSetting<boolean>(SETTINGS_KEYS.llmPostEdit, false));
    const provider = await getProvider();
    const custom = await getCustomServer();
    if (custom) {
      setServerUrl(custom.baseUrl);
      setServerModel(custom.model);
    }
    setLlmProvider(provider);
    setLlmModel(await getModelFor(provider));
    setHasKey((await getApiKey(provider)) !== null);
    setStorageMb(Math.round(((await totalStorageBytes()) / (1024 * 1024)) * 10) / 10);
    setPrivacy(await loadPrivacySettings());
    setAutoUpdate(await autoCheckEnabled());
    setDebugEntries(await readDebugLog());

    // 전사는 서버가 한다 — 어디에 연결됐고 어떤 모델인지를 한 줄로.
    const asr = await getSetting<{
      endpoint?: string;
      model?: string;
      mode?: string;
      geminiModel?: string;
    }>(SETTINGS_KEYS.cloudTranscription, {});
    if (asr.mode === "gemini") {
      const hasKey = await getApiKey("gemini");
      setModelSummary(
        hasKey ? `Gemini · ${asr.geminiModel || "gemini-3.7-flash"}` : "Gemini · 키 없음",
      );
    } else if (!asr.endpoint) setModelSummary("연결 안 됨");
    else {
      const where = asr.mode === "pc" ? "내 컴퓨터" : "콜랩";
      const model = asr.model ? (getServerModel(asr.model)?.name ?? asr.model) : "서버 기본 모델";
      setModelSummary(`${where} · ${model}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const router = useRouter();
  const policy = app.policy;

  // ── 근무·기록 시간 — 듀티표 화면에 있던 것을 여기로 옮겼다.
  // 설정에서 만지는 값이라 설정에 둔다. 달력·근무 통계·자동 기록·홈의 인계
  // 체류 표시가 전부 이 값을 쓴다.
  const [templates, setTemplates] = useState<Record<ShiftCode, ShiftTemplate>>(DEFAULT_TEMPLATES);
  const [editCode, setEditCode] = useState<ShiftCode | null>(null);
  const [editForm, setEditForm] = useState({ start: "", end: "", pre: "", post: "" });
  const [timeMsg, setTimeMsg] = useState<string | null>(null);
  useEffect(() => {
    void loadDutyTemplates().then(setTemplates);
  }, []);
  const capability = platformCapability(iosContinuous);
  // 3택과 같은 판정 — 어느 방식의 세부 설정을 펼칠지 정한다.
  const mode = policy.enabled ? "duty" : geoOn ? "geo" : "off";

  const updatePrivacy = useCallback(async (next: PrivacySettings) => {
    setPrivacy(next);
    await savePrivacySettings(next);
  }, []);

  const toggleCode = useCallback(
    (code: ShiftCode) => {
      const on = policy.codes.includes(code);
      void app.updatePolicy({
        ...policy,
        codes: on ? policy.codes.filter((c) => c !== code) : [...policy.codes, code],
      });
    },
    [app, policy],
  );

  const wipeEverything = useCallback(() => {
    Alert.alert(
      "모든 데이터를 지웁니다.",
      "녹음·전사본·단어장이 모두 지워져요. 되살릴 수 없어요.",
      [
        { text: "취소", style: "cancel" },
        {
          text: "전부 삭제",
          style: "destructive",
          onPress: async () => {
            const SQLite = await import("expo-sqlite");
            deleteAllRecordings();
            resetDbHandle();
            await SQLite.deleteDatabaseAsync("nsr.db");
            await setApiKey(null);
            await app.refresh();
            await load();
          },
        },
      ],
    );
  }, [app, load]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      setUpdate(await checkForUpdate(true));
    } finally {
      setChecking(false);
    }
  }, []);

  const version = currentVersion();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
    <ScrollView
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.bottom,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
    >
      <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: "700", color: t.text }}>설정</Text>

      {/* 프로필 — 근무지·저장 요약이 이 앱의 신원이다 */}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View
            style={{
              width: 44, height: 44, borderRadius: 22,
              backgroundColor: t.accentSoft, alignItems: "center", justifyContent: "center",
            }}
          >
            <Ionicons name="person-outline" size={20} color={t.accent} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Heading>{workplace ? workplace.label : "근무지 미지정"}</Heading>
            <Small>
              저장된 기록 {storageMb} MB · 보관 {policy.retentionDays}일
            </Small>
          </View>
        </View>
      </Card>
      {/* 판 번호와 업데이트 */}
      <Card tone={update?.show ? "accent" : "default"}>
        <GroupHead icon="information-circle-outline" color="#4C7DDB" title="앱 버전" badge={<Badge text="알파" tone="warn" />} />
        <Small muted={false}>{version ? `현재 ${version}` : "개발 중 실행"}</Small>
        <Small>
          
  스토어 앱이 아니라서 새 판을 여기서 알려드려요. 덮어 깔아도 기록은 남아요.
</Small>

        {update?.show && update.release ? (
          <>
            <Divider />
            <Small muted={false}>{update.message}</Small>
            {update.highlights.map((h, i) => (
              <Small key={i}>· {h}</Small>
            ))}
            {update.release.apkSizeMb > 0 ? (
              <Small>
  다운로드 크기 약
{update.release.apkSizeMb} MB</Small>
            ) : null}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label={updatePct !== null ? `받는 중 ${updatePct}%` : "받아서 설치"}
                  tone="primary"
                  busy={updatePct !== null}
                  onPress={async () => {
                    if (!update.release || updatePct !== null) return;
                    setUpdatePct(0);
                    const r = await downloadAndInstall(update.release, setUpdatePct);
                    setUpdatePct(null);
                    if (!r.ok) setConnectionMsg(r.error ?? "내려받지 못했어요. 인터넷 연결을 확인해 주세요.");
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="이 버전 건너뛰기"
                  onPress={async () => {
                    if (!update.version) return;
                    await skipVersion(update.version);
                    setUpdate({ ...update, show: false, message: "이번 버전을 건너뜁니다." });
                  }}
                />
              </View>
            </View>
          </>
        ) : (
          <>
            {update ? <Small muted={false}>{update.message}</Small> : null}
            <Button label="지금 확인" busy={checking} onPress={() => void runCheck()} />
          </>
        )}

        <Divider />
        <Toggle
          label="새 버전 알림 받기"
          description="배터리를 거의 쓰지 않고 가끔 새 판을 확인해요."
          value={autoUpdate}
          onChange={async (v) => {
            setAutoUpdate(v);
            await setAutoCheck(v);
          }}
        />
        <Small>릴리스: github.com/{RELEASE_REPO}/releases</Small>
      </Card>

      {/* 기록 */}
      <Card>
        <GroupHead icon="mic-outline" color="#3E9B6F" title="자동 기록" />
        {/* 듀티표와 근무지 감지는 동시에 켜지 않는다 — 서로 켜고 끄는 시점이
            어긋나면 어느 쪽이 기록을 물고 있는지 알 수 없게 된다. */}
        <Small muted={false}>자동 기록 방식 — 하나만 켭니다</Small>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {(
            [
              ["duty", "듀티표"],
              ["geo", "근무지"],
              ["off", "끄기"],
            ] as const
          ).map(([mode, label]) => {
            const active =
              mode === "duty" ? policy.enabled : mode === "geo" ? geoOn && !policy.enabled : !policy.enabled && !geoOn;
            return (
              <View key={mode} style={{ flex: 1 }}>
                <Button
                  label={label}
                  tone={active ? "primary" : "default"}
                  onPress={async () => {
                    setGeoMsg(null);
                    if (mode === "duty") {
                      setGeoSetup(false);
                      if (geoOn) {
                        await setGeofence(false);
                        setGeoOn(false);
                      }
                      await app.updatePolicy({ ...policy, enabled: true });
                    } else if (mode === "geo") {
                      if (!workplace) {
                        // 근무지가 없으면 켤 수 없다 — 지정 UI 를 아래에 펼친다.
                        setGeoSetup(true);
                        setGeoMsg("근무지가 없어요. 아래에서 먼저 정해 주세요.");
                        return;
                      }
                      const r = await setGeofence(true);
                      if (!r.ok) {
                        setGeoSetup(true);
                        setGeoMsg(r.message ?? "근무지 감지를 켜지 못했어요. 위치 권한을 확인해 주세요.");
                        return;
                      }
                      setGeoOn(true);
                      setGeoSetup(false);
                      await app.updatePolicy({ ...policy, enabled: false });
                    } else {
                      setGeoSetup(false);
                      if (geoOn) {
                        await setGeofence(false);
                        setGeoOn(false);
                      }
                      await app.updatePolicy({ ...policy, enabled: false });
                    }
                  }}
                />
              </View>
            );
          })}
        </View>
        <Small>고른 방식의 자세한 설정이 아래에 나와요.</Small>
        <Small>{capability.explanation}</Small>
        {geoMsg ? <Small muted={false}>{geoMsg}</Small> : null}

        {mode === "duty" ? (
          <>
            <Divider />
            <Small muted={false}>기록할 근무</Small>
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              {(
                [
                  ["D", "데이"],
                  ["E", "이브닝"],
                  ["N", "나이트"],
                  ["ADM", "상근"],
                  ["SPC", "스페셜"],
                  ["EDU", "교육"],
                ] as [ShiftCode, string][]
              ).map(([code, label]) => (
                <Button
                  key={code}
                  label={label}
                  tone={policy.codes.includes(code) ? "primary" : "default"}
                  onPress={() => toggleCode(code)}
                />
              ))}
            </View>
            <Small>듀티표에 그 근무가 있는 날만 자동으로 기록해요.</Small>
            <Divider />
            <Small muted={false}>근무·기록 시간</Small>
            <Small>
              근무를 누르면 시각과 인계 앞뒤 시간을 고칠 수 있어요. 달력·통계·자동
              기록이 모두 이 값을 써요.
            </Small>
            {(["D", "E", "N", "ADM", "SPC"] as ShiftCode[]).map((code) => {
              const tpl = templates[code];
              const editing = editCode === code;
              return (
                <View key={code}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      if (editing) {
                        setEditCode(null);
                        return;
                      }
                      setEditCode(code);
                      setEditForm({
                        start: tpl.startTime ?? "",
                        end: tpl.endTime ?? "",
                        pre: String(tpl.preHandoverMin),
                        post: String(tpl.postHandoverMin),
                      });
                    }}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      minHeight: TOUCH_MIN,
                    }}
                  >
                    <Body>{tpl.label}</Body>
                    <Small>
                      {tpl.startTime}~{tpl.endTime} · 인계 앞 {tpl.preHandoverMin}분 / 뒤{" "}
                      {tpl.postHandoverMin}분 {editing ? "▲" : "▼"}
                    </Small>
                  </Pressable>
                  {editing ? (
                    <View style={{ gap: space.sm, paddingBottom: space.md }}>
                      <View style={{ flexDirection: "row", gap: space.sm }}>
                        {(
                          [
                            ["start", "시작 (07:00)"],
                            ["end", "종료 (15:00)"],
                          ] as const
                        ).map(([field, ph]) => (
                          <TextInput
                            key={field}
                            value={editForm[field]}
                            onChangeText={(v) => setEditForm((f) => ({ ...f, [field]: v }))}
                            placeholder={ph}
                            placeholderTextColor={t.textMuted}
                            keyboardType="numbers-and-punctuation"
                            style={{
                              flex: 1,
                              color: t.text,
                              backgroundColor: t.surfaceAlt,
                              borderRadius: radius.md,
                              padding: space.md,
                              fontSize: 14,
                            }}
                          />
                        ))}
                      </View>
                      <View style={{ flexDirection: "row", gap: space.sm }}>
                        {(
                          [
                            ["pre", "인계 앞(분)"],
                            ["post", "인계 뒤(분)"],
                          ] as const
                        ).map(([field, ph]) => (
                          <TextInput
                            key={field}
                            value={editForm[field]}
                            onChangeText={(v) => setEditForm((f) => ({ ...f, [field]: v }))}
                            placeholder={ph}
                            placeholderTextColor={t.textMuted}
                            keyboardType="number-pad"
                            style={{
                              flex: 1,
                              color: t.text,
                              backgroundColor: t.surfaceAlt,
                              borderRadius: radius.md,
                              padding: space.md,
                              fontSize: 14,
                            }}
                          />
                        ))}
                      </View>
                      <Button
                        label="저장"
                        tone="primary"
                        onPress={() => {
                          void (async () => {
                            const time = /^([01]?\d|2[0-3]):[0-5]\d$/;
                            if (!time.test(editForm.start) || !time.test(editForm.end)) {
                              setTimeMsg("시각 모양이 달라요. 07:00 처럼 적어 주세요.");
                              return;
                            }
                            const pre = Number(editForm.pre);
                            const post = Number(editForm.post);
                            if (
                              !Number.isFinite(pre) ||
                              !Number.isFinite(post) ||
                              pre < 0 ||
                              post < 0
                            ) {
                              setTimeMsg("인계 시간이 이상해요. 0 이상 숫자로 적어 주세요.");
                              return;
                            }
                            await saveDutyTemplateOverride(code, {
                              startTime: editForm.start,
                              endTime: editForm.end,
                              preHandoverMin: Math.round(pre),
                              postHandoverMin: Math.round(post),
                            });
                            setTemplates(await loadDutyTemplates());
                            setEditCode(null);
                            setTimeMsg(null);
                          })();
                        }}
                      />
                    </View>
                  ) : null}
                  <Divider />
                </View>
              );
            })}
            {timeMsg ? <Small muted={false}>{timeMsg}</Small> : null}
            <Small muted={false}>자동 기록 여유</Small>
            <Small>
              인계를 놓치지 않으려면 위 인계 시간보다 넉넉해야 해요.
            </Small>
            <PresetRow
              label="기록 시작 전"
              value={policy.leadMinutes}
              unit="분"
              options={[15, 30, 45, 60]}
              onSelect={(v) => void app.updatePolicy({ ...policy, leadMinutes: v })}
            />
            <PresetRow
              label="종료 후 유지"
              value={policy.trailMinutes}
              unit="분"
              options={[15, 30, 40, 60]}
              onSelect={(v) => void app.updatePolicy({ ...policy, trailMinutes: v })}
            />
          </>
        ) : null}

        {mode === "geo" || geoSetup ? (
          <>
            <Divider />
            <Small muted={false}>근무지</Small>
            <Small>
              병원 반경에 들어오면 기록을 시작하고 벗어나면 끝냅니다. 출퇴근 전후
              오버타임까지 실제 머문 시간이 남아요. 근무일에만 켜지고, 위치는 폰 밖으로
              나가지 않아요.
            </Small>
            {workplace ? (
              <>
                <Row
                  label={workplace.label || "근무지"}
                  value={`반경 ${workplace.radius}m · 해제`}
                  onPress={async () => {
                    await clearWorkplace();
                    setWorkplace(null);
                    setGeoOn(false);
                  }}
                />
                <Small>누르면 풀려요.</Small>
                <Button
                  label="지도에서 위치 확인 (카카오맵)"
                  onPress={() =>
                    void Linking.openURL(
                      `https://map.kakao.com/link/map/${encodeURIComponent(workplace.label || "근무지")},${workplace.latitude},${workplace.longitude}`,
                    )
                  }
                />
              </>
            ) : (
              <>
                <Small muted={false}>병원 이름으로 찾기</Small>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <TextInput
                    value={hospitalQuery}
                    onChangeText={setHospitalQuery}
                    placeholder="예: 서울아산병원"
                    placeholderTextColor={t.textMuted}
                    style={{
                      flex: 1,
                      color: t.text,
                      backgroundColor: t.surfaceAlt,
                      borderRadius: radius.md,
                      paddingHorizontal: space.md,
                      minHeight: 48,
                      fontSize: 15,
                    }}
                  />
                  <Button
                    label="검색"
                    tone="primary"
                    onPress={async () => {
                      try {
                        const r = await searchWorkplace(hospitalQuery);
                        setHospitalHits(r.hits);
                        setGeoMsg(
                          r.hits.length === 0
                            ? r.source === "kakao"
                              ? "찾지 못했어요. 지점 이름을 빼고 다시 찾아 주세요."
                              : "찾지 못했어요. 병원 정식 이름으로 다시 찾아 주세요."
                            : r.source === "kakao"
                              ? "카카오 지도에서 찾았어요."
                              : "병원 목록에서 찾았어요.",
                        );
                      } catch (e) {
                        setGeoMsg(e instanceof Error ? e.message : "찾지 못했어요. 인터넷 연결을 확인해 주세요.");
                      }
                    }}
                  />
                </View>
                {hospitalHits.map((h) => (
                  <Row
                    key={`${h.latitude},${h.longitude}`}
                    label={h.name}
                    value="이곳으로"
                    onPress={async () => {
                      const wp = await setWorkplacePlace(h);
                      setWorkplace(wp);
                      setHospitalHits([]);
                      setHospitalQuery("");
                      // 근무지 방식을 고르다 여기 온 것이면 지정 즉시 켠다.
                      if (geoSetup) {
                        const r = await setGeofence(true);
                        if (r.ok) {
                          setGeoOn(true);
                          setGeoSetup(false);
                          setGeoMsg("근무지 자동 기록을 켰어요.");
                          await app.updatePolicy({ ...policy, enabled: false });
                        } else {
                          setGeoMsg(r.message ?? "근무지 감지를 켜지 못했어요. 위치 권한을 확인해 주세요.");
                        }
                      } else {
                        setGeoMsg(null);
                      }
                    }}
                  />
                ))}
                <Button
                  label="지금 있는 곳을 근무지로"
                  onPress={async () => {
                    const wp = await setWorkplaceHere();
                    if (!wp) {
                      setGeoMsg("위치 사용이 꺼져 있어요. 폰 설정에서 켜 주세요.");
                      return;
                    }
                    setWorkplace(wp);
                    if (geoSetup) {
                      const r = await setGeofence(true);
                      if (r.ok) {
                        setGeoOn(true);
                        setGeoSetup(false);
                        setGeoMsg("근무지 자동 기록을 켰어요.");
                        await app.updatePolicy({ ...policy, enabled: false });
                      } else {
                        setGeoMsg(r.message ?? "근무지 감지를 켜지 못했어요. 위치 권한을 확인해 주세요.");
                      }
                    } else {
                      setGeoMsg(null);
                    }
                  }}
                />
              </>
            )}
            <Small>
              {Platform.OS === "android"
                ? "위치 사용을 '항상 허용'으로 바꿔 주세요. 안드로이드 14부터는 제한이 더 있어요."
                : "위치 사용을 '항상 허용'으로 바꿔 주세요."}
            </Small>
          </>
        ) : null}

        <Divider />
        <PresetRow
          label="파일 분할"
          value={policy.segmentMinutes}
          unit="분"
          options={[10, 20, 30, 50]}
          onSelect={(v) => void app.updatePolicy({ ...policy, segmentMinutes: v })}
          hint="긴 근무를 나눠 담아요. 중간에 끊겨도 앞부분은 남아요."
        />
        <Divider />
        <PresetRow
          label="보관 기간"
          value={policy.retentionDays}
          unit="일"
          options={[7, 14, 30, 60, 90]}
          onSelect={(v) => void app.updatePolicy({ ...policy, retentionDays: v })}
          hint="기한이 지난 기록은 저절로 지워져요. 오래 두면 위험해요."
        />
        <Divider />
        <Row label="현재 사용 중" value={`${storageMb} MB / ${policy.maxStorageMb} MB`} />
      </Card>

      {/* 조용함 */}
      <Card>
        <GroupHead icon="notifications-off-outline" color="#7A6FD0" title="조용히 동작" />
        <Toggle
          label="시작·종료 소리와 진동 없음"
          value={policy.silentStart}
          onChange={(v) => void app.updatePolicy({ ...policy, silentStart: v })}
        />
        <Toggle
          label="앱 알림 표시 안 함"
          value={policy.suppressNotifications}
          onChange={(v) => void app.updatePolicy({ ...policy, suppressNotifications: v })}
        />
        <Divider />
        <Badge text="끌 수 없는 것" tone="warn" />
        <Small>
          {Platform.OS === "ios"
            ? "아이폰 위쪽 주황색 마이크 표시는 앱에서 숨길 수 없어요."
            : "안드로이드 마이크 표시는 폰이 켜요. 기록 중에는 소리 없는 알림이 떠요."}
        </Small>
        {Platform.OS === "ios" ? (
          <>
            <Divider />
            <Toggle
              label="연속 세션 유지 (배터리 소모 큼)"
              description="앱을 열지 않아도 기록을 시작해요. 배터리를 많이 써요."
              value={iosContinuous}
              onChange={async (v) => {
                setIosContinuous(v);
                await setSetting(SETTINGS_KEYS.iosContinuousSession, v);
              }}
            />
          </>
        ) : null}
      </Card>

      {/* 개인정보 */}
      <Card>
        <GroupHead icon="lock-closed-outline" color="#5B5EA6" title="개인정보" />
        <Toggle
          label="앱 잠금"
          description="앱을 열 때 지문이나 얼굴로 잠금을 풀어요."
          value={appLock}
          onChange={async (v) => {
            setAppLock(v);
            await setSetting(SETTINGS_KEYS.appLock, v);
          }}
        />
        <Divider />
        <Badge text="통신비밀보호법" tone="warn" />
        <Small>
          내가 끼지 않은 대화를 녹음하면 불법이에요. 1년 이상 징역이에요.
          앱은 목소리로 사람을 가리지 못해요. 자리를 비울 때는 기록을 끄거나 폰을 꼭
          들고 다녀요.
        </Small>
      </Card>

      {/* 개인정보 가리기 */}
      <Card>
        <GroupHead icon="eye-off-outline" color="#8A5F9E" title="민감 정보 가리기" />
        <Small>
          
  밖으로 내보낼 때 이름·전화번호·등록번호를 자동으로 가려요.
</Small>
        <Divider />
        <Badge text="폰 안에 둘 때는 가리지 않아요" tone="muted" />
        <Small>
          
  전사본은 신고할 때 중요한 증거예요. 그래서 폰 안의 원본은 가리지 않고 남겨요.
</Small>
        <Divider />
        <Toggle
          label="내보낼 때 가리기"
          description="꺼 두어도 내보내기 전에 무엇이 담겼는지 알려드려요."
          value={privacy.enabled}
          onChange={(v) => void updatePrivacy({ ...privacy, enabled: v })}
        />
        {privacy.enabled ? (
          <>
            <Divider />
            <Small muted={false}>무엇을 가릴지</Small>
            {MASKABLE_KINDS.map(({ kind, label, hint }) => (
              <Toggle
                key={kind}
                label={label}
                description={hint}
                value={!privacy.disabled.includes(kind)}
                onChange={(v) =>
                  void updatePrivacy({
                    ...privacy,
                    disabled: v
                      ? privacy.disabled.filter((k) => k !== kind)
                      : [...privacy.disabled, kind as PiiKind],
                  })
                }
              />
            ))}
          </>
        ) : null}
        <Divider />
        <Small muted={false}>
  꼭 가릴 말
</Small>
        <Small>
          
  자동으로 못 잡는 이름을 넣어 두면 늘 가려요.
</Small>
        {privacy.extraTerms.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {privacy.extraTerms.map((term) => (
              <Button
                key={term}
                label={`${term}  ×`}
                onPress={() =>
                  void updatePrivacy({
                    ...privacy,
                    extraTerms: privacy.extraTerms.filter((x) => x !== term),
                  })
                }
              />
            ))}
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <TextInput
            value={newTerm}
            onChangeText={setNewTerm}
            placeholder="가릴 말 (두 글자 이상)"
            placeholderTextColor={t.textMuted}
            style={{
              flex: 1,
              color: t.text,
              backgroundColor: t.surfaceAlt,
              borderRadius: radius.md,
              padding: space.md,
              fontSize: 14,
            }}
          />
          <Button
            label="추가"
            onPress={() => {
              const term = newTerm.trim();
              if (term.length < 2 || privacy.extraTerms.includes(term)) return;
              setNewTerm("");
              void updatePrivacy({
                ...privacy,
                extraTerms: [...privacy.extraTerms, term],
              });
            }}
          />
        </View>
        <Divider />
        <Small>
          
  자동 가림은 완벽하지 않아요. 호칭 없는 이름은 놓칠 수 있어요.
<Text style={{ fontWeight: "700" }}>
          
  음성 파일 자체는 가릴 수 없어요.
</Text> 
  음성에는 이름과 진단명이 그대로 남아요.
</Small>
      </Card>

      {/* 전사 */}
      <Card>
        <GroupHead icon="text-outline" color="#B3762F" title="전사" />
        <Small>
          글자로 바꾸는 일은 폰이 아니라 고른 곳이 해요. 녹음한 소리가 그곳으로 전송돼요.
          지금 어디로 보내는지 아래 한 줄로 늘 보여요.
        </Small>
        <Divider />
        <Row
          label="전사 서버·모델"
          value={`${modelSummary} ›`}
          onPress={() => router.push("/models")}
        />
        <Small>

  큰 모델보다 한국어 전용 모델이 훨씬 정확해요.
</Small>
      </Card>

      {/* 필수 기능 — AI 경로. 이 앱의 분석·보고서·대화는 AI 없이는 안 돈다. */}
      <Card tone={aiPath ? "default" : "warn"}>
        <GroupHead icon="sparkles-outline" color="#C0553F" title="필수 기능 (AI)" />
        <Small>분석·보고서·단어장·대화가 모두 AI 로 돌아요.</Small>
        <Small>아래 조합 하나를 고르고 열쇠를 넣어야 써요.</Small>
        <Small>전사본은 개인정보를 가린 뒤에만 전송돼요.</Small>
        <Small>열쇠가 없으면 다른 모델로 대신 돌리지 않아요.</Small>
        {AI_PATHS.map((p) => {
          const on = aiPath === p.path;
          return (
            <Pressable
              key={p.path}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              onPress={async () => {
                setAiPathState(p.path);
                await setAiPath(p.path);
                setConnectionMsg(null);
              }}
              style={{
                borderRadius: radius.lg,
                borderWidth: 2,
                borderColor: on ? t.accent : "transparent",
                backgroundColor: on ? t.accentSoft : t.surfaceAlt,
                padding: space.md,
                gap: 4,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={[type.body, { color: t.text, fontWeight: "700" }]}>{p.title}</Text>
                {on ? <Badge text="사용 중" tone="ok" /> : null}
              </View>
              <Text style={[type.small, { color: t.text, fontWeight: "600" }]}>{p.models}</Text>
              <Small>{p.why}</Small>
            </Pressable>
          );
        })}

        {aiPath ? (
          <>
            <Divider />
            <Small muted={false}>
              1. Gemini 열쇠 {hasGeminiKey ? "— 넣어 뒀어요" : "(aistudio.google.com/apikey)"}
            </Small>
            <TextInput
              value={geminiKeyInput}
              onChangeText={setGeminiKeyInput}
              placeholder={hasGeminiKey ? "넣어 둔 열쇠가 있어요" : "AIza… 로 시작하는 열쇠"}
              placeholderTextColor={t.textMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                color: t.text,
                backgroundColor: t.surfaceAlt,
                borderRadius: radius.md,
                padding: space.md,
                fontSize: 14,
              }}
            />
            <Button
              label="Gemini 키 저장"
              tone={hasGeminiKey ? "default" : "primary"}
              onPress={async () => {
                if (!geminiKeyInput.trim()) return;
                await setApiKey(geminiKeyInput.trim(), "gemini");
                setGeminiKeyInput("");
                setHasGeminiKey(true);
              }}
            />
            <Small muted={false}>
              2. {aiPath === "claude" ? "Claude 키" : "OpenAI 키"}{" "}
              {hasPathKey
                ? "— 넣어 뒀어요"
                : aiPath === "claude"
                  ? "(console.anthropic.com)"
                  : "(platform.openai.com)"}
            </Small>
            <TextInput
              value={pathKeyInput}
              onChangeText={setPathKeyInput}
              placeholder={hasPathKey ? "넣어 둔 열쇠가 있어요" : "열쇠 붙여넣기"}
              placeholderTextColor={t.textMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                color: t.text,
                backgroundColor: t.surfaceAlt,
                borderRadius: radius.md,
                padding: space.md,
                fontSize: 14,
              }}
            />
            <Button
              label={aiPath === "claude" ? "Claude 키 저장" : "OpenAI 키 저장"}
              tone={hasPathKey ? "default" : "primary"}
              onPress={async () => {
                if (!pathKeyInput.trim()) return;
                await setApiKey(pathKeyInput.trim(), aiPath === "claude" ? "anthropic" : "openai");
                setPathKeyInput("");
                setHasPathKey(true);
                setConnectionMsg(null);
              }}
            />
            <Small>열쇠는 이 폰 안에만 남아요.</Small>
            <Button
              label="연결 테스트"
              onPress={async () => {
                const result = await testConnection();
                setConnectionMsg(result.message);
              }}
            />
            {connectionMsg ? <Small muted={false}>{connectionMsg}</Small> : null}
            <Divider />
            <Toggle
              label="전사 직후 문맥 교정·근무 요약 자동 실행"
              value={llmEnabled}
              onChange={async (v) => {
                setLlmEnabled(v);
                await setSetting(SETTINGS_KEYS.llmPostEdit, v);
              }}
            />
          </>
        ) : (
          <Small muted={false}>위에서 조합을 먼저 골라요. 고르면 열쇠 칸이 열려요.</Small>
        )}
      </Card>

      {/* 디버그 */}
      <Card>
        <GroupHead icon="bug-outline" color="#6B7280" title="디버그" />
        <Small>
          앱에서 생긴 문제가 여기 남아요. 아래 버튼을 누르면 폰 정보와 최근 문제가
          적힌 신고 화면이 열려요.
        </Small>
        <Row
          label="최근 오류"
          value={`${debugEntries.length}개 ${debugOpen ? "접기" : "보기"} ›`}
          onPress={async () => {
            if (!debugOpen) setDebugEntries(await readDebugLog());
            setDebugOpen((o) => !o);
          }}
        />
        {debugOpen
          ? (debugEntries.length === 0
              ? <Small>기록된 문제가 없어요.</Small>
              : debugEntries.slice(-10).reverse().map((e) => (
                  <Small key={e.at}>
                    {new Date(e.at).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {e.message.split("\n")[0]}
                  </Small>
                )))
          : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              label="GitHub 에 버그 보고"
              tone="primary"
              onPress={async () => {
                const url = await buildIssueUrl();
                const ok = await Linking.openURL(url).then(() => true).catch(() => false);
                if (!ok) setConnectionMsg("인터넷 창을 열지 못했어요. 다시 눌러 주세요.");
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="로그 비우기"
              onPress={async () => {
                await clearDebugLog();
                setDebugEntries([]);
              }}
            />
          </View>
        </View>
      </Card>

      {/* 초기화 */}
      <Card>
        <GroupHead icon="trash-outline" color="#B3402F" title="데이터 삭제" />
        <Body muted>
          
  모든 기록을 지워요. 되살릴 수 없어요.
</Body>
        <Button label="모든 데이터 삭제" tone="danger" onPress={wipeEverything} />
      </Card>

      <Card>
        <Small>
          기본 정책값: 근무 {DEFAULT_RECORDING_POLICY.leadMinutes}분 전 시작 ·
          {" "}
          {DEFAULT_RECORDING_POLICY.segmentMinutes}분 분할 ·
          {" "}
          {DEFAULT_RECORDING_POLICY.retentionDays}일 보관
        </Small>
      </Card>
    </ScrollView>
    </SafeAreaView>
  );
}
