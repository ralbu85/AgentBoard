<p align="center">
  <img src="https://img.shields.io/badge/AgentBoard-AI_에이전트_대시보드-7c3aed?style=for-the-badge" alt="AgentBoard" />
</p>

<h1 align="center">AgentBoard v2</h1>

<p align="center">
  <strong>서버에서 AI 에이전트를 돌리고, 어디서든 브라우저로 관리하세요.</strong><br>
  설치 없음. 데스크탑 앱 없음. URL만 열면 끝 — 노트북, 폰, 태블릿 어디서든.<br>
</p>

<p align="center">
  <a href="#왜-agentboard">왜?</a> &bull;
  <a href="#빠른-시작">빠른 시작</a> &bull;
  <a href="#주요-기능">주요 기능</a> &bull;
  <a href="#원격-접속">원격 접속</a> &bull;
  <a href="#아키텍처">아키텍처</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/tmux-필수-1BB91F?logo=tmux&logoColor=white" alt="tmux" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/dependencies-2_(ws%2C_dotenv)-green" alt="deps" />
</p>

---

## 왜 AgentBoard?

AI 코딩 에이전트는 이미 수 시간 자율 작업이 가능합니다. 하지만 여전히:

- 권한 요청 시 **승인**해야 하고
- 여러 세션의 **진행 상황**을 모니터링해야 하고
- 에이전트가 작업 중인 **파일을 확인**해야 합니다

문제: **하루 종일 터미널 앞에 앉아있을 수 없습니다.**

cmux, Cursor, Superset 같은 도구는 데스크탑 앱 설치가 필요하고 로컬에서만 작동합니다. **원격 서버의 에이전트는요?**

**AgentBoard는 순수 웹 앱입니다 — 설치 없음, 데스크탑 클라이언트 없음.** Node.js와 tmux가 있는 서버에 배포하고, 아무 기기에서 브라우저를 열면 바로 접속. Tailscale, Cloudflare Tunnel, ngrok으로 안전한 원격 접속.

### 비교

| | cmux | Cursor | Superset | **AgentBoard** |
|---|---|---|---|---|
| **설치 없음 (URL만)** | ❌ | ❌ | ❌ | ✅ |
| **원격 서버 접속** | ❌ | ❌ | ❌ | ✅ |
| **폰/태블릿** | ❌ | ❌ | ❌ | ✅ |
| 멀티 에이전트 | ✅ | ❌ | ✅ | ✅ |
| 크로스 플랫폼 | macOS | 데스크탑 | 데스크탑 | 모든 브라우저 |
| 파일 편집 + PDF | ❌ | 내장 | Diff 뷰 | 내장 |
| 셀프 호스팅 | N/A | N/A | N/A | ✅ |
| 가격 | 무료 | $20/월 | 유료 | 무료 |

---

## 빠른 시작

```bash
# 사전 요구: Node.js >= 18, tmux
git clone https://github.com/ralbu85/AgentBoard.git
cd AgentBoard/v2
npm install
echo "DASHBOARD_PASSWORD=비밀번호" > ../.env
node server/index.js
```

**http://localhost:3001** 접속 — 끝. **+** 버튼으로 세션 시작.

### 백그라운드 실행

```bash
# pm2 (권장)
npm install -g pm2
pm2 start v2/server/index.js --name agentboard
pm2 save && pm2 startup

# 또는 nohup
nohup node v2/server/index.js > /tmp/agentboard.log 2>&1 &
```

### 설정 (선택)

```bash
cp config.example.json config.json
```

```json
{
  "basePath": "/home/you/projects",
  "defaultCommand": "claude",
  "favorites": ["/home/you/projects/app1"]
}
```

---

## 주요 기능

### 두 패인 레이아웃

- **왼쪽**: 고정 터미널 — xterm.js GPU 가속 렌더링, 풀 ANSI 색상
- **오른쪽**: 분할 가능 뷰어 — 파일을 가장자리로 드래그하면 분할, 중앙이면 탭 추가
- **리사이즈**: 터미널↔뷰어 경계 드래그
- **터미널 직접 입력**: 클릭 후 바로 타이핑 (Enter, 화살표, 숫자 등)

### 멀티 에이전트 관리

10개 이상 AI 에이전트 동시 실행. 각 세션:
- **xterm.js** GPU 렌더링으로 실시간 터미널 출력
- 자동 상태 감지: **Running** / **Waiting** / **Idle** / **Completed**
- 색상 글로우 애니메이션으로 상태 표시
- `esc to interrupt` 기반 감지 — 하드코딩 패턴 없음

### 알림

- 상태 변경 시 브라우저 알림
- 비프음 (waiting과 completed 톤 구분)
- 백그라운드 탭 제목 깜빡임
- 사이드바 세션 플래시

