import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Platform, ScrollView, Switch, TextInput, View } from "react-native";
import type { ComponentProps, ReactNode } from "react";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { DEFAULT_RECORDING_POLICY, type ShiftCode } from "@nsr/core";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Badge, Body, Button, Card, Divider, Heading, Row, Small } from "../../src/components/ui";
import { radius, space, type, useTheme } from "../../src/theme";
import { useApp } from "../../src/state/AppContext";
import { getSetting, resetDbHandle, setSetting, totalStorageBytes } from "../../src/db";
import { SETTINGS_KEYS, platformCapability } from "../../src/services/scheduler";
import { deleteAllRecordings } from "../../src/services/files";
import {
  hasKakaoKey,
  hasPublicDataKey,
  setKakaoKey,
  setPublicDataKey,
} from "../../src/services/publicdata";
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
  const [hospitalQuery, setHospitalQuery] = useState("");
  const [hospitalHits, setHospitalHits] = useState<PlaceHit[]>([]);
  const [publicKeyInput, setPublicKeyInput] = useState("");
  const [hasPublicKey, setHasPublicKey] = useState(false);
  const [kakaoInput, setKakaoInput] = useState("");
  const [hasKakao, setHasKakao] = useState(false);
  const [discardWithoutSelf, setDiscardWithoutSelf] = useState(true);
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

  const load = useCallback(async () => {
    setAppLock(await getSetting<boolean>(SETTINGS_KEYS.appLock, false));
    setIosContinuous(await getSetting<boolean>(SETTINGS_KEYS.iosContinuousSession, false));
    setWorkplace(await getWorkplace());
    setHasPublicKey(await hasPublicDataKey());
    setHasKakao(await hasKakaoKey());
    setGeoOn(await geofenceEnabled());
    setDiscardWithoutSelf(await getSetting<boolean>(SETTINGS_KEYS.discardWithoutSelf, true));
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
      "모든 데이터를 지웁니다",
      "기록 파일, 전사본, 학습 카드, 근무 기록이 모두 삭제되며 복구할 수 없습니다.",
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
    <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.bottom, gap: space.md }}>
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
        <Small muted={false}>{version ? `지금 ${version}` : "개발 중 실행"}</Small>
        <Small>
          
  스토어가 아닌 APK 설치 앱이므로 새 버전이 나오면 알려 드립니다. 다운로드 후 덮어 설치하면 기존 기록이 유지됩니다.
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
                    if (!ok) setConnectionMsg("다운로드 페이지를 열지 못했습니다.");
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
          description="하루 몇 회만 확인하여 배터리와 데이터를 거의 사용하지 않습니다."
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
        <Toggle
          label="듀티표에 따라 자동 기록"
          description={capability.explanation}
          value={policy.enabled}
          onChange={(v) => void app.updatePolicy({ ...policy, enabled: v })}
        />
        <Divider />
        <Small muted={false}>기록할 근무</Small>
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          {(["D", "E", "N", "EDU"] as ShiftCode[]).map((code) => {
            const on = policy.codes.includes(code);
            return (
              <Button
                key={code}
                label={code}
                tone={on ? "primary" : "default"}
                onPress={() => toggleCode(code)}
              />
            );
          })}
        </View>
        <Divider />
        <Row
          label="근무 시작 전 기록 시작"
          value={`${policy.leadMinutes}분 전`}
        />
        <Small>
          
  인계는 근무표 시각보다 일찍 시작합니다. 설정 시간이 인계보다 짧으면 주요 내용을 놓칠 수 있습니다.
</Small>
        <Divider />
        <Row label="파일 분할" value={`${policy.segmentMinutes}분`} />
        <Small>
          
  8시간을 한 파일로 저장하지 않습니다. 파일 손실을 막고 근무 중 전사를 가능하게 합니다.
</Small>
        <Divider />
        <Row label="보관 기간" value={`${policy.retentionDays}일`} />
        <Small>
          
  보관 기간이 지난 기록은 자동 삭제됩니다. 오래된 기록 보관은 보안상 위험합니다.
</Small>
        <Divider />
        <Row label="현재 사용 중" value={`${storageMb} MB / ${policy.maxStorageMb} MB`} />
      </Card>

      {/* 근무지 지오펜스 */}
      <Card>
        <GroupHead icon="location-outline" color="#2E9AA8" title="근무지에서 자동 기록" />
        <Small>
          
  병원 반경 진입 시 기록을 시작하고 벗어나면 종료합니다. 출퇴근 전후 오버타임까지 실제 체류 시간을 기록합니다. 근무일에만 작동하여 오프에는 기록되지 않으며 위치 정보는 외부로 유출되지 않습니다.
