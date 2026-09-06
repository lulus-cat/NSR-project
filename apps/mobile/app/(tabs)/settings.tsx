import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import type { ComponentProps, ReactNode } from "react";
import { Text } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  DEFAULT_RECORDING_POLICY,
  DEFAULT_TEMPLATES,
  GEOFENCE_RADII,
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
  approveCode,
  checkServer,
  forgetOtherDevices,
  getDeviceToken,
  getServerUrl,
  linkDevice,
  pollLink,
  getAutoSend,
  setAutoSend,
  syncWithServer,
  recoverDevice,
  serverState,
  setDeviceToken,
  setServerUrl,
  type LinkTicket,
  type ServerState,
} from "../../src/services/nsr-server";
import {
  clearWorkplace,
  geofenceEnabled,
  getWorkplace,
  searchWorkplace,
  setGeofence,
  setRadius,
  setWorkplaceHere,
  setWorkplacePlace,
  whereAmI,
  type PlaceHit,
  type Workplace,
} from "../../src/services/geofence";
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

/** 서버가 주는 초 단위 시각을 '9월 6일' 로. 어느 줄이 언제 붙었는지만 보면 된다. */
function dayText(seconds: number): string {
  const d = new Date((seconds || 0) * 1000);
  return Number.isNaN(d.getTime()) ? "언젠가" : `${d.getMonth() + 1}월 ${d.getDate()}일`;
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
  const [storageMb, setStorageMb] = useState(0);
  const [privacy, setPrivacy] = useState<PrivacySettings>({
    enabled: true,
    disabled: ["location"],
    extraTerms: [],
  });
  const [newTerm, setNewTerm] = useState("");
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
    setStorageMb(Math.round(((await totalStorageBytes()) / (1024 * 1024)) * 10) / 10);
    setPrivacy(await loadPrivacySettings());
    setAutoUpdate(await autoCheckEnabled());
    setDebugEntries(await readDebugLog());

    const { getTiroKey } = await import("../../src/services/asr");
    setHasTiroKey((await getTiroKey()) !== null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const router = useRouter();
  // 티로 — 열쇠 하나. 앱은 티로에 파일을 안 올린다. 티로가 받아적어 둔 글자를
  // 가져오는 데만 쓴다 (그리고 병동 사전을 티로 단어장에 올리는 데).
  const [tiroKeyInput, setTiroKeyInput] = useState("");
  const [hasTiroKey, setHasTiroKey] = useState(false);
  const [tiroBusy, setTiroBusy] = useState(false);
  const [tiroNote, setTiroNote] = useState<string | null>(null);

  const saveTiro = useCallback(async () => {
    const key = tiroKeyInput.trim();
    if (!key) {
      setTiroNote("열쇠를 먼저 위 칸에 붙여넣어 주세요.");
      return;
    }
    setTiroBusy(true);
    try {
      const { setTiroKey, checkTiroConnection } = await import("../../src/services/asr");
      await setTiroKey(key);
      setHasTiroKey(true);
      setTiroKeyInput("");
      setTiroNote((await checkTiroConnection()).message);
    } catch (e) {
      setTiroNote(e instanceof Error ? e.message : "저장하지 못했어요. 다시 눌러 주세요.");
    } finally {
      setTiroBusy(false);
    }
  }, [tiroKeyInput]);
  // 분석 서버 (VPS). 주소는 비밀이 아니고, 기기 토큰은 보안 저장소에만 둔다.
  const [srvUrl, setSrvUrl] = useState("");
  const [srvHasToken, setSrvHasToken] = useState(false);
  const [srvBusy, setSrvBusy] = useState(false);
  const [srvNote, setSrvNote] = useState<string | null>(null);
  // 앱 버전·디버그 카드가 제 자리에서 말하게 한다 (예전에는 분석 서버 카드에 떴다).
  const [cardNote, setCardNote] = useState<string | null>(null);

  // 화면에 들어올 때마다 다시 본다. 이은 직후에도, 401 로 열쇠가 지워진
  // 뒤에도 '이 기기' 줄이 사실과 같아야 한다 (탭 화면은 한 번 뜨면 안 죽는다).
  // 홈의 "새 판이 나왔어요 · 받기" 로 들어오면 이 카드가 비어 있었다.
  useEffect(() => {
    void checkForUpdate().then(setUpdate);
  }, []);

  // 주소 칸은 사람이 고치고 있을 수 있다. 손대지 않은 동안만 서버 값으로 채운다 —
  // 예전에는 탭을 다녀오면 치던 주소가 저장된 값으로 되돌아갔다.
  const urlDirty = useRef(false);
  // 이어진 기기 목록과 복구 번호. 이어져 있을 때만 서버가 준다.
  const [srvState, setSrvState] = useState<ServerState | null>(null);
  /** 근무를 저절로 올릴까. 전사본이 기기 밖으로 나가는 일이라 끄는 길이 있어야 한다. */
  const [autoSend, setAuto] = useState(true);
  const refreshServer = useCallback(async () => {
    if (!urlDirty.current) setSrvUrl(await getServerUrl());
    const linked = (await getDeviceToken()) !== null;
    setSrvHasToken(linked);
    setAuto(await getAutoSend());
    if (!linked) {
      setSrvState(null);
      return;
    }
    // 서버가 잠깐 안 되는 것 때문에 설정 화면 전체가 멎으면 안 된다.
    // 다만 조용히 비우지는 않는다 — 그러면 '연결됨' 인데 복구 번호도 기기 수도
    // 없는, 사람이 무슨 일인지 알 수 없는 화면이 된다.
    try {
      setSrvState(await serverState());
    } catch (e) {
      setSrvState(null);
      setSrvNote(e instanceof Error ? e.message : "서버에 닿지 못했어요.");
      // 위 요청이 401 이었으면 열쇠가 지워졌을 수 있다. 다시 읽어야 줄이 안 거짓말한다.
      setSrvHasToken((await getDeviceToken()) !== null);
    }
  }, []);
  /**
   * 화면에 들어올 때마다 서버와 한 번 맞춘다. 누를 버튼은 없다.
   *
   * 예전에는 '결과 받기' 버튼이었다. 안 누르면 AI 가 써 둔 보고서도 카드도 폰에
   * 영영 안 들어왔고, 그 사실이 화면 어디에도 없었다.
   */
  const syncNow = useCallback(async () => {
    try {
      const out = await syncWithServer();
      if (!out?.got) return;
      const got = out.got;
      const parts = [
        got.reports ? `보고서 ${got.reports}개` : "",
        got.terms ? `새 용어 ${got.terms}개` : "",
        got.cards ? `카드 ${got.cards}장` : "",
        got.taeum ? "근무 체온" : "",
        got.roles ? `화자 ${got.roles}줄` : "",
        got.fixes ? `교정 ${got.fixes}곳` : "",
      ].filter(Boolean);
      // 새로 온 것이 없으면 아무 말도 안 한다 — 화면에 들어올 때마다 말하면 잔소리다.
      if (parts.length > 0) {
        setSrvNote(`${parts.join(", ")}를 받았어요.`);
        await refreshServer();
      }
    } catch {
      // 서버가 잠깐 안 되는 것으로 설정 화면이 시끄러워지면 안 된다. 다음에 다시 온다.
    }
  }, [refreshServer]);

  useFocusEffect(
    useCallback(() => {
      void refreshServer();
      void syncNow();
    }, [refreshServer, syncNow]),
  );

  // 승인 번호 — AI 커넥터 화면에 뜬 것과, 새로 잇는 기기가 띄운 것 둘 다 여기 넣는다.
  const [srvCode, setSrvCode] = useState("");

  const approveNow = useCallback(async () => {
    setSrvBusy(true);
    setSrvNote(null);
    try {
      const kind = await approveCode(srvCode);
      setSrvCode("");
      setSrvNote(kind === "device" ? "새 기기를 이었어요." : "승인했어요. 곧 연결돼요.");
    } catch (e) {
      setSrvNote(e instanceof Error ? e.message : "승인하지 못했어요. 다시 해 주세요.");
    } finally {
      setSrvBusy(false);
      void refreshServer();
    }
  }, [refreshServer, srvCode]);

  // ── 잇기 ──────────────────────────────────────────────
  //
  // 서버에 기기가 하나도 없으면 버튼 한 번으로 끝난다. 있으면 여섯 자리가 뜨고,
  // 이미 이어진 폰이 승인할 때까지 3초마다 물어본다. 화면을 떠나면 멈춘다 —
  // 안 멈추면 탭을 옮겨 다니는 동안에도 계속 서버를 두드린다.
  const [ticket, setTicket] = useState<LinkTicket | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [recoveryIn, setRecoveryIn] = useState("");
  // 복구 번호는 서버 열쇠다. 늘 띄워 두면 어깨너머·화면 캡처로 샌다.
  const [showRecovery, setShowRecovery] = useState(false);
  const polling = useRef(false);
  // 물어본 횟수는 화면을 드나들어도 이어져야 한다. 상태에 두면 탭을 옮길 때마다
  // 0 으로 돌아가서 '시간이 지났어요' 가 영영 안 뜬다.
  const tries = useRef(0);

  const linkNow = useCallback(async () => {
    setSrvBusy(true);
    setSrvNote(null);
    try {
      await setServerUrl(srvUrl);
      urlDirty.current = false;
      const out = await linkDevice();
      if (out.linked) {
        setRecovery(out.recovery ?? null);
        setSrvNote("이어졌어요. 복구 번호를 적어 두세요.");
      } else {
        tries.current = 0;
        setTicket(out);
        setSrvNote("이미 이은 폰에서 이 번호를 승인해 주세요.");
      }
    } catch (e) {
      setSrvNote(e instanceof Error ? e.message : "잇지 못했어요. 다시 눌러 주세요.");
    } finally {
      setSrvBusy(false);
      void refreshServer();
    }
  }, [refreshServer, srvUrl]);

  useFocusEffect(
    useCallback(() => {
      if (!ticket?.code || !ticket.poll) return;
      polling.current = true;
      const timer = setInterval(() => {
        void (async () => {
          if (!polling.current) return;
          if (++tries.current > 100) {
            setTicket(null);
            setSrvNote("시간이 지났어요. 다시 눌러 주세요.");
            return;
          }
          try {
            const out = await pollLink(ticket.code!, ticket.poll!);
            if (!out.linked || !polling.current) return;
            setTicket(null);
            setRecovery(out.recovery ?? null);
            setSrvNote("이어졌어요. 복구 번호를 적어 두세요.");
            await refreshServer();
          } catch {
            // 잠깐 끊긴 것은 다음 차례에 다시 본다.
          }
        })();
      }, 3000);
      return () => {
        polling.current = false;
        clearInterval(timer);
      };
    }, [refreshServer, ticket]),
  );

  const recoverNow = useCallback(async () => {
    setSrvBusy(true);
    setSrvNote(null);
    try {
      await setServerUrl(srvUrl);
      urlDirty.current = false;
      setRecovery((await recoverDevice(recoveryIn)) ?? null);
      setRecoveryIn("");
      setTicket(null);
      setSrvNote("이어졌어요. 새 복구 번호를 적어 두세요.");
    } catch (e) {
      setSrvNote(e instanceof Error ? e.message : "복구 번호가 맞지 않아요. 다시 넣어 주세요.");
    } finally {
      setSrvBusy(false);
      void refreshServer();
    }
  }, [recoveryIn, refreshServer, srvUrl]);

  const forgetOthers = useCallback(() => {
    Alert.alert("다른 기기 끊기", "이 폰만 남기고 모두 끊어요.", [
      { text: "그만두기", style: "cancel" },
      {
        text: "끊기",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setSrvBusy(true);
            try {
              const n = await forgetOtherDevices();
              setSrvNote(n ? `${n}대를 끊었어요.` : "끊을 기기가 없었어요.");
            } catch (e) {
              setSrvNote(e instanceof Error ? e.message : "끊지 못했어요. 다시 해 주세요.");
            } finally {
              setSrvBusy(false);
              void refreshServer();
            }
          })();
        },
      },
    ]);
  }, [refreshServer]);

  const saveServer = useCallback(async () => {
    setSrvBusy(true);
    try {
      await setServerUrl(srvUrl);
      const out = await checkServer();
      setSrvNote(out.message);
    } catch (e) {
      setSrvNote(e instanceof Error ? e.message : "저장하지 못했어요. 다시 눌러 주세요.");
    } finally {
      setSrvBusy(false);
      void refreshServer();
    }
  }, [refreshServer, srvUrl]);

  const policy = app.policy;
  // 번호는 옮겨 적는 값이라 크고 넓게 둔다 (여섯 자리, 복구 번호 둘 다).
  const codeStyle = {
    fontSize: 26,
    fontWeight: "800" as const,
    letterSpacing: 4,
    color: t.text,
    textAlign: "center" as const,
    paddingVertical: space.sm,
  };

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

  // 근무지 카드를 볼 때마다 지금 안인지 밖인지 한 번 읽는다. 사용자가 버튼을
  // 눌러 확인하는 것이 아니라, 앱이 늘 보고 있다는 것을 그대로 비춘다.
  const [geoNow, setGeoNow] = useState("보는 중…");
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const here = await whereAmI();
        if (!alive) return;
        if (!here) setGeoNow("근무지 없음");
        else if (here.distance === null) setGeoNow("위치를 못 읽었어요");
        else setGeoNow(here.inside ? `근무지 안 · ${here.distance}m` : `밖 · ${here.distance}m`);
      })();
      return () => {
        alive = false;
      };
    }, [workplace]),
  );

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
            // 순서가 중요하다. DB 를 **닫고** 지운 다음 파일을 지운다 — 예전에는
            // 파일부터 지우고 DB 삭제에서 예외로 죽어서, 음성만 사라지고 전사본과
            // 열쇠는 남은 채 "지웠다"고 보였다. 실패하면 사용자에게 말한다.
            try {
              const SQLite = await import("expo-sqlite");
              await resetDbHandle();
              await SQLite.deleteDatabaseAsync("nsr.db");
              deleteAllRecordings();
              const { setTiroKey } = await import("../../src/services/asr");
              await setTiroKey(null);
              await setDeviceToken(null);
              // 분석 서버 카드도 같이 비운다. 안 그러면 다 지운 뒤에도 '연결됨'
              // 과 복구 번호가 그대로 떠 있다 (탭을 다녀와야 사라졌다).
              setRecovery(null);
              setTicket(null);
              setShowRecovery(false);
              await app.refresh();
              await load();
              await refreshServer();
            } catch (e) {
              Alert.alert(
                "다 지우지 못했어요",
                e instanceof Error ? e.message : "앱을 닫았다 열고 다시 해 주세요.",
              );
            }
          },
        },
      ],
    );
  }, [app, load, refreshServer]);

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
      // 키보드가 떠 있을 때 첫 탭이 버튼 대신 키보드 닫기에 먹히지 않게.
      keyboardShouldPersistTaps="handled"
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
      {/* 분석 서버 — 근무를 보내고 AI 가 만든 결과를 받아온다 */}
      <Card>
        <GroupHead icon="cloud-outline" color="#7A5AC7" title="분석 서버" />
        <Small muted={false}>전사본이 이 서버로 나가요.</Small>
        <Small>이름 같은 민감한 말은 가리고 보내요.</Small>
        <Small>보내면 AI 가 읽고 보고서를 써 줘요.</Small>
        <TextInput
          value={srvUrl}
          onChangeText={(v) => {
            urlDirty.current = true;
            setSrvUrl(v);
          }}
          placeholder="https://내서버주소"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={{
            minHeight: TOUCH_MIN,
            paddingHorizontal: space.md,
            borderRadius: radius.md,
            backgroundColor: t.surfaceAlt,
            color: t.text,
            fontSize: 15,
          }}
        />
        {srvHasToken ? (
          <Button label="다시 확인" busy={srvBusy} onPress={() => void saveServer()} />
        ) : (
          <Button label="잇기" tone="primary" busy={srvBusy} onPress={() => void linkNow()} />
        )}
        <Row label="이 기기" value={srvHasToken ? "연결됨" : "아직 연결 안 됨"} />

        {/* 아직 안 이어졌을 때 — 버튼 하나로 끝나거나, 번호가 뜨거나 */}
        {srvHasToken ? null : ticket?.code ? (
          <>
            <Small muted={false}>이미 이은 폰에서 승인해 주세요.</Small>
            <Text style={codeStyle}>{`${ticket.code.slice(0, 3)} ${ticket.code.slice(3)}`}</Text>
            <Small>승인하면 저절로 이어져요.</Small>
            <Small>폰이 이것 하나면 아래 복구 번호를 쓰세요.</Small>
            <Button
              label="그만두기"
              onPress={() => {
                setTicket(null);
                setSrvNote(null);
              }}
            />
          </>
        ) : (
          <Small>서버에 처음 잇는 폰이면 바로 이어져요.</Small>
        )}

        {/* 이은 직후 한 번 — 여기서 놓쳐도 아래 '복구 번호 보기' 에 늘 있다 */}
        {recovery ? (
          <>
            <Small muted={false}>복구 번호예요. 적어 두세요.</Small>
            <Text style={codeStyle}>{recovery}</Text>
          </>
        ) : null}

        {/* 이어진 뒤 — 어떤 기기가 붙어 있나.
            숫자만 보여 주면 그 2대가 내 옛 폰인지 남의 폰인지 알 수가 없다.
            '처음 열리는 문' 의 위험을 갚기로 한 것이 바로 이 목록이다 (docs/08). */}
        {srvState ? (
          <>
            <Small muted={false}>이어진 기기 {srvState.devices.length}대</Small>
            {srvState.devices.map((d, i) => (
              <Row
                key={`${d.created_at}-${i}`}
                label={d.mine ? "이 폰" : (d.label ?? "다른 기기")}
                value={`${dayText(d.created_at)}에 이음`}
              />
            ))}
            {srvState.devices.some((d) => !d.mine) ? (
              <Button label="다른 기기 끊기" busy={srvBusy} onPress={forgetOthers} />
            ) : null}
            <Divider />
            {/* 복구 번호는 서버 열쇠다. 늘 띄워 두면 어깨너머로 샌다 */}
            <Small muted={false}>복구 번호</Small>
            <Small>앱을 지우기 전에 이 번호를 적어 두세요.</Small>
            {showRecovery ? (
              <Text style={codeStyle}>{srvState.recovery}</Text>
            ) : (
              <Button label="번호 보기" onPress={() => setShowRecovery(true)} />
            )}
          </>
        ) : null}

        {srvNote ? <Small muted={false}>{srvNote}</Small> : null}
        <Small>결과는 앱을 열 때마다 저절로 들어와요.</Small>
        <Toggle
          label="저절로 보내기"
          description="전사본이 생기면 이 서버로 올려요."
          value={autoSend}
          onChange={(v) => {
            setAuto(v);
            void setAutoSend(v);
          }}
        />
        <Divider />

        {/* 승인 번호 — AI 연결과 새 기기가 같은 칸을 쓴다. 서버가 알아서 가른다 */}
        <Small muted={false}>승인 번호</Small>
        <Small>AI 연결이나 새 기기가 번호를 보여 줘요.</Small>
        <Small>그 번호를 여기 넣으면 열려요.</Small>
        <TextInput
          value={srvCode}
          onChangeText={setSrvCode}
          placeholder="번호 여섯 자리"
          placeholderTextColor={t.textMuted}
          keyboardType="number-pad"
          maxLength={6}
          style={{
            minHeight: TOUCH_MIN,
            paddingHorizontal: space.md,
            borderRadius: radius.md,
            backgroundColor: t.surfaceAlt,
            color: t.text,
            fontSize: 18,
            letterSpacing: 4,
          }}
        />
        <Button
          label="승인하기"
          busy={srvBusy}
          disabled={!srvHasToken}
          onPress={() => void approveNow()}
        />
        {srvHasToken ? null : <Small>먼저 이 폰을 이어 주세요.</Small>}

        {/* 앱을 지웠다 다시 깔면 열쇠가 사라진다. 승인해 줄 기기도 없을 때의 길.
            이어져 있을 때는 아예 안 보인다 — 바로 위에 복구 번호가 떠 있어서,
            그 번호를 여기 넣어 보는 사람이 반드시 나온다. 그러면 적어 둔 번호가
            그 자리에서 무효가 되고, 정작 앱을 다시 깔 때 쓸 것이 없어진다. */}
        {srvHasToken ? null : (
          <>
            <Divider />
            <Small muted={false}>복구 번호로 잇기</Small>
            <Small>앱을 다시 깔았을 때 쓰는 번호예요.</Small>
            <TextInput
              value={recoveryIn}
              onChangeText={setRecoveryIn}
              placeholder="ABCD-EFGH-JKLM"
              placeholderTextColor={t.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={14}
              style={{
                minHeight: TOUCH_MIN,
                paddingHorizontal: space.md,
                borderRadius: radius.md,
                backgroundColor: t.surfaceAlt,
                color: t.text,
                fontSize: 16,
                letterSpacing: 2,
              }}
            />
            <Button label="복구로 잇기" busy={srvBusy} onPress={() => void recoverNow()} />
          </>
        )}
      </Card>

      {/* 판 번호와 업데이트 */}
      <Card tone={update?.show ? "accent" : "default"}>
        <GroupHead icon="information-circle-outline" color="#4C7DDB" title="앱 버전" badge={<Badge text="알파" tone="warn" />} />
        <Small muted={false}>{version ? `현재 ${version}` : "개발 중 실행"}</Small>
        <Small>앱이 새 버전을 알려드려요.</Small>
        {cardNote ? <Small muted={false}>{cardNote}</Small> : null}

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
                    if (!r.ok) setCardNote(r.error ?? "내려받지 못했어요. 인터넷 연결을 확인해 주세요.");
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
          description="새 버전을 확인해요."
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

                {/* 병원 규모가 제각각이라 사람이 고른다. 의원은 100m, 대학병원은 1km. */}
                <Small muted={false}>얼마나 가까워야 켤까요</Small>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  {GEOFENCE_RADII.map((r) => {
                    const on = workplace.radius === r;
                    return (
                      <Pressable
                        key={r}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        onPress={async () => {
                          const next = await setRadius(r);
                          if (next) setWorkplace(next);
                          setGeoMsg(`반경을 ${r}m 로 바꿨어요.`);
                        }}
                        style={{
                          flex: 1,
                          minHeight: TOUCH_MIN,
                          borderRadius: radius.md,
                          backgroundColor: on ? t.accent : t.surfaceAlt,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text
                          style={[
                            type.small,
                            { color: on ? "#FFFFFF" : t.text, fontWeight: "700" },
                          ]}
                        >
                          {r >= 1000 ? "1km" : `${r}m`}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Small>건물만이면 100m, 부지가 넓으면 500m 이상으로 해요.</Small>

                {/* 지금 어디인지 화면이 알아서 보여 준다. 누를 것이 없다. */}
                <Row label="지금" value={geoNow} />
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

      {/* 티로 — 앱이 하는 일은 가져오기뿐이라 열쇠 한 칸이면 된다 */}
      <Card>
        <GroupHead icon="cloud-download-outline" color="#B3762F" title="티로" />
        <Small>티로 앱으로 녹음하면 티로가 글자로 바꿔요.</Small>
        <Small>열쇠를 넣으면 그 글자를 이 앱으로 가져와요.</Small>
        <TextInput
          value={tiroKeyInput}
          onChangeText={setTiroKeyInput}
          placeholder={hasTiroKey ? "티로 열쇠 — 넣어 뒀어요" : "티로 열쇠 붙여넣기"}
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          style={{
            minHeight: TOUCH_MIN,
            paddingHorizontal: space.md,
            borderRadius: radius.md,
            backgroundColor: t.surfaceAlt,
            color: t.text,
            fontSize: 15,
          }}
        />
        <Button label="열쇠 저장" tone="primary" busy={tiroBusy} onPress={() => void saveTiro()} />
        {tiroNote ? <Small muted={false}>{tiroNote}</Small> : null}
        <Row
          label="티로 노트에서 가져오기"
          value="열기 ›"
          onPress={() => router.push("/tiro-notes")}
        />
        <Small>가져올 때 병동 사전을 티로에 올려요. 다음 녹음이 정확해져요.</Small>
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
                if (!ok) setCardNote("인터넷 창을 열지 못했어요. 다시 눌러 주세요.");
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
