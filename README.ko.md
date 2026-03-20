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
  <a href="#사이드-패널">사이드 패널</a> &bull;
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
- 터미널 옆에서 **파일 편집, 마크다운 미리보기, PDF 열기** 가능
- 폰, 다른 PC 등 브라우저만 있으면 어디서든 접속
- SSH 불필요 — URL만 열면 끝

---

## 주요 기능

### Overview 모드
모든 세션을 카드 그리드로 표시. 실시간 상태와 출력 미리보기. 카드 클릭으로 바로 진입.

### 실시간 상태 감지
터미널 출력을 분석해서 AI 상태를 자동 판별:
- **Running** (보라 glow) — AI가 작업 중
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

### 자동완성
- `/` 입력 → Claude Code 슬래시 명령 드롭다운 (`/help`, `/compact`, `/config` 등)
- `@` 입력 → 파일 경로 탐색 + 하위 폴더 진입 (`@src/components/...`)
- 방향키로 선택, Tab/Enter로 적용

---

## 사이드 패널

**☰** 버튼 또는 **Ctrl+B**로 토글. 경계선 드래그로 크기 조절.

### Files 탭
- 세션 작업 디렉토리 탐색
- 우클릭 컨텍스트 메뉴: Edit, Download, Rename, Delete
- 빈 영역 우클릭: New Folder, New File, Refresh
- 파일 드래그앤드롭 업로드 (프로그레스 바)
- 세션 CWD에 잠금 — 프로젝트 루트 위로 이동 불가

### Editor 탭
- **CodeMirror** 구문 강조: LaTeX, JavaScript, Python, CSS, HTML, YAML, Shell, SQL, Markdown
- 줄 번호, 괄호 매칭, 자동 닫기
- Tab 들여쓰기, `\begin{...}` 뒤 자동 들여쓰기
- **Ctrl+S** 저장
- 마크다운 파일은 미리보기 모드로 자동 열림

### 마크다운 미리보기
- **marked.js** 렌더링
- **KaTeX** 수식 (`$인라인$`, `$$블록$$`)
- LaTeX 표 (`\begin{tabular}`) → HTML 변환, 정렬 지원
- 표, 코드 블럭, 리스트, 링크 전체 지원

### PDF 뷰어
- `.pdf` 클릭 → 인라인 미리보기 (브라우저 내장 뷰어)
- 스트리밍 방식으로 대용량 지원

### History 탭
- 보낸 명령 기록 + 타임스탬프
- 클릭으로 이전 명령 재사용

---

## 터미널 기능

- ANSI 컬러 완전 지원 (256색 + RGB)
- 박스 라인 (`───`) → 깔끔한 구분선 렌더링
- 터미널 내 검색 (카드 헤더 🔍 아이콘)
- 파일 업로드 — 스크린샷 붙여넣기, 파일 드래그앤드롭 (프로그레스 바)
- 빠른 키: Esc, 방향키, Enter, Tab, Ctrl+C
- 적응형 폴링: 활성 세션 500ms, 비활성 5s — 20개 이상 세션에서도 쾌적
- Split 모드에서 세션별 개별 tmux 리사이즈

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
헤더의 **🔍**를 클릭하면 실행 중인 tmux 세션을 스캔해서 대시보드에 추가합니다.

### 터미널에서 직접 접속
```bash
tmux attach -t term-1
```

### 키보드 단축키
| 키 | 동작 |
|-----|------|
| Cmd+Shift+좌/우 | 탭 전환 |
| Ctrl+B | 사이드 패널 토글 |
| Ctrl+S | 파일 저장 (에디터) |
| Ctrl+F | 터미널 출력 검색 |
| Esc, Enter, 방향키 | 활성 세션에 전달 |
| Ctrl+C | 세션에 인터럽트 전송 |

---

## 원격 접속

### Tailscale (가장 안전)

[Tailscale](https://tailscale.com) 사용 시 서버의 Tailscale IP로 접속. 본인 기기만 접근 가능 — 포트 오픈 불필요.

### Cloudflare Tunnel (공유용)

계정 없이 사용 가능. `cloudflared` 설치 시 자동으로 터널 시작:
```
☁️  Tunnel URL → https://random-name.trycloudflare.com
```

URL을 아는 누구나 접속 가능 (비밀번호 보호). 데모나 팀 공유에 적합. 방화벽 뒤에서도 동작 — HTTPS 아웃바운드만 있으면 됨.

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
Node.js HTTP 서버
   ├── server.js          — 진입점, 설정, WebSocket
   ├── server/routes.js   — HTTP API 라우트
   ├── server/workers.js  — 세션 상태, 폴링, AI 감지
   ├── server/tmux.js     — tmux 명령 래퍼
   └── server/tunnel.js   — Cloudflare 터널 관리
   ↕ tmux 명령
tmux 세션들 (term-1, term-2, ...)
   └─ claude / 임의 CLI
```

- **프레임워크 없음** — 순수 Node.js + 바닐라 JS
- **최소 의존성** — `ws`와 `dotenv`만 사용
- **모듈화 서버** — 관심사별 파일 분리
- **tmux 네이티브** — 서버 재시작해도 세션 유지

---

## 크레딧

[sunmerrr/TermHub](https://github.com/sunmerrr/TermHub)을 기반으로 합니다. Overview 모드, 사이드 패널 (파일 브라우저 + 에디터 + PDF 뷰어), 알림 시스템, 자동완성, 적응형 폴링, 모듈 아키텍처 등을 추가했습니다.

## 라이센스

MIT
