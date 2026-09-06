# NSR 서버 — VPS 에 올리는 것

폰이 올린 **가려진** 근무 자료를 보관하고, 평소 쓰는 클로드·GPT 에 창구(MCP)로
열어 준다. 설계 근거는 `docs/08-app-ai-boundary.md` 에 있다.

한 프로그램이 두 손님을 받는다.

| 손님 | 주소 | 인증 |
| --- | --- | --- |
| 폰 (앱) | `/ingest` `/pull` `/pulled` | 헤더의 기기 토큰 |
| 대화 AI (클로드·GPT) | `/mcp` | OAuth — 연결할 때 로그인 화면에서 열쇠 한 번 |

**여기 오지 않는 것**: 원본 전사본(rawText), 오디오, 화자 실명, 태움 점수를 만든 문장.

---

## 1. 준비물

- 우분투 계열 서버 하나 (램 1GB면 충분하다 — 무거운 계산은 AI 쪽에서 한다)
- **도메인 하나.** 커넥터는 https 만 받는다. IP 만으로는 인증서를 못 받아 안 붙는다
- 파이썬 3.11 이상

## 2. 올리기

```bash
sudo apt update && sudo apt install -y python3-venv git
sudo useradd -m -s /bin/bash nsr
sudo -iu nsr

git clone https://github.com/lulus-cat/NSR-project.git
cd NSR-project/server
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## 3. 토큰 하나 만들기

평소에는 이걸 쓸 일이 없다. 폰은 앱에서 버튼 하나로 잇고(7번), AI 연결은 폰이 승인한다.
이 토큰은 그 두 길이 다 막혔을 때 `curl` 로 직접 넣을 수 있는 비상문이다.

```bash
python3 -c "import secrets;print('NSR_DEVICE_TOKEN=' + secrets.token_urlsafe(32))"
```

`/home/nsr/nsr.env` 에 적고 주인만 읽게 잠근다. **도메인도 함께 적는다** —
이게 없으면 커넥터가 421 로 막힌다(아래 5번 설명).

```bash
cat > /home/nsr/nsr.env <<'EOF'
NSR_DEVICE_TOKEN=...
NSR_DB=/home/nsr/nsr.db
NSR_PUBLIC_HOST=nsr.example.com
EOF
chmod 600 /home/nsr/nsr.env
```

## 4. 계속 돌게 하기 (systemd)

`/etc/systemd/system/nsr.service`

```ini
[Unit]
Description=NSR 근무 기록 서버
After=network.target

[Service]
User=nsr
WorkingDirectory=/home/nsr/NSR-project/server
EnvironmentFile=/home/nsr/nsr.env
ExecStart=/home/nsr/NSR-project/server/venv/bin/python -m nsr_server.app
Restart=always
# 서버가 건드릴 수 있는 곳을 줄인다
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/nsr
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now nsr
sudo systemctl status nsr
```

## 5. 바깥에서 들어오는 문 (caddy 또는 nginx)

### 왜 도메인을 서버에도 알려 줘야 하나

MCP SDK 는 `streamable_http_app(host="127.0.0.1")` 이라는 **고정 기본값**을 보고
"로컬 서버구나" 판단해 DNS 리바인딩 보호를 자동으로 켠다. 그러면 허용 목록이
`127.0.0.1`·`localhost` 뿐이라, 프록시가 넘긴 진짜 도메인 `Host` 를
**421 Invalid Host header** 로 거부한다. `Origin` 도 함께 검사해서, 커넥터가 보내는
`https://claude.ai` 가 목록에 없으면 **403** 이 난다.

그래서 `NSR_PUBLIC_HOST` 를 넣는다. 서버가 그 도메인과 커넥터 오리진을 허용 목록에
넣어 준다. 다른 커넥터를 쓰다 403 이 나면 `journalctl -u nsr` 에
`Invalid Origin header: ...` 가 찍히니, 그 값을 `NSR_ALLOWED_ORIGINS` 에 쉼표로 더한다.

> 프록시에서 `Host` 를 억지로 바꿔 우회하지 않는다. `Origin` 까지 걸리고, 헤더가
> 두 개 들어가면 `400 Invalid HTTP request` 가 난다.

### caddy 를 쓸 때

```
nsr.example.com {
    reverse_proxy 127.0.0.1:8787
    # 주소에 토큰이 들어 있다. 접근 기록에 남으면 그게 유출이다.
    log {
        output discard
    }
}
```

### nginx 를 쓸 때

이미 nginx 가 돌고 있으면 그걸 쓰면 된다. **`Host` 를 그대로 넘기고**, MCP 는
스트리밍이라 버퍼링을 끈다. 인증서 발급 경로는 프록시보다 먼저 빼 준다.

