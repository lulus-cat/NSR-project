# NSR 서버 — VPS 에 올리는 것

폰이 올린 **가려진** 근무 자료를 보관하고, 평소 쓰는 클로드·GPT 에 창구(MCP)로
열어 준다. 설계 근거는 `docs/08-app-ai-boundary.md` 에 있다.

한 프로그램이 두 손님을 받는다.

| 손님 | 주소 | 인증 |
| --- | --- | --- |
| 폰 (앱) | `/ingest` `/pull` `/pulled` | 헤더의 기기 토큰 |
| 대화 AI (클로드·GPT) | `/t/<MCP토큰>/mcp` | 주소 안의 토큰 |

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

두 줄을 `/home/nsr/nsr.env` 에 적고 주인만 읽게 잠근다.

```bash
printf 'NSR_MCP_TOKEN=...\nNSR_DEVICE_TOKEN=...\nNSR_DB=/home/nsr/nsr.db\n' > /home/nsr/nsr.env
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

## 5. 바깥에서 들어오는 문 (caddy)

`/etc/caddy/Caddyfile` — 도메인만 바꾸면 인증서는 caddy 가 알아서 받는다.

```
nsr.example.com {
    reverse_proxy 127.0.0.1:8787
    # 주소에 토큰이 들어 있다. 접근 기록에 남으면 그게 유출이다.
    log {
        output discard
    }
}
```

```bash
sudo systemctl reload caddy
curl https://nsr.example.com/healthz   # ok 가 나오면 됐다
```

방화벽은 **443 만** 연다. SSH 는 열쇠 로그인만 두고 비밀번호 로그인은 끈다.

```bash
sudo ufw allow 443/tcp && sudo ufw allow OpenSSH && sudo ufw enable
```

## 6. 대화 AI 에 붙이기

커넥터 주소는 이것이다. `<MCP토큰>` 자리에 3번에서 만든 값을 그대로 넣는다.

```
https://nsr.example.com/t/<MCP토큰>/mcp
```

- **클로드** — 설정 → 커넥터 → 사용자 지정 커넥터 추가 → 위 주소.
- **GPT** — 설정 → 커넥터(개발자 모드) → 새 커넥터 → 위 주소.

붙으면 대화에서 `list_shifts` 같은 도구가 보인다. "9월 3일 근무 뭐 있었는지 봐 줘"
처럼 말하면 AI 가 알아서 도구를 쓴다.

> 주소가 곧 열쇠다. 남에게 보이는 화면에 띄우지 않는다. 샜다 싶으면 `nsr.env` 의
> `NSR_MCP_TOKEN` 만 새로 만들고 `systemctl restart nsr` 한 뒤 커넥터 주소를 다시 넣는다.

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
