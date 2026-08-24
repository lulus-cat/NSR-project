import { useCallback, useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Switch, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { DEFAULT_RECORDING_POLICY, type ShiftCode } from "@nsr/core";
import { Badge, Body, Button, Card, Divider, HeaderScreen, Heading, Row, Small } from "../../src/components/ui";
import { radius, space, type, useTheme } from "../../src/theme";
import { useApp } from "../../src/state/AppContext";
import { getSetting, resetDbHandle, setSetting, totalStorageBytes } from "../../src/db";
import { SETTINGS_KEYS, platformCapability } from "../../src/services/scheduler";
import { deleteAllRecordings } from "../../src/services/files";
import { getApiKey, setApiKey, testConnection } from "../../src/services/llm";
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

export default function Settings() {
  const t = useTheme();
  const app = useApp();
  const [appLock, setAppLock] = useState(false);
  const [iosContinuous, setIosContinuous] = useState(false);
  const [discardWithoutSelf, setDiscardWithoutSelf] = useState(true);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(false);
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
    setDiscardWithoutSelf(await getSetting<boolean>(SETTINGS_KEYS.discardWithoutSelf, true));
    setLlmEnabled(await getSetting<boolean>(SETTINGS_KEYS.llmPostEdit, false));
    setCloudAsr(
      await getSetting(SETTINGS_KEYS.cloudTranscription, { enabled: false, endpoint: "" }),
    );
    setHasKey((await getApiKey()) !== null);
    setStorageMb(Math.round(((await totalStorageBytes()) / (1024 * 1024)) * 10) / 10);
    setPrivacy(await loadPrivacySettings());
    setAutoUpdate(await autoCheckEnabled());

    const [statuses, activeId] = await Promise.all([listModels(), activeModelId()]);
    const installed = statuses.filter((m) => m.installed);
    const active = statuses.find((m) => m.model.id === activeId);
    if (installed.length === 0) setModelSummary("받아 둔 모델 없음");
    else if (active?.installed) setModelSummary(`${active.model.name} · 받아 둔 것 ${installed.length}개`);
    else setModelSummary(`고른 모델 미설치 · 받아 둔 것 ${installed.length}개`);
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
      "녹음 파일, 전사본, 학습카드, 근무 기록이 전부 삭제됩니다. 되돌릴 수 없습니다.",
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
    <HeaderScreen
      title="설정"
      heroLabel="저장된 녹음"
      hero={`${storageMb} MB`}
      rows={[
        { label: "보관 한도", value: `${policy.maxStorageMb} MB` },
        { label: "보관 기간", value: `${policy.retentionDays}일` },
      ]}
    >
      {/* 판 번호와 업데이트 */}
      <Card tone={update?.show ? "accent" : "default"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Heading>앱 버전</Heading>
          <Badge text="알파" tone="warn" />
        </View>
        <Small muted={false}>{version ? `지금 ${version}` : "개발 중 실행"}</Small>
        <Small>
          스토어가 아니라 APK 로 나눠 쓰는 앱이라, 새 판이 나오면 여기서 알려 드립니다.
          받은 뒤 기존 앱 위에 덮어 설치하면 녹음과 전사본이 그대로 남습니다.
        </Small>

        {update?.show && update.release ? (
          <>
            <Divider />
            <Small muted={false}>{update.message}</Small>
            {update.highlights.map((h, i) => (
              <Small key={i}>· {h}</Small>
            ))}
            {update.release.apkSizeMb > 0 ? (
              <Small>내려받을 크기 약 {update.release.apkSizeMb} MB</Small>
            ) : null}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="받으러 가기"
                  tone="primary"
                  onPress={async () => {
                    if (!update.release) return;
                    const ok = await openDownload(update.release);
                    if (!ok) setConnectionMsg("받는 곳을 열지 못했습니다.");
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="이 판 건너뛰기"
                  onPress={async () => {
                    if (!update.version) return;
                    await skipVersion(update.version);
                    setUpdate({ ...update, show: false, message: "건너뛰기로 해 두었습니다." });
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
          label="새 판이 나오면 알려주기"
          description="하루에 몇 번만 확인합니다. 배터리와 데이터를 거의 쓰지 않습니다."
          value={autoUpdate}
          onChange={async (v) => {
            setAutoUpdate(v);
            await setAutoCheck(v);
          }}
        />
        <Small>릴리스: github.com/{RELEASE_REPO}/releases</Small>
      </Card>

      {/* 녹음 */}
      <Card>
        <Heading>자동 녹음</Heading>
        <Toggle
          label="듀티표에 따라 자동 녹음"
          description={capability.explanation}
          value={policy.enabled}
          onChange={(v) => void app.updatePolicy({ ...policy, enabled: v })}
        />
        <Divider />
        <Small muted={false}>녹음할 근무</Small>
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
          label="근무 시작 전 녹음 시작"
          value={`${policy.leadMinutes}분 전`}
        />
        <Small>
          인계는 근무표 시각보다 이르게 시작합니다. 이 값이 인계 시간보다 짧으면 가장 중요한 부분을 놓칩니다.
        </Small>
        <Divider />
        <Row label="파일 분할" value={`${policy.segmentMinutes}분`} />
        <Small>
          8시간을 한 파일에 담지 않습니다. 손상 시 전부 잃고, 근무 중 전사도 못 합니다.
        </Small>
        <Divider />
        <Row label="보관 기간" value={`${policy.retentionDays}일`} />
        <Small>
          기간이 지난 녹음은 자동으로 지워집니다. 오래된 녹음을 쌓아두는 것이 가장 큰 위험입니다.
        </Small>
        <Divider />
        <Row label="현재 사용 중" value={`${storageMb} MB / ${policy.maxStorageMb} MB`} />
      </Card>

      {/* 조용함 */}
      <Card>
        <Heading>조용히 동작</Heading>
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
            ? "iOS의 주황색 마이크 표시와 제어센터의 사용 기록은 OS가 강제하는 것이라 어떤 앱도 끌 수 없습니다."
            : "Android의 마이크 인디케이터와 개인정보 대시보드 기록은 OS가 강제합니다. 또 백그라운드 녹음에는 알림 하나가 반드시 떠 있어야 하며, 이 알림은 소리·진동 없이 목록 안쪽에만 표시되도록 설정되어 있습니다."}
        </Small>
        {Platform.OS === "ios" ? (
          <>
            <Divider />
            <Toggle
              label="연속 세션 유지 (배터리 소모 큼)"
              description="근무 사이에도 오디오 세션을 놓지 않아 앱을 열지 않아도 자동으로 시작됩니다. 배터리가 빠르게 답니다."
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
        <Heading>개인정보</Heading>
        <Toggle
          label="앱 잠금"
          description="열 때마다 생체인증을 요구합니다. 녹음에는 환자 정보가 포함될 수 있습니다."
          value={appLock}
          onChange={async (v) => {
            setAppLock(v);
            await setSetting(SETTINGS_KEYS.appLock, v);
          }}
        />
        <Divider />
        <Toggle
          label="본인 음성이 없는 구간 자동 폐기"
          description="통신비밀보호법은 내가 참여하지 않은 타인간 대화의 녹음을 금지합니다. 이 설정을 끄면 그 위험을 본인이 지게 됩니다. 켜두시는 것을 강하게 권합니다."
          value={discardWithoutSelf}
          onChange={async (v) => {
            if (!v) {
              Alert.alert(
                "정말 끄시겠습니까",
                "내가 없는 자리에서 남들끼리 나눈 대화가 녹음되면 통신비밀보호법 위반이며, 벌금형 없이 1년 이상의 징역형 대상입니다.",
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
        <Heading>환자 정보 가리기</Heading>
        <Small>
          전사본이 기기 밖으로 나갈 때 — 보고서를 내보내거나 공유할 때, 보조 기능으로
          보낼 때 — 이름·전화번호·등록번호를 자동으로 가립니다.
        </Small>
        <Divider />
        <Badge text="저장할 때는 가리지 않습니다" tone="muted" />
        <Small>
          전사본은 증거입니다. 태움 신고나 노동위원회 절차에서 쓰일 수 있고, 그때
          누구에 대한 이야기였는지가 통째로 지워져 있으면 증거로서 값이 떨어집니다.
          그래서 원본은 그대로 두고 나갈 때만 가립니다.
        </Small>
        <Divider />
        <Toggle
          label="내보낼 때 가리기"
          description="꺼도 무엇이 들어 있는지는 내보내기 전에 알려 드립니다."
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
        <Small muted={false}>반드시 가릴 말</Small>
        <Small>
          자동으로는 못 잡는 이름이 있습니다. 호칭 없이 부르는 이름(&ldquo;영희야&rdquo;)이
          특히 그렇습니다. 여기 적어 두면 항상 가립니다.
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
            placeholder="가릴 말 (2글자 이상)"
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
          가리기는 완전하지 않습니다. 한국어 이름은 일반명사와 겹치고, 호칭 없이
          이름만 부르면 잡을 방법이 사실상 없습니다. 그리고 <Text style={{ fontWeight: "700" }}>
          음성 파일 자체는 가릴 수 없습니다</Text> — 목소리에는 이름과 진단이 그대로 담깁니다.
        </Small>
      </Card>

      {/* 전사 */}
      <Card>
        <Heading>전사</Heading>
        <Small>
          기본은 기기 안에서 처리합니다. 병동 대화에는 환자 정보가 들어 있어 외부로 보내는 것은
          의료법 제19조가 걸리는 행위입니다.
        </Small>
        <Divider />
        <Row
          label="전사 모델"
          value={modelSummary}
          onPress={() => router.push("/models")}
        />
        <Small>
          기기 성능과 상황에 따라 골라 씁니다. 크기를 키우는 것보다 한국어로 학습된
          모델을 쓰는 쪽이 훨씬 크게 먹힙니다.
        </Small>
        <Divider />
        <Toggle
          label="자체 서버로 전사"
          description="본인이 띄운 faster-whisper 서버나 병원 내부 서버를 쓸 때만 켜세요. 임의의 상용 API로 보내는 경로는 제공하지 않습니다."
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
            placeholder="https://내서버/transcribe"
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
        <Heading>보조 기능 (선택)</Heading>
        <Small>
          규칙으로 못 푸는 것 — 문맥에 따라 뜻이 갈리는 약어, 흩어진 지시를 하나로 묶기,
          근무 요약 — 에만 모델을 씁니다. 켜면 전사본이 기기를 벗어나며, 전송 직전 비식별화가
          자동 적용됩니다. 비식별화는 완전하지 않습니다.
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
              키는 이 기기의 보안 저장소(iOS 키체인 / Android 키스토어)에만 저장되고
              앱 번들에는 들어가지 않습니다.
            </Small>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="저장"
                  onPress={async () => {
                    if (!apiKeyInput.trim()) return;
                    await setApiKey(apiKeyInput.trim());
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
        <Heading>데이터 삭제</Heading>
        <Body muted>
          녹음 파일, 전사본, 학습카드, 근무 기록을 전부 지웁니다. 되돌릴 수 없습니다.
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
    </HeaderScreen>
  );
}
