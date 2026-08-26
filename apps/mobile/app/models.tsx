import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native";
import {
  KOREAN_MODEL_GUIDE,
  estimateMinutes,
  checkFeasible,
  type AsrModel,
  type SpeedSample,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { CONTENT_MAX, radius, space, type, useTheme } from "../src/theme";
import {
  addCustomModel,
  activeDownloads,
  cancelDownload,
  subscribeDownloads,
  deleteModelFile,
  downloadModel,
  listModels,
  loadSpeedSample,
  removeCustomModel,
  setActiveModel,
  type DownloadProgress,
  type ModelStatus,
} from "../src/services/models";
import { getSetting, setSetting } from "../src/db";
import { SETTINGS_KEYS } from "../src/services/scheduler";

interface ServerAsr {
  enabled: boolean;
  endpoint: string;
  model?: string;
}

/** 노트북(speaches 등)이 받아 쓰는 한국어 CT2 모델. 러너로 파일 구성을 확인해 둔 id 다. */
const KOREAN_SERVER_MODEL = "ghost613/faster-whisper-large-v3-turbo-korean";

/** 8시간 근무에서 VAD로 무음을 걷어내면 실제 발화는 대략 이 정도다. */
const TYPICAL_SPEECH_MINUTES = 90;

function familyLabel(model: AsrModel): { text: string; tone: "ok" | "warn" | "muted" } {
  if (model.family === "whisper-korean") return { text: "한국어 학습됨", tone: "ok" };
  if (model.family === "custom") return { text: "직접 넣음", tone: "muted" };
  return { text: "원본", tone: "muted" };
}

function ProgressBar({ ratio }: { ratio: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        height: 6,
        borderRadius: radius.sm,
        backgroundColor: t.surfaceAlt,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`,
          height: "100%",
          backgroundColor: t.accent,
        }}
      />
    </View>
  );
}

function ModelCard({
  status,
  sample,
  progress,
  onDownload,
  onCancel,
  onDelete,
  onUse,
}: {
  status: ModelStatus;
  sample?: SpeedSample;
  progress?: DownloadProgress;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onUse: () => void;
}) {
  const t = useTheme();
  const { model, installed, active, actualSizeMb } = status;
  const family = familyLabel(model);

  const estimate = estimateMinutes(model, TYPICAL_SPEECH_MINUTES, sample);
  const feasible = checkFeasible(estimate, 12);
  const downloading = progress !== undefined;

  return (
    <Card tone={active ? "accent" : "default"}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: space.sm,
        }}
      >
        <Text style={[type.heading, { color: t.text, flexShrink: 1 }]}>{model.name}</Text>
        {active ? <Badge text="사용 중" tone="ok" /> : <Badge text={family.text} tone={family.tone} />}
      </View>

      <Small>{model.guidance}</Small>

      <Divider />

      <View style={{ gap: space.xs }}>
        <Small muted={false}>
          크기 {installed && actualSizeMb > 0 ? `${actualSizeMb} MB` : `약 ${model.approxSizeMb} MB`}
          {installed ? " · 받아 둠" : ""}
        </Small>
        <Small>
          한국어 정확도{" "}
          {model.korean
            ? `문자 오류율 ${model.korean.cer}% (${model.korean.source})`
            : "공개된 실측 데이터가 없습니다"}
        </Small>
        <Small>
          8시간 근무 전사 예상 시간: {estimate.label}
          {estimate.estimated && estimate.minutes > 0 ? "(타 모델 측정값 기준 환산)" : ""}
        </Small>
        {!feasible.ok && feasible.reason ? (
          <Small muted={false}>⚠ {feasible.reason}</Small>
        ) : null}
      </View>

      {downloading ? (
        <>
          <ProgressBar ratio={progress.ratio} />
          <Small>
            {progress.totalMb > 0
              ? `${progress.receivedMb} / ${progress.totalMb} MB`
              : `${progress.receivedMb} MB 다운로드 중`}
          </Small>
          <Button label="취소" onPress={onCancel} />
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          {!installed ? (
            <View style={{ flex: 1, minWidth: 120 }}>
              <Button
                label={model.url ? "내려받기" : "주소 없음"}
                tone="primary"
                disabled={!model.url}
                onPress={onDownload}
              />
            </View>
          ) : null}
          {installed && !active ? (
            <View style={{ flex: 1, minWidth: 120 }}>
              <Button label="이걸로 전사" tone="primary" onPress={onUse} />
            </View>
          ) : null}
          {installed ? (
            <View style={{ flex: 1, minWidth: 100 }}>
              <Button label="지우기" onPress={onDelete} />
            </View>
          ) : null}
          {model.family === "custom" && !installed ? (
            <View style={{ flex: 1, minWidth: 100 }}>
              <Button label="목록에서 빼기" onPress={onDelete} />
            </View>
          ) : null}
        </View>
      )}
    </Card>
  );
}

export default function Models() {
  const t = useTheme();
  const [statuses, setStatuses] = useState<ModelStatus[]>([]);
  const [sample, setSample] = useState<SpeedSample | undefined>();
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", file: "", url: "", sizeMb: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [server, setServer] = useState<ServerAsr>({ enabled: false, endpoint: "" });

  const load = useCallback(async () => {
    setStatuses(await listModels());
    setSample(await loadSpeedSample());
    setServer(
      await getSetting<ServerAsr>(SETTINGS_KEYS.cloudTranscription, {
        enabled: false,
        endpoint: "",
      }),
    );
  }, []);

  const saveServer = useCallback(async (next: ServerAsr) => {
    setServer(next);
    await setSetting(SETTINGS_KEYS.cloudTranscription, next);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 진행은 서비스가 브로드캐스트한다 — 화면을 나갔다 와도 받던 자리부터 보인다.
  useEffect(() => {
    setProgress(activeDownloads());
    return subscribeDownloads((id, p) => {
      setProgress((prev) => {
        const next = { ...prev };
        if (p) next[id] = p;
        else delete next[id];
        return next;
      });
    });
  }, []);

  const start = useCallback(
    async (model: AsrModel) => {
      const outcome = await downloadModel(model);
      await load();

      if (outcome.canceled) return;
      if (!outcome.ok) {
        Alert.alert("다운로드에 실패했습니다", outcome.error ?? "알 수 없는 오류입니다.");
        return;
      }
      // 처음 받은 모델이면 바로 쓰게 한다. 받아 놓고 안 고르는 실수를 막는다.
      const installedCount = (await listModels()).filter((s) => s.installed).length;
      if (installedCount === 1) {
        await setActiveModel(model.id);
        await load();
      }
    },
    [load],
  );

  const confirmDownload = useCallback(
    (model: AsrModel) => {
      Alert.alert(
        `${model.name} 다운로드`,
        `약 ${model.approxSizeMb} MB를 받습니다. Wi-Fi 사용을 권장합니다.`,
        [
          { text: "취소", style: "cancel" },
          { text: "받기", onPress: () => void start(model) },
        ],
      );
    },
    [start],
  );

  const confirmDelete = useCallback(
    (status: ModelStatus) => {
      const { model } = status;
      Alert.alert(
        `${model.name} 삭제`,
        status.active
          ? "사용 중인 모델입니다. 지우면 다른 모델로 전사합니다."
          : "모델 파일만 지워지며 언제든 다시 받을 수 있습니다.",
        [
          { text: "취소", style: "cancel" },
          {
            text: "지우기",
            style: "destructive",
            onPress: async () => {
              if (model.family === "custom") await removeCustomModel(model.id);
              else deleteModelFile(model);
              await load();
            },
          },
        ],
      );
    },
    [load],
  );

  const submitCustom = useCallback(async () => {
    const sizeMb = Number(form.sizeMb);
    const result = await addCustomModel({
      name: form.name,
      file: form.file,
      url: form.url.trim() || undefined,
      approxSizeMb: Number.isFinite(sizeMb) && sizeMb > 0 ? sizeMb : undefined,
    });
    if (!result.ok) {
      setFormError(result.error ?? "추가하지 못했습니다.");
      return;
    }
    setForm({ name: "", file: "", url: "", sizeMb: "" });
    setFormError(null);
    setAdding(false);
    await load();
  }, [form, load]);

  const input = {
    color: t.text,
    backgroundColor: t.surfaceAlt,
    borderRadius: radius.md,
    padding: space.md,
    fontSize: 14,
  };

  const installedCount = statuses.filter((s) => s.installed).length;

  return (
    <ScrollView
      contentContainerStyle={{
        padding: space.lg,
        gap: space.md,
        width: "100%",
        maxWidth: CONTENT_MAX,
        alignSelf: "center",
      }}
    >
      <Card>
        <Heading>전사 모델</Heading>
        <Body muted>
          
  전사는 기기에서 직접 처리합니다. 성능에 맞는 모델을 선택하십시오.
</Body>
        <Divider />
        <Small muted={false}>
  모델 크기보다 한국어 최적화가 중요합니다
</Small>
        <Small>
          {KOREAN_MODEL_GUIDE.why} 
  모델 크기를 키우는 것보다 한국어 파인튜닝 모델을 쓰는 편이 훨씬 정확합니다.
</Small>
        {installedCount === 0 ? (
          <>
            <Divider />
            <Small muted={false}>
              
  설치된 모델이 없습니다. 음성을 전사하려면 모델을 받아주십시오.
</Small>
          </>
        ) : null}
      </Card>

      {/* 노트북·서버 전사 — 폰이 느릴 때의 탈출구 */}
      <Card tone={server.enabled ? "accent" : "default"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Heading>노트북·서버로 전사</Heading>
          {server.enabled ? <Badge text="사용 중" tone="ok" /> : null}
        </View>
        <Small>
          같은 Wi-Fi의 노트북이 전사를 대신합니다. 폰보다 몇 배 빠르고 배터리를 아낍니다.
          기록 음성이 그 서버로 전송되므로 <Text style={{ fontWeight: "700" }}>내 컴퓨터에만</Text>{" "}
          연결하십시오.
        </Small>
        <Divider />
        <Small muted={false}>노트북에서 한 번만 하면 됩니다</Small>
        <Small>1. Docker(docker.com) 설치 후 터미널에 입력:</Small>
        <View style={{ backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
          <Text selectable style={{ color: t.text, fontFamily: "monospace", fontSize: 12 }}>
            docker run -d -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
          </Text>
        </View>
        <Small>
          2. 노트북의 Wi-Fi IP(예: 192.168.0.10)를 확인해 아래에 넣으십시오. 3. 모델 칸은
          비워도 됩니다 — 서버 기본값을 씁니다. OpenAI 호환(/v1/audio/transcriptions) 서버라면
          무엇이든 붙습니다. 집 밖에서도 쓰려면 Tailscale 이 가장 쉽습니다.
        </Small>
        <Button
          label={server.enabled ? "서버 전사 끄기" : "서버 전사 켜기"}
          tone={server.enabled ? "default" : "primary"}
          onPress={() => void saveServer({ ...server, enabled: !server.enabled })}
        />
        {server.enabled ? (
          <>
            <TextInput
              value={server.endpoint}
              onChangeText={(endpoint) => void saveServer({ ...server, endpoint })}
              placeholder="http://192.168.0.10:8000"
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={input}
            />
            <TextInput
              value={server.model ?? ""}
              onChangeText={(model) => void saveServer({ ...server, model: model || undefined })}
              placeholder="모델 (선택, 예: Systran/faster-whisper-medium)"
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={input}
            />
            <Divider />
            <Small muted={false}>한국어 파인튜닝 모델을 노트북에 설치할까요?</Small>
            <Small>
              누르면 서버 모델이 한국어 파인튜닝판(ghost613 turbo)으로 지정됩니다. 첫 전사 때
              노트북이 알아서 내려받습니다(약 3.2GB, 한 번만). 폰에는 아무것도 안 받습니다.
            </Small>
            <Button
              label={
                server.model === KOREAN_SERVER_MODEL
                  ? "한국어 모델 사용 중"
                  : "노트북에 한국어 모델 쓰기"
              }
              tone="primary"
              disabled={server.model === KOREAN_SERVER_MODEL}
              onPress={() => void saveServer({ ...server, model: KOREAN_SERVER_MODEL })}
            />
          </>
        ) : null}
      </Card>

      {sample ? (
        <Card>
          <Small>

  현재 기기 속도를 기준으로 추정합니다. 환산값에는 오차가 있을 수 있습니다.
</Small>
        </Card>
      ) : (
        <Card>
          <Small>
            
  이력이 없어 예상 시간을 알 수 없습니다. 첫 전사를 마치면 표시됩니다.
</Small>
        </Card>
      )}

      {statuses.map((status) => (
        <ModelCard
          key={status.model.id}
          status={status}
          sample={sample}
          progress={progress[status.model.id]}
          onDownload={() => confirmDownload(status.model)}
          onCancel={() => cancelDownload(status.model.id)}
          onDelete={() => confirmDelete(status)}
          onUse={async () => {
            await setActiveModel(status.model.id);
            await load();
          }}
        />
      ))}

      {/* 직접 넣기 */}
      <Card>
        <Heading>
  한국어 파인튜닝 모델 추가
</Heading>
        <Small>
          
  다운로드 링크 변경에 대비해 직접 등록을 지원합니다. 주소나 파일을 입력하십시오.
</Small>
        <Divider />
        <Small muted={false}>1. 찾기</Small>
        <Small>{KOREAN_MODEL_GUIDE.searchHint}</Small>
        {KOREAN_MODEL_GUIDE.known.map((m) => (
          <View key={m.id} style={{ gap: space.xxs, paddingVertical: space.tight }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Badge text={m.ready ? "변환 불필요" : "변환 필요"} tone={m.ready ? "ok" : "muted"} />
              <Small muted={false}>{m.base}</Small>
            </View>
            <Text selectable style={[type.small, { color: t.text, fontFamily: "monospace" }]}>
              {m.id}
            </Text>
            <Small>{m.note}</Small>
          </View>
        ))}
        <Small muted={false}>
  2. ggml 변환 및 양자화
</Small>
        <View
          style={{
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.md,
            padding: space.md,
          }}
        >
          <Text selectable style={{ color: t.text, fontFamily: "monospace", fontSize: 12 }}>
            {KOREAN_MODEL_GUIDE.convertCommand}
          </Text>
          <Text
            selectable
            style={{ color: t.text, fontFamily: "monospace", fontSize: 12, marginTop: 8 }}
          >
            {KOREAN_MODEL_GUIDE.quantizeCommand}
          </Text>
        </View>
        <Small muted={false}>
  3. 아래 항목 등록 후 모델 폴더에 파일 이동 또는 URL 입력
</Small>

        {adding ? (
          <>
            <Divider />
            <TextInput
              value={form.name}
              onChangeText={(name) => setForm((f) => ({ ...f, name }))}
              placeholder="이름 (예: 한국어 Small 재학습)"
              placeholderTextColor={t.textMuted}
              style={input}
            />
            <TextInput
              value={form.file}
              onChangeText={(file) => setForm((f) => ({ ...f, file }))}
              placeholder="파일 이름 (예: ggml-ko-small-q5_1.bin)"
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={input}
            />
            <TextInput
              value={form.url}
              onChangeText={(url) => setForm((f) => ({ ...f, url }))}
              placeholder="다운로드 URL (https://…, 미입력 가능)"
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={input}
            />
            <TextInput
              value={form.sizeMb}
              onChangeText={(sizeMb) => setForm((f) => ({ ...f, sizeMb }))}
              placeholder="예상 크기 (MB, 선택 사항)"
              placeholderTextColor={t.textMuted}
              keyboardType="number-pad"
              style={input}
            />
            {formError ? <Small muted={false}>{formError}</Small> : null}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button label="추가" tone="primary" onPress={() => void submitCustom()} />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="취소"
                  onPress={() => {
                    setAdding(false);
                    setFormError(null);
                  }}
                />
              </View>
            </View>
          </>
        ) : (
          <Button label="직접 추가" onPress={() => setAdding(true)} />
        )}
      </Card>

      <Card>
        <Small>
          
  모델 파일은 기기 내부 저장소에만 보관되며, 앱 삭제 시 함께 제거됩니다.
</Small>
      </Card>
    </ScrollView>
  );
}
