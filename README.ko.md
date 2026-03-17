<p align="center">
  <img src="https://img.shields.io/badge/AgentBoard-AI_세션_대시보드-7c3aed?style=for-the-badge" alt="AgentBoard" />
</p>

<h1 align="center">AgentBoard</h1>

<p align="center">
  <strong>여러 AI 코딩 세션을 브라우저에서 한눈에 관리</strong><br>
  Claude Code 세션을 모니터링하고, 입력이 필요할 때 즉시 알림을 받으세요.
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> &bull;
  <a href="#주요-기능">주요 기능</a> &bull;
  <a href="#원격-접속">원격 접속</a> &bull;
  <a href="#라이센스">라이센스</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/tmux-필수-1BB91F?logo=tmux&logoColor=white" alt="tmux" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

---

## 이런 문제를 겪고 있다면

Claude Code를 3개 이상 동시에 돌리고 있는데, 터미널 탭을 왔다갔다 하다가 **어떤 세션이 입력을 기다리는지** 놓치고 있지 않나요? 그 대기 시간이 수십 분씩 낭비됩니다.

## 해결책

AgentBoard는 모든 AI 코딩 세션을 **브라우저 하나로** 관리합니다:

- 모든 세션의 실시간 출력을 한눈에 확인
- 입력이 필요한 세션이 생기면 **즉시 알림**
- 폰, 다른 PC 등 브라우저만 있으면 어디서든 접속
- 모니터링에 SSH 불필요 — URL만 열면 끝

---

## 주요 기능

### Overview 모드
모든 세션을 카드 그리드로 표시. 실시간 상태와 출력 미리보기. 카드 클릭으로 바로 진입.

### 실시간 상태 감지
터미널 출력을 분석해서 AI 상태를 자동 판별:
- **Running** (보라) — AI가 작업 중
- **Waiting** (노랑 펄스) — 사용자 입력 대기
- **Idle** (초록) — 작업 완료, 다음 명령 대기
- **Completed** (초록 glow) — 세션 종료, 확인할 때까지 깜빡임

### 알림 시스템
- 세션 완료/입력 대기 시 브라우저 알림
- 비프음 (waiting과 completed 톤 구분)
- 다른 탭에 있을 때 제목 깜빡임
- 다른 세션 보고 있을 때 탭 플래시

### 3가지 레이아웃
- **Overview** — 모든 세션을 카드로 한눈에
- **Tab** — 하나씩 집중, 탭 바로 전환
- **Split** — 나란히 보기, 헤더 드래그로 순서 변경

### 터미널 기능
- ANSI 컬러 완전 지원 (256색 + RGB)
- 박스 라인을 깔끔한 구분선으로 렌더링
- 터미널 내 검색 (돋보기 아이콘 클릭)
- 파일 업로드 — 스크린샷 붙여넣기, 파일 드래그앤드롭
- 빠른 키: Esc, 방향키, Enter, Tab, Ctrl+C

### 기타
- 기존 tmux 세션 자동 감지 및 연결
- 폴더 브라우저 + 북마크
- 모바일 반응형 UI
- 프로세스 정보 (명령, 업타임, 메모리)
- 비밀번호 인증
- Cloudflare 터널로 원격 접속

---

## 빠른 시작

### 사전 요구사항

- **Node.js** >= 18
- **tmux** (macOS: `brew install tmux`, Ubuntu: `apt install tmux`)

### 설치 & 실행

```bash
git clone https://github.com/ralbu85/AgentBoard.git
cd AgentBoard
npm install
```

`.env` 파일 생성:
```bash
echo "DASHBOARD_PASSWORD=비밀번호입력" > .env
```

서버 시작:
```bash
node server.js
```

브라우저에서 **http://localhost:3000** 접속. 끝.

### 선택: 설정 파일

```bash
cp config.example.json config.json
```

`config.json` 편집:
```json
{
  "basePath": "/home/you/projects",
  "defaultCommand": "claude",
  "favorites": ["/home/you/projects/app1", "/home/you/projects/app2"]
}
```

### 선택: 백그라운드 실행

```bash
# nohup 사용
nohup node server.js > /tmp/agentboard.log 2>&1 &

# 또는 pm2 사용
npm install -g pm2
pm2 start server.js --name agentboard
pm2 save
pm2 startup  # 부팅 시 자동 시작
```

---

## 사용법

### 세션 생성
1. 우측 상단 **+** 클릭
2. 프로젝트 폴더로 이동
3. **Open here** 클릭 — 해당 디렉토리에서 Claude Code 세션 시작

### 기존 세션 연결
헤더의 **돋보기 아이콘**을 클릭하면 실행 중인 tmux 세션을 스캔해서 대시보드에 추가합니다.

### 터미널에서 직접 접속
세션은 표준 tmux이므로 터미널에서도 접속 가능:
```bash
tmux attach -t term-1
```

### 키보드 단축키
| 키 | 동작 |
|-----|------|
| Cmd+Shift+좌/우 | 탭 전환 |
| Ctrl+F | 터미널 출력 검색 |
| Esc, Enter, 방향키 | 활성 세션에 전달 |
| Ctrl+C | 세션에 인터럽트 전송 |

---

## 원격 접속

폰이나 다른 PC에서 AgentBoard에 접속하는 방법.

### Cloudflare 터널 (추천)

```bash
brew install cloudflared  # 또는 cloudflare.com에서 다운로드
```

`cloudflared`가 설치되어 있으면 AgentBoard가 자동으로 터널을 시작합니다:
```
☁️  Tunnel URL → https://random-name.trycloudflare.com
```

Discord로 URL을 받으려면 `.env`에 추가:
```env
DISCORD_WEBHOOK=https://discord.com/api/webhooks/your/webhook-url
```

### ngrok

```bash
ngrok http 3000
```

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 서버 포트 |
| `DASHBOARD_PASSWORD` | `changeme` | 로그인 비밀번호 |
| `DISCORD_WEBHOOK` | — | 터널 URL Discord 알림 |

---

## 아키텍처

```
브라우저 (Vanilla JS)
   ↕ WebSocket + REST API
Node.js HTTP 서버 (server.js)
   ↕ tmux 명령
tmux 세션들 (term-1, term-2, ...)
   └─ claude / 임의 CLI
```

- **프레임워크 없음** — 순수 Node.js 서버 + 바닐라 JS 프론트엔드
- **최소 의존성** — `ws`와 `dotenv`만 사용
- **tmux 네이티브** — 서버 재시작해도 세션 유지

---

## 크레딧

[sunmerrr/TermHub](https://github.com/sunmerrr/TermHub)을 기반으로 합니다. Overview 모드, 알림 시스템, Claude 특화 UI, 모바일 지원 등을 추가했습니다.

## 라이센스

MIT
