# AgentForge

Windows 데스크탑 앱. Claude Code + Codex CLI로 **설계 → 교차검토 → 구현 → 2차검증** 파이프라인을 git worktree 격리 환경에서 실행합니다.

- 설치: `release/AgentForge Setup 0.1.0.exe` (미서명 → SmartScreen 경고 가능)
- 개발: `npm run dev` / 빌드: `npm run build` / 설치파일: `npm run dist` / 테스트: `npm test`
- 필요: `claude.exe`, `codex.exe`(로그인 완료), `git` — PATH에서 `.exe`로 해석됨(`.cmd` shim 미지원)

## 흐름
1. 프로젝트(git 저장소) 추가 → 태스크 생성 (태스크마다 `af/<id>` 브랜치 + worktree)
2. 단계마다 사용자가 "실행 승인" 클릭: 설계(Claude, 읽기전용) → 교차검토(Codex, read-only) → 구현(Claude, worktree 안에서만 편집) → 2차검증(Codex, read-only, git이 수집한 사실 + diff 입력)
3. 검증이 `VERDICT: PASS`일 때만 승인 가능. 승인 시 head OID를 고정하고, 머지 직전 재검증.
4. 머지는 사용자가 명시적으로 클릭. 메인 체크아웃이 더티하면 거부.

## 삭제
- 태스크 🗑: 확인 후 `git worktree remove`(**--force 없음**) + 브랜치 삭제, 목록/로그에서 제거. 실행 중이면 비활성. git이 거부하면(변경사항 등) 에러를 보여주고 중단 — 이때는 먼저 "폐기"(강제 정리)하세요. 머지된 태스크는 `branch -d`로 정리만 하고 메인 브랜치 이력은 그대로.
- 프로젝트 "목록에서 제거": 원본 폴더/저장소는 건드리지 않음. 남은 worktree가 있으면 함께 정리할지 확인(정리 안 하면 worktree/브랜치는 저장소에 남음).

## RE 모드
설정에서 rea 실행파일(.exe) 경로를 지정하면, 태스크의 분석 대상에 대해 `analyze-javascript-application <path> --json` 결과를 설계 단계에 주입합니다. (이 서브커맨드 호출 형식은 앱에서 아직 실제 실행 검증하지 않음)

## 알려진 한계
- worktree와 Claude 권한 모드는 **보안 샌드박스가 아닙니다.** 신뢰할 수 있는 저장소에서만 사용하세요.
- 2차검증 전에 호스트가 worktree에서 테스트를 실행(60초 타임아웃): `package.json`의 `scripts.test`(→ `npm test`) 또는 `*.test.js`(→ `node --test`). 실패/타임아웃/실행오류면 Codex 판단과 무관하게 FAIL(머지 승인 불가). 테스트가 없으면 "자동 테스트 없음, 코드 리뷰만 수행"으로 폴백. 추가 규칙: 소스의 **새 공개(export) 함수/클래스**가 순증가했는데 테스트 파일 변경(추가/라인 추가)이 diff에 없으면 FAIL (문서·설정·버그수정·리팩토링·내부 헬퍼·이름변경/이동은 제외, JS/TS만 판정). 한계: 기존 테스트가 새 기능을 실제로 검증하는지는 알 수 없고(Codex가 확인), worktree에 node_modules가 없어 의존성이 필요한 프로젝트는 `npm test`가 실패(=차단)할 수 있음.
- 검증 FAIL 후 구현을 다시 돌리는 경로가 없음(현재는 폐기 후 새 태스크).
- 아이콘 기본값, 코드 서명 없음, 자동 업데이트 없음.
- `~/.codex/config.toml` 기본 모델이 계정에서 거부되면 설정의 Codex 모델을 바꾸세요(기본 `gpt-5.6-sol`).

설계 문서: `../DESIGN.md`(v0.1), `../DESIGN-v0.2.md`(Codex 교차검토 반영), 오픈소스 분석: `../ANALYSIS.md`
