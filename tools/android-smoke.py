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

녹음 중인지는 화면으로 못 본다 — 마이크 버튼이 계속 고동쳐서 uiautomator 가 화면을
못 읽는다("could not get idle state"). 그건 안드로이드의 마이크 사용 기록(appops,
상단 초록 점과 같은 근거)으로 본다 (mic_on).
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
        # 지난 파일을 먼저 지운다. 안 지우면 dump 가 실패했을 때(녹음 중) 예전 화면을
        # 읽고 판정한다 — 0.1.125 시험이 그렇게 틀렸다.
        adb("shell", "rm", "-f", "/sdcard/ui.xml")
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
    adb("shell", "rm", "-f", "/sdcard/ui.xml")
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


def mic_on() -> bool:
    """앱이 지금 마이크로 소리를 받고 있나 (appops 의 RECORD_AUDIO 가 running).

    expo-audio 가 뒤에서 녹음기를 일시정지하면(7초 버그) 여기서 running 이 사라진다.
    """
    return "running" in adb("shell", "appops", "get", PKG, "RECORD_AUDIO").lower()


def wait_mic(on: bool, timeout: int = 15) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if mic_on() == on:
            return True
        time.sleep(1)
    return False


def deny_notif_prompt() -> None:
    """알림 권한 창이 뜨면 '허용 안 함'. 영어판 글자는 굽은 따옴표(Don’t)라 앞을 뗀다."""
    for label in ("t allow", "허용 안"):
        if tap(label, 4):
            say(f"     알림 권한 창에서 '{label}' 거절")
            return


def dismiss_dialogs() -> list[str]:
    """앱이 띄운 대화상자를 내용을 남기고 닫는다.

    대화상자가 떠 있으면 uiautomator 는 그 창만 읽는다 — 밑의 홈('기록 멈추기')이 안 보여
    녹음이 켜졌는데도 안 켜진 것으로 판정된다. 닫고 나서 본다.
    """
    seen = []
    for _ in range(3):
        root = dump()
        title = "기록을 켜지 못했어요" if find(root, "기록을 켜지 못했어요") else None
        if title is None:
            break
        say(f"     대화상자 '{title}': " + " / ".join(texts(root)[:6]))
        seen.append(title)
        if not (tap("그만두기", 3, exact=True) or tap("OK", 3, exact=True) or tap("확인", 3, exact=True)):
            adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(1)
    return seen


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

    def press(on: bool, what: str) -> bool:
        """마이크 버튼을 누르고, 정말 켜졌는지(꺼졌는지) 마이크 사용 기록으로 본다."""
        tap_xy(*mic_xy)
        ok = wait_mic(on, 15)
        if not ok:
            dismiss_dialogs()  # 실패 안내가 떠 있으면 내용을 남기고 닫는다
        check(ok, what)
        return ok

    def recordings(name: str):
        dismiss_dialogs()
        open_link("nsr://recordings")
        time.sleep(6)
        shot(name)
        root = dump()
        rows = [t for t in texts(root) if re.match(r"\d\d:\d\d 시작", t)]
        say("     녹음 기록: " + (" | ".join(rows) if rows else "(줄 없음)"))
        return root, rows

    on = press(True, "마이크를 누르면 녹음이 시작된다")
    say("     마이크 사용 기록: " + " / ".join(adb("shell", "appops", "get", PKG, "RECORD_AUDIO").split("\n")).strip())
    shot("after-start")

    # ── 앱이 뒤로 가도(화면을 꺼도) 이어지나 — '7초만 저장' 버그 ──
    with open(f"{OUT}/services-recording.txt", "w") as f:
        f.write(adb("shell", "dumpsys", "activity", "services", PKG))
    adb("shell", "input", "keyevent", "KEYCODE_HOME")
    time.sleep(40)
    check(mic_on(), "앱이 뒤에 40초 있어도 녹음이 이어진다")
    time.sleep(5)
    launch()
    time.sleep(5)
    shot("back-after-45s")
    if on:
        press(False, "다시 누르면 녹음이 멈춘다")

    # ── 짧게 켰다 끄기를 두 번 — 두 번째 녹음부터 준비가 안 끝나 '녹음 중' 줄이 쌓이던 길 ──
    for i in (2, 3):
        if press(True, f"{i}번째 녹음도 켜진다"):
            time.sleep(4)
            press(False, f"{i}번째 녹음도 멈춘다")
        time.sleep(2)

    root, rows = recordings("recordings")
    ghosts = sum(1 for t in texts(root) if t == "녹음 중")
    check(ghosts == 0, f"'녹음 중' 으로 남은 줄이 없다 (지금 {ghosts}개)")
    check(len(rows) == 3, f"세 번 녹음해서 세 줄이 남는다 (지금 {len(rows)}줄)")
    # 길이는 크기로도 본다. 화면은 분 단위라 1분이 안 되는 것도 '1분' 으로 적는다.
    # 128kbps AAC 는 초당 16KB 쯤이니 55초면 0.8MB 다.
    mbs = [float(x) for t in texts(root) for x in re.findall(r"([0-9]+\.[0-9])MB", t)]
    say(f"     파일 크기: {mbs}")
    check(max(mbs, default=0.0) >= 0.5, "뒤로 가 있던 동안까지 담긴다 (가장 큰 파일 0.5MB 이상)")

    # ── 앱을 완전히 닫았다 다시 열면 뜨나 (무한 로딩) ──
    adb("shell", "am", "force-stop", PKG)
    time.sleep(2)
    t0 = time.time()
    launch()
    home = wait_for("기록 시작하기", 90)
    check(home is not None, "닫았다 다시 열면 90초 안에 홈이 뜬다 (무한 로딩이 아니다)")
    say(f"     다시 열기까지 {time.time() - t0:.0f}초")
    shot("relaunch")

    # ── 알림 권한이 없을 때 — 안드로이드 13+ 에서 '허용 안 함' 을 누른 폰 ──
    # 권한을 거두면 안드로이드가 앱을 죽인다. 다시 열어 마이크를 누른다.
    adb("shell", "pm", "revoke", PKG, "android.permission.POST_NOTIFICATIONS")
    time.sleep(2)
    launch()
    mic = wait_for("기록 시작하기", 90)
    if mic is None:
        check(False, "알림 권한을 거둔 뒤 다시 열면 홈이 뜬다")
        return
    mic_xy = center(mic)
    tap_xy(*mic_xy)
    time.sleep(2)
    deny_notif_prompt()
    on = wait_mic(True, 15)
    shot("no-notif-after-start")
    if not on:
        dismiss_dialogs()
    check(on, "알림 권한이 없어도 녹음이 켜진다")
    if on:
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        time.sleep(20)
        check(mic_on(), "알림 권한이 없어도 앱이 뒤에 있는 동안 녹음이 이어진다")
        launch()
        time.sleep(5)
        press(False, "알림 권한이 없어도 다시 누르면 멈춘다")
    root, _ = recordings("recordings-no-notif")
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