### 파일 관리

- **파일 탐색기** — 탐색, 업로드, 생성, 이름 변경, 삭제
- **코드 에디터** — CodeMirror 구문 강조, 저장 버튼, 디스크에서 새로고침
- **PDF 뷰어** — 줌 (+/-), 페이지 네비게이션, 새로고침
- **이미지 뷰어** — 인라인 표시
- **마크다운 미리보기** — marked.js 렌더링

### 분할 뷰어 (VS Code 스타일)

- 파일을 셀 가장자리에 드래그 → 가로/세로 분할
- 중앙에 드래그 → 탭 추가
- 탭을 셀 간 드래그 → 재배치
- 세션별 분할 상태 저장/복원

### 모바일 최적화

- 터미널 전체 화면, 가벼운 HTML 렌더링 (xterm.js 대신)
- 사이드바에 세션 리스트 + 파일 탐색기
- 한 번 탭으로 즉시 세션 전환
- 모바일에서 tmux 리사이즈 안 함 — 데스크탑과 충돌 없음
- CDN 스크립트 조건부 로딩 — 모바일은 필수만

### 터미널 기능

- ANSI 256색 + RGB 완전 지원
- 터미널 클릭 후 직접 키보드 입력
- 검색 (xterm.js SearchAddon)
- 빠른 키: Esc, 방향키, Enter, Tab, Ctrl+C
- 파일 드래그&드롭 업로드 + 프로그레스 바
- 스크린샷 붙여넣기
- 종료 세션 재연결 (Reconnect)
- 사이드바에서 세션 삭제 (× 버튼)

---

## 원격 접속

**AgentBoard의 핵심 — 어디서든 에이전트를 관리.**

### Tailscale (권장)

[Tailscale](https://tailscale.com) IP로 직접 접속. 설정 불필요, 암호화, 포트 오픈 불필요.

### Cloudflare Tunnel

`cloudflared` 설치 시 자동으로 터널 시작:
```
Tunnel URL → https://random-name.trycloudflare.com
```
비밀번호 보호. 방화벽 뒤에서도 동작.

### ngrok

```bash
ngrok http 3001
```

---

## 키보드 단축키

| 키 | 동작 |
|-----|------|
| Cmd/Ctrl+Shift+←/→ | 세션 전환 |
| Ctrl+B | 사이드바 토글 |
| Ctrl+S | 파일 저장 (에디터) |
| Ctrl+F | 터미널 검색 |
| 터미널 클릭 + 타이핑 | tmux에 직접 입력 |
| Esc, Enter, ↑↓, Tab | 활성 세션에 전달 |

---

## 아키텍처

```
v2/
├── server/
│   ├── index.js      — HTTP + WS 서버, 인증, 브로드캐스트
│   ├── sessions.js   — 세션 CRUD, tmux 라이프사이클, 상태 감지
│   ├── poller.js     — 출력 폴링 (순차 resize → capture)
│   ├── routes.js     — REST API (로그인, 파일, 세션)
│   ├── tmux.js       — tmux 명령 래퍼
│   └── tunnel.js     — Cloudflare 터널
├── public/
│   ├── index.html    — CDN 조건부 로딩 (데스크탑만)
│   ├── style.css     — GitHub 다크 테마, 모바일 반응형
│   └── js/
│       ├── store.js     — SessionStore (EventTarget, 중앙 상태)
│       ├── terminal.js  — xterm.js (데스크탑) / HTML pre (모바일)
│       ├── panels.js    — 두 패인 레이아웃, 뷰어 분할
│       ├── sidebar.js   — 세션 목록, 모바일 탭
│       ├── editor.js    — CodeMirror, PDF.js, 이미지 뷰어
│       ├── files.js     — 파일 브라우저, 컨텍스트 메뉴
│       └── app.js       — 진입점, 로그인, 입력, 키보드
└── package.json
```

**설계 원칙:**
- 프레임워크 없음 — 순수 Node.js + 바닐라 JS
- 의존성 2개 — `ws`, `dotenv`
- IIFE + `AB` 네임스페이스 — 빌드 스텝 없음
- tmux 기반 — 서버 재시작해도 세션 유지
- 렌더링 레이어에서 데스크탑/모바일 분리, 서버는 공유

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` 또는 `V2_PORT` | `3001` | 서버 포트 |
| `DASHBOARD_PASSWORD` | `changeme` | 로그인 비밀번호 |
| `DISCORD_WEBHOOK` | — | 터널 URL Discord 알림 |

---

## 크레딧

[sunmerrr/TermHub](https://github.com/sunmerrr/TermHub)을 기반으로 합니다. 원격 AI 에이전트 관리 플랫폼으로 발전시켰습니다.

## 라이센스

MIT
