import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import type { ComponentProps, ReactNode } from "react";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { DEFAULT_RECORDING_POLICY, type ShiftCode } from "@nsr/core";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Badge, Body, Button, Card, Divider, Heading, Row, Small } from "../../src/components/ui";
import { CONTENT_MAX, radius, space, type, useTheme } from "../../src/theme";
import { useApp } from "../../src/state/AppContext";
import { getSetting, resetDbHandle, setSetting, totalStorageBytes } from "../../src/db";
import { SETTINGS_KEYS, platformCapability } from "../../src/services/scheduler";
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
import { getApiKey, getCustomServer, getProvider, setApiKey, setCustomServer, setProvider, testConnection, type LlmProvider } from "../../src/services/llm";
import {
  MASKABLE_KINDS,
  loadPrivacySettings,
  savePrivacySettings,
  type PrivacySettings,
} from "../../src/services/export";
import { activeModelId, listModels } from "../../src/services/models";
import {
  RELEASE_REPO,
  autoCheckEnabled,
  checkForUpdate,
  currentVersion,
  openDownload,
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
  const [serverUrl, setServerUrl] = useState("");
  const [serverModel, setServerModel] = useState("");
  const [connectionMsg, setConnectionMsg] = useState<string | null>(null);
  const [storageMb, setStorageMb] = useState(0);
  const [cloudAsr, setCloudAsr] = useState<{ enabled: boolean; endpoint: string }>({
    enabled: false,
    endpoint: "",
  });
  const [privacy, setPrivacy] = useState<PrivacySettings>({
    enabled: true,
    disabled: ["location"],
    extraTerms: [],
  });
  const [newTerm, setNewTerm] = useState("");
  const [modelSummary, setModelSummary] = useState("확인 중");
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [checking, setChecking] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);

  const load = useCallback(async () => {
    setAppLock(await getSetting<boolean>(SETTINGS_KEYS.appLock, false));
    setIosContinuous(await getSetting<boolean>(SETTINGS_KEYS.iosContinuousSession, false));
    setWorkplace(await getWorkplace());
    setGeoOn(await geofenceEnabled());
    setLlmEnabled(await getSetting<boolean>(SETTINGS_KEYS.llmPostEdit, false));
    setCloudAsr(
      await getSetting(SETTINGS_KEYS.cloudTranscription, { enabled: false, endpoint: "" }),
    );
    const provider = await getProvider();
    const custom = await getCustomServer();
    if (custom) {
      setServerUrl(custom.baseUrl);
      setServerModel(custom.model);
    }
    setLlmProvider(provider);
    setHasKey((await getApiKey(provider)) !== null);
    setStorageMb(Math.round(((await totalStorageBytes()) / (1024 * 1024)) * 10) / 10);
    setPrivacy(await loadPrivacySettings());
    setAutoUpdate(await autoCheckEnabled());
    setDebugEntries(await readDebugLog());

    const [statuses, activeId] = await Promise.all([listModels(), activeModelId()]);
    const installed = statuses.filter((m) => m.installed);
    const active = statuses.find((m) => m.model.id === activeId);
    if (installed.length === 0) setModelSummary("설치된 모델 없음");
    else if (active?.installed) setModelSummary(`${active.model.name} · 보유 ${installed.length}개`);
    else setModelSummary(`선택 모델 미설치 · 보유 ${installed.length}개`);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const router = useRouter();
  const policy = app.policy;
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
      "기록, 전사본, 암기카드 등 모든 데이터가 지워지며 복구할 수 없습니다.",
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
          
  앱스토어 앱이 아니므로 새 버전을 알려 드립니다. 덮어 설치해도 기존 기록은 남습니다.
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
                  label="받으러 가기"
                  tone="primary"
                  onPress={async () => {
                    if (!update.release) return;
                    const ok = await openDownload(update.release);
                    if (!ok) setConnectionMsg("다운로드 페이지를 열 수 없습니다.");
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
          description="배터리와 데이터를 거의 쓰지 않고 가끔씩 새 버전을 확인합니다."
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
                        setGeoMsg("아래에서 근무지를 먼저 지정해 주십시오.");
                        return;
                      }
                      const r = await setGeofence(true);
                      if (!r.ok) {
                        setGeoSetup(true);
                        setGeoMsg(r.message ?? "근무지 감지를 켜지 못했습니다.");
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
        <Small>선택한 방식의 세부 설정이 아래에 나타납니다.</Small>
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
            <Small>듀티표에 해당 코드가 있는 날만 자동으로 기록합니다.</Small>
            <Divider />
            <PresetRow
              label="근무 시작 전 기록 시작"
              value={policy.leadMinutes}
              unit="분"
              options={[10, 20, 30, 45, 60, 90, 120]}
              onSelect={(v) => void app.updatePolicy({ ...policy, leadMinutes: v })}
              hint="인계는 근무표 시각보다 일찍 시작합니다. 인계를 덮을 만큼 잡으십시오. (최대 2시간)"
            />
            <Divider />
            <PresetRow
              label="근무 종료 후 기록 유지"
              value={policy.trailMinutes}
              unit="분"
              options={[10, 20, 30, 45, 60, 90, 120]}
              onSelect={(v) => void app.updatePolicy({ ...policy, trailMinutes: v })}
              hint="퇴근 인계와 늦어지는 마무리가 여기 남습니다. 이 시간이 오버타임의 증거가 됩니다. (최대 2시간)"
            />
          </>
        ) : null}

        {mode === "geo" || geoSetup ? (
          <>
            <Divider />
            <Small muted={false}>근무지</Small>
            <Small>
              병원 반경에 들어오면 기록을 시작하고 벗어나면 끝냅니다. 출퇴근 전후
              오버타임까지 실제 체류 시간이 남습니다. 근무일에만 작동하며 위치 정보는
              기기 밖으로 나가지 않습니다.
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
                <Small>누르면 해제됩니다.</Small>
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
                              ? "찾지 못했습니다. 지점명을 빼거나 철자를 바꿔 보십시오."
                              : "찾지 못했습니다. 정식 명칭(요양기관명)으로 다시 시도해 보십시오."
                            : r.source === "kakao"
                              ? "카카오 지도에서 찾았습니다."
                              : "심평원 병원 목록에서 찾았습니다.",
                        );
                      } catch (e) {
                        setGeoMsg(e instanceof Error ? e.message : "검색에 실패했습니다.");
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
                          setGeoMsg("근무지 자동 기록을 켰습니다.");
                          await app.updatePolicy({ ...policy, enabled: false });
                        } else {
                          setGeoMsg(r.message ?? "근무지 감지를 켜지 못했습니다.");
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
                      setGeoMsg("위치 권한이 없어 지정하지 못했습니다.");
                      return;
                    }
                    setWorkplace(wp);
                    if (geoSetup) {
                      const r = await setGeofence(true);
                      if (r.ok) {
                        setGeoOn(true);
                        setGeoSetup(false);
                        setGeoMsg("근무지 자동 기록을 켰습니다.");
                        await app.updatePolicy({ ...policy, enabled: false });
                      } else {
                        setGeoMsg(r.message ?? "근무지 감지를 켜지 못했습니다.");
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
                ? "위치 권한을 '항상 허용'으로 변경하십시오. Android 14 이상은 백그라운드 제한이 있습니다."
                : "위치 권한을 '항상 허용'으로 변경하십시오."}
            </Small>
          </>
        ) : null}

        <Divider />
        <PresetRow
          label="파일 분할"
          value={policy.segmentMinutes}
          unit="분"
          options={[10, 15, 20, 30]}
          onSelect={(v) => void app.updatePolicy({ ...policy, segmentMinutes: v })}
          hint="긴 근무를 나눕니다. 중간에 끊겨도 안전하며, 완성된 조각부터 전사할 수 있습니다."
        />
        <Divider />
        <PresetRow
          label="보관 기간"
          value={policy.retentionDays}
          unit="일"
          options={[7, 14, 30, 60, 90]}
          onSelect={(v) => void app.updatePolicy({ ...policy, retentionDays: v })}
          hint="보관 기한이 지난 기록은 지워집니다. 오래된 기록을 남겨두면 보안상 위험합니다."
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
            ? "iOS 상단 주황색 마이크 표시는 OS 정책상 앱에서 숨길 수 없습니다."
            : "Android 마이크 표시는 OS 정책입니다. 백그라운드 작동 시 무음 알림이 뜹니다."}
        </Small>
        {Platform.OS === "ios" ? (
          <>
            <Divider />
            <Toggle
              label="연속 세션 유지 (배터리 소모 큼)"
              description="앱을 열지 않아도 백그라운드에서 기록을 시작합니다. 배터리 소모가 큽니다."
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
          description="앱을 열 때 생체인증을 요구합니다. 민감한 기록을 보호합니다."
          value={appLock}
          onChange={async (v) => {
            setAppLock(v);
            await setSetting(SETTINGS_KEYS.appLock, v);
          }}
        />
        <Divider />
        <Badge text="통신비밀보호법" tone="warn" />
        <Small>
          본인이 참여하지 않은 타인 간 대화 기록은 위법입니다(1년 이상 징역).
          앱은 목소리로 사람을 구분하지 못하므로 이를 자동으로 걸러줄 수 없습니다 —
          자리를 비울 때는 기록을 끄거나 기기를 반드시 휴대하십시오.
        </Small>
      </Card>

      {/* 개인정보 가리기 */}
      <Card>
        <GroupHead icon="eye-off-outline" color="#8A5F9E" title="민감 정보 가리기" />
        <Small>
          
  내보내기나 외부 공유 시 이름, 전화번호, 등록번호를 자동으로 가립니다.
</Small>
        <Divider />
        <Badge text="기기 내 저장 시에는 마스킹하지 않습니다" tone="muted" />
        <Small>
          
  전사본은 괴롭힘 신고 시 중요 증거입니다. 정보가 가려지면 효력이 낮아지므로 기기 내 원본은 보존합니다.
</Small>
        <Divider />
        <Toggle
          label="내보낼 때 가리기"
          description="기능을 꺼도 내보내기 전에 포함된 개인정보를 미리 안내해 드립니다."
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
  필수 마스킹 단어
</Small>
        <Small>
          
  자동 인식이 어려운 호칭 없는 이름 등을 등록해 두면 항상 가려줍니다.
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
            placeholder="마스킹 단어 (2자 이상)"
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
          
  자동 가림은 완벽하지 않아 일반명사나 호칭 없는 이름이 누락될 수 있습니다.
<Text style={{ fontWeight: "700" }}>
          
  음성 파일 자체는 가릴 수 없습니다.
</Text> 
  음성에는 이름과 진단명이 그대로 남습니다.
</Small>
      </Card>

      {/* 전사 */}
      <Card>
        <GroupHead icon="text-outline" color="#B3762F" title="전사" />
        <Small>
          
  전사는 기기 내부에서 처리됩니다. 민감 정보 유출은 의료법 위반입니다.
</Small>
        <Divider />
        <Row
          label="전사 모델"
          value={modelSummary}
          onPress={() => router.push("/models")}
        />
        <Small>
          
  모델 크기를 키우는 것보다 한국어 전용 모델을 쓰는 편이 훨씬 정확합니다.
</Small>
        <Divider />
        <Row
          label="노트북·서버로 전사"
          value={cloudAsr.enabled ? "사용 중 ›" : "꺼짐 ›"}
          onPress={() => router.push("/models")}
        />
        <Small>
          같은 Wi-Fi의 노트북이 전사를 대신하는 기능입니다. 켜는 방법과 설정은 전사 모델
          화면에 있습니다.
        </Small>
      </Card>

      {/* 보조 기능 */}
      <Card>
        <GroupHead icon="sparkles-outline" color="#C0553F" title="보조 기능 (선택)" />
        <Small>
          
  요약 등에 AI를 씁니다. 전사본이 외부로 전송되며, 개인정보는 가려지나 완벽하지 않을 수 있습니다.
</Small>
        <Toggle
          label="문맥 교정·근무 요약 사용"
          value={llmEnabled}
          onChange={async (v) => {
            setLlmEnabled(v);
            await setSetting(SETTINGS_KEYS.llmPostEdit, v);
          }}
        />
        {llmEnabled ? (
          <>
            <Small muted={false}>모델 공급자</Small>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {(
                [
                  ["anthropic", "Claude"],
                  ["openai", "GPT"],
                  ["kimi", "Kimi"],
                  ["custom", "내 서버"],
                ] as [LlmProvider, string][]
              ).map(([p, label]) => (
                <View key={p} style={{ flex: 1 }}>
                  <Button
                    label={label}
                    tone={llmProvider === p ? "primary" : "default"}
                    onPress={async () => {
                      setLlmProvider(p);
                      await setProvider(p);
                      setHasKey((await getApiKey(p)) !== null);
                      setConnectionMsg(null);
                    }}
                  />
                </View>
              ))}
            </View>
            <Small>
              Claude·GPT·Kimi 는 API 키 방식입니다 — Kimi 키는 platform.moonshot.ai
              에서 발급하며 가장 저렴한 축입니다. &lsquo;내 서버&rsquo;는 VPS 나 집
              컴퓨터의 Ollama·vLLM 같은 OpenAI 호환 서버로 보냅니다 — 유료 API 없이
              보조 기능을 쓸 수 있고, 전사본이 내 서버 밖으로 나가지 않습니다.
            </Small>
            {llmProvider === "custom" ? (
              <>
                <TextInput
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  placeholder="서버 주소 (예: http://100.64.0.2:11434/v1)"
                  placeholderTextColor={t.textMuted}
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
                <TextInput
                  value={serverModel}
                  onChangeText={setServerModel}
                  placeholder="모델 이름 (예: qwen2.5:14b)"
                  placeholderTextColor={t.textMuted}
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
                  label="서버 저장"
                  tone="primary"
                  onPress={async () => {
                    if (!serverUrl.trim() || !serverModel.trim()) return;
                    await setCustomServer({ baseUrl: serverUrl.trim(), model: serverModel.trim() });
                    setConnectionMsg("저장했습니다. 하단 연결 테스트를 진행해 주십시오.");
                  }}
                />
                <Small>
                  집 밖에서도 쓰려면 Tailscale 로 서버에 고정 주소를 붙이는 것이 가장
                  쉽습니다. 키가 필요한 서버라면 아래 칸에 키를 저장하십시오.
                </Small>
              </>
            ) : null}
            <TextInput
              value={apiKeyInput}
              onChangeText={setApiKeyInput}
              placeholder={hasKey ? "키가 저장되어 있습니다" : "API 키 입력"}
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
            <Small>
              
  API 키는 기기의 보안 저장소에 안전하게 보관됩니다.
</Small>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="저장"
                  onPress={async () => {
                    if (!apiKeyInput.trim()) return;
                    await setApiKey(apiKeyInput.trim(), llmProvider);
                    setApiKeyInput("");
                    setHasKey(true);
                    setConnectionMsg(null);
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="연결 테스트"
                  onPress={async () => {
                    const result = await testConnection();
                    setConnectionMsg(result.message);
                  }}
                />
              </View>
            </View>
            {connectionMsg ? <Small muted={false}>{connectionMsg}</Small> : null}
          </>
        ) : null}
      </Card>

      {/* 디버그 */}
      <Card>
        <GroupHead icon="bug-outline" color="#6B7280" title="디버그" />
        <Small>
          앱에서 잡힌 오류가 여기 남습니다. 문제가 생기면 아래 버튼으로 보고해
          주십시오 — 기기 정보와 최근 오류가 채워진 GitHub 이슈 화면이 열립니다.
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
              ? <Small>기록된 오류가 없습니다.</Small>
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
                if (!ok) setConnectionMsg("브라우저를 열지 못했습니다.");
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
          
  모든 데이터를 영구 삭제합니다. 복구할 수 없습니다.
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
