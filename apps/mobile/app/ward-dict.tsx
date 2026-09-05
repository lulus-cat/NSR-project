import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  addTermToPack,
  createWardPack,
  draftTermFromSuggestion,
  josa,
  packStats,
  suggestPackTerms,
  type LexiconEntry,
  type PackTermSuggestion,
} from "@nsr/core";
import { Badge, Body, Button, Card, Divider, Heading, Small } from "../src/components/ui";
import { radius, space, type, useTheme } from "../src/theme";
import {
  approvePendingCorrection,
  deleteWardPack,
  listPendingCorrections,
  listWardPacks,
  loadCorrectionMemory,
  rejectPendingCorrection,
  saveWardPack,
  setWardPackEnabled,
  type PendingCorrection,
  type StoredPack,
} from "../src/db";
import {
  checkPackBeforeShare,
  describePack,
  importWardPackFromFile,
  shareWardPack,
  type PackExportCheck,
} from "../src/services/ward-dict";
import { loadLexicon } from "../src/services/asr";

export default function WardDict() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [packs, setPacks] = useState<StoredPack[]>([]);
  const [pending, setPending] = useState<PendingCorrection[]>([]);
  const [suggestions, setSuggestions] = useState<PackTermSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newHospital, setNewHospital] = useState("");
  /** 보내기 전 개인정보 확인 화면. 어느 사전을 보려던 것인지 함께 들고 있는다. */
  const [shareCheck, setShareCheck] = useState<
    { pack: StoredPack; check: PackExportCheck } | null
  >(null);

  const load = useCallback(async () => {
    const [stored, waiting, memory, lexicon] = await Promise.all([
      listWardPacks(),
      listPendingCorrections(),
      loadCorrectionMemory(),
      loadLexicon(),
    ]);
    setPacks(stored);
    setPending(waiting);
    // 사전에 없는 말로 반복해서 고쳤다면, 그건 이 병동에서만 쓰는 말일 가능성이 높다.
    setSuggestions(
      suggestPackTerms(
        Object.values(memory.rules).map((r) => ({ from: r.from, to: r.to, count: r.count })),
        (s) => lexicon.lookup(s) !== null,
      ),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doImport = useCallback(async () => {
    setMsg(null);
    setBusy("가져오는 중");
    try {
      const r = await importWardPackFromFile();
      if (r.canceled) return;
      if (!r.pack) {
        setMsg(r.errors.join(" ") || "사전 파일을 읽지 못했어요. 다른 파일로 다시 해 주세요.");
        return;
      }
      const bits = [`'${r.pack.name}' 사전을 가져왔어요. 단어 ${r.pack.terms.length}개예요.`];
      if (r.warnings.length > 0) bits.push(r.warnings.join(" "));
      setMsg(bits.join(" "));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "사전을 가져오지 못했어요. 다시 눌러 주세요.");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const createPack = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const now = Date.now();
    const pack = createWardPack({
      id: `ward-${now.toString(36)}`,
      name,
      hospital: newHospital.trim() || undefined,
      now,
    });
    await saveWardPack(pack);
    setNewName("");
    setNewHospital("");
    setMsg(`'${name}' 사전을 만들었어요. 아래 추천 단어를 담아 봐요.`);
    await load();
  }, [load, newHospital, newName]);

  const addSuggestionToPack = useCallback(
    async (suggestion: PackTermSuggestion, stored: StoredPack) => {
      const draft: LexiconEntry = draftTermFromSuggestion(
        suggestion,
        stored.pack.id,
        `${stored.pack.name}에 넣을 단어의 뜻을 적어 주세요.`,
      );
      await saveWardPack(addTermToPack(stored.pack, draft, Date.now()));
      setMsg(`'${suggestion.surface}'${josa(suggestion.surface, "을")} ${stored.pack.name} 사전에 넣었어요. 뜻도 적어 봐요.`);
      await load();
    },
    [load],
  );

  const removePack = useCallback(
    (stored: StoredPack) => {
      Alert.alert(
        `'${stored.pack.name}' 사전을 지울까요`,
        "지우면 이 말들을 다시 못 알아들어요. 지우지 않고 잠깐 꺼 둘 수도 있어요.",
        [
          { text: "그만두기", style: "cancel" },
          {
            text: "지우기",
            style: "destructive",
            onPress: async () => {
              await deleteWardPack(stored.pack.id);
              await load();
            },
          },
        ],
      );
    },
    [load],
  );

  return (
    <ScrollView
      // 키보드가 떠 있을 때 첫 탭이 버튼 대신 키보드 닫기에 먹히지 않게.
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        padding: space.lg,
        // 내비게이션 바가 마지막 카드를 가리지 않게 안전영역만큼 띄운다.
        paddingBottom: space.lg + insets.bottom,
        gap: space.md,
      }}
    >
      <Card>
        <Heading>우리 병동 사전</Heading>
        <Body muted>
          
  기본 사전은 교과서 말만 알아요. 우리 병동에서만 쓰는 말은 여기에 모아요.
</Body>
        <Divider />
        <Small muted={false}>
  사전 적용 우선순위
</Small>
        <Small>내 단어장 › 병동 사전 › 기본 사전 순으로 찾아요.</Small>
        <Small>좁고 특별한 말이 먼저 이겨요.</Small>
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              label="사전 가져오기"
              tone="primary"
              busy={busy === "가져오는 중"}
              onPress={() => void doImport()}
            />
          </View>
        </View>
        {msg ? <Small muted={false}>{msg}</Small> : null}
      </Card>

      {/* 보내기 전 확인 */}
      {shareCheck ? (
        <Card tone={shareCheck.check.needsReview ? "warn" : "default"}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Badge
              text={shareCheck.check.needsReview ? "확인 필요" : "확인 끝"}
              tone={shareCheck.check.needsReview ? "warn" : "ok"}
            />
            <Heading>{shareCheck.pack.pack.name} 보내기</Heading>
          </View>
          <Small muted={false}>{shareCheck.check.summary}</Small>
          <Small>예문에 환자 이름이나 병실 번호가 없는지 확인해요.</Small>

          {shareCheck.check.findings.length > 0 ? (
            <>
              <Divider />
              <Small>이건 AI 가 못 가려요. 앞뒤를 보고 직접 지워 주세요.</Small>
              {shareCheck.check.findings.slice(0, 20).map((f, i) => (
                <View key={`${f.termId}-${i}`} style={{ gap: space.xs, paddingVertical: space.sm }}>
                  <Small muted={false}>{f.where}</Small>
                  <Text style={[type.body, { color: t.text }]}>
                    &ldquo;{f.found}&rdquo;
                  </Text>
                  <Small>{f.context}</Small>
                  <Divider />
                </View>
              ))}
              {shareCheck.check.findings.length > 20 ? (
                <Small>…그 외 {shareCheck.check.findings.length - 20}군데 더</Small>
              ) : null}
            </>
          ) : null}

          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                label={shareCheck.check.needsReview ? "그래도 보내기" : "보내기"}
                tone={shareCheck.check.needsReview ? "default" : "primary"}
                onPress={async () => {
                  const target = shareCheck.pack.pack;
                  setShareCheck(null);
                  try {
                    await shareWardPack(target);
                  } catch (e) {
                    setMsg(e instanceof Error ? e.message : "보내지 못했어요. 다시 눌러 주세요.");
                  }
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="그만두기" onPress={() => setShareCheck(null)} />
            </View>
          </View>
        </Card>
      ) : null}

      {/* 확인 대기 치환 규칙 */}
      {pending.length > 0 ? (
        <Card tone="warn">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Badge text="확인 필요" tone="warn" />
            <Heading>받은 교정 규칙 {pending.length}건</Heading>
          </View>
          <Small>
            
  전사 결과를 강제로 바꾸는 규칙이에요. 숫자가 틀어질 수 있어요.
</Small>
          {pending.map((p) => (
            <View key={p.key} style={{ gap: space.xs, paddingVertical: space.sm }}>
              <Text style={[type.body, { color: t.text }]}>
                &ldquo;{p.from}&rdquo; → &ldquo;{p.to}&rdquo;
              </Text>
              {/^\d|\d$/.test(p.from) || /\d/.test(p.to) ? (
                <Badge text="숫자 다름 주의" tone="danger" />
              ) : null}
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="사전에 넣기"
                    onPress={async () => {
                      await approvePendingCorrection(p.key);
                      await load();
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="넘기기"
                    onPress={async () => {
                      await rejectPendingCorrection(p.key);
                      await load();
                    }}
                  />
                </View>
              </View>
              <Divider />
            </View>
          ))}
        </Card>
      ) : null}

      {/* 사전 목록 */}
      {packs.map((stored) => {
        const stats = packStats(stored.pack);
        return (
          <Card key={stored.pack.id}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <Heading>{stored.pack.name}</Heading>
              <Switch
                value={stored.enabled}
                onValueChange={async (v) => {
                  await setWardPackEnabled(stored.pack.id, v);
                  await load();
                }}
              />
            </View>
            <Small>{describePack(stored)}</Small>
            {!stored.enabled ? <Badge text="꺼 둠" tone="muted" /> : null}

            {stats.terms > 0 ? (
              <>
                <Divider />
                {stored.pack.terms.slice(0, 6).map((term) => (
                  <View key={term.id} style={{ paddingVertical: space.xs }}>
                    <Text style={[type.body, { color: t.text }]}>{term.ko}</Text>
                    <Small>{term.definition}</Small>
                  </View>
                ))}
                {stats.terms > 6 ? <Small>… 외 {stats.terms - 6}개</Small> : null}
              </>
            ) : (
              <Small>
  휑~ 아직 넣은 단어가 없어요
</Small>
            )}

            <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="동기에게 보내기"
                  onPress={() =>
                    setShareCheck({ pack: stored, check: checkPackBeforeShare(stored.pack) })
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="사전 지우기" tone="danger" onPress={() => removePack(stored)} />
              </View>
            </View>
          </Card>
        );
      })}

      {/* 새 사전 */}
      <Card>
        <Heading>새 사전 만들기</Heading>
        <Small>단어를 모아 두면 후배에게 파일 하나로 넘길 수 있어요.</Small>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="사전 이름 (예: 71병동)"
          placeholderTextColor={t.textMuted}
          style={{
            color: t.text,
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.md,
            padding: space.md,
            fontSize: 15,
          }}
        />
        <TextInput
          value={newHospital}
          onChangeText={setNewHospital}
          placeholder="병원 이름 (선택)"
          placeholderTextColor={t.textMuted}
          style={{
            color: t.text,
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.md,
            padding: space.md,
            fontSize: 15,
          }}
        />
        <Button
          label="사전 만들기"
          tone="primary"
          disabled={!newName.trim()}
          onPress={() => void createPack()}
        />
      </Card>

      {/* 자동 제안 */}
      {suggestions.length > 0 ? (
        <Card tone="accent">
          <Heading>사전에 없는 말 {suggestions.length}개</Heading>
          <Small>그동안 직접 고친 말이에요.</Small>
          <Small>사전에 넣어 두면 다음부터 알아서 고쳐요.</Small>
          {suggestions.slice(0, 10).map((s) => (
            <View key={s.surface} style={{ gap: space.xs, paddingVertical: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={[type.body, { color: t.text }]}>{s.surface}</Text>
                <Small>{s.count}번 고쳤어요</Small>
              </View>
              <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                {packs.length === 0 ? (
                  <Small>넣을 사전이 없어요. 새 사전부터 만들어요.</Small>
                ) : (
                  packs.map((stored) => (
                    <Pressable
                      key={stored.pack.id}
                      accessibilityRole="button"
                      onPress={() => void addSuggestionToPack(s, stored)}
                      style={{
                        paddingVertical: space.xs,
                        paddingHorizontal: space.md,
                        borderRadius: radius.sm,
                        backgroundColor: t.surfaceAlt,
                      }}
                    >
                      <Text style={{ color: t.text, fontSize: 13 }}>
                        {stored.pack.name}에 담기
                      </Text>
                    </Pressable>
                  ))
                )}
              </View>
              <Divider />
            </View>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}
