import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { Text } from "react-native";
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
        setMsg(r.errors.join(" ") || "사전을 읽지 못했습니다.");
        return;
      }
      const bits = [`'${r.pack.name}' 사전을 가져왔습니다 (용어 ${r.pack.terms.length}개).`];
      if (r.warnings.length > 0) bits.push(r.warnings.join(" "));
      setMsg(bits.join(" "));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "가져오지 못했습니다.");
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
    setMsg(`'${name}' 사전을 생성했습니다. 아래 추천 용어를 추가하십시오.`);
    await load();
  }, [load, newHospital, newName]);

  const addSuggestionToPack = useCallback(
    async (suggestion: PackTermSuggestion, stored: StoredPack) => {
      const draft: LexiconEntry = draftTermFromSuggestion(
        suggestion,
        stored.pack.id,
        `${stored.pack.name} 용어입니다. 의미를 입력하십시오.`,
      );
      await saveWardPack(addTermToPack(stored.pack, draft, Date.now()));
      setMsg(`'${suggestion.surface}'${josa(suggestion.surface, "을")} ${stored.pack.name}에 추가했습니다. 의미를 입력하십시오.`);
      await load();
    },
    [load],
  );

  const removePack = useCallback(
    (stored: StoredPack) => {
      Alert.alert(
        `'${stored.pack.name}' 사전을 삭제합니다`,
        "해당 사전 용어가 인식되지 않습니다. 삭제 대신 비활성화할 수 있습니다.",
        [
          { text: "취소", style: "cancel" },
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
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Card>
        <Heading>병동 사전</Heading>
        <Body muted>
          
  내장 사전은 표준 간호 용어를 제공합니다. 병동 전용 용어는 직접 등록하여 사용하십시오.
</Body>
        <Divider />
        <Small muted={false}>
  사전 적용 우선순위
</Small>
        <Small>
          
  내 사전 &gt; 병동 사전 &gt; 내장 사전 순으로 적용됩니다. 상위 사전의 정의가 우선 적용됩니다.
</Small>
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              label="사전 받아오기"
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
              text={shareCheck.check.needsReview ? "확인 필요" : "확인됨"}
              tone={shareCheck.check.needsReview ? "warn" : "ok"}
            />
            <Heading>{shareCheck.pack.pack.name} 보내기</Heading>
          </View>
          <Small muted={false}>{shareCheck.check.summary}</Small>
          <Small>
            
  사전 작성 시 예문에 민감한 개인정보가 포함되지 않도록 주의하십시오.
</Small>

          {shareCheck.check.findings.length > 0 ? (
            <>
              <Divider />
              <Small>
                
  자동 삭제되지 않는 항목입니다. 문맥을 확인하여 직접 수정하십시오.
</Small>
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
                    setMsg(e instanceof Error ? e.message : "보내지 못했습니다.");
                  }
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="취소" onPress={() => setShareCheck(null)} />
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
            
  사전에 포함된 텍스트 치환 규칙입니다. 전사 결과에 직접 영향을 주므로 확인 후 적용하십시오. 수치 변경 규칙은 주의가 필요합니다.
</Small>
          {pending.map((p) => (
            <View key={p.key} style={{ gap: space.xs, paddingVertical: space.sm }}>
              <Text style={[type.body, { color: t.text }]}>
                &ldquo;{p.from}&rdquo; → &ldquo;{p.to}&rdquo;
              </Text>
              {/^\d|\d$/.test(p.from) || /\d/.test(p.to) ? (
                <Badge text="수치 변경 주의" tone="danger" />
              ) : null}
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="적용"
                    onPress={async () => {
                      await approvePendingCorrection(p.key);
                      await load();
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="버림"
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
            {!stored.enabled ? <Badge text="꺼짐 — 인식 안 됨" tone="muted" /> : null}

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
  등록된 용어가 없습니다.
</Small>
            )}

            <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="동료에게 보내기"
                  onPress={() =>
                    setShareCheck({ pack: stored, check: checkPackBeforeShare(stored.pack) })
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="지우기" tone="danger" onPress={() => removePack(stored)} />
              </View>
            </View>
          </Card>
        );
      })}

      {/* 새 사전 */}
      <Card>
        <Heading>사전 만들기</Heading>
        <Small>
          
  병동 용어를 등록해 두면 신규 간호사에게 파일로 공유할 수 있습니다.
</Small>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="사전 이름 (예: ○○병원 71병동)"
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
          label="만들기"
          tone="primary"
          disabled={!newName.trim()}
          onPress={() => void createPack()}
        />
      </Card>

      {/* 자동 제안 */}
      {suggestions.length > 0 ? (
        <Card tone="accent">
          <Heading>사전에 없는 말 {suggestions.length}개</Heading>
          <Small>
            
  전사에서 자주 수정된 미등록 용어입니다. 사전에 추가하면 다음 전사부터 자동 인식됩니다.
</Small>
          {suggestions.slice(0, 10).map((s) => (
            <View key={s.surface} style={{ gap: space.xs, paddingVertical: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={[type.body, { color: t.text }]}>{s.surface}</Text>
                <Small>{s.count}번 고치심</Small>
              </View>
              <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                {packs.length === 0 ? (
                  <Small>
  등록할 사전이 없습니다. 사전을 먼저 생성하십시오.
</Small>
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
