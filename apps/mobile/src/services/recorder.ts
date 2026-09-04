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
  /** 파일 하나가 완결될 때마다. 여기서 DB 저장과 전사 큐 등록을 한다. */
  onChunk(chunk: RecordedChunk): void | Promise<void>;
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
  private chunkIndex = 0;
  private chunkStartedAt = 0;

  constructor(
    private readonly backend: AudioBackend,
    private readonly policy: RecordingPolicy,
    private readonly shiftId: string,
    private readonly callbacks: SessionCallbacks,
  ) {}

  get isActive(): boolean {
    return this.state === "recording";
  }

  async start(now: number): Promise<boolean> {
    if (this.state !== "idle") return true;
    const granted = await this.backend.ensurePermission();
    if (!granted) return false;

    await this.backend.prepareSession({ silent: this.policy.silentStart });
    this.state = "recording";
    await this.beginChunk(now);
    // beginChunk 이 실패하면 state 가 idle 로 돌아온다. 그때도 true 를 주면
    // 화면이 "기록 중"으로 보이고 사용자는 안 되는 줄 모른 채 근무를 다 보낸다.
    return this.state === "recording";
  }

  /** 근무 종료 또는 사용자 중지. */
  async stop(now: number): Promise<void> {
    if (this.state !== "recording") return;
    this.state = "stopping";
    this.clearTimer();
    try {
      await this.finishChunk(now);
    } finally {
      await this.backend.releaseSession();
      this.state = "idle";
    }
  }

  private async beginChunk(now: number): Promise<void> {
    this.chunkStartedAt = now;
    const fileName = `${this.shiftId.replace(/:/g, "_")}__${String(this.chunkIndex).padStart(3, "0")}.m4a`;
    try {
      await this.backend.start(fileName);
    } catch (error) {
      this.callbacks.onError(error);
      this.state = "idle";
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
  private async rotate(now: number): Promise<void> {
    if (this.state !== "recording") return;
    try {
      await this.finishChunk(now);
      this.chunkIndex += 1;
      await this.beginChunk(now);
    } catch (error) {
      this.callbacks.onError(error);
    }
  }

  private async finishChunk(now: number): Promise<void> {
    if (!this.backend.isRecording()) return;
    const result = await this.backend.stop();
    const chunk: RecordedChunk = {
      index: this.chunkIndex,
      uri: result.uri,
      startedAt: this.chunkStartedAt,
      endedAt: now,
      durationSec: result.durationSec,
      sizeBytes: result.sizeBytes,
    };
    await this.callbacks.onChunk(chunk);
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
      await recorder.stop();
      recording = false;

      const durationSec =
        recorder.currentTime > 0
          ? recorder.currentTime
          : Math.max(0, (Date.now() - startedAtMs) / 1000);
      const tempUri = recorder.uri ?? "";
      recorder = null;

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
