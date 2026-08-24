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
import { radius, space, type, useTheme } from "../src/theme";
import {
  addCustomModel,
  cancelDownload,
  deleteModelFile,
  downloadModel,
  listModels,
  loadSpeedSample,
  removeCustomModel,
  setActiveModel,
  type DownloadProgress,
  type ModelStatus,
} from "../src/services/models";

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
            : "공개된 실측이 없습니다"}
        </Small>
        <Small>
          8시간 근무 전사 예상 시간: {estimate.label}
          {estimate.estimated && estimate.minutes > 0 ? " (다른 모델로 잰 값에서 환산)" : ""}
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
              : `${progress.receivedMb} MB 받는 중`}
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

  const load = useCallback(async () => {
    setStatuses(await listModels());
    setSample(await loadSpeedSample());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = useCallback(
    async (model: AsrModel) => {
      setProgress((p) => ({ ...p, [model.id]: { receivedMb: 0, totalMb: 0, ratio: 0 } }));
      const outcome = await downloadModel(model, (p) =>
        setProgress((prev) => ({ ...prev, [model.id]: p })),
      );
      setProgress((prev) => {
        const next = { ...prev };
        delete next[model.id];
        return next;
      });
      await load();

      if (outcome.canceled) return;
      if (!outcome.ok) {
        Alert.alert("내려받지 못했습니다", outcome.error ?? "알 수 없는 오류입니다.");
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
        `${model.name} 내려받기`,
        `약 ${model.approxSizeMb} MB 를 받습니다. 셀룰러로 받으면 요금이 나갈 수 있으니 Wi-Fi 를 권합니다.`,
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
        `${model.name} 지우기`,
        status.active
          ? "지금 쓰는 모델입니다. 지우면 받아 둔 다른 모델로 전사합니다."
          : "파일만 지웁니다. 필요하면 다시 받을 수 있습니다.",
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
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Card>
        <Heading>전사 모델</Heading>
        <Body muted>
          전사는 기기 안에서 돌아갑니다. 어떤 모델로 돌릴지는 기기 성능과 상황에 따라
          다르므로 여러 개를 놓고 골라 쓸 수 있게 했습니다.
        </Body>
        <Divider />
        <Small muted={false}>크기보다 한국어가 먼저입니다</Small>
        <Small>
          {KOREAN_MODEL_GUIDE.why} 모델을 키우는 것보다 한국어로 학습된 것을 쓰는 쪽이
          훨씬 크게 먹힙니다.
        </Small>
        {installedCount === 0 ? (
          <>
            <Divider />
            <Small muted={false}>
              아직 받아 둔 모델이 없습니다. 하나는 받아야 전사가 됩니다.
            </Small>
          </>
        ) : null}
      </Card>

      {sample ? (
        <Card>
          <Small>
            이 기기에서 잰 속도를 기준으로 시간을 추정합니다. 다른 모델의 시간은
            상대 속도로 환산한 값이라 오차가 있습니다.
          </Small>
        </Card>
      ) : (
        <Card>
          <Small>
            아직 이 기기에서 전사를 해 본 적이 없어 걸리는 시간을 알 수 없습니다.
            남의 폰에서 잰 숫자를 이 폰의 숫자인 것처럼 보여주지 않습니다.
            한 번 전사하고 나면 여기에 예상 시간이 나옵니다.
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
        <Heading>한국어 파인튜닝 모델 넣기</Heading>
        <Small>
          공개된 한국어 재학습 모델이 여럿 있지만 주소를 앱에 박아 두지 않습니다.
          모델은 사라지고 이름이 바뀌고 라이선스가 달라집니다. 죽은 링크를 넣어 두는 것보다
          넣는 방법을 알려 드리는 편이 오래갑니다.
        </Small>
        <Divider />
        <Small muted={false}>1. 찾기</Small>
        <Small>{KOREAN_MODEL_GUIDE.searchHint}</Small>
        <Small muted={false}>2. ggml 로 바꾸기</Small>
        <View
          style={{
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.md,
            padding: space.md,
          }}
        >
          <Text style={{ color: t.text, fontFamily: "monospace", fontSize: 12 }}>
            {KOREAN_MODEL_GUIDE.convertCommand}
          </Text>
        </View>
        <Small muted={false}>3. 아래에 등록하고, 파일을 모델 폴더에 넣거나 주소로 받기</Small>

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
              placeholder="받을 주소 (https://…, 없으면 비워 두세요)"
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={input}
            />
            <TextInput
              value={form.sizeMb}
              onChangeText={(sizeMb) => setForm((f) => ({ ...f, sizeMb }))}
              placeholder="대략 크기 (MB, 몰라도 됩니다)"
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
          모델 파일은 이 기기의 앱 폴더에만 있습니다. 어디로도 올라가지 않고,
          앱을 지우면 함께 사라집니다.
        </Small>
      </Card>
    </ScrollView>
  );
}
