# Cursor 구조 분석과 AgentForge 비교

작성일: 2026-10-19 · 대상: Cursor 3.25.9 (공식 배포본) · 목적: 병렬 에이전트 기능이 어떻게 만들어져 있는지 이해하고 AgentForge와 차이를 정리

이 문서는 기능 수준의 관찰만 담습니다. Cursor 코드는 복사하지 않았고, 인용은 기능 이름·설정 키 수준의 짧은 문자열뿐입니다.

## 1. 분석 방법과 한계

| 항목 | 내용 |
|---|---|
| 대상 | 공식 배포 서버에서 받은 설치 파일 (Windows 설치 파일 215MB, macOS zip 470MB) |
| 실행 여부 | **어느 것도 실행·설치하지 않음.** 격리 폴더에서 압축만 풀고 텍스트로 읽음 |
| 접근 | 로그인, 구독 확인, 서버 통신 등은 건드리지 않음. 파일에 들어 있는 정보만 사용 |
| Windows 설치 파일 | Inno Setup 형식이라 실행 없이 내용을 꺼낼 수 없었음 → 같은 버전의 macOS zip에서 앱 JavaScript만 추출 |
| 가정 | Electron 앱의 JS 번들은 OS와 무관하게 같다고 봄(**추론**, Windows 쪽 대조는 못 함) |
| rea 사용 | 설치 파일 식별, zip/폴더 목록, 매니페스트 확인에는 rea를 썼음. **큰 번들(9~10MB)은 rea의 AST 분석이 메모리 한도를 넘어 실패**함 |
| 번들 내용 | 키워드 문자열 검색(rea 근거 아님)으로 확인. 압축된 코드라 "문자열이 있다"는 것만 보장하며 **실제 동작·활성 여부는 확인하지 못함** |

관찰한 파일: `package.json`, `product.json`, `extensions/cursor-*/package.json`(21개), `cursor-agent-exec/dist/main.js`, `cursor-agent-host/dist/main.js`, `out/vs/workbench/workbench.desktop.main.js`(40MB).

## 2. Cursor는 어떻게 만들어져 있나

**관찰**
- VS Code 포크이고 Electron 앱입니다. `package.json`의 저장소 주소가 `microsoft/vscode`이고, 제작사는 Anysphere입니다.
- 에이전트 기능은 `cursor-*` 확장 21개로 나뉘어 있습니다. 예: `cursor-agent-exec`(명령 실행·파일 조작·승인), `cursor-agent-host`(에이전트 호스트 데몬), `cursor-shadow-workspace`, `cursor-checkout`, `cursor-mcp`, `cursor-retrieval`(코드 검색용 네이티브 모듈), `cursor-always-local`, `cursor-browser-automation`, `cursor-computer-use`.
- 에이전트 호스트는 별도 데몬(`agent-host-daemon`)으로 번들되어 있고, 요청·응답 형식은 protobuf(`agent.v1.*`) 메시지입니다.
- 클라우드 에이전트(`cloudAgent`, `backgroundComposer`)용 코드가 크게 들어 있습니다. 로컬과 클라우드를 한 UI에서 다루는 구조로 보입니다.

**의미(추론)**: Cursor는 "에디터 안에서 에이전트를 직접 구동"하는 제품이고, AgentForge는 "이미 있는 Claude Code/Codex CLI를 바깥에서 지휘"하는 도구입니다. 출발점이 달라서 같은 기능도 구현 방식이 다릅니다.

## 3. 병렬 작업은 어떻게 하나

### 3.1 모드
번들의 모드 목록은 Agent / Plan / Debug / Ask / **Multitask**입니다. Multitask는 "Run and coordinate multiple tasks in parallel"이라는 설명이 붙어 있고, UI에는 **"Build in Parallel"** 버튼이 있습니다. Multitask 모드의 프롬프트는 에이전트를 "코딩 에이전트이면서 비동기 에이전트에게 일을 넘기는 **코디네이터**"로 규정합니다.

