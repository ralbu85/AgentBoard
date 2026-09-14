# 로컬 Python 노트북 실행

2026-09-14. 실행 기능 추가 전 기준 버전은 `cc16280`이며 `main`과 `origin/main`에 저장되어 있다. 모바일 터미널 폭·터치 조정, Codex 아이콘, 워크스페이스/탭/분할 배치와 데스크톱 인앱 브라우저를 포함한다.

## 사용

파일 트리에서 로컬 `.ipynb`를 열면 셀 내용을 편집할 수 있다. **셀 실행** 또는 `Shift+Enter`는 해당 셀을, **전체 실행**은 코드 셀을 순서대로 실행한다. 첫 실행은 자동으로 커널을 연결한다. 오류가 나면 전체 실행을 멈춘다. **중단**은 현재 실행과 뒤에 대기 중인 셀 실행을 멈춘다. **재시작**은 변수를 초기화하며 코드·출력은 유지한다.

**저장**은 코드, 출력, 실행 번호를 원본 파일에 반영한다. 실행만으로 원본을 바꾸지 않는다. 외부 편집으로 원본 버전이 달라졌으면 저장을 거절한다. 현재 초안을 **다운로드**하여 비교·보관할 수 있다. **원본 다시 열기**는 확인 후 초안과 커널 변수를 버리고 디스크 파일을 읽는다.

탭·워크스페이스를 바꾸거나 창을 새로고침해도 서버의 실행과 출력은 유지된다. 편집은 500ms 후 서버에 동기화되므로 전송이 끝나기 전 브라우저가 강제 종료되거나 연결이 끊기면 마지막 입력은 복구되지 않을 수 있다. 다른 클라이언트의 편집과 충돌하면 자동 덮어쓰기 대신 명시적으로 서버 상태를 불러오도록 한다.

서버에 도착한 편집·출력은 `AGENTBOARD_STATE_DIR/.notebook-state/`의 접근 권한 0600 복구 파일에 보관한다. 서버 재시작 후 미저장 코드·출력은 복구하지만 Python 변수와 실행 중 작업은 복구하지 않는다. 복구 파일은 Git에서 제외한다. 커널은 탭을 닫아도 유지되며 **커널 목록**에서 종료할 수 있다.

## 범위와 설정

- 로컬 nbformat 4 Python만 실행한다. 원격 머신, 개별 가상환경 선택, JupyterLab 확장·대화형 위젯·stdin 입력은 이번 범위에 없다.
- 기본 인터프리터는 서버 PATH의 `python3`이다. `AGENTBOARD_NOTEBOOK_PYTHON=/absolute/path/to/python`으로 바꿀 수 있다. 선택한 인터프리터에 `ipykernel`과 사용할 분석 라이브러리가 있어야 한다.
- 노트북 디렉터리에서 실행한다. 노트북 메타데이터에 지정된 kernelspec 명령은 실행하지 않는다. 커널은 AgentBoard 서버 계정의 권한으로 동작한다.
- `AGENTBOARD_NOTEBOOK_KERNELS` 기본 4개, `AGENTBOARD_NOTEBOOK_IDLE_SECONDS` 기본 1800초. 실행 중 커널은 유휴 정리 대상이 아니다. 커널마다 별도 Python 프로세스 메모리를 사용한다.
- 최대 노트북 10MB·2000셀, 셀당 수신 출력 2MB·1000항목. 한도 이후 출력은 생략 표시한다. 비활성 문서 캐시는 최대 32개이며 퇴출한 문서의 복구 초안은 보존한다.
- 출력의 HTML은 정제하고 SVG는 이미지로 표시한다. API에는 로그인, 동일 출처, 파일 접근 경로, 편집 리비전 검사를 적용한다.

## 검증

`backend/.venv/bin/pip install -r backend/requirements-dev.txt`

`backend/.venv/bin/python -m pytest backend/tests -q`

`npm --prefix frontend test -- --reporter=dot`

`npm --prefix frontend run build`

자동화 테스트는 임시 파일과 테스트가 생성한 커널만 사용한다. 인증·경로 제한, 리비전/디스크 저장 충돌, 복구, 실제 커널 변수 공유·오류·중단·재시작·종료, rich output, 출력 한도, 커널 수 제한과 프런트엔드 상태 충돌을 검증한다. 별도 격리 브라우저 테스트에서 실행·편집·탭 전환·저장/새로고침·중단 및 390/440px 폭을 확인했다. 기존 사용자 노트북이나 에이전트 세션에 테스트 코드를 보내지 않았다.

구현 참고: [Jupyter 메시지 규약](https://jupyter-client.readthedocs.io/en/stable/messaging.html), [비동기 클라이언트 API](https://jupyter-client.readthedocs.io/en/stable/api/jupyter_client.asynchronous.html).
