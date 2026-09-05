# VPS 세팅 프롬프트

VPS 에 접속한 클로드(클로드 코드 등)에게 그대로 붙여 넣는 글이다. 아래 `---` 사이를
복사한다. 맨 위 세 줄의 빈칸만 채우면 된다.

---

너는 지금 내 VPS 안에서 일한다. 이 서버에 NSR 근무 기록 서버를 올려서, 내가 평소
쓰는 클로드·GPT 앱에 커넥터로 붙일 수 있게 만드는 것이 목표다.

- 내 도메인: `여기에-도메인-적기.example.com` (DNS 의 A 레코드가 이 서버를 가리키게 이미 해 뒀다)
- 서버 OS: (모르면 `cat /etc/os-release` 로 확인해라)
- sudo: 쓸 수 있다

## 먼저 읽을 것

`https://github.com/lulus-cat/NSR-project` 의 `server/README.md` 가 이 작업의 정본이다.
먼저 clone 하고 그 문서를 읽어라. 아래 순서와 문서가 어긋나면 문서를 따르고, 어긋난
곳을 나에게 말해라.

## 반드시 지킬 것

1. **토큰을 대화에 출력하지 마라.** 파일에만 쓰고, 다 되면 "어느 파일을 열어 보라"고만
   말해라. 나는 비개발자다 — 어떤 명령을 치면 되는지 한 줄로 알려 줘라.
2. **접근 로그를 남기지 마라.** 커넥터 주소 안에 토큰이 들어 있어서, 로그에 주소가
   남으면 그게 유출이다. caddy 로그는 discard 로 둔다.
3. **443 과 SSH 만 열어라.** 8787 을 바깥으로 열지 마라 (caddy 가 안에서 붙는다).
4. 서버는 `nsr` 라는 전용 사용자로 돌려라. root 로 돌리지 마라.
5. 파일에 담기는 것은 **환자 정보가 지워진 사본**이지만, 그래도 남에게 보이면 안 되는
   자료다. DB 파일 권한은 600 을 유지해라.

## 순서

각 단계가 끝날 때마다 **실제로 확인한 출력**을 근거로 다음으로 넘어가라. 안 되면
멈추고 무엇이 안 됐는지 나에게 말해라. 추측으로 넘어가지 마라.

1. **파이썬 확인.** `python3 -V` 가 3.11 이상이어야 한다. 낮으면 올릴 방법을 찾아
   설치해라 (우분투 24.04 는 기본이 3.12 다).
2. **내려받기.** `nsr` 사용자를 만들고 그 홈에 저장소를 clone 한 뒤,
   `server/` 에서 venv 를 만들고 `requirements.txt` 를 설치해라.
3. **환경변수 파일.** `NSR_MCP_TOKEN`(대화 AI 용), `NSR_DEVICE_TOKEN`(폰 용),
   그리고 **`NSR_PUBLIC_HOST`(내 도메인)**. README 의 명령으로 만들어
   `/home/nsr/nsr.env` 에 넣어라. 권한 600. 두 토큰은 서로 달라야 하고 32자 이상이다.
   `NSR_PUBLIC_HOST` 가 없으면 서버가 이유를 말하며 시작을 거부한다 — 그게 정상이다.
4. **systemd 등록.** README 의 서비스 파일을 그대로 쓰고, `systemctl enable --now nsr`
   한 뒤 `systemctl status nsr` 로 돌고 있는지 봐라.
5. **https.** 이 서버에 이미 nginx 가 돌고 있으면 그것을 쓰고, 없으면 caddy 를 써라.
   README 의 5번에 두 경우가 다 있다. 세 가지를 반드시 지켜라 —
   `Host` 를 바꾸지 말 것(서버가 `NSR_PUBLIC_HOST` 로 검사한다),
   `/.well-known/acme-challenge/` 를 프록시보다 먼저 빼 줄 것(안 그러면 인증서 발급 실패),
   `proxy_buffering off`(MCP 는 스트리밍이다).
   끝나면 `curl https://내도메인/healthz` 가 `ok` 를 주는지 확인해라.
6. **방화벽.** 80·443·SSH 만 열어라 (80 은 인증서 갱신에 필요하다). 8787 은 바깥에
   열지 마라 — 밖에서 `curl http://내도메인:8787/healthz` 가 **안 되는 것**까지 확인해라.

## 마지막 점검 — 진짜 도는지 본다

서버 안에서 아래를 돌려, 대화 AI 가 붙었을 때와 같은 왕복이 되는지 확인해라.
`$T` 는 `nsr.env` 의 `NSR_MCP_TOKEN`, `$D` 는 `NSR_DEVICE_TOKEN` 이다.
**출력에 토큰이 섞여 나오지 않게** 조심해라.

```bash
# 1) 대화 AI 처럼 인사하고 도구 목록 받기 — 도구 7개가 나와야 한다
URL="https://내도메인/t/$T/mcp"
curl -si -X POST "$URL" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"setup","version":"1"}}}' | tail -2

# 2) 폰처럼 자료 올리기 — 가리기를 안 했으니 400 이 나와야 정상이다
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://내도메인/ingest \
  -H "authorization: Bearer $D" -H 'content-type: application/json' \
  -d '{"shiftId":"test","masked":false,"sentences":[]}'

# 3) 개인정보가 남은 자료 — 422 가 나와야 정상이다
curl -s -X POST https://내도메인/ingest -H "authorization: Bearer $D" \
  -H 'content-type: application/json' \
  -d '{"shiftId":"test","date":"2026-01-01","code":"D","masked":true,"sentences":[{"t":0,"text":"010-1234-5678"}]}'

# 4) 제대로 가린 자료 — 200 이 나와야 정상이다
curl -s -X POST https://내도메인/ingest -H "authorization: Bearer $D" \
  -H 'content-type: application/json' \
  -d '{"shiftId":"test","date":"2026-01-01","code":"D","masked":true,"sentences":[{"t":0,"text":"[이름]님 폴리 확인"}]}'

# 5) 시험 자료 지우기
sudo -u nsr sqlite3 /home/nsr/nsr.db "DELETE FROM sentences WHERE shift_id='test'; DELETE FROM shifts WHERE shift_id='test';"
```

`server/` 폴더에서 `./venv/bin/python -m pytest -q` 도 돌려라. 14개가 통과해야 한다.

## 다 되면 나에게 알려 줄 것

1. **커넥터 주소를 어떻게 얻는지** — 토큰은 화면에 쓰지 말고, 내가 직접 볼 명령
   한 줄만 알려 줘라 (예: "`sudo cat /home/nsr/nsr.env` 를 치면 두 값이 보여요").
   그리고 주소의 모양만 알려 줘라: `https://내도메인/t/<MCP토큰>/mcp`
2. **폰에 넣을 값** — 서버 주소와 기기 토큰을 어디서 보는지.
3. **위 점검 1~4 의 결과**를 표로.
4. 못 한 것이 있으면 무엇이 왜 안 됐는지.

## 하지 말 것

- 서버 코드를 고치지 마라. 안 맞는 부분이 있으면 나에게 말해라 — 저장소는 다른
  자리에서 고친다.
- 토큰을 대화·로그·주석에 남기지 마라.
- 8787 포트를 바깥에 열지 마라.
- 시험용으로 넣은 자료를 남겨 두지 마라.