### 3.2 Best-of-N
- `best-of-n-runner`라는 **내장 서브에이전트**가 있고, 설명은 "격리된 git worktree에서 작업을 실행, 각자 자기 브랜치와 작업 디렉터리를 가진다"입니다.
- 서브에이전트 프롬프트에 "각 서브에이전트는 할당된 브랜치 이름으로 git worktree를 만들고 그 안에서만 작업한다", "끝에 브랜치 이름과 변경 요약을 보고한다"는 문장이 있습니다.
- 서버 쪽 이벤트에 `best_of_n_group_id`, `all_worktree_paths`, `applied_worktree_path`가 있어서, **같은 요청에서 나온 worktree들을 그룹으로 묶고 그중 하나를 적용**하는 구조로 보입니다.
- 기본 모델 목록 설정(`bestOfNDefaultModels`)에 서로 다른 회사 모델 3개가 들어 있습니다. 모델을 섞어서 비교하는 것이 기본 사용법으로 보입니다.
- `best-of-n-runner`를 쓸 때 전역 명령 `worktree`의 내용을 프롬프트 앞에 붙입니다.

### 3.3 worktree 관리
- `.cursor/worktrees/**` 경로를 따로 취급하고, 설정 파일 `.cursor/worktrees.json`이 있습니다.
- 이 파일의 `setup-worktree` 키는 "**새 worktree 안에서 실행할 셋업**(셸 명령 배열 또는 스크립트 경로)"입니다. 의존성 설치 같은 준비를 자동으로 합니다.
- UI에 "local worktree setup status"(셋업 진행 단계 표시)가 있습니다.
- `applyWorktreeToCurrentBranch`로 worktree 결과를 현재 브랜치에 적용하고, 단축키(Ctrl/Cmd+Shift+Enter)가 연결돼 있습니다.

## 4. 안전장치와 설정

| 항목 | 관찰 내용 |
|---|---|
| 샌드박스 | 정책 종류 `workspace_readwrite` / `workspace_readonly` / `insecure_none`. 정책에 추가 읽기·쓰기 경로, **네트워크 정책(허용 주소 목록, 기본 허용/차단)**, 읽기 경계(`readBoundary`)가 있음. 셸·검색·ls 호출마다 정책이 붙음 |
| 기본 정책 | 번들 안의 기본값 객체(실제 적용 값인지는 미확인)는 `workspace_readwrite` + 네트워크 접근 `false` + 승인 방식 `ask-every-time` |
| 명령 승인 | 분류기(classifier), "스마트 모드" 허용 목록, hook 승인 요구가 있음 |
| Hooks | `hooks.json`을 읽음(엔터프라이즈 경로는 macOS `/Library/Application Support/Cursor`, Windows `C:\ProgramData\Cursor`, Linux `/etc/cursor`) |
| 규칙 | `.cursor/rules`, `AGENTS.md`(기능 플래그가 켜지면 `CLAUDE.md`도 읽음), `.cursor/agents`, `~/.cursor/mcp.json` |
| 체크포인트 | 대화 단위 체크포인트 코드가 있음(개수가 많음) |

## 5. AgentForge와의 차이

| 항목 | Cursor | AgentForge |
|---|---|---|
| 정체 | 에디터에 내장된 에이전트(VS Code 포크) | 외부 CLI(Claude Code/Codex)를 지휘하는 데스크톱 앱 |
| 에이전트 실행 | 자체 호스트 데몬 + 서버 모델 | 사용자 PC의 `claude`/`codex` CLI 프로세스 |
| 병렬 방식 | 코디네이터 에이전트가 서브에이전트에게 위임, 클라우드 에이전트도 지원 | 사용자가 Best-of-N을 직접 만들고 슬롯별로 제어. 로컬만 |
| Best-of-N 격리 | worktree + 브랜치, 그룹 ID로 묶음 | worktree + `af/<id>` 브랜치, 슬롯 단위 |
| 결과 비교 | 그룹에서 하나 적용 | **diff 뷰어 + 슬롯 비교표**(변경 파일, 테스트 결과 등), 병합은 사용자가 결정 |
| 검증 | 확인하지 못함 | **앱이 직접 테스트를 실행하는 게이트**와 VERDICT 게이트(파이프라인) |
| 파이프라인 | Plan/Agent 모드 전환 | 설계→리뷰→빌드→검증 단계와 사람 승인 |
| 다음 작업 설계 | Plan 모드, Multitask 코디네이터 | **계획 도우미**: 읽기 전용 설계, 사용자 확인 후에만 태스크 생성 |
| 샌드박스 | 자체 정책(파일·네트워크) | 각 CLI의 권한 모델에 의존, 계획 도우미는 읽기 전용 인자 |
| Hooks/규칙/MCP 설정 | 자체 형식 지원 | 해당 설정은 각 CLI가 처리 |
| worktree 셋업 | `setup-worktree` 자동 실행 | **없음** (새 worktree가 비어 있는 의존성 상태로 시작) |
| 모델 혼합 | 한 그룹에 여러 회사 모델 | 슬롯별로 Claude/Codex 선택 가능 |
| 클라우드/원격 | 있음 | 없음 |

