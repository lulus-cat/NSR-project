import { describe, it, expect } from "vitest";
import {
  DEFAULT_COLAB_MODEL_ID,
  SERVER_MODELS,
  getServerModel,
  serverModelsFor,
} from "../src/transcription/index.js";

describe("서버 모델 목록", () => {
  it("콜랩 기본 모델이 목록에 있다", () => {
    expect(getServerModel(DEFAULT_COLAB_MODEL_ID)).toBeDefined();
  });

  it("id가 중복되지 않는다", () => {
    const ids = SERVER_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("미러 전용을 뺀 나머지는 허깅페이스 저장소 id 꼴이다", () => {
    for (const m of SERVER_MODELS) {
      if (m.where === "colab") continue;
      expect(m.id, m.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });

  it("무료 콜랩 목록에 램을 넘기는 float32 원본이 없다", () => {
    // 실사용에서 3.2GB float32 적재가 세션을 죽였다 — pc 전용으로 밀어냈다.
    for (const m of serverModelsFor("colab")) {
      expect(m.where, m.id).not.toBe("pc");
    }
  });

  it("요약은 화면 규칙대로 딱 한 문장이다", () => {
    for (const m of SERVER_MODELS) {
      // 마침표로 끝나는 문장이 하나뿐이어야 한다.
      expect(m.summary.trim(), m.id).toMatch(/다\.$/);
      expect(m.summary.trim().split(/(?<=다\.)\s+/).length, m.id).toBe(1);
    }
  });

  it("PC 목록에는 콜랩 전용(릴리스 미러) 모델이 없다", () => {
    const pc = serverModelsFor("pc");
    expect(pc.every((m) => m.where !== "colab")).toBe(true);
    expect(pc.length).toBeGreaterThan(0);
  });

  it("콜랩 목록의 맨 위는 기본 모델이다", () => {
    const colab = serverModelsFor("colab");
    expect(colab[0].id).toBe(DEFAULT_COLAB_MODEL_ID);
  });

  it("크기를 밝힌다 — 서버가 받는 용량이지만 사용자가 기다릴 시간이다", () => {
    for (const m of SERVER_MODELS) {
      expect(m.approxGb, m.id).toBeGreaterThan(0);
    }
  });
});