```nginx
server {
    listen 443 ssl;
    server_name nsr.example.com;

    # 인증서(certbot) 발급·갱신용. 이 자리가 프록시로 넘어가면 404 가 나서
    # 발급이 실패한다. 프록시 규칙보다 위에 둔다.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;              # 바꾸지 않는다
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        # MCP 는 스트리밍이다. 버퍼링을 켜 두면 응답이 끊긴다.
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 주소에 토큰이 들어 있다. 기록하지 않는다.
    access_log off;
    error_log /dev/null crit;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
curl https://nsr.example.com/healthz   # ok 가 나오면 됐다
```

WordOps 같은 관리 도구를 쓰면 `wo site update` 가 이 설정을 다시 만들면서 지운다.
고치기 전에 백업해 두고, 지워졌으면 되돌린다.

## 6. 대화 AI 에 붙이기

커넥터 주소는 이것뿐이다. **비밀이 아니다** — 열쇠는 다음 단계에서 넣는다.

```
https://nsr.example.com/mcp
```

- **클로드** — 설정 → 커넥터 → 사용자 지정 커넥터 추가 → 위 주소.
- **GPT** — 설정 → 커넥터(개발자 모드) → 새 커넥터 → 위 주소.

주소를 넣으면 **번호 화면**이 뜬다. 여섯 자리 숫자가 보이고, 그 화면은 폰을
기다린다. NSR 앱 → 설정 → 분석 서버 → **승인 번호** 에 그 번호를 넣으면
화면이 저절로 넘어간다. 그 뒤로는 다시 묻지 않는다(토큰 30일, 자동 갱신).

**열쇠를 넣는 칸은 없다.** 열쇠를 묻는 화면은 결국 사람이 어딘가에 그 열쇠를
적어 두게 만든다. 번호는 10분이면 사라지고 그 자체로는 힘이 없다 — 승인할 폰이
없으면 아무것도 안 열린다. 그래서 이 서버로 들어오는 길은 둘 다 폰을 거친다.

붙으면 대화에서 `list_shifts` 같은 도구가 보인다. "9월 3일 근무 뭐 있었는지 봐 줘"
처럼 말하면 AI 가 알아서 도구를 쓴다.

### 왜 OAuth 인가

처음에는 추측 불가능한 토큰을 주소에 넣는 방식이었다(`/t/<토큰>/mcp`). 그런데
클로드 커넥터는 주소를 넣으면 **먼저 OAuth 등록을 시도하고**, 등록할 곳이 없으면
"로그인 서비스에 등록할 수 없습니다"로 멈춘다. 인증 없는 서버로 넘어가 주지 않았다.

바꾸고 나니 더 안전하다. 주소가 열쇠가 아니라서 화면 공유·캡처로 새지 않는다.
열쇠가 샜다 싶으면 `nsr.env` 의 값을 새로 만들고 `systemctl restart nsr` 한 뒤
커넥터를 다시 연결한다(기존 토큰을 모두 끊으려면 DB 의 `oauth_tokens` 를 비운다).

## 7. 폰 잇기 — 앱에서 버튼 하나

터미널도, 옮겨 적을 열쇠도 없다. 앱 설정 → 분석 서버에 **서버 주소**
(`https://nsr.example.com`)를 넣고 「잇기」 를 누르면 끝이다.

Jellyfin·Home Assistant·Immich 의 첫 실행과 같은 방식이다.

### 첫 폰 — 처음 한 번만 열리는 문

서버에 이어진 기기가 **하나도 없을 때만** 잇기가 열린다. 첫 폰이 붙는 순간 문은
닫히고, 그 뒤로는 아래 두 길로만 늘어난다.

이을 때 서버가 **복구 번호**(`ABCD-EFGH-JKLM`)를 하나 만들어 앱 화면에 띄운다.
**적어 두거나 화면을 찍어 둔다.** 설정 → 분석 서버에 늘 떠 있으니 나중에 봐도 된다.

문이 열려 있는 동안의 위험은 "먼저 붙는 쪽이 이긴다" 하나다. 도메인은 인증서
기록(CT)으로 공개되므로 아주 없지는 않다. **서버를 세운 날 바로 잇는 것이 좋다.**

이은 뒤에는 설정 → 분석 서버에 **이어진 기기**가 줄로 뜬다. 내 폰인 줄에는
'이 폰', 나머지에는 이은 날짜가 붙는다. 모르는 줄이 있으면 그 자리에서
**다른 기기 끊기** 를 누르면 된다.

### 두 번째 폰 — 이미 이은 폰이 승인

