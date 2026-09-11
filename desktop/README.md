# AgentBoard Desktop

기존 AgentBoard 서버에 연결하는 데스크톱 클라이언트다. 웹 탭은 Electron `WebContentsView`의 Chromium이 **이 PC에서 직접 렌더링**한다. 화면 스트리밍이나 iframe을 사용하지 않는다. 웹으로 접속하는 기존 앱은 그대로 이용할 수 있다.

## 실행

Node.js 22 이상을 설치한 **사용자 데스크톱 PC**에서 저장소를 받고 실행한다.

```sh
npm --prefix desktop ci
npm --prefix desktop start
```

처음 뜨는 연결 화면에 현재 사용하는 AgentBoard 서버 주소를 입력하고 기존 비밀번호로 로그인한다. 서버 주소는 다음 실행에도 기억한다. 메뉴의 `AgentBoard → 서버 연결 변경`으로 바꿀 수 있다. 접속 실패 시 연결 화면으로 돌아온다.

```sh
npm --prefix desktop start -- --server=http://192.168.0.10:3002
```

서버에는 이 버전의 백엔드와 프런트엔드를 배포해야 한다. 데스크톱 앱은 서버나 에이전트 프로세스를 새로 띄우지 않는다.

## 웹 탭

- 기존 `◎ 웹`, 문서·터미널 링크, 워크스페이스별 탭과 분할 화면을 이용한다.
- 한글 입력, 복사·붙여넣기, 텍스트 선택, 스크롤은 Chromium에서 직접 처리한다. 별도의 원격 입력창은 없다.
- 실제 페이지 이동 이력, 주소·제목, 뒤로·앞으로·중지·새로고침, 별도 개발자 도구를 지원한다.
- 탭·워크스페이스 전환과 앱 화면 새로고침 중에는 페이지를 살려둔다. 숨긴 탭도 스크립트가 실행될 수 있다. 탭을 닫으면 페이지가 해제된다. 동시 탭 상한은 12개다.
- 앱 종료 후에는 탭·분할 배치·마지막 주소를 복원한다. 쿠키와 사이트 저장소는 서버 주소+워크스페이스별 디스크 프로필에 보존한다. **앱 프로세스를 종료한 뒤 폼 초안·스크롤·페이지 전체 이력까지 복원하지는 않는다.**
- 파일 선택·다운로드는 PC의 기본 대화상자를 사용한다. 다운로드는 사용자가 고른 PC 경로에 저장된다.
- 일반 팝업 링크는 새 워크스페이스 웹 탭으로 연다. 별도 팝업 창과 `window.opener`에 의존하는 로그인은 추가 대응이 필요할 수 있다. 카메라·마이크 등 사이트 권한은 현재 허용하지 않는다.
- 웹페이지의 네트워크 연결도 이 PC에서 이루어진다. `localhost`는 데스크톱 PC를 뜻한다. 원격 서버의 개발 사이트는 접근 가능한 주소나 사용자가 준비한 SSH 포트 포워딩으로 연다. ORCA의 원격 네트워크 프록시는 이번 구현에 포함하지 않는다.

## 에이전트가 같은 탭 조작하기

웹 탭 상단 `에이전트 연결`이 켜져 있으면, 앱 로그인 쿠키로 인증한 WebSocket을 기존 서버에 연결한다. 공개 CDP 포트나 PC 전체 원격 제어 기능은 열지 않는다. 일반 Chrome 창, 앱 밖의 파일 시스템, 셸 명령 실행은 이 API의 대상이 아니다. 스위치를 끄거나 앱을 종료하면 제어 연결이 끊긴다.

AgentBoard 서버에서 에이전트가 다음 명령을 사용할 수 있다. 서버 로컬 실행은 기존 백엔드 인증 설정을 읽으며 토큰을 출력하지 않는다.

```sh
backend/.venv/bin/python -m backend.desktop_cli clients
backend/.venv/bin/python -m backend.desktop_cli list
backend/.venv/bin/python -m backend.desktop_cli snapshot --id browser:탭ID
backend/.venv/bin/python -m backend.desktop_cli fill --id browser:탭ID --selector '#search' --text '검색할 내용'
backend/.venv/bin/python -m backend.desktop_cli click --id browser:탭ID --selector '#submit'
backend/.venv/bin/python -m backend.desktop_cli screenshot --id browser:탭ID --output /tmp/browser.png
```

`snapshot`은 페이지 텍스트와 조작 가능한 요소의 CSS 선택자를 반환한다. 선택자가 여러 요소를 가리키면 클릭·입력을 거절한다. 스크린샷은 요청할 때만 한 장을 전달한다. 서버에 연결된 데스크톱이 여러 개면 `--desktop ID`를 지정해야 한다. 새 탭은 `open --id browser:고유ID --workspace '["local","/workspace/project"]' --url https://example.com`으로 연다.

다른 머신에서 CLI를 쓸 때는 `--server https://서버주소`와 `AGENTBOARD_AUTH_TOKEN` 환경 변수를 직접 지정한다. 인증 정보는 명령 인수나 문서에 붙여 넣지 않는다. 요청이 시간 초과되면 이미 실행됐을 수 있으므로 변경 작업을 재시도하기 전에 페이지를 확인한다.

API: 인증된 `GET /api/desktop/clients`, `POST /api/desktop/clients/{id}/command`. 허용 작업은 list/open/navigate/back/forward/reload/stop/close/snapshot/screenshot/click/fill/key/scroll이다. 임의 JavaScript 실행 API는 제공하지 않는다.

## 패키지 만들기

대상 운영체제에서 실행한다. 패키지는 `desktop/release`에 생성된다.

```sh
npm --prefix desktop run dist -- --publish never
```

Windows: NSIS 설치 프로그램·portable exe, macOS: dmg·zip, Linux: AppImage·tar.gz 설정을 제공한다. 이번 환경에서는 Linux 실행·패키징을 검증했다. Windows/macOS 설치·코드 서명·공증은 해당 OS에서 별도 확인이 필요하다. 패키지를 배포하는 GitHub Release나 자동 업데이트는 설정하지 않았다.

## 검증

```sh
npm --prefix frontend run build
npm --prefix desktop test
backend/.venv/bin/python -m pytest backend/tests/test_desktop.py -q
AGENTBOARD_TEST_PYTHON=backend/.venv/bin/python xvfb-run -a npm --prefix desktop run test:integration
```

통합 검사는 임시 프로필·독립 FastAPI 서버·가짜 터미널 세션으로 실제 Electron과 인증 제어 릴레이를 검사한다. 운영 에이전트에 입력하지 않는다. Linux의 일반 사용자 실행에서는 Chromium 샌드박스를 사용한다. 루트 컨테이너 안의 통합 테스트에만 `--no-sandbox`를 전달한다.

구현 근거: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [webContents](https://www.electronjs.org/docs/latest/api/web-contents), [보안 지침](https://www.electronjs.org/docs/latest/tutorial/security).