</Small>
        <Divider />
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
                  setGeoMsg(null);
                }}
              />
            ))}
            <Small>
              카카오 지도(키가 있으면)나 심평원 병원 목록에서 찾습니다. 검색어만 나가고 내
              위치는 보내지 않습니다. 키는 아래 &lsquo;검색·데이터 키&rsquo; 카드에서 넣습니다.
            </Small>
            <Button
              label="지금 있는 곳을 근무지로"
              onPress={async () => {
                const wp = await setWorkplaceHere();
                if (wp) {
                  setWorkplace(wp);
                  setGeoMsg(null);
                } else {
                  setGeoMsg("위치 권한이 없어 지정하지 못했습니다.");
                }
              }}
            />
          </>
        )}
        <Toggle
          label="지오펜스 자동 기록"
          description={
            Platform.OS === "android"
              ? "위치 권한을 '항상 허용'으로 설정해야 합니다. Android 14 이상에서는 백그라운드 기록 제한으로 앱 실행 시 시작될 수 있습니다."
              : "위치 권한을 '항상 허용'으로 변경해야 합니다."
          }
          value={geoOn}
          onChange={async (v) => {
            const r = await setGeofence(v);
            setGeoOn(v && r.ok);
            setGeoMsg(r.ok ? null : (r.message ?? null));
          }}
        />
        {geoMsg ? <Small muted={false}>{geoMsg}</Small> : null}
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
            ? "iOS 주황색 마이크 표시와 제어센터 기록은 OS 정책상 임의로 끌 수 없습니다."
            : "Android 마이크 표시와 개인정보 기록은 OS 정책입니다. 백그라운드 기록 시 필수 알림이 발생하며, 소리·진동 없이 무음으로 표시됩니다."}
        </Small>
        {Platform.OS === "ios" ? (
          <>
            <Divider />
            <Toggle
              label="연속 세션 유지 (배터리 소모 큼)"
              description="오디오 세션을 계속 유지하여 앱을 열지 않아도 기록이 시작됩니다. 배터리 소모가 큽니다."
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
          description="앱 실행 시 생체인증을 확인합니다. 기록에는 민감한 내용이 포함될 수 있습니다."
          value={appLock}
          onChange={async (v) => {
            setAppLock(v);
            await setSetting(SETTINGS_KEYS.appLock, v);
          }}
        />
        <Divider />
        <Toggle
          label="본인 음성이 없는 구간 자동 폐기"
          description="통신비밀보호법상 대화 당사자가 아닌 타인 간 대화 기록은 금지됩니다. 법적 보호를 위해 이 설정을 유지하십시오."
          value={discardWithoutSelf}
          onChange={async (v) => {
            if (!v) {
              Alert.alert(
                "정말 해제하시겠습니까",
                "본인이 참여하지 않은 타인 간 대화 기록은 통신비밀보호법 위반이며, 벌금형 없이 1년 이상 징역형 대상입니다.",
                [
                  { text: "취소", style: "cancel" },
                  {
                    text: "그래도 끄기",
                    style: "destructive",
                    onPress: async () => {
                      setDiscardWithoutSelf(false);
                      await setSetting(SETTINGS_KEYS.discardWithoutSelf, false);
                    },
                  },
                ],
              );
              return;
            }
            setDiscardWithoutSelf(true);
            await setSetting(SETTINGS_KEYS.discardWithoutSelf, true);
          }}
        />
      </Card>

      {/* 개인정보 가리기 */}
      <Card>
        <GroupHead icon="eye-off-outline" color="#8A5F9E" title="민감 정보 가리기" />
        <Small>
          
  보고서 내보내기, 공유, 외부 기능 송신 시 이름·전화번호·등록번호를 자동으로 마스킹합니다.
</Small>
        <Divider />
        <Badge text="기기 내 저장 시에는 마스킹하지 않습니다" tone="muted" />
        <Small>
          
  전사본은 직장 내 괴롭힘 신고나 노동위원회 제출 시 증거가 됩니다. 대상자 정보가 지워지면 증거 효력이 낮아지므로 원본은 유지하고 내보낼 때만 가립니다.
</Small>
        <Divider />
        <Toggle
          label="내보낼 때 가리기"
          description="기능을 꺼도 내보내기 전 포함된 개인정보를 미리 안내합니다."
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
          
  호칭 없는 이름 등 자동 인식이 어려운 단어를 등록하면 항상 마스킹 처리합니다.
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
          
  자동 마스킹은 완벽하지 않습니다. 일반명사와 겹치거나 호칭이 없는 이름은 누락될 수 있으며,
<Text style={{ fontWeight: "700" }}>
          
  음성 파일 자체는 마스킹할 수 없습니다
</Text> 
  — 음성에는 이름과 진단명이 그대로 포함됩니다.
</Small>
      </Card>

      {/* 검색·데이터 키 */}
      <Card>
        <GroupHead icon="key-outline" color="#3E7BB6" title="검색·데이터 키 (무료)" />
        <Small>
          키는 앱에 내장되어 배포되므로 보통 아무것도 입력할 필요가 없습니다. 여기는 내장
          키의 트래픽이 소진됐거나 내 키를 따로 쓰고 싶을 때를 위한 칸입니다 — 내 키가 항상
          우선합니다. 모두 무료이고 이 기기의 보안 저장소에만 저장됩니다.
        </Small>
        <Divider />
        <Small muted={false}>카카오 REST 키 — 근무지 지도 검색</Small>
        <Small>
          developers.kakao.com → 내 애플리케이션 만들기 → 앱 키의 &lsquo;REST API 키&rsquo;를
          붙여넣으십시오. 카드 등록 없이 발급됩니다.
        </Small>
        <TextInput
          value={kakaoInput}
          onChangeText={setKakaoInput}
          placeholder={hasKakao ? "키가 있습니다 (공유 키 포함)" : "카카오 REST API 키 입력"}
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
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              label="저장"
              tone="primary"
              onPress={async () => {
                if (!kakaoInput.trim()) return;
                await setKakaoKey(kakaoInput.trim());
                setKakaoInput("");
                setHasKakao(true);
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="삭제"
              onPress={async () => {
                await setKakaoKey(null);
                setHasKakao(await hasKakaoKey());
              }}
            />
          </View>
        </View>
        <Divider />
        <Small muted={false}>공공데이터포털 키 — 심평원 병원 목록 · e약은요 의약품</Small>
        <Small>
          data.go.kr 가입 → 각 서비스 활용신청 → 마이페이지의 일반 인증키(Decoding)를
          붙여넣으십시오.
        </Small>
        <TextInput
          value={publicKeyInput}
          onChangeText={setPublicKeyInput}
          placeholder={hasPublicKey ? "키가 있습니다 (공유 키 포함)" : "공공데이터포털 인증키 입력"}
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
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              label="저장"
              tone="primary"
              onPress={async () => {
                if (!publicKeyInput.trim()) return;
                await setPublicDataKey(publicKeyInput.trim());
                setPublicKeyInput("");
                setHasPublicKey(true);
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="삭제"
              onPress={async () => {
                await setPublicDataKey(null);
                setHasPublicKey(await hasPublicDataKey());
              }}
            />
          </View>
        </View>
      </Card>

      {/* 전사 */}
      <Card>
        <GroupHead icon="text-outline" color="#B3762F" title="전사" />
        <Small>
          
  전사는 기본적으로 기기 내에서 처리됩니다. 민감 정보 유출은 의료법 제19조 위반 대상입니다.
</Small>
        <Divider />
        <Row
          label="전사 모델"
          value={modelSummary}
          onPress={() => router.push("/models")}
        />
        <Small>
          
  기기 성능에 맞춰 선택하십시오. 모델 크기보다 한국어 학습 모델을 사용하는 것이 정확도 향상에 훨씬 효과적입니다.
</Small>
        <Divider />
        <Toggle
          label="노트북·서버로 전사"
          description="같은 Wi-Fi의 노트북에 whisper 서버를 켜 두면 폰보다 몇 배 빠릅니다. 켜는 방법은 전사 모델 화면에 있습니다. 기록 음성이 그 서버로 전송되므로 내 컴퓨터에만 연결하십시오."
          value={cloudAsr.enabled}
          onChange={async (v) => {
            const next = { ...cloudAsr, enabled: v };
            setCloudAsr(next);
            await setSetting(SETTINGS_KEYS.cloudTranscription, next);
          }}
        />
        {cloudAsr.enabled ? (
          <TextInput
            value={cloudAsr.endpoint}
            onChangeText={async (endpoint) => {
              const next = { ...cloudAsr, endpoint };
              setCloudAsr(next);
              await setSetting(SETTINGS_KEYS.cloudTranscription, next);
            }}
            placeholder="http://192.168.0.10:8000"
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
        ) : null}
      </Card>

      {/* 보조 기능 */}
      <Card>
        <GroupHead icon="sparkles-outline" color="#C0553F" title="보조 기능 (선택)" />
        <Small>
          
  문맥상 약어 해석, 지시사항 정돈, 근무 요약 등에 AI 모델을 사용합니다. 활성화 시 전사본이 외부로 전송되며, 자동 비식별화가 적용되나 완벽하지 않을 수 있습니다.
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
              Claude·GPT 는 API 키 방식입니다. &lsquo;내 서버&rsquo;는 VPS 나 집
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
                    setConnectionMsg("저장했습니다. 아래 연결 테스트로 확인하십시오.");
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
              
  API 키는 기기의 보안 저장소(iOS 키체인 / Android 키스토어)에만 안전하게 보관됩니다.
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

      {/* 초기화 */}
      <Card>
        <GroupHead icon="trash-outline" color="#B3402F" title="데이터 삭제" />
        <Body muted>
          
  기록 파일, 전사본, 학습 카드, 근무 기록을 모두 삭제합니다. 복구할 수 없습니다.
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