새 폰에서 주소를 넣고 「잇기」 를 누르면 여섯 자리 번호가 뜬다. 그 번호를
**이미 이어진 폰**의 설정 → 분석 서버 → **승인 번호** 칸에 넣으면, 새 폰이
저절로 이어진다(10분 안에). Syncthing·시그널의 기기 연결과 같은 방식이다.

같은 칸이 AI 커넥터 번호도 받는다. 어느 쪽인지는 서버가 알아서 가른다.

### 앱을 지웠다 다시 깔았을 때 — 복구 번호

앱을 지우면 그 폰의 열쇠도 사라진다. 폰이 하나뿐이면 승인해 줄 기기가 없으니
잇기가 막힌다. 그때 쓰는 것이 복구 번호다.

설정 → 분석 서버 → **복구 번호로 잇기** 에 적어 둔 번호를 넣는다. 한 번 쓰면
서버가 새 번호로 바꿔 주고, 그 번호가 화면에 다시 뜬다.

틀리면 서버가 1초 늦게 대답한다(잠기지는 않는다 — 잠금은 남이 대신 걸어서
주인을 막을 수 있다). 번호가 열두 자리라 이 정도면 찍기는 불가능하다.

### 죽은 열쇠 치우기

앱을 지웠다 깔기를 되풀이하면 서버에 안 쓰는 열쇠가 쌓인다. 설정 → 분석 서버의
**다른 기기 끊기** 를 누르면 지금 폰만 남고 나머지가 끊긴다.

### 다 막혔을 때

복구 번호까지 잃어버렸으면 3번의 `NSR_DEVICE_TOKEN` 이 남아 있다. DB 의
`device_tokens` 를 비우면(`sqlite3 /home/nsr/nsr.db "DELETE FROM device_tokens;"`)
문이 다시 열리고, 앱에서 「잇기」 한 번으로 처음처럼 이어진다.

**문을 다시 여는 것은 첫 잇기와 같은 상태로 돌아가는 것이다** — 그 사이에 남이
먼저 누를 수 있다. 비우고 나면 바로 앱에서 잇는다.

낯선 기기가 목록에 있으면: 앱에서 **다른 기기 끊기** 를 누른다(이 폰만 남는다).
앱이 이어져 있지 않아 그걸 못 누르는 상황이면 위 명령으로 전부 비우고 다시 잇는다.

> 서버는 워커 하나로 돌린다(README 의 systemd 설정 그대로). `--workers 2` 를
> 붙이면 '기기가 0대일 때만 연다' 는 판단이 워커 사이에서 갈라진다.

---

## 도구 목록

| 도구 | 하는 일 |
| --- | --- |
| `list_shifts` | 근무 목록 (날짜·듀티·길이·문장 수·보고서 유무) |
| `get_shift_sentences` | 근무 한 편의 문장을 페이지로. **가려진 사본이다** |
| `search_terms` | 병동 사전 찾기 |
| `add_term` | 병동 사전에 새 말 넣기 → 폰이 가져가 전사 교정에 쓰고, 티로 단어장에도 올라간다 |
| `get_taeum_summary` | 태움 점수·등급. **숫자만** |
| `get_shift_report` / `put_shift_report` | 보고서 읽기·쓰기 |
| `list_tiro_notes` | 티로에 있는 녹음 노트 — 제목·날짜·길이만 |
| `import_from_tiro` | 노트를 가져와 **가린 뒤** 저장. 원문은 서버에 안 남는다 |

뒤의 둘은 `NSR_TIRO_KEY` 가 있을 때만 나타난다.

## 폰이 쓰는 주소

```
POST /ingest    { shiftId, date, code, minutes, masked:true, taeum, terms, sentences[] }
GET  /pull      → { reports[], terms[] }   아직 안 가져간 것
POST /pulled    { shiftIds[], entries[] }  받았다고 알리기
```

`masked: true` 가 없으면 400 으로 돌려보낸다. 문장에 전화번호·주민번호·등록번호·
이메일이 남아 있으면 422 로 돌려보낸다(몇 건인지만 알려 주고 값은 돌려주지 않는다).
**가려 주지 않고 돌려보내는 이유**: 서버가 대신 가려 주기 시작하면 폰의 1차 관문이
느슨해진다. 가리는 자리는 폰이다.

## 티로에서 바로 가져오기 (선택)

대화 AI 가 티로 MCP 를 함께 붙여 두면 노트를 **안 가려진 원문 그대로** 읽는다.
그래서 이 길을 둔다 — AI 는 "가져와"라고만 하고, 받아서 가리는 일은 서버가 한다.

