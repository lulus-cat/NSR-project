/**
 * 기록 서비스.
 *
 * 설계 형태
 * --------
 * 기록 "정책"(언제 시작·회전·정지하는가)과 기록 "장치"(실제 마이크 API)를 분리했다.
 * 정책은 `RecordingSession`이 갖고, 장치는 `AudioBackend` 포트 뒤에 있다.
 * Expo SDK가 오디오 API를 바꿔도 `expoAudioBackend`만 손보면 된다.
 *
 * 조용함에 대해
 * ------------
 * 이 서비스는 어떤 소리도, 진동도, 알림도 내지 않는다.
 * 다만 **OS의 마이크 인디케이터는 끌 수 없다** (docs/01-legal-and-privacy.md).
 * Android는 포그라운드 서비스 알림이 필수이므로 최소 중요도 채널로 내보내되,
 * 문구는 거짓말하지 않는다.
 */

import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
} from "expo-audio";
import type { RecordingPolicy } from "@nsr/core";
import { fileSize, moveIntoRecordings, recordingFileUri } from "./files";
import { beginWork, endWork } from "./progress-notify";

/** 진행 알림의 이름. 참조를 세는 쪽(progress-notify)이 이 이름으로 짝을 맞춘다. */
const RECORDING_WORK_ID = "recording";

export interface AudioBackend {
  /** 마이크 권한. 이미 있으면 즉시 true. */
  ensurePermission(): Promise<boolean>;
  /**
   * 오디오 세션을 백그라운드 지속 모드로 준비한다.
   * iOS: AVAudioSession 카테고리 playAndRecord + 백그라운드 유지
   * Android: 포그라운드 서비스 시작
   */
  prepareSession(options: { silent: boolean }): Promise<void>;
  /** 새 파일로 기록 시작. 반환값은 파일 URI. */
  start(fileName: string): Promise<string>;
  /** 정지하고 결과를 돌려준다. */
  stop(): Promise<{ uri: string; durationSec: number; sizeBytes: number }>;
  /** 세션 정리. */
  releaseSession(): Promise<void>;
  isRecording(): boolean;
}

export type SessionState = "idle" | "recording" | "stopping";

export interface RecordedChunk {
  index: number;
  uri: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  sizeBytes: number;
}

export interface SessionCallbacks {
  /** 조각을 열 때. 여기서 DB 줄을 먼저 만든다 (파일만 남는 창을 없앤다). */
  onChunkStart?(index: number, startedAt: number): void | Promise<void>;
  /** 파일 하나가 완결될 때마다. 여기서 DB 저장과 전사 큐 등록을 한다. */
  onChunk(chunk: RecordedChunk): void | Promise<void>;
  /** 소리가 안 담긴 조각. 마이크를 뺏겼다는 뜻이다. */
  onEmptyChunk?(chunk: RecordedChunk): void;
  onError(error: unknown): void;
}

/**
 * 한 근무의 기록 세션.
 *
 * 8시간을 한 파일에 담지 않는다. 이유가 셋이다.
 *   - 앱이 죽거나 파일이 손상되면 전부 잃는다
 *   - 근무가 끝나야 전사를 시작할 수 있다 (중간중간 돌리는 편이 훨씬 낫다)
 *   - 파일이 커지면 이동·삭제가 느려진다
 */
export class RecordingSession {
  private state: SessionState = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chunkIndex: number;
  private chunkStartedAt = 0;
  /** 포그라운드 서비스를 이 세션이 쥐고 있는가. 짝을 맞추려고 센다. */
  private holdsService = false;
  /**
   * 지금 도는 회전(파일 닫고 다음 열기). stop() 이 이걸 기다린다.
   *
   * 안 기다리면 타이머가 막 회전을 시작한 순간에 사용자가 정지를 눌렀을 때
   * 둘이 같은 녹음기를 두 번 멈추고, 회전은 정지 뒤에 **새 파일을 또 연다** —
   * 화면은 꺼졌는데 마이크는 켜진 채 남는다.
   */
  private rotating: Promise<void> | null = null;
  /**
   * 마이크를 뺏겨 빈 파일이 **두 번 연속** 나왔다. 살아 있는 척하지 않는다 —
   * tick 이 되살린다.
   *
   * 한 번으로 죽이지 않는 이유: 전화가 3분 왔다 가면 그 조각은 비지만 다음
   * 조각부터는 멀쩡히 담긴다. 한 번에 주저앉히면 tick 이 올 때까지(15분에서
   * 한 시간) 아무것도 안 담긴다. 예전 코드는 경계에서 무조건 다시 열었다.
   */
  private dead = false;
  private emptyStreak = 0;

