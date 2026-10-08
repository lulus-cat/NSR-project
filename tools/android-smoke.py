#!/usr/bin/env python3
"""
에뮬레이터에서 NSR 의 녹음 흐름을 실제로 돌려 본다 — CI(android-test.yml) 전용.

폰에 깔아 보기 전에 "켜지나, 화면을 꺼도 이어지나, 멈추면 남나, 다시 열면 뜨나" 를
진짜 안드로이드에서 먼저 확인한다. 실기기에서 하던 시행착오를 여기서 한다.

    python3 tools/android-smoke.py <apk> <결과 폴더>

결과 폴더에 단계별 화면(png)·화면 구조(xml)·logcat·요약(summary.txt)이 남는다.
확인 하나가 틀려도 끝까지 돌고, 하나라도 틀렸으면 종료 코드 1 로 끝난다.

화면은 uiautomator 로 읽는다 — 글자(text)와 접근성 이름(content-desc)으로 찾아서
그 한가운데를 누른다. 출시용 APK 라 앱 안의 DB 는 못 열어 본다(run-as 불가).
그래서 판정은 사람이 보는 화면(녹음 기록)과 logcat 으로 한다.
"""
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

PKG = "app.nsr.shiftlog"
APK, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
lines: list[str] = []
failed = False


def say(msg: str) -> None:
    print(msg, flush=True)
    lines.append(msg)


def check(ok: bool, what: str) -> None:
    global failed
    say(("PASS " if ok else "FAIL ") + what)
    failed |= not ok


def adb(*args: str, timeout: int = 120) -> str:
    try:
        r = subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return ""


W, H = 1080, 2400


def dump():
    for _ in range(3):
        adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
        xml = adb("shell", "cat", "/sdcard/ui.xml")
        start = xml.find("<?xml")
        if start >= 0:
            try:
                return ET.fromstring(xml[start:])
            except ET.ParseError:
                pass
        time.sleep(1)
    return None


def find(root, needle: str, exact: bool = False):
    if root is None:
        return None
    for n in root.iter("node"):
        for v in (n.get("text", ""), n.get("content-desc", "")):
            if (v == needle) if exact else (needle in v):
                return n
    return None


def center(n) -> tuple[int, int]:
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
    return (x1 + x2) // 2, (y1 + y2) // 2


def tap_xy(x: int, y: int) -> None:
    adb("shell", "input", "tap", str(x), str(y))


