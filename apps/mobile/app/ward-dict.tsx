import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { Text } from "react-native";
import {
  addTermToPack,
  createWardPack,
  draftTermFromSuggestion,
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
  describePack,
  importWardPackFromFile,
  shareWardPack,
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
    setMsg(`'${name}' 사전을 만들었습니다. 아래 제안에서 말을 담아 보세요.`);
    await load();
  }, [load, newHospital, newName]);

  const addSuggestionToPack = useCallback(
    async (suggestion: PackTermSuggestion, stored: StoredPack) => {
      const draft: LexiconEntry = draftTermFromSuggestion(
        suggestion,
        stored.pack.id,
        `${stored.pack.name}에서 쓰는 말. 뜻을 채워 주세요.`,
      );
      await saveWardPack(addTermToPack(stored.pack, draft, Date.now()));
      setMsg(`'${suggestion.surface}'을(를) ${stored.pack.name}에 담았습니다. 뜻을 채워 주세요.`);
      await load();
    },
    [load],
  );

  const removePack = useCallback(
    (stored: StoredPack) => {
      Alert.alert(
        `'${stored.pack.name}' 사전을 지웁니다`,
        "이 사전의 용어는 더 이상 인식되지 않습니다. 잠시 안 쓸 거라면 지우지 말고 꺼두셔도 됩니다.",
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
          내장 사전은 어느 병원에서나 통하는 말을 담습니다. 그런데 실제로 막히는 건
          그 병동에서만 쓰는 말입니다. 그건 어떤 사전에도 안 실립니다.
        </Body>
        <Divider />
        <Small muted={false}>사전은 세 층으로 겹칩니다</Small>
        <Small>
          내 사전 &gt; 병동 사전 &gt; 내장 사전 — 구체적인 쪽이 일반적인 쪽을 이깁니다.
          같은 말을 병동 사전이 다르게 정의하면 그쪽이 적용됩니다.
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

      {/* 확인 대기 치환 규칙 */}
      {pending.length > 0 ? (
        <Card tone="warn">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Badge text="확인 필요" tone="warn" />
            <Heading>받은 교정 규칙 {pending.length}건</Heading>
          </View>
          <Small>
            받은 사전에 글자를 바꾸는 규칙이 함께 왔습니다. 치환은 전사본의 글자를 그대로
            바꾸는 일이라 자동으로 켜지 않습니다. 하나씩 보고 정해 주세요.
            숫자가 바뀌는 규칙은 특히 조심하세요.
          </Small>
          {pending.map((p) => (
            <View key={p.key} style={{ gap: space.xs, paddingVertical: space.sm }}>
              <Text style={[type.body, { color: t.text }]}>
                &ldquo;{p.from}&rdquo; → &ldquo;{p.to}&rdquo;
              </Text>
              {/^\d|\d$/.test(p.from) || /\d/.test(p.to) ? (
                <Badge text="숫자가 바뀝니다" tone="danger" />
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
              <Small>아직 담긴 말이 없습니다.</Small>
            )}

            <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="동료에게 보내기"
                  onPress={async () => {
                    try {
                      await shareWardPack(stored.pack);
                    } catch (e) {
                      setMsg(e instanceof Error ? e.message : "보내지 못했습니다.");
                    }
                  }}
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
          우리 병동 말을 직접 모읍니다. 만들어 두면 다음에 들어오는 신규에게 파일 하나로 넘길 수 있습니다.
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
            전사본에서 반복해서 고치신 말인데 어느 사전에도 없습니다. 이 병동에서만 쓰는
            말일 가능성이 높습니다. 담아 두면 다음부터 자동으로 인식됩니다.
          </Small>
          {suggestions.slice(0, 10).map((s) => (
            <View key={s.surface} style={{ gap: space.xs, paddingVertical: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={[type.body, { color: t.text }]}>{s.surface}</Text>
                <Small>{s.count}번 고치심</Small>
              </View>
              <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                {packs.length === 0 ? (
                  <Small>담을 사전이 없습니다. 위에서 사전을 먼저 만들어 주세요.</Small>
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