  /**
   * @param startIndex 이 근무에 이미 있는 조각 다음 번호.
   *
   *   0 에서 다시 세면 안 된다. 파일 이름도 DB 키도 `근무id + 번호`라서,
   *   같은 근무에서 기록이 두 번 켜지면(점심에 나갔다 들어오면 그렇다)
   *   두 번째 000 번이 첫 번째 000 번 **파일을 덮어쓰고** DB 는 키 충돌로
   *   터진다. 아침 기록이 사라지는 길이었다.
   */
  constructor(
    private readonly backend: AudioBackend,
    private readonly policy: RecordingPolicy,
    private readonly shiftId: string,
    private readonly callbacks: SessionCallbacks,
    startIndex = 0,
  ) {
    this.chunkIndex = startIndex;
  }

  get isActive(): boolean {
    return this.state === "recording" && !this.dead;
  }

  async start(now: number): Promise<boolean> {
    if (this.state !== "idle") return true;
    this.dead = false;
    this.emptyStreak = 0;
    const granted = await this.backend.ensurePermission();
    if (!granted) return false;

    // **포그라운드 서비스를 잡는다 (안드로이드).**
    //
    // 이게 없으면 화면을 끄거나 다른 앱으로 넘어간 순간 시스템이 우리를
    // 얼리고(cached app freezer), 안드로이드 14+ 는 아예 마이크를 끊는다.
    // 사용자는 기록되는 줄 알고 근무를 다 보낸 뒤에야 파일이 없는 것을 안다.
    // 유형은 microphone 이어야 한다 — dataSync 만으로는 마이크가 안 산다.
    //
    // 잡는 것과 놓는 것을 **세션이** 짝지어 쥔다. 백엔드에 두었더니 시작이
    // 실패한 경로에서 놓지 못하고 참조가 새서, 아무것도 기록하지 않는 채
    // "기록 중" 알림만 영영 떠 있었다.
    await beginWork("기록 중", "화면을 꺼도 계속 기록해요", true);
    this.holdsService = true;

    try {
      await this.backend.prepareSession({ silent: this.policy.silentStart });
      this.state = "recording";
      await this.beginChunk(now);
    } catch (error) {
      this.callbacks.onError(error);
      this.state = "idle";
    }
    // beginChunk 이 실패하면 state 가 idle 로 돌아온다. 그때도 true 를 주면
    // 화면이 "기록 중"으로 보이고 사용자는 안 되는 줄 모른 채 근무를 다 보낸다.
    if (this.state !== "recording") {
      await this.release();
      return false;
    }
    return true;
  }

  /** 서비스를 놓는다. 두 번 불러도 한 번만 놓는다. */
  private async release(): Promise<void> {
    await this.backend.releaseSession();
    if (!this.holdsService) return;
    this.holdsService = false;
    await endWork(RECORDING_WORK_ID);
  }

  /** 근무 종료 또는 사용자 중지. */
  async stop(now: number): Promise<void> {
    // 회전 중이면 끝나기를 기다린다. 그 뒤의 상태로 판단해야 한다.
    if (this.rotating) await this.rotating.catch(() => {});
    // 상태가 무엇이든 서비스는 놓는다. 예전에는 idle 이면 곧장 돌아가서,
    // 조각 열기에 실패한 세션이 서비스를 쥔 채 버려졌다.
    if (this.state !== "recording") {
      await this.release();
      return;
    }
    this.state = "stopping";
    this.clearTimer();
    try {
      const chunk = await this.closeChunk(now);
      if (chunk) await this.persistChunk(chunk);
    } finally {
      await this.release();
      this.state = "idle";
    }
  }

  private async beginChunk(now: number): Promise<void> {
    this.chunkStartedAt = now;
    try {
      await this.callbacks.onChunkStart?.(this.chunkIndex, now);
    } catch (error) {
      // 줄을 못 만들어도 소리는 담는다. 파일이 있으면 나중에 이어 붙일 수 있다.
      this.callbacks.onError(error);
    }
    const fileName = `${this.shiftId.replace(/:/g, "_")}__${String(this.chunkIndex).padStart(3, "0")}.m4a`;
    try {
      await this.backend.start(fileName);
    } catch (error) {
      this.callbacks.onError(error);
      this.state = "idle";
      await this.release();
      return;
    }
    this.scheduleRotation();
  }

  private scheduleRotation(): void {
    this.clearTimer();
    const ms = Math.max(1, this.policy.segmentMinutes) * 60_000;
    this.timer = setTimeout(() => {
      void this.rotate(Date.now());
    }, ms);
  }

  /** 현재 파일을 닫고 즉시 다음 파일을 연다. 사이의 공백을 최소화한다. */
  private rotate(now: number): Promise<void> {
    if (this.state !== "recording") return Promise.resolve();
    const run = (async () => {
      let previous: RecordedChunk | null = null;
      try {
        previous = await this.closeChunk(now);
        // 닫는 사이에 정지가 들어왔거나 마이크를 뺏겼으면 새 파일을 열지 않는다.
        if (this.state === "recording" && !this.dead) {
          this.chunkIndex += 1;
          await this.beginChunk(now);
        }
      } catch (error) {
        // 닫다가 터졌으면 녹음기 상태를 믿을 수 없다. 살아 있는 척하면 tick 이
        // 안 되살리고, 화면은 '기록 중' 인 채 아무것도 안 담긴다.
        this.callbacks.onError(error);
        this.state = "idle";
      }
      // DB 쓰기는 **다음 파일이 돌기 시작한 뒤에** 한다. (파일 옮기기는 아직
      // backend.stop() 안에서 먼저 일어난다 — 이름 바꾸기라 보통 한순간이다.)
      if (previous) await this.persistChunk(previous);
      if (this.state !== "recording" || this.dead) {
        this.state = "idle";
        // release 가 터져도 여기서 삼킨다 — 밖은 `void rotate()` 라 받을 곳이 없다.
        await this.release().catch((error) => this.callbacks.onError(error));
      }
    })();
    this.rotating = run;
    return run.finally(() => {
      if (this.rotating === run) this.rotating = null;
    });
  }

