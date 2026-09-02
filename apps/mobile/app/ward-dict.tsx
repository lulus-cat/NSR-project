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
    setBusy("낑낑 가져오는 중");
    try {
      const r = await importWardPackFromFile();
      if (r.canceled) return;
      if (!r.pack) {
        setMsg(r.errors.join(" ") || "엥 족보 파일이 깨졌나 안 읽혀요 ㅠㅠ");
        return;
      }
      const bits = [`'${r.pack.name}' 족보 야무지게 훔쳐 왔어요 (단어 무려 ${r.pack.terms.length}개 겟또!).`];
      if (r.warnings.length > 0) bits.push(r.warnings.join(" "));
      setMsg(bits.join(" "));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "앗 훔쳐오기 엎어짐");
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
    setMsg(`빰! '${name}' 족보 파기 성공! 밑에 추천 단어들 쏙쏙 담아보세요`);
    await load();
  }, [load, newHospital, newName]);

  const addSuggestionToPack = useCallback(
    async (suggestion: PackTermSuggestion, stored: StoredPack) => {
      const draft: LexiconEntry = draftTermFromSuggestion(
        suggestion,
        stored.pack.id,
        `${stored.pack.name}에 들어갈 단어 뜻을 찰지게 적어주세용`,
      );
      await saveWardPack(addTermToPack(stored.pack, draft, Date.now()));
      setMsg(`'${suggestion.surface}'${josa(suggestion.surface, "을")} ${stored.pack.name} 족보에 모셔왔습니다! 뜻도 예쁘게 적어봐요`);
      await load();
    },
    [load],
  );

  const removePack = useCallback(
    (stored: StoredPack) => {
      Alert.alert(
        `'${stored.pack.name}' 족보 폭파`,
        "이거 지우면 나중에 글자 바꿀 때 이 은어들 싹 다 못 알아먹어요! 굳이 안 지우고 잠깐 꺼둘 수도 있는데 진짜 날려요?",
        [
          { text: "앗차차 (취소)", style: "cancel" },
          {
            text: "냅다 지우기",
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
      contentContainerStyle={{
        padding: space.lg,
        // 내비게이션 바가 마지막 카드를 가리지 않게 안전영역만큼 띄운다.
        paddingBottom: space.lg + insets.bottom,
        gap: space.md,
      }}
    >
      <Card>
        <Heading>우리 병동 족보</Heading>
        <Body muted>
          
  찐 기본 사전은 FM 교과서 단어만 알아요 ㅠㅠ 우리 병동만의 스펙타클 은어는 여기다 따로 모아주세요!
</Body>
        <Divider />
        <Small muted={false}>
  사전 적용 우선순위
</Small>
        <Small>
          
  내 단어장 › 병동 족보 › 기본 사전 순으로 서열 정리 끝! 좁고 딥한 은어가 다 이겨먹어요
</Small>
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              label="남의 족보 훔쳐오기"
              tone="primary"
              busy={busy === "낑낑 가져오는 중"}
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
              text={shareCheck.check.needsReview ? "확인 필수!" : "끄덕끄덕 (확인 완)"}
              tone={shareCheck.check.needsReview ? "warn" : "ok"}
            />
            <Heading>{shareCheck.pack.pack.name} 보내기</Heading>
          </View>
          <Small muted={false}>{shareCheck.check.summary}</Small>
          <Small>
            
  족보 예문에 환자 이름이나 병실 번호 같은 거 껴있지 않게 눈 크게 뜨고 조심!
</Small>

          {shareCheck.check.findings.length > 0 ? (
            <>
              <Divider />
              <Small>
                
  이건 AI가 눈치 못 채서 못 가려주는 놈들이에요! 앞뒤 문맥 보고 쌤이 직접 지워주세요 제발
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
                label={shareCheck.check.needsReview ? "알빠임? 그냥 쏠래" : "슝 보내기"}
                tone={shareCheck.check.needsReview ? "default" : "primary"}
                onPress={async () => {
                  const target = shareCheck.pack.pack;
                  setShareCheck(null);
                  try {
                    await shareWardPack(target);
                  } catch (e) {
                    setMsg(e instanceof Error ? e.message : "앗 쏘기 실패");
                  }
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="앗차차 (취소)" onPress={() => setShareCheck(null)} />
            </View>
          </View>
        </Card>
      ) : null}

      {/* 확인 대기 치환 규칙 */}
      {pending.length > 0 ? (
        <Card tone="warn">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Badge text="확인 필수!" tone="warn" />
            <Heading>받은 교정 규칙 {pending.length}건</Heading>
          </View>
          <Small>
            
  글자 변환 결과를 멱살 잡고 억지로 바꾸는 스킬이에요. 숫자 꼬일 수 있으니까 켤 때 쫄깃하게 조심하세용
</Small>
          {pending.map((p) => (
            <View key={p.key} style={{ gap: space.xs, paddingVertical: space.sm }}>
              <Text style={[type.body, { color: t.text }]}>
                &ldquo;{p.from}&rdquo; → &ldquo;{p.to}&rdquo;
              </Text>
              {/^\d|\d$/.test(p.from) || /\d/.test(p.to) ? (
                <Badge text="숫자 틀어짐 킹조심!" tone="danger" />
              ) : null}
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="얍 적용!"
                    onPress={async () => {
                      await approvePendingCorrection(p.key);
                      await load();
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="에이 버려"
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
            {!stored.enabled ? <Badge text="꺼둠 — 알아서 못 알아먹음" tone="muted" /> : null}

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
                  label="동기한테 족보 뿌리기"
                  onPress={() =>
                    setShareCheck({ pack: stored, check: checkPackBeforeShare(stored.pack) })
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="싹 날리기" tone="danger" onPress={() => removePack(stored)} />
              </View>
            </View>
          </Card>
        );
      })}

      {/* 새 사전 */}
      <Card>
        <Heading>새 족보 파기</Heading>
        <Small>
          
  단어 모아두면, 멘붕 온 후배 신규 쌤한테 파일 하나로 족보 쫙 뿌릴 수 있어요
</Small>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="족보 이름 (예: 헬게이트 71병동)"
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
          label="뚝딱 만들기"
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
            
  쌤이 그동안 빡쳐서 수동으로 고친 단어들이에요! 족보에 짱박아두면 다음부턴 AI가 눈치껏 알아서 잡아드림
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
  엥? 꽂아넣을 족보가 없어요! 새 족보부터 파고 오세요
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
