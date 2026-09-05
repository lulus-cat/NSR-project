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

## 3. 토큰 두 개 만들기

둘을 나눠 둔 이유는 하나가 새도 다른 하나는 멀쩡하기 때문이다. 기기 토큰이 새도
남이 전사본을 읽지는 못하고, MCP 토큰이 새도 남이 자료를 올리지는 못한다.

```bash
python3 -c "import secrets;print('NSR_MCP_TOKEN=' + secrets.token_urlsafe(32))"
python3 -c "import secrets;print('NSR_DEVICE_TOKEN=' + secrets.token_urlsafe(32))"
```

`NSR_MCP_TOKEN` 은 **커넥터를 연결할 때 로그인 화면에 넣는 비밀번호**다. 주소에는
안 들어간다. `NSR_DEVICE_TOKEN` 은 폰이 자료를 올릴 때 쓴다.

두 줄을 `/home/nsr/nsr.env` 에 적고 주인만 읽게 잠근다. **도메인도 함께 적는다** —
이게 없으면 커넥터가 421 로 막힌다(아래 5번 설명).

```bash
cat > /home/nsr/nsr.env <<'EOF'
NSR_MCP_TOKEN=...
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

주소를 넣으면 **로그인 화면**이 뜬다. 거기에 `nsr.env` 의 `NSR_MCP_TOKEN` 을
붙여넣으면 연결이 끝난다. 그 뒤로는 다시 묻지 않는다(토큰 30일, 자동 갱신).

```bash
sudo grep NSR_MCP_TOKEN /home/nsr/nsr.env   # 로그인 화면에 넣을 값
```

붙으면 대화에서 `list_shifts` 같은 도구가 보인다. "9월 3일 근무 뭐 있었는지 봐 줘"
처럼 말하면 AI 가 알아서 도구를 쓴다.

### 왜 OAuth 인가

처음에는 추측 불가능한 토큰을 주소에 넣는 방식이었다(`/t/<토큰>/mcp`). 그런데
클로드 커넥터는 주소를 넣으면 **먼저 OAuth 등록을 시도하고**, 등록할 곳이 없으면
"로그인 서비스에 등록할 수 없습니다"로 멈춘다. 인증 없는 서버로 넘어가 주지 않았다.

바꾸고 나니 더 안전하다. 주소가 열쇠가 아니라서 화면 공유·캡처로 새지 않는다.
열쇠가 샜다 싶으면 `nsr.env` 의 값을 새로 만들고 `systemctl restart nsr` 한 뒤
커넥터를 다시 연결한다(기존 토큰을 모두 끊으려면 DB 의 `oauth_tokens` 를 비운다).

## 7. 앱에 넣을 것

전사 설정 화면에 두 칸이 생긴다(예정).

| 칸 | 값 |
| --- | --- |
| 서버 주소 | `https://nsr.example.com` |
| 기기 토큰 | 3번의 `NSR_DEVICE_TOKEN` |

---

## 도구 목록

| 도구 | 하는 일 |
| --- | --- |
| `list_shifts` | 근무 목록 (날짜·듀티·길이·문장 수·보고서 유무) |
| `get_shift_sentences` | 근무 한 편의 문장을 페이지로. **가려진 사본이다** |
| `search_terms` | 병동 사전 찾기 |
| `add_term` | 병동 사전에 새 말 넣기 → 폰이 가져가 전사 교정에 쓴다 |
| `get_taeum_summary` | 태움 점수·등급. **숫자만** |
| `get_shift_report` / `put_shift_report` | 보고서 읽기·쓰기 |

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
| 로그인 화면에서 계속 튕긴다 | 열쇠가 다르다 | `sudo grep NSR_MCP_TOKEN /home/nsr/nsr.env` 값을 그대로 붙여넣는다 |
| `400 Invalid HTTP request` | 프록시가 `Host` 를 두 번 넣었다 | `proxy_set_header Host $host;` 하나만 남긴다 |
| 인증서 발급 실패 | `/.well-known/acme-challenge/` 가 프록시로 넘어간다 | 그 위치를 프록시 규칙보다 먼저 빼 준다 |
| 응답이 중간에 끊긴다 | 프록시 버퍼링 | `proxy_buffering off` |
