# 재현 가능한 논문 수집 예제

Transformer → BERT → T5로 이어지는 공개 논문 3편을 고정 대상으로 사용한다.
자유 주제에서 논문을 발굴하는 기능이나 앱 브라우저 제어 연결을 검증하는 예제는 아니다.

저장소 루트에서 실행:

```sh
backend/.venv/bin/python examples/paper-collection/collect.py
```

1. 별도의 일회용 Chromium에서 Scholar에 각 논문의 정확한 제목을 검색하고 제목이 일치하는 결과 링크를 기록한다. 기존 사용자 브라우저·로그인·세션은 건드리지 않는다.
2. Scholar의 차단 응답이나 사람 확인 화면을 감지하면 검색을 중단한다. CAPTCHA 우회나 자동 반복 시도는 하지 않는다.
3. 검색 결과와 별개로 미리 지정한 arXiv 공개 원문 URL에서 PDF를 저장한다. Scholar가 막혀도 가능한 별도 경로이며, 이를 Scholar 검색 성공으로 기록하지 않는다.
4. PDF 헤더·종료 표식을 검사하고 SHA-256과 파일 크기를 저장한다. 논문 본문과 제목의 의미적 일치까지 검증하는 것은 아니다.
5. 같은 명령을 다시 실행하면 기존 파일의 해시를 확인해 유지하고 실패한 다운로드만 재시도한다. 출처 불명·변경된 기존 파일은 덮어쓰지 않는다.

`output/manifest.json`에서 논문별 `search.status`와 `download.status`를 따로 확인할 수 있다. 출력 PDF와 manifest는 Git에 포함하지 않는다. PDF 확보가 모두 성공하면 종료 코드 0이며, 이는 Scholar 검색 성공을 의미하지 않는다.

Scholar 검색 기록은 일반 재실행에서 유지한다. 나중에 직접 재시도하려면 `--retry-search`를 사용한다. 다른 저장 위치는 `--output /path/to/directory`로 지정한다. Playwright/Chromium이 없어도 검색 불가 상태를 기록하고 공개 PDF 다운로드는 진행한다.

대상 및 메타데이터:

브라우저에는 앱과 동일한 안전 정책이 적용된다. 루트 실행과 샌드박스
해제는 허용하지 않는다. 비루트·샌드박스 지원 환경 또는
[`deploy/browser`](../../deploy/browser/README.md)의 전용 작업자가 필요하다.

- [Attention Is All You Need](https://arxiv.org/abs/1706.03762)
- [BERT](https://arxiv.org/abs/1810.04805)
- [T5: Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer](https://arxiv.org/abs/1910.10683)