가리는 규칙은 서버에서 다시 짜지 않는다. `packages/core` 의 `deidentify` 를
`tools/mask-tiro-note.mjs` 로 부른다 — 구현이 두 벌이 되면 반드시 어긋난다.
그래서 서버에 **node 와 빌드된 core** 가 필요하다.

```bash
sudo apt install -y nodejs npm
sudo -iu nsr bash -c 'cd ~/NSR-project && npm ci && npm run build'
echo 'NSR_TIRO_KEY=티로열쇠' | sudo tee -a /home/nsr/nsr.env
sudo systemctl restart nsr
```

되는지 확인:

```bash
sudo -iu nsr bash -c 'cd ~/NSR-project && echo "{\"paragraphs\":[{\"transcript\":{\"content\":\"김영희님 010-1234-5678 302호\"}}]}" | node tools/mask-tiro-note.mjs'
# → 이름·전화·병실이 [이름] [전화번호] [위치] 로 바뀌어 나오면 된다
```

**한계**: 폰에는 사용자가 등록한 이름 목록이 있어 호칭 없이 부르는 이름까지
가리지만, 서버에는 그 목록이 없다. 그래서 이 길은 폰 경로보다 약하다.

## 서버 올리기 (새 판을 받았을 때)

`git pull` 만으로는 안 바뀐다 — systemd 가 돌고 있는 것은 이미 읽어 들인 옛 코드다.
아래를 위에서부터 그대로 돌리고, **마지막 줄이 200 이나 202 를 찍는지** 본다.

```bash
sudo -iu nsr bash -c 'cd ~/NSR-project && git fetch origin && git checkout claude/clinical-nursing-app-whisper-vn25k5 && git pull && git log --oneline -1'
sudo -iu nsr bash -c '~/NSR-project/server/venv/bin/pip install -r ~/NSR-project/server/requirements.txt'
sudo systemctl restart nsr && sleep 2 && systemctl is-active nsr
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<도메인>/device/link \
  -H 'content-type: application/json' -d '{}'
```

- 첫 줄이 `error: Your local changes…` 로 멈추면: `sudo -iu nsr bash -c 'cd ~/NSR-project && git stash && git pull'`
- `systemctl is-active` 가 `failed` 면: `sudo journalctl -u nsr -n 30 --no-pager`
- 마지막 줄이 아직 **404** 면 서비스가 다른 폴더를 보고 있다. 확인:
  `systemctl show nsr -p WorkingDirectory -p ExecStart`
- **200 이나 202** 가 나오면 올라간 것이다. 이제 앱에서 잇는다 (7번).

venv 는 `~/NSR-project/server/venv` 에 있다 (4번의 systemd 설정과 같은 자리).

---

## 시험

```bash
cd server && ./venv/bin/python -m pytest -q
```

## 안 될 때

| 증상 | 까닭 | 고치는 법 |
| --- | --- | --- |
| `421 Invalid Host header` | 서버가 도메인을 모른다 | `nsr.env` 에 `NSR_PUBLIC_HOST` 를 넣고 재시작 |
| `403` (커넥터에서만) | 그 앱의 Origin 이 목록에 없다 | `journalctl -u nsr` 에서 값을 보고 `NSR_ALLOWED_ORIGINS` 에 더한다 |
| "로그인 서비스에 등록할 수 없습니다" | 옛 주소(`/t/…/mcp`)를 넣었다 | 주소를 `https://도메인/mcp` 로 바꾼다 |
| 번호 화면이 안 넘어간다 | 폰이 아직 승인하지 않았다 | 앱 → 설정 → 분석 서버 → 승인 번호에 번호를 넣는다 (10분 안에) |
| 앱이 "서버가 옛 판이에요" | 코드는 새 판인데 서비스가 옛 판을 돌고 있다 | 아래 **서버 올리기** 를 그대로 돌린다 |
| 앱이 "이 폰은 이어져 있지 않습니다" | 폰이 아직 안 이어졌다 | 앱 → 설정 → 분석 서버 → 잇기 (7번) |
| 「잇기」 를 눌렀는데 번호만 뜬다 | 서버에 이미 다른 기기가 있다 | 그 기기에서 승인하거나, 복구 번호로 잇는다 (7번) |
| `400 Invalid HTTP request` | 프록시가 `Host` 를 두 번 넣었다 | `proxy_set_header Host $host;` 하나만 남긴다 |
| 인증서 발급 실패 | `/.well-known/acme-challenge/` 가 프록시로 넘어간다 | 그 위치를 프록시 규칙보다 먼저 빼 준다 |
| 응답이 중간에 끊긴다 | 프록시 버퍼링 | `proxy_buffering off` |
