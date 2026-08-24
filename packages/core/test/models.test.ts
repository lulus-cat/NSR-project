import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL_ID,
  OFFICIAL_MODELS,
  checkFeasible,
  estimateMinutes,
  getModel,
  makeCustomModel,
} from "../src/transcription/index.js";

describe("모델 목록", () => {
  it("기본 모델이 목록에 있다", () => {
    expect(getModel(DEFAULT_MODEL_ID)).toBeDefined();
  });

  it("id가 중복되지 않는다", () => {
    const ids = OFFICIAL_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("공식 모델은 전부 받을 곳이 있고 ggml 파일이다", () => {
    for (const m of OFFICIAL_MODELS) {
      expect(m.url, m.id).toMatch(/^https:\/\//);
      expect(m.file, m.id).toMatch(/\.bin$/);
    }
  });

  it("모르는 정확도는 null로 둔다", () => {
    // 추정치를 적어 두면 사용자가 사실로 받아들인다.
    for (const m of OFFICIAL_MODELS) {
      if (m.korean === null) continue;
      expect(m.korean.source.length, m.id).toBeGreaterThan(3);
      expect(m.korean.cer).toBeGreaterThan(0);
    }
    expect(OFFICIAL_MODELS.some((m) => m.korean === null)).toBe(true);
  });

  it("큰 모델일수록 느리다", () => {
    const small = getModel("small-q5_1")!;
    const large = getModel("large-v3-q5_0")!;
    expect(large.relativeSpeed).toBeLessThan(small.relativeSpeed);
    expect(large.approxSizeMb).toBeGreaterThan(small.approxSizeMb);
  });
});

describe("전사 시간 추정", () => {
  const small = getModel("small-q5_1")!;
  const large = getModel("large-v3-q5_0")!;
  // 이 기기에서 small 이 실시간의 절반 속도였다고 하자.
  const sample = { modelId: "small-q5_1", secondsPerAudioSecond: 0.5 };

  it("재본 적 없으면 모른다고 말한다", () => {
    const e = estimateMinutes(small, 90);
    expect(e.minutes).toBe(0);
    expect(e.label).toContain("재봐야");
  });

  it("잰 모델은 그대로 환산한다", () => {
    // 90분 오디오 × 0.5 = 45분
    expect(estimateMinutes(small, 90, sample).minutes).toBe(45);
    expect(estimateMinutes(small, 90, sample).estimated).toBe(false);
  });

  it("다른 모델은 상대 속도로 환산하고 추정임을 밝힌다", () => {
    const e = estimateMinutes(large, 90, sample);
    // large 는 small 의 1/4 속도 → 4배 걸린다
    expect(e.minutes).toBe(180);
    expect(e.estimated).toBe(true);
    expect(e.label).toContain("3시간");
  });
});

describe("현실성 판단", () => {
  const sample = { modelId: "small-q5_1", secondsPerAudioSecond: 0.5 };
  const large = getModel("large-v3-q5_0")!;

  it("다음 근무 전에 못 끝나면 막는다", () => {
    const e = estimateMinutes(large, 90, sample); // 180분
    const f = checkFeasible(e, 2); // 2시간 = 120분
    expect(f.ok).toBe(false);
    expect(f.reason).toContain("더 작은 모델");
  });

  it("빠듯하면 충전을 알려준다", () => {
    const e = estimateMinutes(large, 90, sample); // 180분
    const f = checkFeasible(e, 4); // 240분, 75% 사용
    expect(f.ok).toBe(true);
    expect(f.reason).toContain("충전");
  });

  it("넉넉하면 아무 말 안 한다", () => {
    const e = estimateMinutes(getModel("small-q5_1")!, 90, sample); // 45분
    expect(checkFeasible(e, 12).reason).toBeUndefined();
  });

  it("재본 적 없으면 막지 않는다", () => {
    expect(checkFeasible(estimateMinutes(large, 90), 1).ok).toBe(true);
  });
});

describe("직접 넣은 모델", () => {
  it("ggml 파일만 받는다", () => {
    expect(makeCustomModel({ name: "한국어", file: "model.pt" }).error).toContain("ggml");
  });

  it("http 주소는 거절한다", () => {
    const r = makeCustomModel({ name: "한국어", file: "m.bin", url: "http://x/m.bin" });
    expect(r.error).toContain("https");
  });

  it("이름이 없으면 거절한다", () => {
    expect(makeCustomModel({ name: "  ", file: "m.bin" }).error).toContain("이름");
  });

  it("정확도를 지어내지 않는다", () => {
    const r = makeCustomModel({ name: "한국어 파인튜닝", file: "ggml-ko.bin", approxSizeMb: 500 });
    expect(r.model?.korean).toBeNull();
    expect(r.model?.family).toBe("custom");
  });

  it("크기로 속도를 대략 잡는다", () => {
    const big = makeCustomModel({ name: "큰것", file: "a.bin", approxSizeMb: 1000 }).model!;
    const small = makeCustomModel({ name: "작은것", file: "b.bin", approxSizeMb: 100 }).model!;
    expect(big.relativeSpeed).toBeLessThan(small.relativeSpeed);
  });
});