  /** 녹음기를 멈추고 조각을 돌려준다. 저장은 하지 않는다. */
  private async closeChunk(now: number): Promise<RecordedChunk | null> {
    if (!this.backend.isRecording()) return null;
    const result = await this.backend.stop();
    const chunk: RecordedChunk = {
      index: this.chunkIndex,
      uri: result.uri,
      startedAt: this.chunkStartedAt,
      endedAt: now,
      durationSec: result.durationSec,
      sizeBytes: result.sizeBytes,
    };
    // 0바이트거나 몇 초 만에 끝난 조각은 마이크를 뺏긴 것이다.
    const empty =
      chunk.sizeBytes === 0 || (chunk.durationSec < 1 && now - this.chunkStartedAt > 5_000);
    if (empty) {
      this.emptyStreak += 1;
      this.callbacks.onEmptyChunk?.(chunk);
      // 두 번 연속이면 다음 파일을 열어도 소용없다. 살아 있다고 보고하면 tick 이
      // 되살리지 않는다 — 예전에는 알림 글만 남기고 끝이었다.
      if (this.emptyStreak >= 2) this.dead = true;
    } else {
      this.emptyStreak = 0;
    }
    return chunk;
  }

  private async persistChunk(chunk: RecordedChunk): Promise<void> {
    try {
      await this.callbacks.onChunk(chunk);
    } catch (error) {
      // 파일은 이미 저장됐다. 여기서 던지면 stop() 이 중간에 끊겨 세션이
      // '기록 중'으로 갇히고, 그다음부터는 아무것도 시작되지 않는다.
      this.callbacks.onError(error);
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ────────────────────────────────────────────────────────────
//  Expo 구현
// ────────────────────────────────────────────────────────────

/**
 * expo-audio 기반 백엔드.
 *
 * 파일 경로에 대해: expo-audio는 자기 캐시 경로에 쓰고 `uri`로 알려줄 뿐,
 * 출력 위치를 지정하는 옵션이 없다. 캐시는 OS가 언제든 비울 수 있으므로
 * 기록이 끝나면 곧바로 문서 디렉터리로 옮긴다.
 */
export function createExpoAudioBackend(): AudioBackend {
  let recorder: AudioRecorder | null = null;
  let recording = false;
  let startedAtMs = 0;
  let currentName = "";

  return {
    async ensurePermission() {
      const status = await requestRecordingPermissionsAsync();
      return status.granted;
    },

    async prepareSession({ silent }) {
      await setAudioModeAsync({
        // iOS에서 마이크를 쓰려면 세션이 기록을 허용해야 한다.
        allowsRecording: true,
        // 화면을 꺼도 세션이 살아 있어야 기록이 이어진다.
        shouldPlayInBackground: true,
        // 다른 앱 소리를 끊지 않는다. 통화나 알람이 죽으면 바로 들킨다.
        interruptionMode: "mixWithOthers",
      });
      // 시작음·종료음은 애초에 재생하지 않는다.
      // 이 플래그는 정책을 코드에 남겨두기 위한 것이고, 여기서 할 일은 없다.
      void silent;
    },

    async start(fileName) {
      currentName = fileName;
      recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recorder.prepareToRecordAsync();
      recorder.record();
      recording = true;
      startedAtMs = Date.now();
      return recordingFileUri(fileName);
    },

    async stop() {
      if (!recorder) throw new Error("녹음이 켜져 있지 않아요. 다시 눌러 주세요.");
      const r = recorder;
      // 멈추다 터져도 깃발은 내린다. 안 내리면 다음 정지가 죽은 녹음기를 또
      // 멈추려 들고, isRecording() 은 영영 참이다.
      recording = false;
      recorder = null;
      await r.stop();

      const durationSec =
        r.currentTime > 0 ? r.currentTime : Math.max(0, (Date.now() - startedAtMs) / 1000);
      const tempUri = r.uri ?? "";

      const uri = tempUri ? moveIntoRecordings(tempUri, currentName) : "";
      // 크기를 못 구해도 기록 자체는 유효하다. 저장 용량 계산만 부정확해진다.
      return { uri, durationSec, sizeBytes: fileSize(uri) };
    },

    async releaseSession() {
      await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
    },

    isRecording() {
      return recording;
    },
  };
}