## 6. 우리에게 쓸 만한 아이디어 (우선순위 제안)

1. **worktree 셋업 명령**: 프로젝트별로 "새 worktree에서 먼저 실행할 명령"(예: `npm ci`)을 두는 기능. 의존성이 없는 worktree에서 테스트 게이트가 실패하는 문제를 줄입니다. Cursor의 `setup-worktree`와 같은 문제를 푸는 기능이고, 구현은 작습니다. 다만 임의 명령 실행이므로 프로젝트 설정에서 사용자가 직접 입력하게 하고 실행 전 표시하는 안전장치가 필요합니다.
2. **슬롯 결과 한 번에 적용**: 비교표에서 고른 슬롯을 현재 브랜치에 병합하는 흐름은 이미 있으므로, Cursor처럼 단축키로 빠르게 적용하는 정도의 개선 여지가 있습니다(우선순위 낮음).
3. **Best-of-N 그룹 ID 개념**: 지금은 한 태스크 안의 슬롯으로 묶이므로 이미 비슷합니다. 변경 불필요.
4. **셋업 진행 상태 표시**: 1번을 만들면 같이 필요합니다.

가져오지 않는 편이 나은 것: 클라우드 에이전트, 코디네이터형 자동 위임(사용자 승인 없이 에이전트가 에이전트를 만드는 구조는 AgentForge의 "사람이 확인한 뒤 실행" 원칙과 맞지 않음), 자체 샌드박스(각 CLI의 권한 모델을 따르는 편이 단순함).

## 7. 확인하지 못한 것

- 실제 실행 시 동작(UI, 성능, 모델 호출 방식). 앱을 실행하지 않았음.
- Windows 번들과 macOS 번들의 동일성.
- 번들에 있는 기능이 현재 사용자에게 켜져 있는지(기능 플래그 `enable_multitask_mode`의 기본값이 `true`로 보이지만, 서버 값이 우선할 수 있음).
- 서버 쪽 처리(모델 라우팅, 어떤 worktree를 "최선"으로 고르는지). 클라이언트 번들만 봤음.
- `best-of-n-runner`의 서브에이전트 방식과, UI의 모델 그룹 방식 중 어느 쪽이 주된 경로인지.
- rea의 구조 분석(IPC, 자식 프로세스 그래프)은 대형 번들에서 실패해서 얻지 못했음.

## 8. 라이선스와 이용 시 주의

- Cursor는 상용 제품이며 소스가 공개되어 있지 않습니다. 이 문서는 공개 배포된 설치 파일에서 관찰한 기능 이름과 구조를 요약한 것입니다.
- 코드, 프롬프트 전문, 내부 프로토콜 정의는 AgentForge에 복사하지 않습니다. 위 아이디어는 모두 일반적인 개념(worktree 셋업, 결과 적용)이라 별도로 구현해야 합니다.
- 설치 파일 이용약관이 분석(리버스 엔지니어링)을 어떻게 다루는지는 확인하지 않았습니다. 이 문서를 외부에 공개하거나 배포하기 전에 약관을 확인하세요.