def swipe_up() -> None:
    adb("shell", "input", "swipe", str(W // 2), str(H * 7 // 10), str(W // 2), str(H * 3 // 10), "400")


def wait_for(needle: str, timeout: int = 60, exact: bool = False, scroll: bool = False):
    end = time.time() + timeout
    while time.time() < end:
        n = find(dump(), needle, exact)
        if n is not None:
            return n
        if scroll:
            swipe_up()
        time.sleep(2)
    return None


def tap(needle: str, timeout: int = 60, exact: bool = False, scroll: bool = False) -> bool:
    n = wait_for(needle, timeout, exact, scroll)
    if n is None:
        say(f"     '{needle}' 이(가) {timeout}초 안에 안 보였다")
        return False
    tap_xy(*center(n))
    time.sleep(1.5)
    return True


shots = 0


def shot(name: str) -> None:
    global shots
    shots += 1
    base = f"{OUT}/{shots:02d}-{name}"
    adb("shell", "screencap", "-p", "/sdcard/s.png")
    adb("pull", "/sdcard/s.png", base + ".png")
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    adb("pull", "/sdcard/ui.xml", base + ".xml")


def launch() -> None:
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")


def open_link(url: str) -> None:
    adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", url, PKG)


def texts(root) -> list[str]:
    if root is None:
        return []
    return [v for n in root.iter("node") for v in (n.get("text", ""),) if v]


def main() -> None:
    global W, H
    m = re.search(r"(\d+)x(\d+)", adb("shell", "wm", "size"))
    if m:
        W, H = int(m.group(1)), int(m.group(2))
    say(f"화면 {W}x{H}, 안드로이드 {adb('shell', 'getprop', 'ro.build.version.release').strip()}")

    # -g: 앱이 쓰는 권한(마이크·알림·위치)을 미리 준다. 권한 창은 이 시험의 대상이 아니다.
    say("설치: " + adb("install", "-r", "-g", APK, timeout=600).strip().splitlines()[-1])
    adb("logcat", "-c")

    # ── 첫 실행: 안내 화면을 넘긴다 ──
    t0 = time.time()
    launch()
    check(wait_for("나중에 지정하기", 240) is not None, "첫 실행에서 안내 화면이 뜬다")
    say(f"     첫 화면까지 {time.time() - t0:.0f}초")
    shot("onboarding")
    tap("나중에 지정하기", exact=True)
    if not tap("나중에 정하기", 15, exact=True):
        tap("다음", 15, exact=True)
    tap("다음", 30, exact=True)
    # 동의 항목을 전부 누른다. 화면 밖에 있는 것은 밀어 올려 가며.
    for _ in range(12):
        root = dump()
        boxes = [n for n in (root.iter("node") if root is not None else [])
                 if n.get("checkable") == "true" and n.get("checked") == "false"]
        for b in boxes:
            tap_xy(*center(b))
            time.sleep(0.6)
        if find(dump(), "시작하기", exact=True) is not None:
            break
        swipe_up()
        time.sleep(1)
    shot("consent")
    check(tap("시작하기", 20, exact=True, scroll=True), "동의를 마치고 시작한다")

    # ── 홈: 마이크로 켠다 ──
    mic = wait_for("기록 시작하기", 60)
    check(mic is not None, "홈이 뜬다")
    shot("home")
    if mic is None:
        return
    mic_xy = center(mic)

    tap_xy(*mic_xy)
    time.sleep(8)
    shot("after-start")
    root = dump()
    check(find(root, "기록 멈추기") is not None, "마이크를 누르면 기록이 켜진다")
    alert = find(root, "기록을 켜지 못했어요")
    if alert is not None:
        say("     경고창: " + " / ".join(texts(root)[:8]))
        tap("확인", 5, exact=True) or adb("shell", "input", "keyevent", "KEYCODE_BACK")

    # ── 화면을 꺼도(앱이 뒤로 가도) 이어지나 ──
    with open(f"{OUT}/services-recording.txt", "w") as f:
        f.write(adb("shell", "dumpsys", "activity", "services", PKG))
    adb("shell", "input", "keyevent", "KEYCODE_HOME")
    time.sleep(45)
    launch()
    time.sleep(6)
    shot("back-after-45s")
    stop = wait_for("기록 멈추기", 20)
    check(stop is not None, "뒤에 45초 있다 돌아와도 기록 중이다")
    if stop is not None:
        tap_xy(*center(stop))
        time.sleep(6)
    shot("after-stop")

    # ── 짧게 켰다 끄기를 두 번 — 줄이 여러 개 남던 길 ──
    for i in range(2):
        tap_xy(*mic_xy)
        time.sleep(5)
        tap_xy(*mic_xy)
        time.sleep(4)
    shot("after-bursts")

    # ── 녹음 기록 화면에서 확인 ──
    open_link("nsr://recordings")
    time.sleep(6)
    shot("recordings")
    root = dump()
    rows = [t for t in texts(root) if "시작" in t]
    say("     녹음 기록: " + (" | ".join(rows) if rows else "(줄 없음)"))
    ghosts = sum(1 for t in texts(root) if t == "녹음 중")
    check(ghosts == 0, f"'녹음 중' 으로 남은 줄이 없다 (지금 {ghosts}개)")
    # 길이는 크기로 본다. 화면은 분 단위라 1분이 안 되는 것도 '1분' 으로 적는다 — 7초만
    # 남던 버그를 그걸로는 못 잡는다. 128kbps AAC 는 초당 16KB 쯤이니 50초면 0.8MB 다.
    mbs = [float(x) for t in texts(root) for x in re.findall(r"([0-9]+\.[0-9])MB", t)]
    say(f"     파일 크기: {mbs}")
    check(max(mbs, default=0.0) >= 0.5, "뒤로 가 있던 45초까지 담긴다 (가장 큰 파일 0.5MB 이상)")

    # ── 앱을 완전히 닫았다 다시 열면 뜨나 (무한 로딩) ──
    adb("shell", "am", "force-stop", PKG)
    time.sleep(2)
    t0 = time.time()
    launch()
    home = wait_for("기록 시작하기", 40)
    check(home is not None, "닫았다 다시 열면 40초 안에 홈이 뜬다")
    say(f"     다시 열기까지 {time.time() - t0:.0f}초")
    shot("relaunch")
    open_link("nsr://recordings")
    time.sleep(6)
    shot("recordings-after-relaunch")

    # ── 알림 권한이 없을 때 — 안드로이드 13+ 에서 사람이 '허용 안 함' 을 누른 경우 ──
    # 권한을 거두면 안드로이드가 앱을 죽인다. 다시 열어 마이크를 누른다.
    adb("shell", "pm", "revoke", PKG, "android.permission.POST_NOTIFICATIONS")
    time.sleep(2)
    launch()
    mic = wait_for("기록 시작하기", 40)
    if mic is None:
        check(False, "알림 권한을 거둔 뒤 다시 열면 홈이 뜬다")
        return
    tap_xy(*center(mic))
    time.sleep(3)
    for label in ("Don't allow", "허용 안함", "허용 안 함"):  # 앱이 묻는 알림 권한 창
        if tap(label, 3, exact=True):
            say(f"     알림 권한 창에서 '{label}'")
            break
    time.sleep(12)
    shot("no-notif-after-start")
    root = dump()
    started = find(root, "기록 멈추기") is not None
    check(started, "알림 권한이 없어도 녹음이 켜진다")
    if find(root, "기록을 켜지 못했어요") is not None:
        say("     경고창: " + " / ".join(texts(root)[:8]))
        tap("OK", 5, exact=True) or tap("확인", 5, exact=True)
    if started:
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        time.sleep(20)
        launch()
        stop = wait_for("기록 멈추기", 20)
        if stop is not None:
            tap_xy(*center(stop))
            time.sleep(5)
    open_link("nsr://recordings")
    time.sleep(6)
    shot("recordings-no-notif")
    root = dump()
    say("     녹음 기록: " + " | ".join(t for t in texts(root) if "시작" in t))
    ghosts = sum(1 for t in texts(root) if t == "녹음 중")
    check(ghosts == 0, f"알림 권한이 없어도 '녹음 중' 유령 줄이 안 생긴다 (지금 {ghosts}개)")


try:
    main()
except Exception as e:  # 시험 도구가 터져도 기록은 남긴다
    check(False, f"시험 도구 오류: {e!r}")
finally:
    log = adb("logcat", "-d", "-v", "threadtime", timeout=120)
    with open(f"{OUT}/logcat.txt", "w") as f:
        f.write(log)
    keep = re.compile(r"ReactNativeJS|NSR|AndroidRuntime|FATAL|expo|Audio|MediaRecorder|ForegroundService|NsrWork|startForeground", re.I)
    with open(f"{OUT}/logcat-app.txt", "w") as f:
        f.write("\n".join(l for l in log.splitlines() if keep.search(l)))
    # 앱이 죽었으면 그 자리를 요약에 바로 붙인다 — logcat 6만 줄을 뒤질 필요가 없게.
    crash = log.find("FATAL EXCEPTION")
    if crash >= 0:
        lines.append("앱이 죽었다:")
        lines.extend("     " + l for l in log[crash:].splitlines()[:12])
    with open(f"{OUT}/summary.txt", "w") as f:
        f.write("\n".join(lines) + "\n")
    sys.exit(1 if failed else 0)
