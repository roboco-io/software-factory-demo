# P3 증거·유입 확장(Evidence & Intake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P2 잔여 과제 두 건을 끝내고, 버그 PR이 "수정 전 코드에서 실패하고 수정 후 코드에서 통과하는 재현 테스트"를 가졌는지 CI가 증명하는 필수 체크 `evidence`를 추가하며, 프로덕션 에러·앱 내 익명 피드백·프로덕션 스모크 실패가 사람의 지시 없이 GitHub 이슈로 들어오게 만든다.

**Architecture:** 판정·유입 로직은 모두 `packages/factory`의 CLI 명령(`evidence`, `evidence-run`, `intake`, `smoke-report`)에 두고, 워크플로 YAML은 그 명령만 호출한다. `evidence`는 두 job으로 나눈다. `evidence-plan`은 GitHub 읽기 토큰과 base 커밋의 팩토리 코드로 "버그 PR인가, 어떤 테스트 파일이 바뀌었나"를 정하고, `evidence`는 토큰·시크릿 없이 base 트리에 head의 테스트 파일만 덮어쓴 작업 트리(git worktree)와 head 트리에서 Vitest를 실행한다. API는 Worker `onError`가 에러를 D1 `error_events`에 fingerprint 단위로 upsert하고, `POST /api/feedback`가 IP 해시 기반 레이트 리밋과 함께 피드백을 저장하며, `INTAKE_TOKEN`으로 보호된 수집 엔드포인트를 `factory-intake.yml`(30분 주기)이 읽어 이슈로 바꾼다. `factory-smoke.yml`(6시간 주기)은 프로덕션에 읽기 요청만 보내고 결과를 `smoke-report`로 이슈에 반영한다.

**Tech Stack:** Node 24, pnpm 10.25, TypeScript 6.0, Vitest 4.1, zod 4.6, Hono 4.13, drizzle-orm 0.45, Cloudflare D1, `@cloudflare/vitest-plugin` 1.4, React 19 + react-router 8, Playwright 1.64, Hurl(`gacts/install-hurl@v1`), GitHub App 토큰(`actions/create-github-app-token@v3`).

**Spec:** `docs/superpowers/specs/2026-10-11-software-factory-design.md` (7.1 P3 증거·유입 확장 7.1.1-7.1.4, 9장 "P3 증거·유입 확장 — 완료 조건", 팩토리 관례는 4장·5장)

## Global Constraints

- 언어와 버전은 P2와 같다: Node `>=24`(`.nvmrc` 24), pnpm `10.25.0`, TypeScript `~6.0.3`, Vitest `^4.1.11`, zod `^4.6.5`. 새 의존성을 추가하지 않는다(`package.json`·`pnpm-lock.yaml`을 바꾸지 않는다).
- 액션 메이저는 P2와 같다: `actions/checkout@v7`, `pnpm/action-setup@v6`, `actions/setup-node@v7`, `actions/upload-artifact@v7`, `actions/create-github-app-token@v3`, `gacts/install-hurl@v1`.
- `evidence` 판정(spec 7.1.2, 그대로): 대상은 PR 본문의 팩토리 표식이 가리키는 이슈에 `type:bug` 라벨이 있는 PR이다. 그 밖의 PR은 검사 없이 즉시 통과한다. base 커밋 트리에 PR이 추가·수정한 테스트 파일만 head 버전으로 덮어써서 실행하면 **실패**해야 하고, head 트리에서 같은 테스트를 실행하면 **통과**해야 한다. 버그 PR인데 테스트 파일 변경이 없으면 실패다. 커밋 순서는 판정에 쓰지 않는다.
- 테스트 파일 정의: spec의 `apps/*/test/**`, `**/*.test.ts`, `apps/web/e2e/**`에 `**/*.test.tsx`를 더한다(웹 컴포넌트 테스트가 `.test.tsx`이기 때문이다. 판정 후보 1). 실행 대상은 이 중 `*.test.ts`·`*.test.tsx`이고, `apps/web/e2e/**`는 덮어쓰기 대상이지만 실행하지 않는다(판정 후보 2).
- 판정 코드는 base 커밋의 팩토리 CLI로 실행하고, PR 코드는 시크릿·GitHub 토큰이 없는 job에서만 실행한다(spec 5.4, 7.1.2).
- 에러 fingerprint(spec 7.1.3): 메시지의 숫자·UUID·slug를 정규화한 문자열과 스택 상위 3프레임의 SHA-256 앞 16자. 열은 `fingerprint`, 대표 메시지, 경로, `count`, `first_seen`, `last_seen`, `acked_at`. 기록은 `ctx.waitUntil`로 하고 기록 실패는 무시한다.
- 피드백(spec 7.1.3): `POST /api/feedback`, 본문 `{"feedback": {"body": "...", "path": "/#/..."}}`, 본문 1-2000자, 경로 200자 이하, IP 원문은 저장하지 않고 `SHA-256(IP + INTAKE_TOKEN)`만 저장, 같은 해시는 10분에 3건까지, 초과하면 429.
- 수집 엔드포인트(spec 7.1.3): `GET /api/_factory/intake`(미확인 에러와 피드백 최대 50건), `POST /api/_factory/intake/ack`(`{"errors": [fingerprint], "feedback": [id]}`). `Authorization: Bearer <INTAKE_TOKEN>`이 없거나 다르면 알 수 없는 경로와 같은 404.
- 유입 이슈 표식(spec 7.1.3, 그대로): `<!-- factory:intake {"kind":"error","key":"<fp>"} -->`. 에러 이슈 라벨 `source:error`, `type:bug`. 피드백 이슈 라벨 `source:feedback`. 스모크 이슈 라벨 `source:smoke`.
- `INTAKE_TOKEN`의 원본은 GitHub `production` environment secret 하나다. `deploy.yml`이 배포마다 같은 값을 Worker secret으로 넣는다(판정 후보 6). 값을 `echo`하거나 로그·커밋·이슈에 쓰지 않는다.
- 신뢰할 수 없는 데이터(에러 메시지, 피드백 본문, HTTP 응답 본문, 워크플로 간 전달 값)는 zod로 검증하고 타입 단언으로 넘기지 않는다. 이슈·코멘트에 들어가는 텍스트는 `packages/factory/src/report/text.ts`의 `inline`·`cell`·`codeCell`·`demote`로만 넣는다.
- D1 쿼리 하나의 바운드 파라미터는 100개 이하다. 마이그레이션은 추가만 한다(열·테이블 삭제 없음). 새 마이그레이션 `0003_intake.sql`은 T2다.
- 워크플로 `run:` 안에 `${{ github.event.* }}`, `${{ github.head_ref }}`, `${{ inputs.* }}`를 넣지 않는다. 값은 `env:`로만 넘긴다. PR 코드를 실행하는 job의 체크아웃은 `persist-credentials: false`이고 `secrets.*`를 참조하지 않는다. 시크릿을 받는 job은 `main`(또는 base 커밋)의 팩토리 코드만 실행한다. 새 워크플로마다 `packages/factory/test/workflows.test.ts`에 구조 테스트를 더한다.
- 위험 정책과 CODEOWNERS를 같이 고친다. 이 계획이 새로 분류하는 경로: T3 `tests/smoke/**`, `apps/web/e2e-smoke/**`. T2 `apps/api/src/middleware/intake.ts`, `apps/api/src/routes/intake.ts`(수집 엔드포인트의 인증 경계).
- GitHub API 목록은 페이지네이션하고, 결과를 끝까지 얻지 못하면 실패로 처리한다(fail closed).
- 변경은 거의 모두 T2·T3 경로다. 사람(컨트롤러)이 커밋하고 사람이 병합한다. PR은 두 개로 나눈다. PR #1(브랜치 `p3-evidence-intake`, Task 1-12)을 병합한 뒤, PR #2(브랜치 `p3-evidence-gate`, Task 14)가 `ci.yml`의 `evidence` job과 필수 체크 목록을 바꾼다. 이렇게 나누는 이유: `evidence` job은 base 커밋의 CLI를 쓰므로, CLI가 main에 들어가기 전에는 그 job을 켤 수 없다. 7.1.1이 지우는 "base에 CLI가 없으면 건너뛴다" 분기를 다시 만들지 않기 위해서다.
- Markdown 본문에 물결표로 범위를 쓰지 않는다(`3-4`처럼 하이픈). 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`를 붙이고, 커밋 전에 `pnpm exec prettier --write <바꾼 파일>`을 실행한다.

## Review Focus

1. **에러 메시지·피드백 본문에 표식·멘션·닫기 키워드가 들어 있는 경우**: 사용자가 `<!-- factory:intake {"kind":"error","key":"..."} -->`, `@serithemage`, `fixes #1`을 피드백으로 보내도, 만들어진 이슈가 다른 유입 항목의 표식을 위조하거나 사람을 멘션하거나 다른 이슈를 닫지 않아야 한다. 사람이 연 이슈에 같은 표식을 써도 유입 중복 판정에 쓰이지 않아야 한다. (Task 10, Task 11 테스트로 고정)
2. **고친 뒤 닫힌 에러가 다시 발생하는 경우**: 같은 fingerprint의 이슈가 닫혀 있으면 코멘트가 아니라 새 이슈를 만들어야 한다(회귀를 사람이 보게). (Task 10 테스트로 고정)
3. **`CF-Connecting-IP` 헤더가 없는 요청과 Worker에 `INTAKE_TOKEN`이 없는 환경(프리뷰·로컬)**: 헤더가 없는 요청끼리는 같은 레이트 리밋 버킷을 쓰고, 토큰이 비어 있으면 `Authorization: Bearer `(빈 토큰)를 포함한 어떤 요청도 수집 엔드포인트에 닿지 못해야 한다. (Task 7, Task 8 테스트로 고정)
4. **이름이 바뀌었거나 삭제된 테스트 파일, 경로 조작**: rename된 테스트는 새 경로로, 삭제된 테스트는 제외하고, `..`가 든 경로나 테스트 파일이 아닌 경로가 판정 계획에 들어오면 실행 전에 거부해야 한다. (Task 2, Task 3 테스트로 고정)
5. **스모크가 실패·복구를 반복하는 경우**: 실패 → 복구 → 실패 → 복구에서 각 전이마다 코멘트가 한 번씩만 남고, 성공이 이어져도 "복구됨"이 반복되지 않아야 한다. (Task 11 테스트로 고정)


## 판정 후보

계획을 쓰면서 spec이 정하지 않았거나 spec과 다르게 정한 값이다. 실행 전에 사용자가 확정한다. 확정하지 않으면 아래 "제안"대로 실행하고, Task 16 Step 5에서 spec에 사실로 기록한다.

1. **테스트 파일 정의에 `**/*.test.tsx` 추가.** spec 7.1.2는 `apps/*/test/**`, `**/*.test.ts`, `apps/web/e2e/**`만 적었다. 웹 컴포넌트 테스트(`ErrorList.test.tsx` 등)가 `.test.tsx`라서 빼면 웹 버그의 재현 테스트를 판정할 수 없다. 제안: 추가한다. 틀렸을 때 비용: 정의를 좁히면 웹 버그 PR이 항상 "테스트 파일 없음"으로 실패한다.
2. **Playwright E2E를 evidence 실행 범위에서 제외.** E2E는 `wrangler dev`와 `vite preview` 서버, 브라우저 설치가 필요해 base·head 두 번 실행하면 job이 크게 느려진다. 제안: `apps/web/e2e/**`는 덮어쓰기만 하고 실행하지 않으며, E2E만 바꾼 버그 PR은 실패로 둔다(프롬프트·AGENTS.md가 Vitest로 재현하라고 안내한다). 틀렸을 때 비용: 화면 흐름 버그를 E2E로만 재현할 수 있는 경우 팩토리가 그 버그를 고치지 못하고 사람에게 넘긴다. 나중에 Playwright 실행 모드를 `evidence-run`에 추가할 수 있다.
3. **evidence를 두 job과 두 PR로 나눔.** 토큰이 필요한 계획(`evidence-plan`)과 PR 코드를 실행하는 판정(`evidence`)을 다른 job으로 나누고, `ci.yml` job 추가는 PR #1 병합 뒤 PR #2로 한다. 제안: 그대로. 틀렸을 때 비용: 한 PR로 합치면 PR #1의 `evidence` job이 base에 없는 명령을 호출해 실패하거나, 7.1.1에서 지운 "CLI가 없으면 건너뛴다" 분기를 다시 만들어야 한다.
4. **오류 주입 방법: 토큰으로 보호한 상시 경로 `POST /api/_factory/intake/probe`.** 대안은 (a) 처리되지 않는 예외를 일으키는 잘못된 요청을 찾는 방법(현재 코드에 확실한 경로가 없고, 찾으면 그것은 고쳐야 할 버그다), (b) 검증 때만 임시 경로를 배포하는 방법(배포 두 번과 T1 PR 두 개가 더 들고 리허설마다 반복해야 한다)이다. 제안: 상시 probe 경로. 토큰이 없으면 다른 미지 경로와 같은 404이고, 효과는 `error_events` 한 행뿐이다. 틀렸을 때 비용: "프로덕션 디버그 경로 금지"를 엄격히 적용하면 Task 8의 probe 라우트와 테스트를 지우고, 라이브 검증 때 임시 경로 PR을 따로 만들어야 한다.
5. **fingerprint의 스택 프레임에서 줄·열 번호 제거.** spec은 "스택 상위 3프레임"이라고만 했다. 번호를 남기면 배포할 때마다 같은 에러가 새 fingerprint가 되어 새 이슈가 열린다. 제안: 제거한다(함수 이름·파일만 남김). 틀렸을 때 비용: 같은 파일·함수의 다른 줄에서 난 서로 다른 에러가 하나로 묶일 수 있다(메시지가 다르면 여전히 구분된다).
6. **`INTAKE_TOKEN`의 Worker secret 설정 방식: `deploy.yml`이 배포마다 environment secret에서 동기화.** 대안은 사람이 한 번 `wrangler secret put`하는 방법이다. 제안: 배포마다 동기화(GitHub secret 하나가 원본이라 두 값이 어긋나지 않는다). 틀렸을 때 비용: 배포마다 Worker 버전이 하나 더 생기고, secret이 비어 있으면 배포 job이 실패한다(의도된 fail closed).
7. **수집 목록 50건을 에러 25 + 피드백 25로 나눔.** spec은 "미확인 에러와 피드백 최대 50건"이라고만 했다. 제안: 종류별 25건(한쪽이 많아도 다른 쪽이 밀리지 않는다). 틀렸을 때 비용: 30분에 한 종류가 25건을 넘으면 나머지는 다음 실행으로 밀린다.
8. **새 경로의 위험 등급.** `tests/smoke/**`, `apps/web/e2e-smoke/**`를 T3(구현 에이전트가 스모크 기준을 바꾸지 못하게), `apps/api/src/middleware/intake.ts`, `apps/api/src/routes/intake.ts`를 T2(수집 데이터의 인증 경계)로 둔다. `apps/api/src/routes/feedback.ts`, `apps/api/src/lib/error-events.ts`는 T1이다. 제안: 그대로. 틀렸을 때 비용: T1로 두면 봇이 사람 승인 없이 스모크를 약하게 하거나 토큰 검사를 바꾼 PR을 자동 병합할 수 있다. T2·T3를 늘리면 그 경로를 고치는 이슈는 매번 사람 승인을 기다린다.
9. **심은 버그: 글 목록 페이지 수를 `Math.floor`로 계산.** 단위 테스트·Hurl·E2E가 잡지 못하고 데이터를 바꾸지 않지만, 관찰하려면 프로덕션 글이 11개 이상이어야 한다. 부족하면 Task 15 Step 1이 데모 계정으로 글을 만든다. 제안: 그대로. 틀렸을 때 비용: 프로덕션에 데모용 글과 계정이 남는다. 이것을 피하려면 데이터와 무관하게 보이는 다른 버그를 골라야 하고 Task 15의 관찰 스크립트도 바뀐다.
10. **에러 메시지·경로를 정규화한 형태로 저장하고 `{n}`·`{uuid}`·`{slug}` 토큰을 쓴다.** 유입 이슈가 퍼블릭 리포에 열리므로, 원문 메시지에 들어 있을 수 있는 개별 값(ID, slug)을 남기지 않는다. 꺾쇠 토큰은 GitHub 마크다운에서 HTML로 해석되어 사라지므로 중괄호를 쓴다. 제안: 그대로. 틀렸을 때 비용: 원문을 저장하면 디버깅 정보는 늘지만 공개 이슈에 사용자 관련 값이 실릴 수 있다.

---

## File Structure

```
apps/api/
  migrations/0003_intake.sql           error_events, feedback 테이블과 인덱스 (T2)
  src/db/schema.ts                     errorEvents, feedback 테이블 정의 추가
  src/env.ts                           INTAKE_TOKEN?(Worker secret) 추가
  src/lib/errors.ts                    429 상태, tooLong(), rateLimited(), ROUTE_NOT_FOUND
  src/lib/hash.ts                      sha256Hex()
  src/lib/error-events.ts              normalizeText(), topFrames(), errorFingerprint(), recordError()
  src/middleware/intake.ts             requireIntakeToken, constantTimeEqual() (T2)
  src/routes/intake.ts                 GET /_factory/intake, POST /_factory/intake/ack, POST /_factory/intake/probe (T2)
  src/routes/feedback.ts               POST /feedback, ipHash(), 레이트 리밋
  src/index.ts                         라우터 연결, onError에서 recordError(waitUntil)
  test/error-events.test.ts, test/intake.test.ts, test/feedback.test.ts, test/schema.test.ts(수정)
  test/env.d.ts, vitest.config.ts      INTAKE_TOKEN 테스트 바인딩
apps/web/
  src/components/Footer.tsx            푸터, "피드백" 버튼, 모달(익명 전송)
  src/components/Footer.test.tsx
  src/App.tsx                          <Footer /> 추가
  e2e/feedback.spec.ts                 로컬 E2E(가짜 데이터)
  e2e-smoke/playwright.config.ts, e2e-smoke/home.spec.ts   프로덕션 읽기 전용 스모크 (T3)
  tsconfig.json                        include에 e2e-smoke 추가
tests/smoke/readonly.hurl              프로덕션 읽기 전용 Hurl 스모크 (T3)
packages/factory/
  src/policy/evidence.ts               isTestFile(), isSafeRelativePath(), planSuites(), SUITES
  src/policy/risk.ts                   ChangedFile.removed 추가
  src/github/octokit.ts                listPullFiles가 status "removed"를 removed: true로 매핑
  src/stages/evidence.ts               EvidencePlanSchema, runEvidencePlan(), runEvidence(), renderEvidenceText()
  src/stages/intake.ts                 유입 표식, IntakeClient, runIntake(), 이슈 렌더링
  src/stages/smoke.ts                  runSmokeReport(), smokeStatus()
  src/stages/review.ts                 위험 등급 보류(needs-human) PR에도 판정 리뷰를 남긴다
  src/stages/triage.ts                 source:error|feedback|smoke 봇 이슈는 트리아지한다
  src/stages/implement.ts, src/agents/prompt.ts   버그 이슈 재현 테스트 규칙(bugRule)
  src/stages/fix.ts                    evidence 실패 시 피드백 문구 보강
  src/stages/common.ts, src/runs/store.ts          런 역할 intake, smoke 추가
  src/stages/bootstrap.ts              source:error|feedback|smoke 라벨
  src/report/pr.ts                     PR 본문 필수 체크 목록에 evidence (PR #2)
  src/cli.ts                           evidence, evidence-run, intake, smoke-report 명령
  test/*.test.ts                       각 Task의 테스트
factory/
  risk-policy.yml                      새 T2·T3 경로, requiredChecks에 evidence(PR #2)
  prompts/implement.md                 "버그 재현 규칙" 절, 수정 금지 경로 목록 갱신
  prompts/fix.md                       수정 금지 경로 목록 갱신
.github/
  CODEOWNERS                           새 T2·T3 경로
  workflows/ci.yml                     risk-tier 임시 분기 제거(PR #1), evidence-plan·evidence job(PR #2)
  workflows/preview.yml                policy 임시 분기 제거
  workflows/deploy.yml                 INTAKE_TOKEN Worker secret 동기화
  workflows/factory-intake.yml         30분 주기 유입(environment production)
  workflows/factory-smoke.yml          6시간 주기 읽기 전용 스모크와 결과 보고
AGENTS.md                              evidence 규칙 한 줄(PR #2)
README.md                              임시 조치 문단 삭제, 유입·evidence·리허설 런북, 보안 한계
docs/superpowers/specs/2026-10-11-software-factory-design.md   P3 확정 사항과 근거(Task 16)
```

### 단계와 워크플로 대응

| 워크플로 | 트리거 | CLI | 비고 |
|---|---|---|---|
| `ci.yml` `evidence-plan` | `pull_request` | `evidence --pr N --sha H --base B --json` | base 커밋의 CLI, `GITHUB_TOKEN`(읽기), PR 코드 체크아웃 없음 |
| `ci.yml` `evidence`(필수 체크) | `pull_request`, `needs: evidence-plan`, `if: !cancelled()` | `evidence-run` | 시크릿·토큰 없음. 계획이 없으면 실패한다(건너뛴 필수 체크는 통과로 취급되므로 건너뛰지 않는다) |
| `factory-intake.yml` | `schedule`(매시 7분·37분), `workflow_dispatch` | `intake` | environment `production`(secret `INTAKE_TOKEN`), App 토큰으로 이슈 생성(트리아지 워크플로가 이어서 돈다) |
| `factory-smoke.yml` `checks` | `schedule`(6시간마다 23분), `workflow_dispatch(api_base)` | 없음(Hurl, Playwright) | 읽기 요청만 보낸다. 시크릿 없음 |
| `factory-smoke.yml` `report` | `needs: checks`, `if: !cancelled()` | `smoke-report --result success|failure` | App 토큰 |
| `deploy.yml` `api` | 기존 | 없음 | `wrangler secret put INTAKE_TOKEN`(stdin) |

### evidence 실행 방식(구체)

1. `evidence-plan` job: base 커밋을 `base/`에 체크아웃하고 의존성을 설치한 뒤 `pnpm -s factory evidence --pr "$PR" --sha "$HEAD_SHA" --base "$BASE_SHA" --json`을 실행한다. 출력 JSON 한 줄을 job output `plan`으로 넘긴다.
2. `evidence` job: base 커밋을 `base/`(CLI용, 수정하지 않음), PR head를 `head/`(`fetch-depth: 0`, base 커밋 객체 포함)에 체크아웃한다. `base/`에서만 의존성을 설치하고 `pnpm -s factory evidence-run`을 실행한다. 환경변수는 `EVIDENCE_PLAN`(계획 JSON)과 `FACTORY_WORKDIR=$GITHUB_WORKSPACE/head`뿐이다.
3. `evidence-run`(base 코드): 계획을 zod로 검증한다. 버그 PR이 아니면 즉시 통과한다. 버그 PR이면 `head/`의 HEAD가 계획의 head SHA인지 확인하고, `git worktree add --detach $RUNNER_TEMP/evidence-*/overlay <base SHA>`로 base 트리를 만든 뒤 계획의 테스트 파일마다 `git show <head SHA>:<경로>` 내용을 overlay에 쓴다. overlay와 `head/`에서 각각 `pnpm install --frozen-lockfile`을 실행하고, 패키지별로 `pnpm --filter <api|web|factory> exec vitest run <패키지 기준 상대 경로...>`를 overlay(base)와 `head/`(head)에서 실행한다. 하나 이상의 base 실행이 0이 아닌 종료 코드로 끝나고 모든 head 실행이 0으로 끝나야 통과다. 명령마다 15분 제한을 둔다. 하위 프로세스 env는 `scrubEnv()`로 비밀 값을 지운다.
4. 실행 대상 패키지 대응: `apps/api/` → `--filter api`, `apps/web/`(단 `apps/web/e2e/` 제외) → `--filter web`, `packages/factory/` → `--filter factory`. 그 밖의 위치에 있는 `*.test.ts(x)`와 `apps/web/e2e/**`는 "지원하지 않는 테스트"로 보고서에 적는다. 실행할 수 있는 테스트가 하나도 없으면 실패다.

---

### Task 1: P2 잔여 과제 — 임시 분기 제거와 위험 등급 보류 PR의 리뷰 판정

브랜치 `p3-evidence-intake`를 main에서 만들고 시작한다(`git switch -c p3-evidence-intake main`). Task 1-12는 이 브랜치에 커밋한다.

**Files:**
- Modify: `.github/workflows/ci.yml`(risk-tier job 마지막 step), `.github/workflows/preview.yml`(policy job `risk` step)
- Modify: `packages/factory/src/stages/review.ts`(import, `heldForRisk()` 추가, `publish` 교체)
- Modify: `README.md`("임시 조치" 문단 삭제)
- Test: `packages/factory/test/review.test.ts`, `packages/factory/test/workflows.test.ts`

**Interfaces:**
- Consumes: `classifyFiles` (`src/policy/risk.ts`), `flattenFiles` (`src/stages/gate.ts`), `TooManyFilesError` (`src/github/port.ts`), `latestVerdict`, `renderReviewBody` (`src/report/comments.ts`), `openBotPr(h, meta?, files?)`, `makeTestDeps()`, `BOT` (`test/helpers.ts`)
- Produces: `heldForRisk(deps: StageDeps, pr: number): Promise<boolean>` (`src/stages/review.ts`, export) — PR 변경 파일의 등급이 T2·T3이면(파일 목록을 끝까지 얻지 못하면 T3로 보고) true. review publish 규칙: 이슈가 `in-review`이면 기존과 같다. 이슈가 `needs-human`이고 `heldForRisk`가 true이면 판정 리뷰(`COMMENT` + `factory:verdict` 표식, 리뷰한 head SHA에 묶음)만 남기고 상태 전이·fix/merge dispatch·리뷰 재dispatch를 하지 않는다. 그 밖의 상태에서는 아무것도 하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성(리뷰 판정)**

`packages/factory/test/review.test.ts` 맨 아래 `describe("review stage", ...)` 블록 닫는 괄호 바로 앞에 추가한다:
```ts
  describe("risk hold (spec 7.1.1)", () => {
    async function heldRun(fixture: "review-approve" | "review-changes", files: string[]) {
      const codex = createFakeAdapter(loadFakeScript(fixture), "codex");
      const h = makeTestDeps({ adapters: { codex } });
      const { pr, issue } = await openBotPr(h, {}, files);
      const plan = (await reviewStage.prepare(h.deps, { pr }))!;
      const out = await reviewStage.agent(h.deps, plan);
      // 리뷰가 도는 동안 gate가 T2·T3 PR을 needs-human으로 옮긴 상황(2026-10-11 PR #10)을 재현한다.
      await h.gh.removeLabel(issue, "factory:in-review");
      await h.gh.addLabels(issue, ["factory:needs-human"]);
      await reviewStage.publish(h.deps, plan, out);
      return { h, pr, issue };
    }

    it("posts the verdict for a T2 PR held in needs-human without changing state or dispatching", async () => {
      const { h, pr, issue } = await heldRun("review-approve", ["apps/api/migrations/0003_x.sql"]);
      expect(latestVerdict(await h.gh.listReviews(pr), BOT, "sha-a")?.verdict).toBe("APPROVE");
      expect(h.gh.dispatches).toEqual([]);
      expect((await h.gh.getIssue(issue)).labels).toEqual(["factory:needs-human"]);
      expect((await h.deps.runs.since(new Date(0))).filter((r) => r.role === "review")).toHaveLength(1);
    });

    it("posts REQUEST_CHANGES for a held PR but does not start a fix round", async () => {
      const { h, pr } = await heldRun("review-changes", ["apps/api/migrations/0003_x.sql"]);
      expect(latestVerdict(await h.gh.listReviews(pr), BOT, "sha-a")?.verdict).toBe(
        "REQUEST_CHANGES",
      );
      expect(h.gh.dispatches).toEqual([]);
    });

    it("treats a PR whose file list cannot be read as held (T3)", async () => {
      const codex = createFakeAdapter(loadFakeScript("review-approve"), "codex");
      const h = makeTestDeps({ adapters: { codex } });
      const { pr } = await openBotPr(h);
      h.gh.listPullFiles = async () => {
        throw new TooManyFilesError("too many");
      };
      expect(await heldForRisk(h.deps, pr)).toBe(true);
    });

    it("posts nothing for a T1 PR that a human moved to needs-human (e.g. @factory stop)", async () => {
      const { h, pr } = await heldRun("review-approve", ["apps/api/src/routes/tags.ts"]);
      expect(await h.gh.listReviews(pr)).toEqual([]);
      expect(h.gh.dispatches).toEqual([]);
    });
  });
```
같은 파일 맨 위 import를 다음으로 바꾼다:
```ts
import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import { TooManyFilesError } from "../src/github/port";
import { latestVerdict } from "../src/report/comments";
import { runPhase } from "../src/stages/phased";
import { heldForRisk, reviewStage, truncateDiff } from "../src/stages/review";
import { BOT, makeTestDeps, openBotPr } from "./helpers";
```

- [ ] **Step 2: 실패하는 테스트 작성(임시 분기 제거)**

`packages/factory/test/workflows.test.ts`의 `describe("modified P1 workflows", ...)` 안 두 테스트에 단언을 더한다.

`it("ci.yml judges risk-tier with the base commit's factory code", ...)`의 `expect(run.run).toContain("--check");` 바로 아래에:
```ts
    // spec 7.1.1: base에 CLI가 없으면 건너뛰던 P2 도입용 분기를 지웠다. CLI가 사라지면 체크가 실패해야 한다.
    expect(run.run).not.toContain("cli.ts");
    expect(run.run?.trim()).toBe('pnpm -s factory risk --pr "$PR" --check');
```
`it("preview.yml deploys only when the policy job allows it", ...)`의 `expect(risk.run).toContain("--json");` 바로 아래에:
```ts
    expect(risk.run).not.toContain("cli.ts");
    expect(risk.run).not.toMatch(/allowed=true/);
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/review.test.ts test/workflows.test.ts`
Expected: FAIL — `heldForRisk`가 export되지 않았고(`heldForRisk is not a function` 또는 타입 오류), held 테스트에서 리뷰가 0개이며, workflows 테스트에서 `cli.ts`가 들어 있다는 단언이 실패한다.

- [ ] **Step 4: review publish 구현**

`packages/factory/src/stages/review.ts`의 import 블록 위쪽에 두 줄을 더한다(기존 import는 그대로 둔다):
```ts
import { TooManyFilesError } from "../github/port";
import { classifyFiles } from "../policy/risk";
```
그리고 `import type { StageDeps } from "./deps";` 아래에 한 줄을 더한다:
```ts
import { flattenFiles } from "./gate";
```
`const RECORDED = new WeakSet<ReviewPlan>();` 바로 위에 함수를 더한다:
```ts
// gate는 T2·T3 PR을 CI 직후 needs-human으로 옮긴다. 그 뒤에 끝난 리뷰도 사람 리뷰어가 볼 수 있게 판정만 남긴다(spec 7.1.1).
// 변경 파일 목록을 끝까지 얻지 못하면 등급을 알 수 없으므로 T3로 본다.
export async function heldForRisk(deps: StageDeps, pr: number): Promise<boolean> {
  try {
    const risk = classifyFiles(flattenFiles(await deps.gh.listPullFiles(pr)), deps.policy);
    return risk.tier === "T2" || risk.tier === "T3";
  } catch (e) {
    if (e instanceof TooManyFilesError) return true;
    throw e;
  }
}
```
`reviewStage`의 `async publish(deps, plan, out) { ... },` 전체를 다음으로 바꾼다:
```ts
  async publish(deps, plan, out) {
    await recordOnce(deps, plan, out);
    const { state } = await readState(deps.gh, plan.issue);
    const held = state === "needs-human" && (await heldForRisk(deps, plan.pr));
    if (state !== "in-review" && !held) {
      deps.log(`review: #${plan.issue} is ${state}; skipping verdict`);
      return;
    }
    const review = out.result.ok ? out.review : null;
    if (!review) {
      if (held) {
        deps.log(`review: PR #${plan.pr} is held for a human; no verdict to post`);
        return;
      }
      await moveTo(
        deps,
        plan.issue,
        "needs-human",
        "review",
        `PR #${plan.pr} 리뷰 에이전트가 판정을 내지 못했다(사유: ${failureText(out.result.failureReason ?? "invalid_output")}). 사람이 리뷰하거나 \`@factory retry\`로 구현부터 다시 시작한다.${runLink(deps.settings)}`,
      );
      return;
    }
    // 리뷰하는 동안 head가 바뀌었거나 다른 런이 같은 SHA의 판정을 이미 올렸으면 이 판정은 버린다.
    const pull = await deps.gh.getPull(plan.pr);
    if (pull.headSha !== plan.headSha || pull.state !== "open") {
      deps.log(`review: PR #${plan.pr} head moved to ${pull.headSha}; verdict dropped`);
      // 새 head에는 판정이 없다. 이슈가 in-review로 남아 있으면 새 head를 리뷰하도록 다시 보낸다.
      if (pull.state === "open" && !held) {
        await deps.gh.dispatchWorkflow("factory-review.yml", {
          pr: String(plan.pr),
          issue: String(plan.issue),
        });
      }
      return;
    }
    if (latestVerdict(await deps.gh.listReviews(plan.pr), deps.settings.botLogin, plan.headSha)) {
      return;
    }
    await deps.gh.createReview(plan.pr, {
      event: "COMMENT",
      body: renderReviewBody(review, {
        sha: plan.headSha,
        engine: plan.engine,
        model: plan.model,
      }),
      commitId: plan.headSha,
    });
    if (held) {
      // 사람이 병합을 결정하는 PR이다. 상태를 바꾸지 않고 fix·merge도 보내지 않는다.
      deps.log(`review: verdict posted on held PR #${plan.pr}; #${plan.issue} stays needs-human`);
      return;
    }
    if (review.verdict === "REQUEST_CHANGES") {
      await deps.gh.dispatchWorkflow("factory-fix.yml", {
        pr: String(plan.pr),
        sha: plan.headSha,
        reason: "review",
        issue: String(plan.issue),
      });
    } else {
      await deps.gh.dispatchWorkflow("factory-merge.yml", { pr: String(plan.pr) });
    }
  },
```

- [ ] **Step 5: 워크플로 임시 분기 제거**

`.github/workflows/ci.yml`의 `risk-tier` job 마지막 step을 다음으로 바꾼다(주석 줄 `# 첫 줄은 이 계획의 PR 자신...`도 지운다):
```yaml
      - working-directory: base
        run: pnpm -s factory risk --pr "$PR" --check
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
```
`.github/workflows/preview.yml`의 `policy` job에서 주석 `# 첫 줄은 base에 팩토리 CLI가 아직 없는 P2 도입 PR만 해당한다. ...` 한 줄과 `- id: risk` step을 다음으로 바꾼다:
```yaml
      # 판정이 실패하거나 PR head가 이벤트의 SHA에서 바뀌었으면 배포하지 않는다.
      - id: risk
        working-directory: base
        run: |
          pnpm -s factory risk --pr "$PR" --sha "$HEAD_SHA" --json > "$RUNNER_TEMP/risk.json"
          jq -r '"allowed=\(.previewAllowed)", "stale=\(.stale)"' "$RUNNER_TEMP/risk.json" >> "$GITHUB_OUTPUT"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # 이 이벤트의 head SHA다. 판정 시점에 PR head가 바뀌었으면 previewAllowed=false로 배포하지 않는다.
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```
`README.md`의 "## 소프트웨어 팩토리" 절에서 `- 임시 조치: \`ci.yml\`의 \`risk-tier\` job과 ...`로 시작하는 문단(한 줄) 전체를 지운다.

- [ ] **Step 6: 테스트가 통과하는지 확인**

Run: `pnpm --filter factory exec vitest run test/review.test.ts test/workflows.test.ts && pnpm typecheck`
Expected: PASS. 기존 review 테스트("ignores human PRs and issues that are not in review" 포함)도 통과한다. 그 테스트의 PR은 T1(`apps/api/src/routes/tags.ts`)이라 needs-human이어도 보류 대상이 아니기 때문이다.

- [ ] **Step 7: 커밋**

```bash
pnpm exec prettier --write packages/factory/src/stages/review.ts packages/factory/test/review.test.ts packages/factory/test/workflows.test.ts .github/workflows/ci.yml .github/workflows/preview.yml README.md
git add packages/factory/src/stages/review.ts packages/factory/test/review.test.ts packages/factory/test/workflows.test.ts .github/workflows/ci.yml .github/workflows/preview.yml README.md
git commit -m "fix(factory): P2 잔여 — risk-tier·policy 임시 분기 제거, 위험 보류 PR에도 리뷰 판정 게시

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: 증거 계획 — 테스트 파일 판정과 `evidence` CLI

**Files:**
- Create: `packages/factory/src/policy/evidence.ts`, `packages/factory/src/stages/evidence.ts`
- Modify: `packages/factory/src/policy/risk.ts`(`ChangedFile.removed`), `packages/factory/src/github/octokit.ts`(`listPullFiles` 매핑), `packages/factory/src/cli.ts`(`base` 옵션, `sha40()`, `evidence` 명령)
- Test: `packages/factory/test/evidence-policy.test.ts`, `packages/factory/test/evidence-plan.test.ts`, `packages/factory/test/octokit.test.ts`, `packages/factory/test/cli.test.ts`

**Interfaces:**
- Consumes: `normalizePath`, `ChangedFile` (`src/policy/risk.ts`), `parsePrMeta` (`src/report/pr.ts`), `TooManyFilesError` (`src/github/port.ts`), `num`, `reqStr`, `UsageError`, `COMMANDS` (`src/cli.ts`), `openBotPr`, `makeTestDeps` (`test/helpers.ts`)
- Produces (`src/policy/evidence.ts`):
  - `TEST_FILE_PATTERNS: readonly string[]` = `["apps/*/test/**", "**/*.test.ts", "**/*.test.tsx", "apps/web/e2e/**"]`
  - `isSafeRelativePath(file: string): boolean` — 1-300자, 절대 경로·`\`·NUL·줄바꿈·빈 세그먼트·`.`·`..` 없음
  - `isTestFile(file: string): boolean` — `isSafeRelativePath`이고 `TEST_FILE_PATTERNS` 중 하나와 일치
  - `type SuiteName = "api" | "web" | "factory"`, `interface SuiteRun { suite: SuiteName; filter: string; targets: string[] }`(targets는 패키지 디렉토리 기준 상대 경로)
  - `SUITES: readonly { suite: SuiteName; filter: string; dir: string }[]`
  - `planSuites(files: string[]): { runs: SuiteRun[]; unsupported: string[] }`
- Produces (`src/stages/evidence.ts`):
  - `EvidencePlanSchema`(zod) / `type EvidencePlan = { pr: number; required: boolean; reason: string; baseSha: string; headSha: string; testFiles: string[] }` — SHA는 40자리 소문자 16진수, `testFiles`는 `isTestFile`을 만족하는 경로 200개 이하
  - `runEvidencePlan(deps: StageDeps, args: { pr: number; baseSha: string; headSha: string }): Promise<EvidencePlan>`
- Produces (`src/policy/risk.ts`): `ChangedFile.removed?: boolean`
- CLI: `pnpm -s factory evidence --pr N --sha <head 40자> --base <base 40자> [--json]` — 종료 코드 0, `--json`이면 계획 JSON 한 줄을 출력

- [ ] **Step 1: 실패하는 테스트 작성(경로 판정)**

`packages/factory/test/evidence-policy.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isTestFile, planSuites } from "../src/policy/evidence";

describe("isTestFile", () => {
  it.each([
    ["apps/api/test/favorites.test.ts", true],
    ["apps/api/test/helpers.ts", true],
    ["apps/web/src/components/ErrorList.test.tsx", true],
    ["apps/web/src/lib/markdown.test.ts", true],
    ["apps/web/e2e/smoke.spec.ts", true],
    ["packages/factory/test/gate.test.ts", true],
    ["apps/api/src/routes/tags.ts", false],
    ["apps/web/e2e-smoke/home.spec.ts", false],
    ["tests/realworld/skip.txt", false],
    ["apps/api/test/../../../etc/passwd", false],
    ["apps/api/test/./a.test.ts", false],
    ["/etc/a.test.ts", false],
    ["apps/api/test/a\nb.test.ts", false],
    ["apps\\api\\test\\a.test.ts", false],
    ["", false],
  ])("%j → %s", (file, expected) => {
    expect(isTestFile(file)).toBe(expected);
  });
});

describe("planSuites", () => {
  it("groups runnable test files by workspace package and reports what it cannot run", () => {
    expect(
      planSuites([
        "apps/api/test/favorites.test.ts",
        "apps/api/test/helpers.ts",
        "apps/web/src/components/ArticleList.test.tsx",
        "apps/web/e2e/smoke.spec.ts",
        "packages/factory/test/gate.test.ts",
        "tools/x.test.ts",
      ]),
    ).toEqual({
      runs: [
        { suite: "api", filter: "api", targets: ["test/favorites.test.ts"] },
        { suite: "web", filter: "web", targets: ["src/components/ArticleList.test.tsx"] },
        { suite: "factory", filter: "factory", targets: ["test/gate.test.ts"] },
      ],
      unsupported: ["apps/web/e2e/smoke.spec.ts", "tools/x.test.ts"],
    });
  });

  it("returns no runs when only helpers or e2e specs changed", () => {
    expect(planSuites(["apps/api/test/helpers.ts", "apps/web/e2e/a.spec.ts"])).toEqual({
      runs: [],
      unsupported: ["apps/web/e2e/a.spec.ts"],
    });
  });
});
```

- [ ] **Step 2: 실패하는 테스트 작성(계획)**

`packages/factory/test/evidence-plan.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TooManyFilesError, type ChangedFile } from "../src/github/port";
import { EvidencePlanSchema, runEvidencePlan } from "../src/stages/evidence";
import { makeTestDeps, openBotPr, type TestHarness } from "./helpers";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

async function bugPr(h: TestHarness, files: (string | ChangedFile)[]) {
  const opened = await openBotPr(h, {}, files);
  await h.gh.addLabels(opened.issue, ["type:bug"]);
  h.gh.setBranch(opened.branch, HEAD, files);
  return opened;
}

describe("runEvidencePlan", () => {
  it("does not require evidence for a PR without a factory marker", async () => {
    const h = makeTestDeps();
    h.gh.setBranch("feature/x", HEAD, ["apps/api/test/a.test.ts"]);
    const pr = await h.gh.createPull({
      title: "human",
      body: "사람이 연 PR",
      head: "feature/x",
      base: "main",
      draft: false,
    });
    h.gh.pulls.get(pr)!.author = "serithemage";
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toMatchObject({ required: false, testFiles: [] });
  });

  it("does not require evidence when the linked issue is not type:bug", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await openBotPr(h);
    h.gh.setBranch(branch, HEAD, ["apps/api/test/a.test.ts"]);
    expect(await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      required: false,
    });
  });

  it("lists added, modified and renamed test files of a bug PR, skipping removed and non-test files", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await bugPr(h, [
      "apps/web/src/components/ArticleList.tsx",
      "apps/web/src/components/ArticleList.test.tsx",
      {
        filename: "apps/api/test/new-name.test.ts",
        previousFilename: "apps/api/test/old-name.test.ts",
        additions: [],
      },
      { filename: "apps/api/test/gone.test.ts", additions: [], removed: true },
      "apps/api/test/helpers.ts",
      "apps/web/e2e/x.spec.ts",
      "README.md",
    ]);
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toEqual({
      pr,
      required: true,
      reason: `연결 이슈 #${issue}가 type:bug다. PR이 추가·수정한 테스트 파일 4개로 판정한다.`,
      baseSha: BASE,
      headSha: HEAD,
      testFiles: [
        "apps/api/test/helpers.ts",
        "apps/api/test/new-name.test.ts",
        "apps/web/e2e/x.spec.ts",
        "apps/web/src/components/ArticleList.test.tsx",
      ],
    });
    expect(EvidencePlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it("requires evidence but lists no files when the PR head moved after the event", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await bugPr(h, ["apps/api/test/a.test.ts"]);
    h.gh.setBranch(branch, "c".repeat(40), ["apps/api/test/a.test.ts"]);
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toMatchObject({ required: true, testFiles: [] });
    expect(plan.reason).toContain("PR head가");
  });

  it("requires evidence but lists no files when GitHub cannot list every changed file", async () => {
    const h = makeTestDeps();
    const { pr } = await bugPr(h, ["apps/api/test/a.test.ts"]);
    h.gh.listPullFiles = async () => {
      throw new TooManyFilesError("too many");
    };
    expect(await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      required: true,
      testFiles: [],
    });
  });
});

describe("EvidencePlanSchema", () => {
  const ok = {
    pr: 1,
    required: true,
    reason: "r",
    baseSha: BASE,
    headSha: HEAD,
    testFiles: ["apps/api/test/a.test.ts"],
  };
  it.each([
    ["path traversal", { ...ok, testFiles: ["apps/api/test/../../../etc/passwd"] }],
    ["non-test path", { ...ok, testFiles: ["apps/api/src/index.ts"] }],
    ["short sha", { ...ok, headSha: "abc" }],
    ["missing field", { pr: 1, required: true }],
  ])("rejects %s", (_name, value) => {
    expect(EvidencePlanSchema.safeParse(value).success).toBe(false);
  });
});
```

`packages/factory/test/octokit.test.ts`의 `describe("createOctokitPort listPullFiles", ...)` 안 기존 테스트 아래에 추가한다:
```ts
  it("marks files GitHub reports as removed", async () => {
    const gh = port([
      { method: "GET", path: /pulls\/5$/, status: 200, body: { changed_files: 1 } },
      {
        method: "GET",
        path: /pulls\/5\/files$/,
        status: 200,
        body: [{ filename: "a.test.ts", status: "removed", additions: 0, patch: "@@ -1 +0,0 @@\n-x" }],
      },
    ]);
    expect(await gh.listPullFiles(5)).toEqual([
      { filename: "a.test.ts", additions: [], additionCount: 0, removed: true },
    ]);
  });
```

`packages/factory/test/cli.test.ts`의 `describe("cli main", ...)` 안에 추가한다(파일 위 import에 `openBotPr`를 더한다: `import { makeTestDeps, openBotPr } from "./helpers";`):
```ts
  it("evidence prints the plan as JSON and rejects malformed sha options", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    const out: string[] = [];
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    expect(
      await main(
        ["evidence", "--pr", String(pr), "--sha", head, "--base", base, "--json"],
        context(h, [], out),
      ),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      pr,
      required: false,
      baseSha: base,
      headSha: head,
      testFiles: [],
    });
    expect(
      await main(["evidence", "--pr", String(pr), "--sha", "HEAD", "--base", base], context(h)),
    ).toBe(2);
  });
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/evidence-policy.test.ts test/evidence-plan.test.ts test/octokit.test.ts test/cli.test.ts`
Expected: FAIL — `Cannot find module '../src/policy/evidence'`, `'../src/stages/evidence'`, octokit 결과에 `removed`가 없음, CLI usage 오류(알 수 없는 명령 `evidence`).

- [ ] **Step 4: 구현**

`packages/factory/src/policy/risk.ts`의 `ChangedFile` 인터페이스 끝(`patchMissing?: boolean;` 아래)에 추가한다:
```ts
  /** GitHub가 이 파일을 삭제(status "removed")로 보고했다. evidence는 삭제된 테스트를 실행 대상에서 뺀다. */
  removed?: boolean;
```
`packages/factory/src/github/octokit.ts`의 `listPullFiles` 반환 매핑을 다음으로 바꾼다:
```ts
      return files.map((f) => ({
        filename: f.filename,
        ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
        additions: addedLinesFromPatch(f.patch ?? ""),
        additionCount: f.additions,
        ...(f.patch === undefined ? { patchMissing: true } : {}),
        ...(f.status === "removed" ? { removed: true } : {}),
      }));
```
`packages/factory/src/policy/evidence.ts`:
```ts
import picomatch from "picomatch";

// spec 7.1.2의 테스트 파일 정의에 웹 컴포넌트 테스트(.test.tsx)를 더한다.
export const TEST_FILE_PATTERNS: readonly string[] = [
  "apps/*/test/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "apps/web/e2e/**",
];

// evidence-run은 이 경로에 파일을 쓴다. 작업 트리 밖을 가리킬 수 있는 경로는 받지 않는다.
export function isSafeRelativePath(file: string): boolean {
  if (file.length === 0 || file.length > 300) return false;
  if (file.startsWith("/") || /[\0\r\n\\]/.test(file)) return false;
  return file.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function isTestFile(file: string): boolean {
  return isSafeRelativePath(file) && picomatch.isMatch(file, [...TEST_FILE_PATTERNS], { dot: true });
}

export type SuiteName = "api" | "web" | "factory";

export interface SuiteRun {
  suite: SuiteName;
  filter: string;
  // 패키지 디렉토리 기준 상대 경로. `pnpm --filter <filter> exec vitest run <targets...>`에 넘긴다.
  targets: string[];
}

export const SUITES: readonly { suite: SuiteName; filter: string; dir: string }[] = [
  { suite: "api", filter: "api", dir: "apps/api/" },
  { suite: "web", filter: "web", dir: "apps/web/" },
  { suite: "factory", filter: "factory", dir: "packages/factory/" },
];

// Playwright E2E는 서버 두 개와 브라우저가 필요해 evidence에서 실행하지 않는다(판정 후보 2).
const E2E_DIR = "apps/web/e2e/";
const RUNNABLE = /\.test\.tsx?$/;

export function planSuites(files: string[]): { runs: SuiteRun[]; unsupported: string[] } {
  const runs = new Map<SuiteName, SuiteRun>();
  const unsupported: string[] = [];
  for (const f of files) {
    if (f.startsWith(E2E_DIR)) {
      unsupported.push(f);
      continue;
    }
    // 도우미 파일(test/helpers.ts 등)은 overlay에 덮어쓰기만 하고 직접 실행하지 않는다.
    if (!RUNNABLE.test(f)) continue;
    const spec = SUITES.find((s) => f.startsWith(s.dir));
    if (!spec) {
      unsupported.push(f);
      continue;
    }
    const run = runs.get(spec.suite) ?? { suite: spec.suite, filter: spec.filter, targets: [] };
    run.targets.push(f.slice(spec.dir.length));
    runs.set(spec.suite, run);
  }
  return { runs: [...runs.values()], unsupported };
}
```
`packages/factory/src/stages/evidence.ts`:
```ts
import { z } from "zod";
import { TooManyFilesError, type ChangedFile } from "../github/port";
import { isTestFile } from "../policy/evidence";
import { normalizePath } from "../policy/risk";
import { parsePrMeta } from "../report/pr";
import type { StageDeps } from "./deps";

const SHA = /^[0-9a-f]{40}$/;

// evidence-plan job이 만들고 evidence job이 job output으로 받는 계획. 받는 쪽은 이 스키마로 다시 검증한다.
export const EvidencePlanSchema = z.object({
  pr: z.number().int().positive(),
  required: z.boolean(),
  reason: z.string().max(500),
  baseSha: z.string().regex(SHA),
  headSha: z.string().regex(SHA),
  testFiles: z.array(z.string().refine(isTestFile, "테스트 파일 경로가 아니다")).max(200),
});
export type EvidencePlan = z.infer<typeof EvidencePlanSchema>;

export async function runEvidencePlan(
  deps: StageDeps,
  args: { pr: number; baseSha: string; headSha: string },
): Promise<EvidencePlan> {
  const plan = (required: boolean, reason: string, testFiles: string[] = []): EvidencePlan => ({
    pr: args.pr,
    required,
    reason,
    baseSha: args.baseSha,
    headSha: args.headSha,
    testFiles,
  });
  const pull = await deps.gh.getPull(args.pr);
  const meta = parsePrMeta(pull.body);
  if (!meta) {
    return plan(false, "PR 본문에 팩토리 표식이 없다(사람이 연 PR 등). 버그 PR 증거 검사를 하지 않는다.");
  }
  const issue = await deps.gh.getIssue(meta.issue);
  if (!issue.labels.includes("type:bug")) {
    return plan(
      false,
      `연결 이슈 #${meta.issue}에 type:bug 라벨이 없다. 버그 PR 증거 검사를 하지 않는다.`,
    );
  }
  // 이벤트 이후 head가 바뀌었으면 이 head의 파일 목록을 알 수 없다. 실패로 두고 새 head의 실행에 맡긴다.
  if (pull.headSha !== args.headSha) {
    return plan(
      true,
      `PR head가 ${pull.headSha}로 바뀌어 ${args.headSha}의 테스트 파일을 확정할 수 없다. 새 head의 evidence 실행이 판정한다.`,
    );
  }
  let files: ChangedFile[];
  try {
    files = await deps.gh.listPullFiles(args.pr);
  } catch (e) {
    if (!(e instanceof TooManyFilesError)) throw e;
    return plan(true, "변경 파일이 너무 많아 테스트 파일 목록을 확정할 수 없다.");
  }
  const testFiles = [
    ...new Set(
      files
        .filter((f) => !f.removed)
        .map((f) => normalizePath(f.filename))
        .filter(isTestFile),
    ),
  ].sort();
  return plan(
    true,
    `연결 이슈 #${meta.issue}가 type:bug다. PR이 추가·수정한 테스트 파일 ${testFiles.length}개로 판정한다.`,
    testFiles,
  );
}
```
`packages/factory/src/cli.ts`를 고친다.
- import 블록에 추가: `import { runEvidencePlan } from "./stages/evidence";`
- `OPTIONS`에 두 줄을 더한다(`check: { type: "boolean" },` 아래): `base: { type: "string" },`, `result: { type: "string" },`
- `reqStr` 함수 아래에 추가:
```ts
function sha40(v: Values, name: string): string {
  const s = reqStr(v, name);
  if (!/^[0-9a-f]{40}$/.test(s)) throw new UsageError(`--${name}는 40자리 소문자 16진수여야 한다`);
  return s;
}
```
- `COMMANDS`의 `"deploy-failed"` 항목 아래에 추가:
```ts
  evidence: async (ctx, v) => {
    const plan = await runEvidencePlan(ctx.buildDeps(ctx.env, "all"), {
      pr: num(v, "pr"),
      headSha: sha40(v, "sha"),
      baseSha: sha40(v, "base"),
    });
    ctx.stdout(
      v.json === true
        ? JSON.stringify(plan)
        : `evidence ${plan.required ? "required" : "not required"}: ${plan.reason}`,
    );
    return 0;
  },
```
- 파일 끝의 `export { optNum, reqStr, str, num };`를 `export { optNum, reqStr, str, num, sha40 };`로 바꾼다.

- [ ] **Step 5: 테스트가 통과하는지 확인**

Run: `pnpm --filter factory exec vitest run test/evidence-policy.test.ts test/evidence-plan.test.ts test/octokit.test.ts test/cli.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
pnpm exec prettier --write packages/factory/src packages/factory/test
git add packages/factory/src/policy/evidence.ts packages/factory/src/stages/evidence.ts packages/factory/src/policy/risk.ts packages/factory/src/github/octokit.ts packages/factory/src/cli.ts packages/factory/test/evidence-policy.test.ts packages/factory/test/evidence-plan.test.ts packages/factory/test/octokit.test.ts packages/factory/test/cli.test.ts
git commit -m "feat(factory): evidence 계획 — 버그 PR 판정과 테스트 파일 목록(evidence CLI)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: 증거 실행기 — base 오버레이와 `evidence-run` CLI

**Files:**
- Modify: `packages/factory/src/stages/evidence.ts`(실행기 추가), `packages/factory/src/cli.ts`(`evidence-run` 명령)
- Test: `packages/factory/test/evidence-run.test.ts`, `packages/factory/test/cli.test.ts`

**Interfaces:**
- Consumes: `EvidencePlan`, `EvidencePlanSchema` (Task 2), `planSuites`, `isSafeRelativePath` (Task 2), `scrubEnv` (`src/agents/env.ts`), `tail` (`src/exec/checks.ts`), `runProcess`, `SpawnFn`, `ProcessResult` (`src/exec/process.ts`), `StageDeps.spawn`, `StageDeps.settings.workdir`, `StageDeps.settings.env`
- Produces (`src/stages/evidence.ts`):
  - `EVIDENCE_STEP_TIMEOUT_MS = 900_000`
  - `interface SuiteOutcome { suite: string; targets: string[]; baseCode: number | null; headCode: number | null; baseOutput: string; headOutput: string }`
  - `interface EvidenceResult { pr: number; required: boolean; ok: boolean; reason: string; testFiles: string[]; unsupported: string[]; suites: SuiteOutcome[] }`
  - `runEvidence(deps: StageDeps, plan: EvidencePlan): Promise<EvidenceResult>` — 하나 이상의 base 실행이 0이 아닌 숫자 종료 코드이고 모든 head 실행이 0이면 `ok: true`. 종료 코드가 `null`(시간 초과·강제 종료)이면 실패.
  - `renderEvidenceText(r: EvidenceResult): string`
- CLI: `pnpm -s factory evidence-run [--json]` — 환경변수 `EVIDENCE_PLAN`(계획 JSON), `FACTORY_WORKDIR`(PR head 체크아웃). 계획이 없거나 형식이 틀리면 종료 코드 1(fail closed). `buildDeps(env, "agent")`를 쓰므로 GitHub 토큰이 env에 있으면 예외로 끝난다. 결과가 `ok`면 0, 아니면 1.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/factory/test/evidence-run.test.ts`(실제 git 저장소를 임시 디렉토리에 만들고, `pnpm` 호출만 가짜로 바꾼다):
```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, type SpawnFn } from "../src/exec/process";
import { runEvidence, type EvidencePlan } from "../src/stages/evidence";
import { makeTestDeps, type TestHarness } from "./helpers";

const SRC = "apps/web/src/pages.ts";
const TEST = "apps/web/src/pages.test.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function put(dir: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

// base: 버그가 있는 코드와 예전 테스트. head: 고친 코드와 새 재현 테스트.
function setup(): { h: TestHarness; base: string; head: string } {
  const h = makeTestDeps({
    settings: { env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  });
  git(h.dir, "init", "-q", "-b", "main");
  put(h.dir, SRC, "export const pages = (n: number) => Math.floor(n / 10);\n");
  put(h.dir, TEST, "// base test\n");
  git(h.dir, "add", "-A");
  git(h.dir, "commit", "-qm", "base");
  const base = git(h.dir, "rev-parse", "HEAD");
  put(h.dir, SRC, "export const pages = (n: number) => Math.ceil(n / 10);\n");
  put(h.dir, TEST, "// head reproduction test\n");
  git(h.dir, "add", "-A");
  git(h.dir, "commit", "-qm", "head");
  return { h, base, head: git(h.dir, "rev-parse", "HEAD") };
}

interface Seen {
  where: "base" | "head";
  args: string[];
  src: string;
  test: string;
}

// git은 실제로 실행하고, pnpm install은 성공, vitest는 트리별 종료 코드를 돌려준다.
function fakeSpawn(
  h: TestHarness,
  codes: { base: number | null; head: number | null },
  seen: Seen[],
): SpawnFn {
  return async (cmd, args, opts) => {
    if (cmd === "git") return runProcess(cmd, args, opts);
    if (args[0] === "install") return { code: 0, stdout: "", stderr: "" };
    const where = opts.cwd === h.dir ? "head" : "base";
    seen.push({
      where,
      args: [...args],
      src: readFileSync(path.join(opts.cwd, SRC), "utf8"),
      test: readFileSync(path.join(opts.cwd, TEST), "utf8"),
    });
    const code = codes[where];
    return { code, stdout: `${where} vitest`, stderr: "" };
  };
}

const plan = (base: string, head: string, over: Partial<EvidencePlan> = {}): EvidencePlan => ({
  pr: 7,
  required: true,
  reason: "연결 이슈 #6가 type:bug다.",
  baseSha: base,
  headSha: head,
  testFiles: [TEST],
  ...over,
});

describe("runEvidence", () => {
  it("runs the head test on the base tree (must fail) and on the head tree (must pass)", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, seen);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.where)).toEqual(["base", "head"]);
    // base 트리에는 버그 코드가 그대로 있고, 테스트만 head 버전으로 덮였다.
    expect(seen[0]!.src).toContain("Math.floor");
    expect(seen[0]!.test).toBe("// head reproduction test\n");
    expect(seen[1]!.src).toContain("Math.ceil");
    expect(seen[0]!.args).toEqual(["--filter", "web", "exec", "vitest", "run", "src/pages.test.ts"]);
    expect(r.suites).toMatchObject([{ suite: "web", baseCode: 1, headCode: 0 }]);
    // 임시 worktree는 정리된다.
    expect(git(h.dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("fails when the reproduction test also passes on the base tree", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, { base: 0, head: 0 }, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수정 전(base) 코드에서도 통과");
  });

  it("fails when the test does not pass on the head tree", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 1 }, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수정 후(head) 코드에서 실패");
  });

  it("does not count a killed or timed-out base run as a reproduction", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, { base: null, head: 0 }, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("시간 제한");
  });

  it("passes immediately without running anything when evidence is not required", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, seen);
    const r = await runEvidence(h.deps, plan(base, head, { required: false, testFiles: [] }));
    expect(r.ok).toBe(true);
    expect(seen).toEqual([]);
  });

  it("fails a bug PR without test files and a bug PR with only e2e specs", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, []);
    expect((await runEvidence(h.deps, plan(base, head, { testFiles: [] }))).reason).toContain(
      "테스트 파일 변경이 없다",
    );
    const e2e = await runEvidence(h.deps, plan(base, head, { testFiles: ["apps/web/e2e/a.spec.ts"] }));
    expect(e2e.ok).toBe(false);
    expect(e2e.unsupported).toEqual(["apps/web/e2e/a.spec.ts"]);
  });

  it("refuses to judge when the checked-out head is not the planned head", async () => {
    const { h, base } = setup();
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, []);
    const r = await runEvidence(h.deps, plan(base, base));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("판정 대상");
  });
});
```
`packages/factory/test/cli.test.ts`의 `describe("cli main", ...)` 안에 추가한다:
```ts
  it("evidence-run fails closed when the plan is missing or malformed, without building deps", async () => {
    const h = makeTestDeps();
    const phases: Phase[] = [];
    for (const raw of [undefined, "", "{}", '{"pr":1,"required":false}']) {
      const out: string[] = [];
      const ctx = { ...context(h, phases, out), env: raw === undefined ? {} : { EVIDENCE_PLAN: raw } };
      expect(await main(["evidence-run"], ctx)).toBe(1);
      expect(out[0]).toContain("EVIDENCE_PLAN");
    }
    expect(phases).toEqual([]);
  });

  it("evidence-run builds agent-phase deps and passes a plan that does not require evidence", async () => {
    const h = makeTestDeps();
    const phases: Phase[] = [];
    const out: string[] = [];
    const planJson = JSON.stringify({
      pr: 3,
      required: false,
      reason: "사람 PR",
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      testFiles: [],
    });
    const ctx = { ...context(h, phases, out), env: { EVIDENCE_PLAN: planJson } };
    expect(await main(["evidence-run"], ctx)).toBe(0);
    expect(phases).toEqual(["agent"]);
    expect(out[0]).toContain("evidence 통과");
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/evidence-run.test.ts test/cli.test.ts`
Expected: FAIL — `runEvidence`가 export되지 않았고, `evidence-run`은 알 수 없는 명령이라 종료 코드 2다.

- [ ] **Step 3: 구현**

`packages/factory/src/stages/evidence.ts` 맨 위 import를 다음으로 바꾼다:
```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { scrubEnv } from "../agents/env";
import { tail } from "../exec/checks";
import type { ProcessResult } from "../exec/process";
import { TooManyFilesError, type ChangedFile } from "../github/port";
import { isSafeRelativePath, isTestFile, planSuites } from "../policy/evidence";
import { normalizePath } from "../policy/risk";
import { parsePrMeta } from "../report/pr";
import type { StageDeps } from "./deps";
```
파일 끝에 추가한다:
```ts
export const EVIDENCE_STEP_TIMEOUT_MS = 15 * 60_000;

export interface SuiteOutcome {
  suite: string;
  targets: string[];
  baseCode: number | null;
  headCode: number | null;
  baseOutput: string;
  headOutput: string;
}

export interface EvidenceResult {
  pr: number;
  required: boolean;
  ok: boolean;
  reason: string;
  testFiles: string[];
  unsupported: string[];
  suites: SuiteOutcome[];
}

// 이 함수는 PR 코드(테스트와 그 의존성)를 실행한다. 시크릿·GitHub 토큰이 없는 evidence job에서만 부른다(spec 7.1.2).
export async function runEvidence(deps: StageDeps, plan: EvidencePlan): Promise<EvidenceResult> {
  const { runs, unsupported } = planSuites(plan.testFiles);
  const done = (ok: boolean, reason: string, suites: SuiteOutcome[] = []): EvidenceResult => ({
    pr: plan.pr,
    required: plan.required,
    ok,
    reason,
    testFiles: plan.testFiles,
    unsupported,
    suites,
  });
  if (!plan.required) return done(true, plan.reason);
  if (plan.testFiles.length === 0) {
    return done(
      false,
      `버그 PR인데 테스트 파일 변경이 없다. 수정 전 코드에서 실패하는 재현 테스트를 추가해야 한다. (${plan.reason})`,
    );
  }
  if (runs.length === 0) {
    return done(
      false,
      "실행할 수 있는 Vitest 테스트 파일(apps/api, apps/web, packages/factory 아래 *.test.ts(x))이 없다. Playwright E2E만으로는 evidence를 통과하지 못한다.",
    );
  }
  const env = scrubEnv(deps.settings.env);
  const repo = deps.settings.workdir;
  const exec = async (cmd: string, args: string[], cwd: string): Promise<ProcessResult> => {
    try {
      return await deps.spawn(cmd, args, {
        cwd,
        env,
        signal: AbortSignal.timeout(EVIDENCE_STEP_TIMEOUT_MS),
      });
    } catch (e) {
      return { code: null, stdout: "", stderr: String(e) };
    }
  };
  const head = await exec("git", ["rev-parse", "HEAD"], repo);
  if (head.code !== 0 || head.stdout.trim() !== plan.headSha) {
    return done(
      false,
      `작업 트리 head(${head.stdout.trim() || "알 수 없음"})가 판정 대상 ${plan.headSha}와 다르다.`,
    );
  }
  const root = mkdtempSync(path.join(deps.settings.env.RUNNER_TEMP || tmpdir(), "evidence-"));
  const overlay = path.join(root, "overlay");
  try {
    const add = await exec("git", ["worktree", "add", "--detach", overlay, plan.baseSha], repo);
    if (add.code !== 0) return done(false, `base 커밋 ${plan.baseSha}로 작업 트리를 만들지 못했다.`);
    for (const file of plan.testFiles) {
      const target = path.resolve(overlay, file);
      if (!isSafeRelativePath(file) || !target.startsWith(`${overlay}${path.sep}`)) {
        return done(false, `안전하지 않은 테스트 파일 경로: ${file}`);
      }
      const blob = await exec("git", ["show", `${plan.headSha}:${file}`], repo);
      if (blob.code !== 0 || blob.truncated) return done(false, `head에서 ${file}을 읽지 못했다.`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, blob.stdout);
    }
    for (const [dir, name] of [
      [overlay, "base+테스트"],
      [repo, "head"],
    ] as const) {
      const install = await exec("pnpm", ["install", "--frozen-lockfile"], dir);
      if (install.code !== 0) return done(false, `${name} 트리의 의존성 설치가 실패했다.`);
    }
    const suites: SuiteOutcome[] = [];
    for (const run of runs) {
      const args = ["--filter", run.filter, "exec", "vitest", "run", ...run.targets];
      const base = await exec("pnpm", args, overlay);
      const after = await exec("pnpm", args, repo);
      suites.push({
        suite: run.suite,
        targets: run.targets,
        baseCode: base.code,
        headCode: after.code,
        baseOutput: tail(`${base.stdout}\n${base.stderr}`.trim(), 3000),
        headOutput: tail(`${after.stdout}\n${after.stderr}`.trim(), 3000),
      });
    }
    if (suites.some((s) => s.baseCode === null || s.headCode === null)) {
      return done(false, "테스트 실행이 시간 제한(15분)에 걸리거나 강제 종료되었다.", suites);
    }
    if (!suites.every((s) => s.headCode === 0)) {
      return done(false, "재현 테스트가 수정 후(head) 코드에서 실패했다.", suites);
    }
    if (!suites.some((s) => s.baseCode !== 0)) {
      return done(
        false,
        "재현 테스트가 수정 전(base) 코드에서도 통과했다. 버그를 재현하지 못하는 테스트다.",
        suites,
      );
    }
    return done(
      true,
      "재현 테스트가 수정 전(base) 코드에서 실패하고 수정 후(head) 코드에서 통과했다.",
      suites,
    );
  } finally {
    await exec("git", ["worktree", "remove", "--force", overlay], repo);
    rmSync(root, { recursive: true, force: true });
  }
}

export function renderEvidenceText(r: EvidenceResult): string {
  const lines = [
    `evidence ${r.ok ? "통과" : "실패"}(PR #${r.pr}): ${r.reason}`,
    `테스트 파일: ${r.testFiles.length > 0 ? r.testFiles.join(", ") : "(없음)"}`,
  ];
  if (r.unsupported.length > 0) lines.push(`실행하지 않은 테스트: ${r.unsupported.join(", ")}`);
  for (const s of r.suites) {
    lines.push(`- ${s.suite} ${s.targets.join(" ")}: base 종료 코드 ${s.baseCode}, head 종료 코드 ${s.headCode}`);
    if (!r.ok) lines.push(`  base 출력:\n${s.baseOutput}`, `  head 출력:\n${s.headOutput}`);
  }
  return lines.join("\n");
}
```
`packages/factory/src/cli.ts`를 고친다.
- evidence import를 `import { EvidencePlanSchema, renderEvidenceText, runEvidence, runEvidencePlan, type EvidencePlan } from "./stages/evidence";`로 바꾼다.
- `COMMANDS`의 `evidence` 항목 아래에 추가:
```ts
  "evidence-run": async (ctx, v) => {
    // 계획은 다른 job이 넘긴 값이다. 형식이 틀리거나 없으면(evidence-plan job 실패) 통과시키지 않는다.
    let plan: EvidencePlan;
    try {
      plan = EvidencePlanSchema.parse(JSON.parse(ctx.env.EVIDENCE_PLAN ?? ""));
    } catch {
      ctx.stdout(
        "evidence 실패: EVIDENCE_PLAN(판정 계획)이 없거나 형식이 틀렸다. evidence-plan job 결과를 확인한다.",
      );
      return 1;
    }
    const result = await runEvidence(ctx.buildDeps(ctx.env, "agent"), plan);
    ctx.stdout(v.json === true ? JSON.stringify(result) : renderEvidenceText(result));
    return result.ok ? 0 : 1;
  },
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter factory exec vitest run test/evidence-run.test.ts test/evidence-plan.test.ts test/cli.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: 로컬에서 실제 저장소로 한 번 확인(수동)**

현재 브랜치 head에서 이전 커밋을 base로 삼아, 이미 통과하는 테스트 하나로 "base에서도 통과" 판정이 나오는지 본다.
```bash
BASE=$(git rev-parse HEAD~1); HEAD=$(git rev-parse HEAD)
EVIDENCE_PLAN="{\"pr\":1,\"required\":true,\"reason\":\"local\",\"baseSha\":\"$BASE\",\"headSha\":\"$HEAD\",\"testFiles\":[\"apps/web/src/lib/markdown.test.ts\"]}" \
FACTORY_WORKDIR="$PWD" env -u GITHUB_TOKEN -u GH_TOKEN -u FACTORY_TOKEN pnpm -s factory evidence-run; echo "exit=$?"
git worktree list
```
Expected: `evidence 실패(PR #1): 재현 테스트가 수정 전(base) 코드에서도 통과했다.`, `exit=1`, `git worktree list`에 현재 디렉토리 한 줄만 남는다.

- [ ] **Step 6: 커밋**

```bash
pnpm exec prettier --write packages/factory/src/stages/evidence.ts packages/factory/src/cli.ts packages/factory/test/evidence-run.test.ts packages/factory/test/cli.test.ts
git add packages/factory/src/stages/evidence.ts packages/factory/src/cli.ts packages/factory/test/evidence-run.test.ts packages/factory/test/cli.test.ts
git commit -m "feat(factory): evidence 실행기 — base 트리+head 테스트는 실패, head는 통과(evidence-run CLI)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: 버그 이슈 implement 프롬프트 규칙과 evidence 실패 피드백

**Files:**
- Modify: `packages/factory/src/agents/prompt.ts`(`BUG_RULE`, `NOT_BUG_RULE`, `bugRuleFor()`), `factory/prompts/implement.md`("버그 재현 규칙" 절), `packages/factory/src/stages/implement.ts`(prepare의 `renderPrompt` 변수), `packages/factory/src/stages/fix.ts`(`feedbackFor`)
- Test: `packages/factory/test/prompt.test.ts`, `packages/factory/test/implement.test.ts`, `packages/factory/test/fix.test.ts`

**Interfaces:**
- Consumes: `renderPrompt`, `loadPrompt` (`src/agents/prompt.ts`), `implementStage`, `fixStage`, `approvedIssue(h, labels)`(implement.test.ts 내부 함수), `TAGS`(implement.test.ts 상수), `write(n)`(fix.test.ts 내부 함수)
- Produces (`src/agents/prompt.ts`): `BUG_RULE: string`(spec 7.1.2 문장 "재현 테스트를 먼저 작성해 실패를 확인한 뒤 수정하라"를 그대로 포함), `NOT_BUG_RULE: string`, `bugRuleFor(labels: string[]): string`. implement 템플릿 변수는 `issueNumber`, `issueTitle`, `issueBody`, `acceptanceCriteria`, `bugRule` 다섯 개가 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/factory/test/prompt.test.ts`를 세 군데 고친다.
- `describe("factory/prompts templates", ...)`의 `vars.implement`를 `["issueNumber", "issueTitle", "issueBody", "acceptanceCriteria", "bugRule"]`로 바꾼다.
- `it("a body containing the closing delimiter cannot close the block", ...)`의 implement `renderPrompt` 변수 객체에 `bugRule: "b",`를 더한다.
- `describe("delimiter hardening: raw delimiter counts", ...)`의 `impl` 함수가 넘기는 객체에 `bugRule: "b",`를 더한다.

같은 파일 끝에 추가한다(위 import에 `BUG_RULE, NOT_BUG_RULE, bugRuleFor`를 더한다):
```ts
describe("bugRuleFor", () => {
  it("asks for a failing reproduction test first only on type:bug issues", () => {
    expect(BUG_RULE).toContain("재현 테스트를 먼저 작성해 실패를 확인한 뒤 수정하라");
    expect(bugRuleFor(["factory:approved", "type:bug"])).toBe(BUG_RULE);
    expect(bugRuleFor(["type:feature"])).toBe(NOT_BUG_RULE);
    expect(bugRuleFor([])).toBe(NOT_BUG_RULE);
  });
});
```
`packages/factory/test/implement.test.ts`의 `describe("implement stage", ...)` 안에 추가한다(위 import에 `import { BUG_RULE, NOT_BUG_RULE } from "../src/agents/prompt";`를 더한다):
```ts
  it("puts the reproduction-test rule into the prompt of type:bug issues only", async () => {
    const bugAgent = createFakeAdapter([TAGS], "claude");
    const bugH = makeTestDeps({ adapters: { claude: bugAgent } });
    await run(bugH, approvedIssue(bugH, ["factory:approved", "type:bug"]), BOT);
    expect(bugAgent.calls[0]?.prompt).toContain(BUG_RULE);

    const featureAgent = createFakeAdapter([TAGS], "claude");
    const featureH = makeTestDeps({ adapters: { claude: featureAgent } });
    await run(featureH, approvedIssue(featureH), BOT);
    expect(featureAgent.calls[0]?.prompt).toContain(NOT_BUG_RULE);
    expect(featureAgent.calls[0]?.prompt).not.toContain(BUG_RULE);
  });
```
`packages/factory/test/fix.test.ts`의 `it("feeds failing CI check names to the agent for reason=ci", ...)` 아래에 추가한다:
```ts
  it("explains the evidence rule when the evidence check failed", async () => {
    const claude = createFakeAdapter([write(3)], "claude");
    const h = makeTestDeps({ adapters: { claude } });
    const { pr } = await openBotPr(h);
    h.gh.setChecks("sha-a", { unit: "success", evidence: "failure" });
    await runPhase(fixStage, "all", h.deps, { pr, sha: "sha-a", reason: "ci" }, null);
    expect(claude.calls[0]?.prompt).toContain("CI 필수 체크가 실패했다: evidence");
    expect(claude.calls[0]?.prompt).toContain(
      "재현 테스트(Vitest)가 수정 전(base) 코드에서 실패하고 PR 코드에서 통과해야",
    );
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/prompt.test.ts test/implement.test.ts test/fix.test.ts`
Expected: FAIL — `BUG_RULE`·`bugRuleFor`가 없고, implement 템플릿에 `{{bugRule}}`이 없어 출력에 `<bugRule>`이 없으며, fix 프롬프트에 evidence 설명이 없다.

- [ ] **Step 3: 구현**

`packages/factory/src/agents/prompt.ts`의 `UNTRUSTED_NOTICE` 선언 아래에 추가한다:
```ts
// spec 7.1.2: 버그 이슈의 implement 프롬프트에 재현 테스트 규칙을 넣는다. CI의 evidence 체크가 이 규칙을 검증한다.
export const BUG_RULE =
  "이 이슈는 버그(type:bug)다. 재현 테스트를 먼저 작성해 실패를 확인한 뒤 수정하라. 재현 테스트는 Vitest 파일(apps/api/test/*.test.ts 또는 apps/web/src/**/*.test.tsx)로 쓴다. CI의 evidence 체크가 PR이 추가·수정한 테스트 파일을 수정 전(base) 코드에 올려 실행해 실패하는지, PR 코드에서 통과하는지 확인한다. Playwright E2E(apps/web/e2e/)만 바꾸면 evidence를 통과하지 못한다.";
export const NOT_BUG_RULE = "이 이슈는 버그(type:bug)가 아니므로 이 절은 적용하지 않는다.";

export function bugRuleFor(labels: string[]): string {
  return labels.includes("type:bug") ? BUG_RULE : NOT_BUG_RULE;
}
```
`factory/prompts/implement.md`에서 `## 규칙` 목록의 마지막 줄(`- 끝내기 전에 pnpm format을 실행하고, ...`) 다음 빈 줄 뒤, `## 이슈 #{{issueNumber}}` 앞에 다음 절을 넣는다:
```markdown
## 버그 재현 규칙

{{bugRule}}

```
`packages/factory/src/stages/implement.ts`의 import에서 `import { loadPrompt, renderPrompt } from "../agents/prompt";`를 `import { bugRuleFor, loadPrompt, renderPrompt } from "../agents/prompt";`로 바꾸고, prepare의 `renderPrompt(loadPrompt("implement"), { ... })` 변수 객체 끝(`acceptanceCriteria: ...,` 다음)에 한 줄을 더한다:
```ts
      bugRule: bugRuleFor(issue.labels),
```
`packages/factory/src/stages/fix.ts`의 `feedbackFor` 마지막 `return` 문을 다음으로 바꾼다:
```ts
  const evidence = failing.includes("evidence")
    ? " evidence 체크는 버그 PR의 재현 테스트(Vitest)가 수정 전(base) 코드에서 실패하고 PR 코드에서 통과해야 통과한다. 테스트 파일 변경이 없거나, 테스트가 base에서도 통과하거나, Playwright E2E만 바꿨으면 실패한다. 재현 테스트가 버그를 실제로 드러내는지 확인하고 고친다."
    : "";
  return `CI 필수 체크가 실패했다: ${failing.join(", ") || "(실패한 체크 이름을 찾지 못함)"}. 작업 디렉토리에서 같은 검사(pnpm typecheck, pnpm lint, pnpm test, RealWorld 스위트는 scripts/realworld-api.sh)를 실행해 원인을 찾고 고친다.${evidence}`;
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter factory test && pnpm typecheck`
Expected: PASS(팩토리 전체 테스트).

- [ ] **Step 5: 커밋**

```bash
pnpm exec prettier --write packages/factory/src/agents/prompt.ts packages/factory/src/stages/implement.ts packages/factory/src/stages/fix.ts packages/factory/test/prompt.test.ts packages/factory/test/implement.test.ts packages/factory/test/fix.test.ts
git add factory/prompts/implement.md packages/factory/src/agents/prompt.ts packages/factory/src/stages/implement.ts packages/factory/src/stages/fix.ts packages/factory/test/prompt.test.ts packages/factory/test/implement.test.ts packages/factory/test/fix.test.ts
git commit -m "feat(factory): 버그 이슈 implement 프롬프트에 재현 테스트 규칙, fix 피드백에 evidence 설명

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: API 기반 — 마이그레이션 0003, 스키마, 오류 헬퍼, 해시

**Files:**
- Create: `apps/api/migrations/0003_intake.sql`, `apps/api/src/lib/hash.ts`
- Modify: `apps/api/src/db/schema.ts`, `apps/api/src/env.ts`, `apps/api/src/lib/errors.ts`, `apps/api/src/index.ts`(`notFound`), `apps/api/vitest.config.ts`, `apps/api/test/env.d.ts`
- Test: `apps/api/test/schema.test.ts`, `apps/api/test/hash.test.ts`

**Interfaces:**
- Produces (`src/db/schema.ts`): `errorEvents`(`fingerprint` PK, `message`, `path`, `count`, `firstSeen`, `lastSeen`, `ackedAt`), `feedback`(`id` PK, `body`, `path`, `ipHash`, `createdAt`, `ackedAt`)
- Produces (`src/lib/errors.ts`): `type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 429 | 501`, `tooLong(field: string, max: number): ApiError`(422, `is too long (maximum is N characters)`), `rateLimited(field: string): ApiError`(429, `too many requests`), `ROUTE_NOT_FOUND = { errors: { route: ["not found"] } }`
- Produces (`src/lib/hash.ts`): `sha256Hex(text: string): Promise<string>`(소문자 16진수 64자)
- Produces (`src/env.ts`): `Env.INTAKE_TOKEN?: string`(Worker secret. 프로덕션만 설정, 프리뷰·로컬은 없음). 테스트 바인딩 `INTAKE_TOKEN = "test-intake-token"`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/schema.test.ts`의 `it("creates P1 tables", ...)`를 다음으로 바꾼다:
```ts
  it("creates P1 tables and the P3 intake tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "article_tags",
      "articles",
      "comments",
      "error_events",
      "favorites",
      "feedback",
      "tags",
      "users",
    ]);
  });

  it("stores an IP hash column, never a raw IP column, and indexes it with created_at", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(feedback)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual([
      "id",
      "body",
      "path",
      "ip_hash",
      "created_at",
      "acked_at",
    ]);
    const idx = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('feedback','error_events') ORDER BY name",
    ).all<{ name: string }>();
    expect(idx.results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "error_events_last_seen_idx",
        "feedback_ip_created_idx",
        "feedback_pending_idx",
      ]),
    );
  });
```
`apps/api/test/hash.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/hash";

describe("sha256Hex", () => {
  it("returns the lowercase hex digest", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter api exec vitest run test/schema.test.ts test/hash.test.ts`
Expected: FAIL — 테이블 목록에 `error_events`, `feedback`이 없고, `../src/lib/hash`를 찾을 수 없다.

- [ ] **Step 3: 구현**

`apps/api/migrations/0003_intake.sql`(추가만 한다):
```sql
-- P3 유입(spec 7.1.3): 프로덕션 에러와 익명 피드백. 열·테이블을 지우지 않는다.
CREATE TABLE error_events (
  fingerprint TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  acked_at TEXT
);
CREATE INDEX error_events_last_seen_idx ON error_events (last_seen);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  path TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT
);
CREATE INDEX feedback_ip_created_idx ON feedback (ip_hash, created_at);
CREATE INDEX feedback_pending_idx ON feedback (acked_at, id);
```
`apps/api/src/db/schema.ts` 끝에 추가한다:
```ts
export const errorEvents = sqliteTable("error_events", {
  fingerprint: text("fingerprint").primaryKey(),
  message: text("message").notNull(),
  path: text("path").notNull(),
  count: integer("count").notNull(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
  ackedAt: text("acked_at"),
});

export const feedback = sqliteTable("feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  body: text("body").notNull(),
  path: text("path").notNull(),
  // IP 원문은 저장하지 않는다. SHA-256(IP + INTAKE_TOKEN)만 레이트 리밋에 쓴다(spec 7.1.3).
  ipHash: text("ip_hash").notNull(),
  createdAt: text("created_at").notNull(),
  ackedAt: text("acked_at"),
});
```
`apps/api/src/env.ts`의 `Env`를 다음으로 바꾼다:
```ts
export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ALLOWED_ORIGINS: string;
  // 프로덕션 Worker secret. deploy.yml이 GitHub production environment secret에서 넣는다. 프리뷰·로컬에는 없다.
  INTAKE_TOKEN?: string;
};
```
`apps/api/src/lib/errors.ts`를 고친다. 첫 줄을 `export type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 429 | 501;`로 바꾸고, 파일 끝에 추가한다:
```ts
export const tooLong = (field: string, max: number) =>
  one(422, field, `is too long (maximum is ${max} characters)`);
export const rateLimited = (field: string) => one(429, field, "too many requests");

// 알 수 없는 경로의 응답 본문. 수집 엔드포인트도 토큰이 틀리면 같은 본문을 돌려준다.
export const ROUTE_NOT_FOUND = { errors: { route: ["not found"] } };
```
`apps/api/src/lib/hash.ts`:
```ts
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
```
`apps/api/src/index.ts`에서 `import { ApiError } from "./lib/errors";`를 `import { ApiError, ROUTE_NOT_FOUND } from "./lib/errors";`로 바꾸고, `app.notFound(...)` 줄을 다음으로 바꾼다:
```ts
app.notFound((c) => c.json(ROUTE_NOT_FOUND, 404));
```
`apps/api/vitest.config.ts`의 `bindings`를 다음으로 바꾼다:
```ts
          bindings: {
            TEST_MIGRATIONS: migrations,
            JWT_SECRET: "test-secret",
            INTAKE_TOKEN: "test-intake-token",
          },
```
`apps/api/test/env.d.ts`의 `interface Env`에 `INTAKE_TOKEN: string;`을 `ALLOWED_ORIGINS: string;` 아래에 더한다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter api test && pnpm --filter api typecheck`
Expected: PASS(기존 API 테스트 포함. `app.test.ts`의 unknown route 404 기대가 그대로 통과한다).

- [ ] **Step 5: 커밋**

```bash
pnpm exec prettier --write apps/api/src apps/api/test apps/api/vitest.config.ts
git add apps/api/migrations/0003_intake.sql apps/api/src/db/schema.ts apps/api/src/env.ts apps/api/src/lib/errors.ts apps/api/src/lib/hash.ts apps/api/src/index.ts apps/api/vitest.config.ts apps/api/test/env.d.ts apps/api/test/schema.test.ts apps/api/test/hash.test.ts
git commit -m "feat(api): 마이그레이션 0003(error_events, feedback)과 오류·해시 헬퍼

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: 에러 기록기 — fingerprint와 upsert

**Files:**
- Create: `apps/api/src/lib/error-events.ts`
- Test: `apps/api/test/error-events.test.ts`

**Interfaces:**
- Consumes: `errorEvents` (Task 5), `sha256Hex` (Task 5), `db` (`src/db/client.ts`), `Env`
- Produces (`src/lib/error-events.ts`):
  - `MESSAGE_MAX = 500`, `PATH_MAX = 200`
  - `normalizeText(s: string): string` — UUID → `{uuid}`, `slugify()` 형식 slug(하이픈으로 이은 소문자·숫자 단어 + 6자 접미사) → `{slug}`, 숫자 → `{n}` 순서로 바꾼다. 꺾쇠(`<n>`)가 아니라 중괄호를 쓰는 이유: 이 값이 GitHub 이슈 마크다운에 실리는데 꺾쇠는 HTML 태그로 해석되어 사라지기 때문이다
  - `topFrames(stack: string | undefined, n?: number): string[]` — `at `으로 시작하는 줄 상위 n(기본 3)개, 끝의 `:줄:열`을 지운다(배포마다 줄 번호가 바뀌어 fingerprint가 달라지지 않게. 판정 후보 5)
  - `errorFingerprint(err: Error): Promise<string>` — `normalizeText("이름: 메시지")`와 `topFrames`를 줄바꿈으로 이은 문자열의 SHA-256 앞 16자
  - `recordError(env: Env, err: Error, pathname: string, now?: Date): Promise<void>` — fingerprint로 upsert. 새 행은 `count=1`, `first_seen=last_seen=now`, `message=normalizeText("이름: 메시지")` 앞 500자, `path=normalizeText(pathname)` 앞 200자. 같은 fingerprint면 `count+1`, `last_seen=now`만 바꾼다. 메시지·경로를 정규화해 저장하는 이유: 이 값이 퍼블릭 리포 이슈에 그대로 실리므로 숫자·ID·slug 같은 개별 값을 남기지 않기 위해서다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/error-events.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  errorFingerprint,
  normalizeText,
  recordError,
  topFrames,
} from "../src/lib/error-events";

const make = (message: string) => new Error(message);

describe("normalizeText", () => {
  it("replaces UUIDs, slugs and numbers", () => {
    expect(
      normalizeText(
        "article hello-world-ab12cd id 42 user 0b5e7a3c-1f2d-4e5f-8a9b-0c1d2e3f4a5b",
      ),
    ).toBe("article {slug} id {n} user {uuid}");
  });

  it("leaves ordinary words alone", () => {
    expect(normalizeText("UNIQUE constraint failed: users.email")).toBe(
      "UNIQUE constraint failed: users.email",
    );
  });
});

describe("topFrames", () => {
  it("keeps the top three frames without line and column", () => {
    const stack = [
      "Error: x",
      "    at a (file.js:10:5)",
      "    at b (file.js:20:7)",
      "    at file.js:30:9",
      "    at d (file.js:40:1)",
    ].join("\n");
    expect(topFrames(stack)).toEqual(["at a (file.js)", "at b (file.js)", "at file.js"]);
    expect(topFrames(undefined)).toEqual([]);
  });
});

describe("errorFingerprint", () => {
  it("is 16 hex chars and ignores numbers in the message", async () => {
    const a = await errorFingerprint(make("article 12 not found"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await errorFingerprint(make("article 99 not found"))).toBe(a);
    expect(await errorFingerprint(make("other failure"))).not.toBe(a);
  });

  it("differs when the error comes from a different place", async () => {
    const here = new Error("same");
    expect(await errorFingerprint(here)).not.toBe(await errorFingerprint(make("same")));
  });
});

describe("recordError", () => {
  it("upserts by fingerprint, counting repeats and keeping the first normalized message and path", async () => {
    const first = make("article 5 failed");
    const fp = await errorFingerprint(first);
    await recordError(env, first, "/api/articles/hello-ab12cd/comments/5", new Date("2026-10-12T00:00:00.000Z"));
    await recordError(env, make("article 6 failed"), "/api/other", new Date("2026-10-12T00:05:00.000Z"));
    const row = await env.DB.prepare(
      "SELECT fingerprint, message, path, count, first_seen, last_seen, acked_at FROM error_events WHERE fingerprint = ?",
    )
      .bind(fp)
      .first();
    expect(row).toEqual({
      fingerprint: fp,
      message: "Error: article {n} failed",
      path: "/api/articles/{slug}/comments/{n}",
      count: 2,
      first_seen: "2026-10-12T00:00:00.000Z",
      last_seen: "2026-10-12T00:05:00.000Z",
      acked_at: null,
    });
  });

  it("truncates long messages to 500 characters", async () => {
    const err = make("x".repeat(3000));
    await recordError(env, err, "/api/x");
    const row = await env.DB.prepare("SELECT message FROM error_events WHERE fingerprint = ?")
      .bind(await errorFingerprint(err))
      .first<{ message: string }>();
    expect(row?.message.length).toBe(500);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter api exec vitest run test/error-events.test.ts`
Expected: FAIL — `../src/lib/error-events`를 찾을 수 없다.

- [ ] **Step 3: 구현**

`apps/api/src/lib/error-events.ts`:
```ts
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { errorEvents } from "../db/schema";
import type { Env } from "../env";
import { sha256Hex } from "./hash";

export const MESSAGE_MAX = 500;
export const PATH_MAX = 200;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// slugify()(src/lib/slug.ts)가 만드는 형식: 하이픈으로 이은 소문자·숫자 단어 + 6자 접미사.
const SLUG = /\b[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}\b/g;
const NUMBER = /\d+/g;

export function normalizeText(s: string): string {
  return s.replace(UUID, "{uuid}").replace(SLUG, "{slug}").replace(NUMBER, "{n}");
}

// 배포마다 번들의 줄·열이 바뀌므로 위치는 지우고 함수·파일만 남긴다.
export function topFrames(stack: string | undefined, n = 3): string[] {
  return (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, n)
    .map((l) => l.replace(/:\d+:\d+(\)?)$/, "$1"));
}

export async function errorFingerprint(err: Error): Promise<string> {
  const head = normalizeText(`${err.name}: ${err.message}`);
  return (await sha256Hex([head, ...topFrames(err.stack)].join("\n"))).slice(0, 16);
}

// spec 7.1.3. 호출하는 쪽(onError)이 ctx.waitUntil로 넘기고 실패를 무시한다.
export async function recordError(
  env: Env,
  err: Error,
  pathname: string,
  now: Date = new Date(),
): Promise<void> {
  const ts = now.toISOString();
  await db(env)
    .insert(errorEvents)
    .values({
      fingerprint: await errorFingerprint(err),
      message: normalizeText(`${err.name}: ${err.message}`).slice(0, MESSAGE_MAX),
      path: normalizeText(pathname).slice(0, PATH_MAX),
      count: 1,
      firstSeen: ts,
      lastSeen: ts,
    })
    .onConflictDoUpdate({
      target: errorEvents.fingerprint,
      set: { count: sql`${errorEvents.count} + 1`, lastSeen: ts },
    });
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter api exec vitest run test/error-events.test.ts && pnpm --filter api typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
pnpm exec prettier --write apps/api/src/lib/error-events.ts apps/api/test/error-events.test.ts
git add apps/api/src/lib/error-events.ts apps/api/test/error-events.test.ts
git commit -m "feat(api): 에러 fingerprint와 error_events upsert

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: 익명 피드백 API와 IP 해시 레이트 리밋

**Files:**
- Create: `apps/api/src/routes/feedback.ts`
- Modify: `apps/api/src/index.ts`(라우터 연결)
- Test: `apps/api/test/feedback.test.ts`

**Interfaces:**
- Consumes: `feedback` 테이블 (Task 5), `sha256Hex`, `tooLong`, `rateLimited`, `invalid` (Task 5), `readWrapped`, `requireString` (`src/lib/body.ts`), `api()` (`test/helpers.ts`)
- Produces (`src/routes/feedback.ts`): `FEEDBACK_BODY_MAX = 2000`, `FEEDBACK_PATH_MAX = 200`, `FEEDBACK_LIMIT = 3`, `FEEDBACK_WINDOW_MS = 600_000`, `ipHash(ip: string, salt: string): Promise<string>`(= `sha256Hex(ip + salt)`), `feedbackRouter`
- HTTP: `POST /api/feedback`, 본문 `{"feedback": {"body": string, "path"?: string}}`. 본문은 앞뒤 공백을 지운 뒤 1-2000자, 경로는 200자 이하 문자열(없으면 `/`). 성공 201 `{"feedback": {"received": true}}`. 같은 IP 해시로 최근 10분 안에 3건이 있으면 429 `{"errors": {"feedback": ["too many requests"]}}`. IP는 `CF-Connecting-IP` 헤더, 없으면 `unknown`(같은 버킷). 솔트는 `INTAKE_TOKEN`(없으면 빈 문자열, 프리뷰·로컬). 인증 헤더는 읽지 않는다(익명).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/feedback.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ipHash } from "../src/routes/feedback";
import { api } from "./helpers";

const post = (body: unknown, ip?: string) =>
  api("/feedback", { method: "POST", body, headers: ip ? { "cf-connecting-ip": ip } : {} });
const valid = (text: string) => ({ feedback: { body: text, path: "/#/" } });

describe("POST /api/feedback", () => {
  it("stores feedback with an IP hash only and answers the 4th request in 10 minutes with 429", async () => {
    for (let i = 0; i < 3; i++) expect((await post(valid(`fb ${i}`), "203.0.113.7")).status).toBe(201);
    const fourth = await post(valid("fb 3"), "203.0.113.7");
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ errors: { feedback: ["too many requests"] } });
    expect((await post(valid("other ip"), "203.0.113.8")).status).toBe(201);
    const rows = await env.DB.prepare("SELECT * FROM feedback").all<Record<string, unknown>>();
    expect(JSON.stringify(rows.results)).not.toContain("203.0.113.7");
    const hash = await ipHash("203.0.113.7", env.INTAKE_TOKEN);
    expect(rows.results.filter((r) => r.ip_hash === hash)).toHaveLength(3);
  });

  it("forgets requests older than 10 minutes", async () => {
    const hash = await ipHash("198.51.100.9", env.INTAKE_TOKEN);
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await env.DB.batch(
      [0, 1, 2].map((i) =>
        env.DB.prepare(
          "INSERT INTO feedback (body, path, ip_hash, created_at) VALUES (?, '/', ?, ?)",
        ).bind(`old ${i}`, hash, old),
      ),
    );
    expect((await post(valid("new"), "198.51.100.9")).status).toBe(201);
  });

  it("puts requests without CF-Connecting-IP into one shared bucket", async () => {
    for (let i = 0; i < 3; i++) expect((await post(valid(`anon ${i}`))).status).toBe(201);
    expect((await post(valid("anon 3"))).status).toBe(429);
  });

  it("accepts exactly 2000 characters, trims the body and defaults the path to /", async () => {
    const res = await post({ feedback: { body: ` ${"가".repeat(2000)} ` } }, "192.0.2.1");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ feedback: { received: true } });
    const row = await env.DB.prepare("SELECT body, path FROM feedback WHERE ip_hash = ?")
      .bind(await ipHash("192.0.2.1", env.INTAKE_TOKEN))
      .first<{ body: string; path: string }>();
    expect(row).toEqual({ body: "가".repeat(2000), path: "/" });
  });

  it.each([
    [{ feedback: { body: "" } }, "body"],
    [{ feedback: { body: "   " } }, "body"],
    [{ feedback: { body: "x".repeat(2001) } }, "body"],
    [{ feedback: { body: "x", path: "/".repeat(201) } }, "path"],
    [{ feedback: { body: "x", path: 5 } }, "path"],
    [{ body: "x" }, "body"],
  ])("rejects %j with 422 on %s", async (body, field) => {
    const res = await post(body, "192.0.2.99");
    expect(res.status).toBe(422);
    expect(Object.keys(((await res.json()) as { errors: Record<string, unknown> }).errors)).toEqual([
      field,
    ]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter api exec vitest run test/feedback.test.ts`
Expected: FAIL — `../src/routes/feedback`를 찾을 수 없다.

- [ ] **Step 3: 구현**

`apps/api/src/routes/feedback.ts`:
```ts
import { and, count, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { feedback } from "../db/schema";
import type { AppEnv } from "../env";
import { readWrapped, requireString } from "../lib/body";
import { invalid, rateLimited, tooLong } from "../lib/errors";
import { sha256Hex } from "../lib/hash";

export const FEEDBACK_BODY_MAX = 2000;
export const FEEDBACK_PATH_MAX = 200;
export const FEEDBACK_LIMIT = 3;
export const FEEDBACK_WINDOW_MS = 10 * 60_000;

// spec 7.1.3: IP 원문은 저장하지 않는다. INTAKE_TOKEN을 솔트로 쓴 SHA-256만 저장한다.
export function ipHash(ip: string, salt: string): Promise<string> {
  return sha256Hex(`${ip}${salt}`);
}

export const feedbackRouter = new Hono<AppEnv>();

// 익명 피드백. Authorization 헤더는 읽지 않는다.
feedbackRouter.post("/feedback", async (c) => {
  const input = await readWrapped<{ body: unknown; path: unknown }>(c, "feedback");
  const body = requireString(input.body, "body").trim();
  if (body.length > FEEDBACK_BODY_MAX) throw tooLong("body", FEEDBACK_BODY_MAX);
  let path = "/";
  if (input.path !== undefined) {
    if (typeof input.path !== "string") throw invalid("path");
    if (input.path.length > FEEDBACK_PATH_MAX) throw tooLong("path", FEEDBACK_PATH_MAX);
    path = input.path || "/";
  }
  const now = new Date();
  const hash = await ipHash(c.req.header("cf-connecting-ip") ?? "unknown", c.env.INTAKE_TOKEN ?? "");
  const d = db(c.env);
  const since = new Date(now.getTime() - FEEDBACK_WINDOW_MS).toISOString();
  const recent = await d
    .select({ n: count() })
    .from(feedback)
    .where(and(eq(feedback.ipHash, hash), gt(feedback.createdAt, since)))
    .get();
  // 동시에 들어온 요청은 같은 수를 읽을 수 있다. 데모 범위에서 수용한다(README 보안 한계).
  if ((recent?.n ?? 0) >= FEEDBACK_LIMIT) throw rateLimited("feedback");
  await d.insert(feedback).values({ body, path, ipHash: hash, createdAt: now.toISOString() });
  return c.json({ feedback: { received: true } }, 201);
});
```
`apps/api/src/index.ts`에 import `import { feedbackRouter } from "./routes/feedback";`를 더하고, `router.route("/", tagsRouter);` 아래에 `router.route("/", feedbackRouter);`를 더한다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter api test && pnpm --filter api typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
pnpm exec prettier --write apps/api/src/routes/feedback.ts apps/api/src/index.ts apps/api/test/feedback.test.ts
git add apps/api/src/routes/feedback.ts apps/api/src/index.ts apps/api/test/feedback.test.ts
git commit -m "feat(api): 익명 피드백 POST /api/feedback와 IP 해시 레이트 리밋

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: 수집 엔드포인트 — INTAKE_TOKEN, 404 은닉, ack, 검증용 probe, onError 기록

**Files:**
- Create: `apps/api/src/middleware/intake.ts`, `apps/api/src/routes/intake.ts`
- Modify: `apps/api/src/index.ts`(라우터 연결, `onError`에서 `recordError`)
- Test: `apps/api/test/intake.test.ts`

**Interfaces:**
- Consumes: `errorEvents`, `feedback`, `ROUTE_NOT_FOUND`, `invalid` (Task 5), `recordError` (Task 6), `POST /api/feedback` (Task 7), `api()` (`test/helpers.ts`)
- Produces (`src/middleware/intake.ts`): `constantTimeEqual(a: string, b: string): Promise<boolean>`(두 값의 SHA-256 32바이트를 XOR 누적으로 비교), `requireIntakeToken: MiddlewareHandler<AppEnv>`(`Authorization: Bearer <토큰>`이 `INTAKE_TOKEN`과 같을 때만 통과. 토큰이 비어 있거나 헤더가 없거나 다르면 `ROUTE_NOT_FOUND` 404)
- Produces (`src/routes/intake.ts`): `INTAKE_PAGE = 25`, `ACK_MAX = 50`, `intakeRouter`
- HTTP:
  - `GET /api/_factory/intake` → `{"errors": [{fingerprint, message, path, count, firstSeen, lastSeen}], "feedback": [{id, body, path, createdAt}]}`. 에러는 `acked_at IS NULL OR last_seen > acked_at`(ack 뒤 다시 발생한 것 포함) 최대 25건, 피드백은 `acked_at IS NULL` 최대 25건(합계 50건, 판정 후보 7). `ip_hash`는 내보내지 않는다.
  - `POST /api/_factory/intake/ack` 본문 `{"errors": [16자 16진수], "feedback": [양의 정수]}`(각 50개 이하, 생략 가능) → 200 `{"acked": {"errors": n, "feedback": m}}`. 에러는 `acked_at = last_seen`, 피드백은 `acked_at = now`. 형식이 틀리면 토큰 검사 뒤 422.
  - `POST /api/_factory/intake/probe` → 토큰이 맞으면 의도적 예외 `Error("factory intake probe: deliberate error for intake verification")`로 500(onError가 기록). 라이브 검증용 오류 주입(판정 후보 4).
- `onError`: `ApiError`(4xx)와 UNIQUE 409는 기록하지 않는다. 그 밖의 예외는 500을 돌려주기 전에 `c.executionCtx.waitUntil(recordError(...).catch(() => undefined))`로 넘긴다. `executionCtx`가 없으면 기록하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/intake.test.ts`:
```ts
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { constantTimeEqual, requireIntakeToken } from "../src/middleware/intake";
import { api } from "./helpers";

const TOKEN = "test-intake-token";
const PROBE_PATH = "/api/_factory/intake/probe";
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

type ErrorRow = { fingerprint: string; message: string; path: string; count: number };
type Pending = {
  errors: (ErrorRow & { firstSeen: string; lastSeen: string })[];
  feedback: { id: number; body: string; path: string; createdAt: string }[];
};

// onError는 기록을 waitUntil로 넘긴다. 응답 뒤에 끝나므로 행이 생길 때까지 기다린다.
async function eventually<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for the error recorder");
}

const probeRow = (minCount: number) =>
  eventually(async () => {
    const row = await env.DB.prepare(
      "SELECT fingerprint, message, path, count FROM error_events WHERE path = ?",
    )
      .bind(PROBE_PATH)
      .first<ErrorRow>();
    return row && row.count >= minCount ? row : null;
  });
const probe = () => api("/_factory/intake/probe", { method: "POST", headers: auth() });
const pending = async () =>
  (await (await api("/_factory/intake", { headers: auth() })).json()) as Pending;

describe("intake endpoints", () => {
  it("answer exactly like an unknown route when the token is missing, wrong or malformed", async () => {
    const unknown = await api("/nope");
    const expected = { status: unknown.status, body: await unknown.json() };
    const variants: (Record<string, string> | undefined)[] = [
      undefined,
      auth("wrong"),
      auth(`${TOKEN}x`),
      { authorization: `Token ${TOKEN}` },
      { authorization: "Bearer " },
    ];
    const calls = [
      ["GET", "/_factory/intake", undefined],
      ["POST", "/_factory/intake/ack", { errors: [], feedback: [] }],
      ["POST", "/_factory/intake/probe", undefined],
    ] as const;
    for (const headers of variants) {
      for (const [method, path, body] of calls) {
        const res = await api(path, { method, headers, body });
        expect({ status: res.status, body: await res.json() }, `${method} ${path}`).toEqual(
          expected,
        );
      }
    }
  });

  it("let nothing through when the Worker has no INTAKE_TOKEN (preview, local)", async () => {
    const mini = new Hono<AppEnv>().get("/x", requireIntakeToken, (c) => c.text("ok"));
    const base = { DB: env.DB, JWT_SECRET: "x", ALLOWED_ORIGINS: "" };
    for (const authorization of ["Bearer ", "Bearer x", ""]) {
      const res = await mini.request("/x", { headers: { authorization } }, { ...base, INTAKE_TOKEN: "" });
      expect(res.status).toBe(404);
    }
    expect((await mini.request("/x", { headers: auth() }, base)).status).toBe(404);
    const ok = await mini.request("/x", { headers: auth() }, { ...base, INTAKE_TOKEN: TOKEN });
    expect(await ok.text()).toBe("ok");
  });

  it("compares tokens by value", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("records an unhandled error from onError and counts repeats under one fingerprint", async () => {
    const res = await probe();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ errors: { server: ["internal error"] } });
    const first = await probeRow(1);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(first.message).toBe(
      "Error: factory intake probe: deliberate error for intake verification",
    );
    await probe();
    expect((await probeRow(2)).fingerprint).toBe(first.fingerprint);
  });

  it("does not record RealWorld 4xx errors", async () => {
    expect((await api("/articles/ghost-slug")).status).toBe(404);
    expect((await api("/users", { method: "POST", rawBody: "{" })).status).toBe(422);
    await probe();
    await probeRow(1);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM error_events WHERE path <> ?")
      .bind(PROBE_PATH)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("lists pending errors and feedback without ip_hash, acks them, and lists an error again after it recurs", async () => {
    await probe();
    const fp = (await probeRow(1)).fingerprint;
    const sent = await api("/feedback", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.50" },
      body: { feedback: { body: "버튼이 안 눌려요", path: "/#/editor" } },
    });
    expect(sent.status).toBe(201);
    const list = await pending();
    expect(list.errors.find((e) => e.fingerprint === fp)).toMatchObject({
      count: 1,
      path: PROBE_PATH,
    });
    const item = list.feedback.find((f) => f.body === "버튼이 안 눌려요")!;
    expect(Object.keys(item).sort()).toEqual(["body", "createdAt", "id", "path"]);
    const ack = await api("/_factory/intake/ack", {
      method: "POST",
      headers: auth(),
      body: { errors: [fp], feedback: [item.id] },
    });
    expect(await ack.json()).toEqual({ acked: { errors: 1, feedback: 1 } });
    const after = await pending();
    expect(after.errors.map((e) => e.fingerprint)).not.toContain(fp);
    expect(after.feedback.map((f) => f.id)).not.toContain(item.id);
    await probe();
    await probeRow(2);
    expect((await pending()).errors.find((e) => e.fingerprint === fp)?.count).toBe(2);
  });

  it("returns at most 25 feedback items per call", async () => {
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 30 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO feedback (body, path, ip_hash, created_at) VALUES (?, '/', 'h', ?)",
        ).bind(`bulk ${i}`, now),
      ),
    );
    expect((await pending()).feedback).toHaveLength(25);
  });

  it("rejects malformed ack bodies with 422 once the token is valid", async () => {
    for (const body of [
      { errors: ["XYZ"] },
      { errors: Array.from({ length: 51 }, () => "0".repeat(16)) },
      { feedback: [0] },
      { feedback: ["1"] },
      [1],
    ]) {
      const res = await api("/_factory/intake/ack", { method: "POST", headers: auth(), body });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter api exec vitest run test/intake.test.ts`
Expected: FAIL — `../src/middleware/intake`를 찾을 수 없다.

- [ ] **Step 3: 구현**

`apps/api/src/middleware/intake.ts`:
```ts
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { ROUTE_NOT_FOUND } from "../lib/errors";

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// 길이가 같은 두 다이제스트를 바이트마다 XOR해 누적한다. 길이·일치 위치에 따라 비교 시간이 달라지지 않는다.
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// spec 7.1.3: 토큰이 없거나 다르면 알 수 없는 경로와 같은 404로 엔드포인트 존재를 드러내지 않는다.
// Worker에 INTAKE_TOKEN이 없으면(프리뷰·로컬) 어떤 요청도 통과하지 못한다.
export const requireIntakeToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.INTAKE_TOKEN ?? "";
  const m = BEARER.exec(c.req.header("authorization") ?? "");
  const ok = expected.length > 0 && m !== null && (await constantTimeEqual(m[1]!, expected));
  if (!ok) return c.json(ROUTE_NOT_FOUND, 404);
  await next();
};
```
`apps/api/src/routes/intake.ts`:
```ts
import { and, asc, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { errorEvents, feedback } from "../db/schema";
import type { AppEnv } from "../env";
import { invalid } from "../lib/errors";
import { requireIntakeToken } from "../middleware/intake";

export const INTAKE_PAGE = 25;
// D1은 쿼리당 바운드 파라미터 100개까지다. 목록당 50개로 제한한다.
export const ACK_MAX = 50;
const FINGERPRINT = /^[0-9a-f]{16}$/;

// 미들웨어는 라우트마다 붙인다. 이 라우터는 "/"에 붙으므로 use("*")를 쓰면 모든 /api 경로에 걸린다.
export const intakeRouter = new Hono<AppEnv>();

intakeRouter.get("/_factory/intake", requireIntakeToken, async (c) => {
  const d = db(c.env);
  const errors = await d
    .select()
    .from(errorEvents)
    .where(or(isNull(errorEvents.ackedAt), gt(errorEvents.lastSeen, errorEvents.ackedAt)))
    .orderBy(asc(errorEvents.lastSeen))
    .limit(INTAKE_PAGE);
  const items = await d
    .select()
    .from(feedback)
    .where(isNull(feedback.ackedAt))
    .orderBy(asc(feedback.id))
    .limit(INTAKE_PAGE);
  return c.json({
    errors: errors.map((e) => ({
      fingerprint: e.fingerprint,
      message: e.message,
      path: e.path,
      count: e.count,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
    })),
    feedback: items.map((f) => ({ id: f.id, body: f.body, path: f.path, createdAt: f.createdAt })),
  });
});

intakeRouter.post("/_factory/intake/ack", requireIntakeToken, async (c) => {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw invalid("body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("body");
  const { errors: fps = [], feedback: ids = [] } = parsed as { errors?: unknown; feedback?: unknown };
  if (
    !Array.isArray(fps) ||
    fps.length > ACK_MAX ||
    !fps.every((f): f is string => typeof f === "string" && FINGERPRINT.test(f))
  ) {
    throw invalid("errors");
  }
  if (
    !Array.isArray(ids) ||
    ids.length > ACK_MAX ||
    !ids.every((n): n is number => Number.isSafeInteger(n) && (n as number) > 0)
  ) {
    throw invalid("feedback");
  }
  const d = db(c.env);
  if (fps.length > 0) {
    // ack 이후 다시 발생하면 last_seen이 acked_at보다 커져 목록에 다시 나온다.
    await d
      .update(errorEvents)
      .set({ ackedAt: sql`${errorEvents.lastSeen}` })
      .where(inArray(errorEvents.fingerprint, fps));
  }
  if (ids.length > 0) {
    await d
      .update(feedback)
      .set({ ackedAt: new Date().toISOString() })
      .where(and(inArray(feedback.id, ids), isNull(feedback.ackedAt)));
  }
  return c.json({ acked: { errors: fps.length, feedback: ids.length } });
});

// 라이브 검증용 오류 주입(spec 7.1.4). 토큰이 맞을 때만 의도적 예외를 던지고, onError가 error_events에 기록한다.
intakeRouter.post("/_factory/intake/probe", requireIntakeToken, () => {
  throw new Error("factory intake probe: deliberate error for intake verification");
});
```
`apps/api/src/index.ts`를 고친다.
- import에 두 줄을 더한다: `import { recordError } from "./lib/error-events";`, `import { intakeRouter } from "./routes/intake";`
- `router.route("/", feedbackRouter);` 아래에 `router.route("/", intakeRouter);`를 더한다.
- `app.onError(...)` 전체를 다음으로 바꾼다:
```ts
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ errors: err.errors }, err.status);
  const msg = String((err as { cause?: unknown }).cause ?? err.message);
  const unique = /UNIQUE constraint failed: users\.(email|username)/.exec(msg);
  if (unique) return c.json({ errors: { [unique[1]!]: ["has already been taken"] } }, 409);
  console.error(err);
  // spec 7.1.3: 기록은 응답을 늦추지 않도록 waitUntil로 넘기고, 기록 실패는 무시한다.
  try {
    c.executionCtx.waitUntil(
      recordError(c.env, err, new URL(c.req.url).pathname).catch(() => undefined),
    );
  } catch {
    // ExecutionContext가 없는 실행에서는 기록하지 않는다.
  }
  return c.json({ errors: { server: ["internal error"] } }, 500);
});
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter api test && pnpm --filter api typecheck && pnpm --filter api build:check && scripts/realworld-api.sh`
Expected: PASS. RealWorld 스위트 결과가 변경 전과 같다(새 경로는 RealWorld 경로와 겹치지 않는다). 로컬에 `hurl`이 없으면 마지막 명령은 건너뛰고 PR의 `realworld-api` 체크로 확인한다.

- [ ] **Step 5: 커밋**

```bash
pnpm exec prettier --write apps/api/src apps/api/test/intake.test.ts
git add apps/api/src/middleware/intake.ts apps/api/src/routes/intake.ts apps/api/src/index.ts apps/api/test/intake.test.ts
git commit -m "feat(api): INTAKE_TOKEN 수집 엔드포인트(목록·ack·probe)와 onError 에러 기록

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: 웹 푸터의 "피드백" 버튼과 모달

**Files:**
- Create: `apps/web/src/components/Footer.tsx`, `apps/web/src/components/Footer.test.tsx`, `apps/web/e2e/feedback.spec.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `API_BASE`, `ApiFailure`, `createClient` (`src/api/client.ts`), `Errors` (`src/api/types.ts`), `ErrorList`, `AuthProvider`, `POST /api/feedback` (Task 7)
- Produces (`src/components/Footer.tsx`): `Footer()`(HashRouter 안에서 렌더링), `FEEDBACK_MAX = 2000`, `feedbackPath(pathname: string): string`(`"/#" + pathname`, 200자로 자름). 모달은 로그인 여부와 관계없이 토큰을 보내지 않는 별도 클라이언트로 `POST /feedback`을 호출한다. 화면 문자열: 버튼 `피드백`, 입력 placeholder `무엇이 불편했는지 알려 주세요`, 전송 `보내기`, 닫기 `닫기`, 완료 `피드백을 보냈습니다. 고맙습니다.`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/src/components/Footer.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { Footer, feedbackPath } from "./Footer";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Call = [RequestInfo | URL, RequestInit | undefined];

function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (String(input).endsWith("/user")) {
        const user = { email: "u@test.com", token: "jwt-1", username: "u", bio: null, image: null };
        return new Response(JSON.stringify({ user }), { status: 200 });
      }
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Footer />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const openModal = () => fireEvent.click(screen.getByRole("button", { name: "피드백" }));
const typeText = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText("무엇이 불편했는지 알려 주세요"), {
    target: { value: v },
  });

describe("Footer feedback", () => {
  it("sends anonymous feedback with the current hash path, without the login token", async () => {
    localStorage.setItem(`jwt:${API_BASE}`, "jwt-1");
    const calls = stubFetch(201, { feedback: { received: true } });
    renderAt("/article/abc");
    openModal();
    typeText("  좋아요  ");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByText("피드백을 보냈습니다. 고맙습니다.")).toBeInTheDocument();
    const [url, init] = calls.find(([u]) => String(u).endsWith("/feedback"))!;
    expect(String(url)).toBe(`${API_BASE}/feedback`);
    expect(JSON.parse(String(init?.body))).toEqual({
      feedback: { body: "좋아요", path: "/#/article/abc" },
    });
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("shows the server error when rate-limited", async () => {
    stubFetch(429, { errors: { feedback: ["too many requests"] } });
    renderAt("/");
    openModal();
    typeText("again");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByText("feedback too many requests")).toBeInTheDocument();
  });

  it("keeps 보내기 disabled for blank or over-long text and closes with 닫기", () => {
    stubFetch(201, {});
    renderAt("/");
    openModal();
    const send = screen.getByRole("button", { name: "보내기" });
    expect(send).toBeDisabled();
    typeText("   ");
    expect(send).toBeDisabled();
    typeText("x".repeat(2001));
    expect(send).toBeDisabled();
    typeText("ok");
    expect(send).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("caps the reported path at 200 characters", () => {
    expect(feedbackPath("/editor")).toBe("/#/editor");
    expect(feedbackPath(`/${"a".repeat(300)}`)).toHaveLength(200);
  });
});
```
`apps/web/e2e/feedback.spec.ts`(로컬 `wrangler dev`와 프리뷰 대상 E2E에서 돈다. 프로덕션 스모크에서는 돌지 않는다):
```ts
import { expect, test } from "@playwright/test";

test("anonymous feedback from the footer", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "피드백" }).click();
  await page.getByPlaceholder("무엇이 불편했는지 알려 주세요").fill(`e2e feedback ${Date.now()}`);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText("피드백을 보냈습니다. 고맙습니다.")).toBeVisible();
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter web exec vitest run src/components/Footer.test.tsx`
Expected: FAIL — `./Footer`를 찾을 수 없다.

- [ ] **Step 3: 구현**

`apps/web/src/components/Footer.tsx`:
```tsx
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useLocation } from "react-router";
import { API_BASE, ApiFailure, createClient } from "../api/client";
import type { Errors } from "../api/types";
import { ErrorList } from "./ErrorList";

export const FEEDBACK_MAX = 2000;
const PATH_MAX = 200;

// HashRouter 경로를 API가 받는 "/#/..." 형식으로 바꾼다(spec 7.1.3).
export function feedbackPath(pathname: string): string {
  return `/#${pathname}`.slice(0, PATH_MAX);
}

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const PANEL: CSSProperties = {
  background: "#fff",
  padding: "1.5rem",
  borderRadius: "4px",
  width: "min(90vw, 480px)",
};

export function Footer() {
  const [open, setOpen] = useState(false);
  return (
    <footer>
      <div className="container">
        <a href="#/" className="logo-font">
          conduit
        </a>
        <span className="attribution">소프트웨어 팩토리 데모</span>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary pull-xs-right"
          onClick={() => setOpen(true)}
        >
          피드백
        </button>
      </div>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </footer>
  );
}

function FeedbackModal({ onClose }: { onClose: () => void }) {
  // 익명 피드백이다. 로그인 토큰을 붙이지 않는 별도 클라이언트를 쓴다.
  const client = useMemo(() => createClient(API_BASE, () => null), []);
  const { pathname } = useLocation();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<Errors | null>(null);
  const length = body.trim().length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors(null);
    try {
      await client.post("/feedback", {
        feedback: { body: body.trim(), path: feedbackPath(pathname) },
      });
      setSent(true);
    } catch (err) {
      setErrors(err instanceof ApiFailure ? err.errors : { feedback: ["could not be sent"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="feedback-title" style={OVERLAY}>
      <div style={PANEL}>
        <h2 id="feedback-title">피드백</h2>
        {sent ? (
          <p>피드백을 보냈습니다. 고맙습니다.</p>
        ) : (
          <form onSubmit={submit}>
            <ErrorList errors={errors} />
            <fieldset className="form-group">
              <textarea
                className="form-control"
                rows={5}
                maxLength={FEEDBACK_MAX}
                placeholder="무엇이 불편했는지 알려 주세요"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </fieldset>
            <p>익명으로 보냅니다. 이름·이메일 같은 개인정보는 쓰지 마세요.</p>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || length === 0 || length > FEEDBACK_MAX}
            >
              보내기
            </button>
          </form>
        )}
        <button type="button" className="btn btn-outline-secondary" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
```
`apps/web/src/App.tsx`에 `import { Footer } from "./components/Footer";`를 더하고, `</Routes>` 바로 아래(같은 `HashRouter` 안)에 `<Footer />`를 넣는다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter web test && pnpm --filter web typecheck && pnpm --filter web e2e`
Expected: PASS. E2E는 기존 `smoke.spec.ts`와 새 `feedback.spec.ts` 두 개가 통과한다.

- [ ] **Step 5: 커밋**

```bash
pnpm exec prettier --write apps/web/src/components/Footer.tsx apps/web/src/components/Footer.test.tsx apps/web/src/App.tsx apps/web/e2e/feedback.spec.ts
git add apps/web/src/components/Footer.tsx apps/web/src/components/Footer.test.tsx apps/web/src/App.tsx apps/web/e2e/feedback.spec.ts
git commit -m "feat(web): 푸터 피드백 버튼과 익명 피드백 모달

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: 팩토리 `intake` 단계, 트리아지 예외, 유입 라벨

**Files:**
- Create: `packages/factory/src/stages/intake.ts`
- Modify: `packages/factory/src/stages/common.ts`(`stepRecord` 역할), `packages/factory/src/runs/store.ts`(`RunRole`), `packages/factory/src/stages/triage.ts`(prepare 조건), `packages/factory/src/stages/bootstrap.ts`(라벨 3개), `packages/factory/src/cli.ts`(`intake` 명령)
- Test: `packages/factory/test/intake.test.ts`, `packages/factory/test/triage.test.ts`, `packages/factory/test/bootstrap.test.ts`, `packages/factory/test/cli.test.ts`

**Interfaces:**
- Consumes: `GitHubPort.listOpenIssues`, `createIssue`, `comment` (`src/github/port.ts`), `cell`, `codeCell`, `demote`, `inline`, `readMarker`, `writeMarker` (`src/report/text.ts`), `isBot`, `record`, `runLink`, `stepRecord` (`src/stages/common.ts`), `implementStage` (`src/stages/implement.ts`)
- Produces (`src/stages/intake.ts`):
  - `INTAKE_MARKER = "factory:intake"`, `INTAKE_SOURCES = ["source:error", "source:feedback", "source:smoke"] as const`, `type IntakeKind = "error" | "feedback" | "smoke"`
  - `intakeMarker(kind: IntakeKind, key: string): string` — `<!-- factory:intake {"kind":"...","key":"..."} -->`
  - `findIntakeIssue(issues: Issue[], settings: Settings, kind: IntakeKind, key: string): Issue | null` — 봇이 연 열린 이슈(PR 제외) 중 본문의 마지막 유입 표식이 kind·key와 같은 첫 이슈
  - `IntakeResponseSchema`(zod), `type IntakeError`, `type IntakeFeedback`
  - `interface IntakeClient { pending(): Promise<unknown>; ack(input: { errors: string[]; feedback: number[] }): Promise<void> }`
  - `createIntakeClient(baseUrl: string, token: string, fetchImpl?: typeof fetch): IntakeClient` — `GET {base}/_factory/intake`, `POST {base}/_factory/intake/ack`, 헤더 `Authorization: Bearer <token>`. 오류 메시지에 토큰을 넣지 않는다.
  - `interface IntakeSummary { created: number[]; updated: number[]; acked: { errors: number; feedback: number }; failed: number }`
  - `runIntake(deps: StageDeps, client: IntakeClient): Promise<IntakeSummary>` — 응답이 스키마에 맞지 않으면 예외(이슈도 ack도 없음). 항목별로 이슈 생성·코멘트에 성공한 것만 ack한다.
  - `renderErrorIssue(e: IntakeError, settings: Settings)`, `renderFeedbackIssue(f: IntakeFeedback, settings: Settings)` — `{ title: string; body: string }`
- Produces (`src/stages/common.ts`, `src/runs/store.ts`): `stepRecord`의 role과 `RunRole`에 `"intake" | "smoke"` 추가
- 트리아지 규칙: 봇이 연 이슈는 건너뛰되, `INTAKE_SOURCES` 라벨이 하나라도 있으면 트리아지한다(spec 7.1.3).
- 라벨: `source:error`, `source:feedback`, `source:smoke`(bootstrap 라벨 24개 → 27개)
- CLI: `pnpm -s factory intake` — env `INTAKE_URL`(예: `https://sfd-api.roboco.workers.dev/api`), `INTAKE_TOKEN`, `FACTORY_TOKEN`. 둘 중 하나라도 없으면 종료 코드 2. 실패 항목이 있으면 1.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/factory/test/intake.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  createIntakeClient,
  findIntakeIssue,
  runIntake,
  type IntakeClient,
} from "../src/stages/intake";
import { BOT, makeTestDeps } from "./helpers";

const FP = "0123456789abcdef";
const error = (over: Record<string, unknown> = {}) => ({
  fingerprint: FP,
  message: "Error: article {n} failed",
  path: "/api/articles/{slug}",
  count: 1,
  firstSeen: "2026-10-12T00:00:00.000Z",
  lastSeen: "2026-10-12T00:00:00.000Z",
  ...over,
});
const fb = (over: Record<string, unknown> = {}) => ({
  id: 7,
  body: "버튼이 안 눌려요",
  path: "/#/editor",
  createdAt: "2026-10-12T00:01:00.000Z",
  ...over,
});

function fake(payload: unknown) {
  const acks: { errors: string[]; feedback: number[] }[] = [];
  const client: IntakeClient = {
    pending: async () => payload,
    ack: async (input) => {
      acks.push(input);
    },
  };
  return { client, acks };
}

describe("runIntake", () => {
  it("opens a source:error + type:bug issue with the fingerprint marker and acks it", async () => {
    const h = makeTestDeps();
    const { client, acks } = fake({ errors: [error()], feedback: [] });
    expect(await runIntake(h.deps, client)).toEqual({
      created: [1],
      updated: [],
      acked: { errors: 1, feedback: 0 },
      failed: 0,
    });
    const issue = await h.gh.getIssue(1);
    expect(issue.author).toBe(BOT);
    expect(issue.labels).toEqual(["source:error", "type:bug"]);
    expect(issue.title).toBe("[에러] Error: article {n} failed");
    expect(issue.body).toContain(`<!-- factory:intake {"kind":"error","key":"${FP}"} -->`);
    expect(issue.body).toContain("> Error: article {n} failed");
    expect(acks).toEqual([{ errors: [FP], feedback: [] }]);
    expect(await h.deps.runs.since(new Date(0))).toMatchObject([
      { role: "intake", issue: 1, ok: true },
    ]);
  });

  it("comments the new count on the open issue when the same fingerprint comes back", async () => {
    const h = makeTestDeps();
    await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client);
    const again = fake({
      errors: [error({ count: 3, lastSeen: "2026-10-12T01:00:00.000Z" })],
      feedback: [],
    });
    expect(await runIntake(h.deps, again.client)).toMatchObject({ created: [], updated: [1] });
    expect(h.gh.issues.size).toBe(1);
    expect((await h.gh.listComments(1)).at(-1)?.body).toContain("누적 3회");
    expect(again.acks).toEqual([{ errors: [FP], feedback: [] }]);
  });

  it("opens a new issue when the earlier issue for the fingerprint was closed (regression)", async () => {
    const h = makeTestDeps();
    await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client);
    await h.gh.closeIssue(1);
    const again = await runIntake(h.deps, fake({ errors: [error({ count: 2 })], feedback: [] }).client);
    expect(again.created).toEqual([2]);
  });

  it("ignores a look-alike marker in an issue a human opened", async () => {
    const h = makeTestDeps();
    h.gh.addIssue({
      title: "fake",
      author: "outsider",
      body: `<!-- factory:intake {"kind":"error","key":"${FP}"} -->`,
    });
    expect((await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client)).created).toEqual([2]);
    expect(await h.gh.listComments(1)).toEqual([]);
  });

  it("opens one source:feedback issue per item with mentions, close keywords and markers neutralized", async () => {
    const h = makeTestDeps();
    const body = `@serithemage fixes #1 <!-- factory:intake {"kind":"error","key":"${FP}"} --> 좋아요`;
    const { client, acks } = fake({
      errors: [],
      feedback: [fb({ body }), fb({ id: 8, body: "두 번째" })],
    });
    expect((await runIntake(h.deps, client)).created).toEqual([1, 2]);
    const issue = await h.gh.getIssue(1);
    expect(issue.labels).toEqual(["source:feedback"]);
    expect(issue.title.startsWith("[피드백] @‍serithemage")).toBe(true);
    expect(issue.body).not.toContain("@serithemage");
    expect(issue.body).not.toMatch(/fixes #1/);
    expect(findIntakeIssue([issue], h.deps.settings, "error", FP)).toBeNull();
    expect(findIntakeIssue([issue], h.deps.settings, "feedback", "7")?.number).toBe(1);
    expect(acks).toEqual([{ errors: [], feedback: [7, 8] }]);
  });

  it("reuses the open feedback issue when the same id comes back after a failed ack", async () => {
    const h = makeTestDeps();
    const failing: IntakeClient = {
      pending: async () => ({ errors: [], feedback: [fb()] }),
      ack: async () => {
        throw new Error("ack failed");
      },
    };
    await expect(runIntake(h.deps, failing)).rejects.toThrow("ack failed");
    const { client, acks } = fake({ errors: [], feedback: [fb()] });
    expect((await runIntake(h.deps, client)).created).toEqual([]);
    expect(h.gh.issues.size).toBe(1);
    expect(acks).toEqual([{ errors: [], feedback: [7] }]);
  });

  it("does not ack an item whose issue could not be created", async () => {
    const h = makeTestDeps();
    const create = h.gh.createIssue.bind(h.gh);
    let calls = 0;
    h.gh.createIssue = async (title, body, labels) => {
      calls++;
      if (calls === 1) throw new Error("GitHub 502");
      return create(title, body, labels);
    };
    const { client, acks } = fake({ errors: [error()], feedback: [fb()] });
    expect(await runIntake(h.deps, client)).toMatchObject({ created: [1], failed: 1 });
    expect(acks).toEqual([{ errors: [], feedback: [7] }]);
  });

  it.each([
    ["bad fingerprint", { errors: [error({ fingerprint: "XYZ" })], feedback: [] }],
    ["too many items", { errors: [], feedback: Array.from({ length: 51 }, (_, i) => fb({ id: i + 1 })) }],
    ["oversized body", { errors: [], feedback: [fb({ body: "x".repeat(2001) })] }],
    ["not an object", "<html>"],
  ])("fails closed on a malformed response (%s): no issues, no ack", async (_name, payload) => {
    const h = makeTestDeps();
    const { client, acks } = fake(payload);
    await expect(runIntake(h.deps, client)).rejects.toThrow(/intake 응답 형식/);
    expect(h.gh.issues.size).toBe(0);
    expect(acks).toEqual([]);
  });
});

describe("createIntakeClient", () => {
  it("sends the bearer token to both endpoints and keeps it out of error messages", async () => {
    const seen: { url: string; auth: string | null; method: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        method: init?.method ?? "GET",
      });
      return String(input).endsWith("/ack")
        ? new Response("{}", { status: 200 })
        : new Response("nope", { status: 404 });
    }) as typeof fetch;
    const c = createIntakeClient("https://api.test/api/", "s3cret-token", fetchImpl);
    const err = (await c.pending().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("404");
    expect(err.message).not.toContain("s3cret-token");
    await c.ack({ errors: [FP], feedback: [] });
    expect(seen).toEqual([
      { url: "https://api.test/api/_factory/intake", auth: "Bearer s3cret-token", method: "GET" },
      {
        url: "https://api.test/api/_factory/intake/ack",
        auth: "Bearer s3cret-token",
        method: "POST",
      },
    ]);
  });
});
```
`packages/factory/test/triage.test.ts`의 `describe("triage stage", ...)` 안에 추가한다(위 import에 `import { implementStage } from "../src/stages/implement";`를 더한다):
```ts
  it("triages bot-opened intake issues (source:*) and still needs @factory go to implement", async () => {
    const pi = createFakeAdapter(loadFakeScript("triage-feature"), "pi");
    const h = makeTestDeps({ adapters: { pi } });
    const issue = h.gh.addIssue({
      title: "[에러] Error: x",
      author: BOT,
      labels: ["source:error", "type:bug"],
    });
    await runPhase(triageStage, "all", h.deps, { issue: issue.number }, null);
    expect(pi.calls).toHaveLength(1);
    expect((await h.gh.getIssue(issue.number)).labels).toContain("factory:triaged");
    expect(await implementStage.prepare(h.deps, { issue: issue.number })).toBeNull();
    expect((await h.gh.getIssue(issue.number)).labels).not.toContain("factory:in-progress");
  });

  it("keeps skipping bot issues without an intake source label", async () => {
    const pi = createFakeAdapter([], "pi");
    const h = makeTestDeps({ adapters: { pi } });
    const deploy = h.gh.addIssue({ title: "d", author: BOT, labels: ["source:deploy"] });
    await runPhase(triageStage, "all", h.deps, { issue: deploy.number }, null);
    expect(pi.calls).toHaveLength(0);
  });
```
`packages/factory/test/bootstrap.test.ts`에서 `labels: 24`를 `labels: 27`로, `toBe(24)`를 `toBe(27)`로 바꾸고, 확인 목록 배열 끝에 `"source:error"`, `"source:feedback"`, `"source:smoke"`를 더한다.

`packages/factory/test/cli.test.ts`의 `describe("cli main", ...)` 안에 추가한다:
```ts
  it("intake requires INTAKE_URL and INTAKE_TOKEN", async () => {
    const h = makeTestDeps();
    for (const env of [{}, { INTAKE_URL: "https://x/api" }, { INTAKE_TOKEN: "t" }, { INTAKE_URL: "ftp://x", INTAKE_TOKEN: "t" }]) {
      const out: string[] = [];
      expect(await main(["intake"], { ...context(h, [], out), env })).toBe(2);
      expect(out[0]).toContain("INTAKE_URL");
    }
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/intake.test.ts test/triage.test.ts test/bootstrap.test.ts test/cli.test.ts`
Expected: FAIL — `../src/stages/intake`가 없고, 봇 유입 이슈가 트리아지되지 않으며, 라벨이 24개다.

- [ ] **Step 3: 구현**

`packages/factory/src/runs/store.ts`의 `RunRole`을 다음으로 바꾼다:
```ts
export type RunRole = Role | "command" | "gate" | "deploy" | "intake" | "smoke";
```
`packages/factory/src/stages/common.ts`의 `stepRecord` 첫 매개변수 타입을 `role: "command" | "gate" | "deploy" | "intake" | "smoke",`로 바꾼다.

`packages/factory/src/stages/intake.ts`:
```ts
import { z } from "zod";
import type { Issue } from "../github/port";
import { cell, codeCell, demote, inline, readMarker, writeMarker } from "../report/text";
import { isBot, record, runLink, stepRecord } from "./common";
import type { Settings, StageDeps } from "./deps";

export const INTAKE_MARKER = "factory:intake";
export const INTAKE_SOURCES = ["source:error", "source:feedback", "source:smoke"] as const;

const IntakeKeySchema = z.object({
  kind: z.enum(["error", "feedback", "smoke"]),
  key: z.string().min(1).max(100),
});
export type IntakeKind = z.infer<typeof IntakeKeySchema>["kind"];

export function intakeMarker(kind: IntakeKind, key: string): string {
  return writeMarker(INTAKE_MARKER, { kind, key });
}

// 사람이 연 이슈의 표식은 믿지 않는다. 봇이 연 열린 이슈만 본다.
export function findIntakeIssue(
  issues: Issue[],
  settings: Settings,
  kind: IntakeKind,
  key: string,
): Issue | null {
  for (const i of issues) {
    if (i.isPullRequest || i.state !== "open" || !isBot(settings, i.author)) continue;
    const m = readMarker(i.body, INTAKE_MARKER, IntakeKeySchema);
    if (m && m.kind === kind && m.key === key) return i;
  }
  return null;
}

const Timestamp = z.string().max(40);
// API 응답은 신뢰하지 않는다. 형식이 틀리면 아무 이슈도 만들지 않고 ack도 하지 않는다.
export const IntakeResponseSchema = z.object({
  errors: z
    .array(
      z.object({
        fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
        message: z.string().max(2000),
        path: z.string().max(200),
        count: z.number().int().positive(),
        firstSeen: Timestamp,
        lastSeen: Timestamp,
      }),
    )
    .max(50),
  feedback: z
    .array(
      z.object({
        id: z.number().int().positive(),
        body: z.string().min(1).max(2000),
        path: z.string().max(200),
        createdAt: Timestamp,
      }),
    )
    .max(50),
});
export type IntakeError = z.infer<typeof IntakeResponseSchema>["errors"][number];
export type IntakeFeedback = z.infer<typeof IntakeResponseSchema>["feedback"][number];

export interface IntakeClient {
  pending(): Promise<unknown>;
  ack(input: { errors: string[]; feedback: number[] }): Promise<void>;
}

export function createIntakeClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): IntakeClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async pending() {
      const res = await fetchImpl(`${base}/_factory/intake`, { headers });
      if (!res.ok) {
        throw new Error(
          `intake 목록 요청이 HTTP ${res.status}로 실패했다(404는 INTAKE_TOKEN 불일치일 수 있다)`,
        );
      }
      const parsed: unknown = await res.json();
      return parsed;
    },
    async ack(input) {
      const res = await fetchImpl(`${base}/_factory/intake/ack`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`intake ack 요청이 HTTP ${res.status}로 실패했다`);
    },
  };
}

function short(s: string, max: number): string {
  const t = inline(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const GO_NOTE = "구현은 리포 쓰기 권한자의 `@factory go`가 있어야 시작한다.";

export function renderErrorIssue(e: IntakeError, settings: Settings): { title: string; body: string } {
  return {
    title: `[에러] ${short(e.message, 80) || e.fingerprint}`,
    body: [
      "프로덕션 API에서 처리되지 않은 예외가 기록되었다. 아래 값은 Worker가 기록한 것이며 신뢰할 수 없는 입력으로 다룬다. 메시지와 경로의 숫자·UUID·slug는 `{n}`·`{uuid}`·`{slug}`로 정규화되어 있다.",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      `| fingerprint | \`${e.fingerprint}\` |`,
      `| 경로 | \`${codeCell(e.path)}\` |`,
      `| 발생 횟수 | ${e.count} |`,
      `| 처음 발생 | ${cell(e.firstSeen)} |`,
      `| 마지막 발생 | ${cell(e.lastSeen)} |`,
      "",
      "대표 메시지:",
      "",
      demote(e.message || "(메시지 없음)"),
      "",
      `같은 fingerprint의 에러가 다시 기록되면 새 이슈 대신 이 이슈에 코멘트로 횟수를 갱신한다. ${GO_NOTE}${runLink(settings)}`,
      "",
      intakeMarker("error", e.fingerprint),
    ].join("\n"),
  };
}

export function renderErrorRepeat(e: IntakeError, settings: Settings): string {
  return `같은 에러(fingerprint \`${e.fingerprint}\`)가 다시 기록되었다. 누적 ${e.count}회, 마지막 발생 ${cell(e.lastSeen)}.${runLink(settings)}`;
}

export function renderFeedbackIssue(
  f: IntakeFeedback,
  settings: Settings,
): { title: string; body: string } {
  return {
    title: `[피드백] ${short(f.body, 60) || `#${f.id}`}`,
    body: [
      "앱 푸터의 피드백 버튼으로 익명 사용자가 보낸 의견이다. 본문은 신뢰할 수 없는 입력으로 다룬다. API는 IP 원문을 저장하지 않는다.",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      `| 피드백 ID | ${f.id} |`,
      `| 화면 경로 | \`${codeCell(f.path)}\` |`,
      `| 받은 시각 | ${cell(f.createdAt)} |`,
      "",
      "본문:",
      "",
      demote(f.body),
      "",
      `${GO_NOTE}${runLink(settings)}`,
      "",
      intakeMarker("feedback", String(f.id)),
    ].join("\n"),
  };
}

export interface IntakeSummary {
  created: number[];
  updated: number[];
  acked: { errors: number; feedback: number };
  failed: number;
}

export async function runIntake(deps: StageDeps, client: IntakeClient): Promise<IntakeSummary> {
  const parsed = IntakeResponseSchema.safeParse(await client.pending());
  if (!parsed.success) {
    throw new Error(`intake 응답 형식이 틀렸다(문제 ${parsed.error.issues.length}개). 아무것도 처리하지 않는다.`);
  }
  const open = await deps.gh.listOpenIssues();
  const summary: IntakeSummary = {
    created: [],
    updated: [],
    acked: { errors: 0, feedback: 0 },
    failed: 0,
  };
  const ack = { errors: [] as string[], feedback: [] as number[] };
  const create = async (issue: { title: string; body: string }, labels: string[]) => {
    const n = await deps.gh.createIssue(issue.title, issue.body, labels);
    open.push({
      number: n,
      title: issue.title,
      body: issue.body,
      author: deps.settings.botLogin,
      labels,
      state: "open",
      isPullRequest: false,
    });
    summary.created.push(n);
    await record(deps, stepRecord("intake", n, null, true));
  };
  for (const e of parsed.data.errors) {
    try {
      const existing = findIntakeIssue(open, deps.settings, "error", e.fingerprint);
      if (existing) {
        await deps.gh.comment(existing.number, renderErrorRepeat(e, deps.settings));
        summary.updated.push(existing.number);
        await record(deps, stepRecord("intake", existing.number, null, true));
      } else {
        await create(renderErrorIssue(e, deps.settings), ["source:error", "type:bug"]);
      }
      ack.errors.push(e.fingerprint);
    } catch (err) {
      summary.failed++;
      deps.log(`intake: error ${e.fingerprint} 처리 실패, ack하지 않는다: ${String(err)}`);
    }
  }
  for (const f of parsed.data.feedback) {
    try {
      // 이전 실행이 이슈를 만든 뒤 ack에 실패했다면 같은 피드백이 다시 온다. 열린 이슈를 재사용한다.
      if (!findIntakeIssue(open, deps.settings, "feedback", String(f.id))) {
        await create(renderFeedbackIssue(f, deps.settings), ["source:feedback"]);
      }
      ack.feedback.push(f.id);
    } catch (err) {
      summary.failed++;
      deps.log(`intake: feedback ${f.id} 처리 실패, ack하지 않는다: ${String(err)}`);
    }
  }
  if (ack.errors.length + ack.feedback.length > 0) {
    await client.ack(ack);
    summary.acked = { errors: ack.errors.length, feedback: ack.feedback.length };
  }
  return summary;
}
```
`packages/factory/src/stages/triage.ts`를 고친다. import에 `import { INTAKE_SOURCES } from "./intake";`를 더하고, prepare의 첫 조건문을 다음으로 바꾼다:
```ts
    // 봇이 연 이슈(차단기 알림 등)는 건너뛴다. 단 유입 이슈(source:error|feedback|smoke)는 트리아지한다(spec 7.1.3).
    const intake = info.labels.some((l) => (INTAKE_SOURCES as readonly string[]).includes(l));
    if (
      info.isPullRequest ||
      info.state !== "open" ||
      (isBot(deps.settings, info.author) && !intake)
    ) {
      return null;
    }
```
`packages/factory/src/stages/bootstrap.ts`의 `LABELS` 배열 끝(`source:deploy` 항목 뒤)에 추가한다:
```ts
  {
    name: "source:error",
    color: "d93f0b",
    description: "프로덕션 에러 유입(factory-intake). 트리아지 후 @factory go로 착수",
  },
  {
    name: "source:feedback",
    color: "d93f0b",
    description: "앱 내 익명 피드백 유입(factory-intake). 트리아지 후 @factory go로 착수",
  },
  {
    name: "source:smoke",
    color: "d93f0b",
    description: "프로덕션 스모크 실패 유입(factory-smoke). 트리아지 후 @factory go로 착수",
  },
```
`packages/factory/src/cli.ts`를 고친다. import에 `import { createIntakeClient, runIntake } from "./stages/intake";`를 더하고, `COMMANDS`의 `"evidence-run"` 항목 아래에 추가한다:
```ts
  intake: async (ctx) => {
    const url = ctx.env.INTAKE_URL ?? "";
    const token = ctx.env.INTAKE_TOKEN ?? "";
    if (!/^https?:\/\/\S+$/.test(url) || token.length === 0) {
      throw new UsageError("INTAKE_URL(http(s)://...)과 INTAKE_TOKEN 환경변수가 필요하다");
    }
    const summary = await runIntake(ctx.buildDeps(ctx.env, "all"), createIntakeClient(url, token));
    ctx.stdout(JSON.stringify(summary));
    return summary.failed > 0 ? 1 : 0;
  },
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm --filter factory test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
pnpm exec prettier --write packages/factory/src packages/factory/test
git add packages/factory/src/stages/intake.ts packages/factory/src/stages/common.ts packages/factory/src/runs/store.ts packages/factory/src/stages/triage.ts packages/factory/src/stages/bootstrap.ts packages/factory/src/cli.ts packages/factory/test/intake.test.ts packages/factory/test/triage.test.ts packages/factory/test/bootstrap.test.ts packages/factory/test/cli.test.ts
git commit -m "feat(factory): intake 단계(에러·피드백 → 이슈), 유입 이슈 트리아지 예외, source 라벨

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: 스모크 — 읽기 전용 검사 파일과 `smoke-report` 단계

**Files:**
- Create: `tests/smoke/readonly.hurl`, `apps/web/e2e-smoke/playwright.config.ts`, `apps/web/e2e-smoke/home.spec.ts`, `packages/factory/src/stages/smoke.ts`
- Modify: `apps/web/tsconfig.json`(`include`에 `"e2e-smoke"`), `packages/factory/src/cli.ts`(`smoke-report` 명령)
- Test: `packages/factory/test/smoke.test.ts`, `packages/factory/test/cli.test.ts`

**Interfaces:**
- Consumes: `findIntakeIssue`, `intakeMarker` (Task 10), `readMarker`, `writeMarker`, `codeCell` (`src/report/text.ts`), `isBot`, `record`, `runLink`, `stepRecord` (Task 10에서 `"smoke"` 역할 추가), `REPO_ROOT` (`src/paths.ts`)
- Produces (`src/stages/smoke.ts`):
  - `SMOKE_MARKER = "factory:smoke"`, `SMOKE_KEY = "production"`, `type SmokeStatus = "failing" | "recovered"`, `type SmokeAction = "created" | "commented" | "recovered" | "none"`
  - `smokeStatus(issue: Issue, comments: Comment[], settings: Settings): SmokeStatus` — 이슈 본문과 봇 코멘트의 마지막 `factory:smoke` 표식
  - `runSmokeReport(deps: StageDeps, args: { result: "success" | "failure" }): Promise<{ action: SmokeAction; issue: number | null }>` — 실패: 열린 스모크 이슈가 없으면 `source:smoke` 이슈 생성, 있으면 실패 코멘트. 성공: 열린 스모크 이슈의 상태가 `failing`일 때만 "복구됨" 코멘트. 이슈를 닫지 않는다(사람이 정한다). 검사 대상이 바뀐 경우(env `SMOKE_API_BASE`) 그 값을 코멘트에 적는다.
- CLI: `pnpm -s factory smoke-report --result success|failure` — 다른 값이면 종료 코드 2.
- 스모크 파일: Hurl 변수 `api`(예: `https://sfd-api.roboco.workers.dev/api`), Playwright env `E2E_BASE_URL`(필수). 둘 다 읽기 요청만 보낸다.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/factory/test/smoke.test.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/paths";
import { runSmokeReport } from "../src/stages/smoke";
import { BOT, makeTestDeps } from "./helpers";

describe("runSmokeReport", () => {
  it("opens one source:smoke issue on the first failure and comments on the next failure", async () => {
    const h = makeTestDeps();
    expect(await runSmokeReport(h.deps, { result: "failure" })).toEqual({
      action: "created",
      issue: 1,
    });
    const issue = await h.gh.getIssue(1);
    expect(issue.author).toBe(BOT);
    expect(issue.labels).toEqual(["source:smoke"]);
    expect(issue.body).toContain('<!-- factory:intake {"kind":"smoke","key":"production"} -->');
    expect(await runSmokeReport(h.deps, { result: "failure" })).toEqual({
      action: "commented",
      issue: 1,
    });
    expect(h.gh.issues.size).toBe(1);
    expect(await h.deps.runs.since(new Date(0))).toMatchObject([
      { role: "smoke", issue: 1, ok: false, failureReason: "smoke_failed" },
      { role: "smoke", issue: 1, ok: false, failureReason: "smoke_failed" },
    ]);
  });

  it("comments 복구됨 once after a failure and stays quiet on further successes", async () => {
    const h = makeTestDeps();
    await runSmokeReport(h.deps, { result: "failure" });
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "recovered",
      issue: 1,
    });
    expect((await h.gh.listComments(1)).at(-1)?.body.startsWith("복구됨")).toBe(true);
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "none",
      issue: 1,
    });
    expect(await h.gh.listComments(1)).toHaveLength(1);
  });

  it("leaves one comment per transition when failures and recoveries alternate", async () => {
    const h = makeTestDeps();
    for (const result of ["failure", "success", "failure", "success", "success"] as const) {
      await runSmokeReport(h.deps, { result });
    }
    const bodies = (await h.gh.listComments(1)).map((c) => c.body.split(":")[0]);
    expect(bodies).toHaveLength(3);
    expect((await h.gh.listComments(1)).map((c) => c.body.startsWith("복구됨"))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("does nothing on success when no smoke issue is open", async () => {
    const h = makeTestDeps();
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "none",
      issue: null,
    });
    expect(h.gh.issues.size).toBe(0);
  });

  it("ignores a human issue that carries the smoke markers", async () => {
    const h = makeTestDeps();
    h.gh.addIssue({
      title: "fake",
      author: "outsider",
      body: '<!-- factory:smoke {"status":"failing"} -->\n<!-- factory:intake {"kind":"smoke","key":"production"} -->',
    });
    expect(await runSmokeReport(h.deps, { result: "success" })).toEqual({
      action: "none",
      issue: null,
    });
    expect((await runSmokeReport(h.deps, { result: "failure" })).issue).toBe(2);
  });

  it("names the injected target from SMOKE_API_BASE", async () => {
    const h = makeTestDeps({
      settings: { env: { SMOKE_API_BASE: "https://sfd-api.roboco.workers.dev/api/__smoke_injected_failure" } },
    });
    await runSmokeReport(h.deps, { result: "failure" });
    expect((await h.gh.getIssue(1)).body).toContain(
      "`https://sfd-api.roboco.workers.dev/api/__smoke_injected_failure`",
    );
  });
});

describe("production smoke files", () => {
  it("send only read requests and never fill or submit forms", () => {
    const hurl = readFileSync(path.join(REPO_ROOT, "tests/smoke/readonly.hurl"), "utf8");
    const methods = hurl
      .split("\n")
      .map((l) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/.exec(l)?.[1])
      .filter((m): m is string => m !== undefined);
    expect(methods).toEqual(["GET", "GET", "GET"]);
    const spec = readFileSync(path.join(REPO_ROOT, "apps/web/e2e-smoke/home.spec.ts"), "utf8");
    expect(spec).not.toMatch(/\.fill\(|\.click\(|\.press\(|request\.(post|put|patch|delete)/);
  });
});
```
`packages/factory/test/cli.test.ts`의 `describe("cli main", ...)` 안에 추가한다:
```ts
  it("smoke-report accepts only success|failure and reports the action", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    expect(await main(["smoke-report", "--result", "cancelled"], context(h, [], out))).toBe(2);
    expect(await main(["smoke-report", "--result", "failure"], context(h, [], out))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({ action: "created", issue: 1 });
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/smoke.test.ts test/cli.test.ts`
Expected: FAIL — `../src/stages/smoke`가 없고 스모크 파일이 없다.

- [ ] **Step 3: 스모크 파일 작성**

`tests/smoke/readonly.hurl`:
```
# 프로덕션 읽기 전용 스모크(spec 7.1.3). 데이터를 만들거나 바꾸는 요청을 넣지 않는다.
# 실행: hurl --test --variable "api=https://sfd-api.roboco.workers.dev/api" tests/smoke/readonly.hurl
GET {{api}}/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"

GET {{api}}/articles?limit=1
HTTP 200
[Asserts]
jsonpath "$.articlesCount" isInteger
jsonpath "$.articles" isCollection

GET {{api}}/tags
HTTP 200
[Asserts]
jsonpath "$.tags" isCollection
```
`apps/web/e2e-smoke/playwright.config.ts`:
```ts
import { defineConfig, devices } from "@playwright/test";

// 프로덕션 읽기 전용 스모크 전용 설정. 로컬 서버를 띄우지 않고 E2E_BASE_URL만 검사한다.
const raw = process.env.E2E_BASE_URL;
if (!raw) throw new Error("E2E_BASE_URL is required for the production smoke");
const baseURL = raw.endsWith("/") ? raw : `${raw}/`;

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 1,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```
`apps/web/e2e-smoke/home.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

// 읽기 전용: 페이지를 열고 보기만 한다. 입력·클릭·전송을 하지 않는다.
test("home renders the article list from the production API", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "conduit" })).toBeVisible();
  await expect(page.getByText("Global Feed")).toBeVisible();
  await expect(page.getByText("Loading articles...")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".error-messages")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "피드백" })).toBeVisible();
});
```
`apps/web/tsconfig.json`의 `include`를 `["src", "e2e", "e2e-smoke", "vite.config.ts", "playwright.config.ts"]`로 바꾼다.

- [ ] **Step 4: smoke-report 구현**

`packages/factory/src/stages/smoke.ts`:
```ts
import { z } from "zod";
import type { Comment, Issue } from "../github/port";
import { codeCell, readMarker, writeMarker } from "../report/text";
import { isBot, record, runLink, stepRecord } from "./common";
import type { Settings, StageDeps } from "./deps";
import { findIntakeIssue, intakeMarker } from "./intake";

export const SMOKE_MARKER = "factory:smoke";
export const SMOKE_KEY = "production";
const SmokeStatusSchema = z.object({ status: z.enum(["failing", "recovered"]) });
export type SmokeStatus = z.infer<typeof SmokeStatusSchema>["status"];
export type SmokeAction = "created" | "commented" | "recovered" | "none";

const CHECKS =
  "프로덕션 읽기 전용 스모크(Hurl: `/api/health`, 글 목록, 태그 목록 / Playwright: 홈 화면 렌더링)";

// 이슈 본문과 봇 코멘트의 표식 중 마지막 값이 현재 상태다. 사람이 쓴 코멘트의 표식은 무시한다.
export function smokeStatus(issue: Issue, comments: Comment[], settings: Settings): SmokeStatus {
  let status: SmokeStatus =
    readMarker(issue.body, SMOKE_MARKER, SmokeStatusSchema)?.status ?? "failing";
  for (const c of comments) {
    if (!isBot(settings, c.author)) continue;
    const m = readMarker(c.body, SMOKE_MARKER, SmokeStatusSchema);
    if (m) status = m.status;
  }
  return status;
}

function target(settings: Settings): string {
  const injected = settings.env.SMOKE_API_BASE?.trim();
  return injected ? `검증용으로 지정한 API \`${codeCell(injected)}\`` : "프로덕션 API와 웹";
}

export async function runSmokeReport(
  deps: StageDeps,
  { result }: { result: "success" | "failure" },
): Promise<{ action: SmokeAction; issue: number | null }> {
  const issue = findIntakeIssue(await deps.gh.listOpenIssues(), deps.settings, "smoke", SMOKE_KEY);
  const run = runLink(deps.settings);
  if (result === "failure") {
    const failing = writeMarker(SMOKE_MARKER, { status: "failing" });
    if (issue) {
      await deps.gh.comment(
        issue.number,
        `${CHECKS}가 실패했다. 대상: ${target(deps.settings)}.${run}\n\n${failing}`,
      );
      await record(deps, stepRecord("smoke", issue.number, null, false, "smoke_failed"));
      return { action: "commented", issue: issue.number };
    }
    const body = [
      `${CHECKS}가 실패했다. 대상: ${target(deps.settings)}. 실패한 단계와 로그는 워크플로 run에서 확인한다.${run}`,
      "",
      '실패가 이어지면 이 이슈에 코멘트를 추가하고, 다음 스모크가 성공하면 "복구됨" 코멘트를 남긴다. 이슈 종료는 사람이 정한다. 구현은 리포 쓰기 권한자의 `@factory go`가 있어야 시작한다.',
      "",
      failing,
      intakeMarker("smoke", SMOKE_KEY),
    ].join("\n");
    const n = await deps.gh.createIssue("[스모크] 프로덕션 읽기 전용 스모크 실패", body, [
      "source:smoke",
    ]);
    await record(deps, stepRecord("smoke", n, null, false, "smoke_failed"));
    return { action: "created", issue: n };
  }
  if (!issue) return { action: "none", issue: null };
  if (smokeStatus(issue, await deps.gh.listComments(issue.number), deps.settings) !== "failing") {
    return { action: "none", issue: issue.number };
  }
  await deps.gh.comment(
    issue.number,
    `복구됨: ${CHECKS}가 다시 통과했다. 대상: ${target(deps.settings)}.${run} 원인 조사와 이슈 종료는 사람이 정한다.\n\n${writeMarker(SMOKE_MARKER, { status: "recovered" })}`,
  );
  await record(deps, stepRecord("smoke", issue.number, null, true));
  return { action: "recovered", issue: issue.number };
}
```
`packages/factory/src/cli.ts`에 import `import { runSmokeReport } from "./stages/smoke";`를 더하고, `COMMANDS`의 `intake` 항목 아래에 추가한다:
```ts
  "smoke-report": async (ctx, v) => {
    const result = reqStr(v, "result");
    if (result !== "success" && result !== "failure") {
      throw new UsageError("--result는 success|failure 중 하나다");
    }
    ctx.stdout(JSON.stringify(await runSmokeReport(ctx.buildDeps(ctx.env, "all"), { result })));
    return 0;
  },
```

- [ ] **Step 5: 테스트가 통과하는지 확인**

Run: `pnpm --filter factory test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: 스모크 파일을 프로덕션에 한 번 실행(읽기 전용)**

```bash
hurl --test --variable "api=https://sfd-api.roboco.workers.dev/api" tests/smoke/readonly.hurl
E2E_BASE_URL=https://roboco.io/the-software-factory-demo/ pnpm --filter web exec playwright test -c e2e-smoke/playwright.config.ts
```
Expected: Hurl은 3개 요청 모두 성공한다. Playwright는 "피드백" 버튼 단언에서 **실패한다**(프로덕션에 Task 9 웹이 아직 배포되지 않았기 때문이다). 나머지 단언(제목, Global Feed, 오류 없음)은 통과하는지 trace로 확인한다. 배포 뒤 재확인은 Task 13에서 한다.

- [ ] **Step 7: 커밋**

```bash
pnpm exec prettier --write packages/factory/src/stages/smoke.ts packages/factory/src/cli.ts packages/factory/test/smoke.test.ts packages/factory/test/cli.test.ts apps/web/e2e-smoke apps/web/tsconfig.json
git add tests/smoke/readonly.hurl apps/web/e2e-smoke/playwright.config.ts apps/web/e2e-smoke/home.spec.ts apps/web/tsconfig.json packages/factory/src/stages/smoke.ts packages/factory/src/cli.ts packages/factory/test/smoke.test.ts packages/factory/test/cli.test.ts
git commit -m "feat(factory): 프로덕션 읽기 전용 스모크 파일과 smoke-report 단계

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: 유입 워크플로, INTAKE_TOKEN 동기화, 위험 정책·CODEOWNERS, 문서

**Files:**
- Create: `.github/workflows/factory-intake.yml`, `.github/workflows/factory-smoke.yml`
- Modify: `.github/workflows/deploy.yml`(`api` job), `factory/risk-policy.yml`, `.github/CODEOWNERS`, `factory/prompts/implement.md`, `factory/prompts/fix.md`, `README.md`
- Test: `packages/factory/test/workflows.test.ts`, `packages/factory/test/codeowners.test.ts`, `packages/factory/test/risk.test.ts`

**Interfaces:**
- Consumes: CLI `intake` (Task 10), `smoke-report` (Task 11), 스모크 파일 (Task 11), Worker 환경 `INTAKE_TOKEN` (Task 5, 8)
- Produces: 워크플로 `factory-intake.yml`(job `intake`), `factory-smoke.yml`(job `checks`, `report`), `deploy.yml` `api` job의 secret 동기화 step. 위험 정책: T3 `tests/smoke/**`, `apps/web/e2e-smoke/**`, T2 `apps/api/src/middleware/intake.ts`, `apps/api/src/routes/intake.ts`.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/factory/test/workflows.test.ts`를 고친다.
- `interface Job`에 `env?: Record<string, string>;`를 더한다.
- `it("exist with the expected names", ...)`의 기대 배열을 다음으로 바꾼다:
```ts
    expect(FACTORY).toEqual([
      "factory-command.yml",
      "factory-contract.yml",
      "factory-fix.yml",
      "factory-guard.yml",
      "factory-implement.yml",
      "factory-intake.yml",
      "factory-merge.yml",
      "factory-review.yml",
      "factory-smoke.yml",
      "factory-triage.yml",
    ]);
```
- 파일 끝에 추가한다:
```ts
describe("P3 intake workflows", () => {
  it("factory-intake.yml runs main's CLI with the production INTAKE_TOKEN only in the intake step", () => {
    const wf = load("factory-intake.yml");
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const job = wf.jobs.intake!;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("production");
    expect(checkouts(job)[0]!.with).toMatchObject({ ref: "main", "persist-credentials": false });
    const run = job.steps.find((s) => s.run?.includes("pnpm -s factory intake"))!;
    expect(run.env?.INTAKE_TOKEN).toBe("${{ secrets.INTAKE_TOKEN }}");
    expect(run.env?.FACTORY_TOKEN).toBe("${{ steps.app.outputs.token }}");
    expect(run.env?.INTAKE_URL).toBe("https://sfd-api.${{ vars.WORKERS_SUBDOMAIN }}.workers.dev/api");
    expect(JSON.stringify(job.steps.filter((s) => s !== run))).not.toContain("INTAKE_TOKEN");
  });

  it("factory-smoke.yml checks production without secrets and reports with an App token", () => {
    const wf = load("factory-smoke.yml");
    const checks = wf.jobs.checks!;
    const report = wf.jobs.report!;
    expect(checks.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(checks)).not.toMatch(/secrets\.|create-github-app-token|FACTORY_TOKEN/);
    for (const s of checkouts(checks)) {
      expect(s.with).toMatchObject({ ref: "main", "persist-credentials": false });
    }
    expect(checks.steps.some((s) => s.run?.includes("tests/smoke/readonly.hurl"))).toBe(true);
    expect(checks.steps.some((s) => s.run?.includes("e2e-smoke/playwright.config.ts"))).toBe(true);
    expect(report.needs).toBe("checks");
    expect(report.if).toContain("!cancelled()");
    const run = report.steps.find((s) => s.run?.includes("pnpm -s factory smoke-report"))!;
    expect(run.run).toContain('--result "$RESULT"');
    expect(run.env?.RESULT).toBe("${{ needs.checks.result }}");
    expect(run.env?.SMOKE_API_BASE).toBe("${{ inputs.api_base }}");
  });

  it("deploy.yml syncs INTAKE_TOKEN into the Worker through stdin without printing it", () => {
    const job = load("deploy.yml").jobs.api!;
    expect(job.environment).toBe("production");
    const step = job.steps.find((s) => s.run?.includes("wrangler secret put INTAKE_TOKEN"))!;
    expect(step.run).toContain(`printf '%s' "$INTAKE_TOKEN" | pnpm exec wrangler secret put INTAKE_TOKEN`);
    expect(step.run).toContain('test -n "$INTAKE_TOKEN"');
    expect(step.run).not.toMatch(/\becho\b/);
    expect(step.env?.INTAKE_TOKEN).toBe("${{ secrets.INTAKE_TOKEN }}");
  });
});
```
`packages/factory/test/codeowners.test.ts`의 `it.each([...])("requires @serithemage for T2/T3 path %s", ...)` 목록 끝(`".gitignore",` 다음)에 추가한다:
```ts
    "tests/smoke/readonly.hurl",
    "apps/web/e2e-smoke/home.spec.ts",
    "apps/web/e2e-smoke/playwright.config.ts",
    "apps/api/src/middleware/intake.ts",
    "apps/api/src/routes/intake.ts",
    "apps/api/migrations/0003_intake.sql",
```
`packages/factory/test/risk.test.ts`의 `describe("tierOf with factory/risk-policy.yml", ...)` 첫 `it.each` 표에서 `["tests/realworld/skip.txt", "T1"],` 아래에 추가한다:
```ts
    ["apps/api/src/routes/feedback.ts", "T1"],
    ["apps/api/src/lib/error-events.ts", "T1"],
    ["apps/web/e2e/feedback.spec.ts", "T1"],
    ["apps/api/migrations/0003_intake.sql", "T2"],
    ["apps/api/src/routes/intake.ts", "T2"],
    ["apps/api/src/middleware/intake.ts", "T2"],
    ["tests/smoke/readonly.hurl", "T3"],
    ["apps/web/e2e-smoke/home.spec.ts", "T3"],
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/workflows.test.ts test/codeowners.test.ts test/risk.test.ts`
Expected: FAIL — 새 워크플로 파일이 없고, 스모크·수집 경로가 T1이며 CODEOWNERS에 없다.

- [ ] **Step 3: 위험 정책·CODEOWNERS·프롬프트 경로 목록**

`factory/risk-policy.yml`의 T3 `patterns` 끝(`- "tests/realworld/UPSTREAM.txt"` 아래)에 추가한다:
```yaml
      # 프로덕션 스모크는 유입(source:smoke)의 판정 기준이다. 구현 에이전트가 기준을 바꾸지 못하게 한다.
      - "tests/smoke/**"
      - "apps/web/e2e-smoke/**"
```
T2 `patterns` 끝(`- "**/.dev.vars"` 아래)에 추가한다:
```yaml
      # 수집 엔드포인트의 토큰 검사는 에러·피드백 데이터의 인증 경계다.
      - "apps/api/src/middleware/intake.ts"
      - "apps/api/src/routes/intake.ts"
```
`.github/CODEOWNERS`의 T3 묶음 끝(`/tests/realworld/UPSTREAM.txt @serithemage` 아래)에 추가한다:
```
/tests/smoke/ @serithemage
/apps/web/e2e-smoke/ @serithemage
```
T2 묶음 끝(`/pnpm-*.yaml @serithemage` 아래)에 추가한다:
```
/apps/api/src/middleware/intake.ts @serithemage
/apps/api/src/routes/intake.ts @serithemage
```
`factory/prompts/implement.md`와 `factory/prompts/fix.md`의 "다음 경로는 수정하지 않는다:" 목록에서 `tests/realworld/vendor/` 뒤에 `, tests/smoke/, apps/web/e2e-smoke/`를 더한다(마침표는 목록 끝에 그대로 둔다).

- [ ] **Step 4: 워크플로 작성**

`.github/workflows/factory-intake.yml`:
```yaml
name: factory-intake
on:
  schedule:
    - cron: "7,37 * * * *"
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: factory-intake
  cancel-in-progress: false
jobs:
  intake:
    # INTAKE_TOKEN(production environment secret)을 받는 job이다. main의 팩토리 코드만 실행한다.
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: production
    steps:
      - uses: actions/checkout@v7
        with: { ref: main, persist-credentials: false }
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - id: app
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.FACTORY_APP_ID }}
          private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      # App 토큰으로 만든 이슈만 issues: opened 이벤트로 factory-triage를 트리거한다(GITHUB_TOKEN으로 만든 이슈는 워크플로를 트리거하지 않는다).
      - run: pnpm -s factory intake
        env:
          FACTORY_TOKEN: ${{ steps.app.outputs.token }}
          FACTORY_BOT_USER_ID: ${{ vars.FACTORY_BOT_USER_ID }}
          INTAKE_URL: https://sfd-api.${{ vars.WORKERS_SUBDOMAIN }}.workers.dev/api
          INTAKE_TOKEN: ${{ secrets.INTAKE_TOKEN }}
```
`.github/workflows/factory-smoke.yml`:
```yaml
name: factory-smoke
on:
  schedule:
    - cron: "23 */6 * * *"
  workflow_dispatch:
    inputs:
      api_base:
        description: 검증용 실패 주입에만 쓴다. 비우면 프로덕션 API(https://sfd-api.<WORKERS_SUBDOMAIN>.workers.dev/api)를 검사한다.
        required: false
        type: string
permissions:
  contents: read
concurrency:
  group: factory-smoke
  cancel-in-progress: false
jobs:
  checks:
    # 프로덕션에 읽기 요청만 보낸다(spec 7.1.3). 시크릿과 GitHub App 토큰을 받지 않는다.
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
    env:
      API_BASE: ${{ inputs.api_base || format('https://sfd-api.{0}.workers.dev/api', vars.WORKERS_SUBDOMAIN) }}
      E2E_BASE_URL: ${{ vars.WEB_URL }}
    steps:
      - uses: actions/checkout@v7
        with: { ref: main, persist-credentials: false }
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: gacts/install-hurl@v1
      - name: API 읽기 전용 스모크(Hurl)
        run: hurl --test --variable "api=$API_BASE" tests/smoke/readonly.hurl
      # Hurl이 실패해도 웹 스모크까지 실행해 실패 범위를 한 run에서 보이게 한다.
      - if: ${{ !cancelled() }}
        run: pnpm --filter web exec playwright install --with-deps chromium
      - name: 웹 읽기 전용 스모크(Playwright)
        if: ${{ !cancelled() }}
        run: pnpm --filter web exec playwright test -c e2e-smoke/playwright.config.ts
  report:
    needs: checks
    if: ${{ !cancelled() && github.ref == 'refs/heads/main' }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with: { ref: main, persist-credentials: false }
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - id: app
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.FACTORY_APP_ID }}
          private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      - run: pnpm -s factory smoke-report --result "$RESULT"
        env:
          FACTORY_TOKEN: ${{ steps.app.outputs.token }}
          FACTORY_BOT_USER_ID: ${{ vars.FACTORY_BOT_USER_ID }}
          RESULT: ${{ needs.checks.result }}
          SMOKE_API_BASE: ${{ inputs.api_base }}
```
`.github/workflows/deploy.yml`의 `api` job에서 `run: pnpm exec wrangler deploy` step 다음에 추가한다:
```yaml
      # INTAKE_TOKEN의 원본은 production environment secret이다. 배포마다 같은 값을 Worker secret으로 넣는다(값은 stdin으로만 전달).
      - name: Sync INTAKE_TOKEN Worker secret
        working-directory: apps/api
        run: |
          test -n "$INTAKE_TOKEN"
          printf '%s' "$INTAKE_TOKEN" | pnpm exec wrangler secret put INTAKE_TOKEN
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          INTAKE_TOKEN: ${{ secrets.INTAKE_TOKEN }}
```

- [ ] **Step 5: README 갱신**

`README.md`의 "## 소프트웨어 팩토리" 절에서 "처음 설정" 문단의 시크릿 목록 문장 끝에 다음 문장을 더한다: `P3부터는 GitHub environment \`production\`에 secret \`INTAKE_TOKEN\`(임의의 64자 16진수)도 둔다. \`deploy\` 워크플로가 배포마다 같은 값을 Worker secret으로 넣는다.`

"## 배포 롤백" 절 바로 앞에 새 절을 넣는다:
```markdown
## 유입과 증거(P3)

- `evidence` 필수 체크: PR 본문의 팩토리 표식이 가리키는 이슈에 `type:bug` 라벨이 있으면, PR이 추가·수정한 테스트 파일만 base 커밋 트리에 덮어써 실행해 실패하고, head 트리에서 같은 테스트가 통과해야 한다. 그 밖의 PR은 즉시 통과한다. 실행 대상은 Vitest 파일(`*.test.ts`, `*.test.tsx`)이고, Playwright E2E(`apps/web/e2e/`)는 실행하지 않는다. 판정 코드는 base 커밋의 팩토리 CLI이며, PR 코드는 시크릿과 GitHub 토큰이 없는 `evidence` job에서만 실행된다.
- 에러 유입: Worker가 처리하지 못한 예외는 `error_events` 테이블에 fingerprint(정규화한 메시지와 스택 상위 3프레임의 해시) 단위로 모인다. `factory-intake` 워크플로(매시 7분·37분)가 미확인 항목을 읽어 `source:error`·`type:bug` 이슈를 만들거나, 같은 fingerprint의 열린 이슈에 누적 횟수를 코멘트한다.
- 피드백 유입: 웹 푸터의 "피드백" 버튼으로 익명 의견을 받는다. API는 IP 원문을 저장하지 않고 `SHA-256(IP + INTAKE_TOKEN)`만 저장하며, 같은 해시는 10분에 3건까지 받는다. 건마다 `source:feedback` 이슈가 된다.
- 스모크 유입: `factory-smoke` 워크플로(6시간마다)가 프로덕션에 읽기 요청만 보낸다(Hurl `tests/smoke/readonly.hurl`, Playwright `apps/web/e2e-smoke/`). 실패하면 `source:smoke` 이슈를 만들거나 열린 이슈에 코멘트하고, 다음 성공 때 "복구됨" 코멘트를 남긴다. 이슈 종료는 사람이 정한다.
- 유입 이슈는 자동으로 트리아지되지만, 구현은 리포 쓰기 권한자의 `@factory go`가 있어야 시작한다.
- `INTAKE_TOKEN`: 원본은 GitHub environment `production`의 secret이다. 값을 바꾸려면 secret을 바꾼 뒤 `deploy` 워크플로를 다시 실행한다. 검증용 로컬 사본은 `~/.config/sfd/intake-token`(권한 600)에만 두고 터미널에 출력하지 않는다.
- 수동 실행: `gh workflow run factory-intake.yml`, `gh workflow run factory-smoke.yml`.
- 스모크 실패 주입: `gh workflow run factory-smoke.yml -f api_base=https://sfd-api.roboco.workers.dev/api/__smoke_injected_failure`. 존재하지 않는 경로라 `/health`가 404가 된다. 입력 없이 다시 실행하면 복구를 확인할 수 있다.
- 에러 주입: `POST /api/_factory/intake/probe`에 `Authorization: Bearer <INTAKE_TOKEN>`을 보내면 의도적 예외가 하나 기록된다. 토큰이 없거나 틀리면 다른 미지 경로와 같은 404다.
```
"## 팩토리 보안 한계" 절 끝에 다음 항목을 더한다:
```markdown
- `evidence` job은 PR 코드(테스트, 의존성 설치 스크립트)를 실행한다. 이 job에는 시크릿과 GitHub 토큰이 없지만, 판정 프로세스와 같은 VM에서 돌기 때문에 악의적인 PR 코드는 판정 결과를 조작할 수 있다. PR 코드를 실행하는 다른 필수 체크(`unit`, `e2e` 등)와 같은 수준이다. `evidence`는 재현 테스트가 있다는 증거를 요구하는 장치이고, 악의적인 작성자를 막는 장치가 아니다. T2·T3 변경은 계속 사람 승인이 막는다.
- 피드백 레이트 리밋은 "최근 10분 건수 조회 후 삽입"으로 동작하므로, 같은 IP에서 동시에 들어온 요청은 3건을 조금 넘길 수 있다.
- `POST /api/_factory/intake/probe`는 `INTAKE_TOKEN`을 가진 사람만 쓸 수 있는 오류 주입 경로다. 효과는 `error_events` 한 행과 그에 따른 유입 이슈뿐이다.
- `factory-intake`는 environment `production`을 참조하므로, GitHub가 30분마다 이 environment의 배포 기록을 하나씩 만든다.
```

- [ ] **Step 6: 테스트가 통과하는지 확인**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS(전체). `workflows.test.ts`의 기존 규칙("never interpolate event data into run scripts", "keep shell glue to at most one conditional line", "calls the factory CLI instead of embedding logic", "never persist checkout credentials and never see Cloudflare secrets")도 새 워크플로에 대해 통과한다.

- [ ] **Step 7: 커밋**

```bash
pnpm exec prettier --write .github/workflows/factory-intake.yml .github/workflows/factory-smoke.yml .github/workflows/deploy.yml factory/risk-policy.yml README.md packages/factory/test/workflows.test.ts packages/factory/test/codeowners.test.ts packages/factory/test/risk.test.ts
git add .github/workflows/factory-intake.yml .github/workflows/factory-smoke.yml .github/workflows/deploy.yml factory/risk-policy.yml .github/CODEOWNERS factory/prompts/implement.md factory/prompts/fix.md README.md packages/factory/test/workflows.test.ts packages/factory/test/codeowners.test.ts packages/factory/test/risk.test.ts
git commit -m "feat(factory): factory-intake·factory-smoke 워크플로, INTAKE_TOKEN 동기화, 새 T2·T3 경로

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: INTAKE_TOKEN 준비, PR #1 병합, 배포 확인, bootstrap

이 Task는 실제 GitHub·Cloudflare를 쓴다. 각 Step의 근거(명령 출력, run URL)를 PR #1의 코멘트로 남긴다. 근거가 없는 항목은 완료로 보고하지 않는다. `R=roboco-io/the-software-factory-demo`, `API=https://sfd-api.roboco.workers.dev/api`를 셸 변수로 둔다.

**Files:** 없음(코드 변경 없음)

**Interfaces:**
- Consumes: Task 1-12의 브랜치 `p3-evidence-intake`
- Produces: GitHub environment `production`의 secret `INTAKE_TOKEN`, 로컬 사본 `~/.config/sfd/intake-token`(권한 600), main에 병합된 PR #1, 프로덕션 D1의 `error_events`·`feedback` 테이블, 라벨 27개

- [ ] **Step 1: INTAKE_TOKEN 생성과 등록(사람, 값은 출력하지 않는다)**

`deploy.yml`의 동기화 step은 secret이 비어 있으면 실패하므로 병합 전에 만든다.
```bash
R=roboco-io/the-software-factory-demo
mkdir -p ~/.config/sfd && chmod 700 ~/.config/sfd
( umask 077; openssl rand -hex 32 > ~/.config/sfd/intake-token )
gh secret set INTAKE_TOKEN --env production -R "$R" < ~/.config/sfd/intake-token
gh secret list --env production -R "$R" --json name --jq '.[].name' | grep -x INTAKE_TOKEN
```
Expected: 마지막 명령이 `INTAKE_TOKEN` 한 줄을 출력한다. 토큰 값은 어디에도 출력되지 않는다.

- [ ] **Step 2: PR #1 생성과 체크**

```bash
pnpm typecheck && pnpm lint && pnpm test
git push -u origin p3-evidence-intake
gh pr create -R "$R" --base main --head p3-evidence-intake --title "P3 증거·유입 확장(1/2): evidence CLI, 에러·피드백·스모크 유입" --body "spec 7.1(P3)의 P2 잔여 과제, evidence 판정 CLI, 에러·피드백 수집 API, 웹 피드백, factory-intake·factory-smoke 워크플로를 추가한다. ci.yml의 evidence job과 필수 체크 등록은 이 PR 병합 뒤 PR 2/2에서 한다(evidence job이 base 커밋의 CLI를 쓰기 때문이다). 계획: docs/superpowers/plans/2026-10-11-p3-evidence-intake.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr checks -R "$R" --watch
```
Expected: `typecheck`, `lint`, `unit`, `realworld-api`, `e2e`, `risk-tier`가 성공한다. `risk-tier`는 임시 분기 없이 base(main)의 CLI로 판정한다(사람 PR이므로 forbidden 없음). `preview`의 `deploy`·`e2e-preview`도 성공한다(사람 PR이라 프리뷰를 만들고, 프리뷰 Worker에는 `INTAKE_TOKEN`이 없으므로 수집 엔드포인트는 404다).

- [ ] **Step 3: 병합(사람)과 배포 확인**

사용자가 diff를 검토하고 squash 병합한다(T2·T3 포함, CODEOWNERS 승인 필요). 병합 뒤:
```bash
sleep 20
RUN=$(gh run list -R "$R" -w deploy --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch -R "$R" "$RUN" --exit-status
API=https://sfd-api.roboco.workers.dev/api
curl -sS -o /dev/null -w '%{http_code}\n' "$API/_factory/intake"
curl -fsS -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.config/sfd/intake-token)") "$API/_factory/intake"; echo
curl -fsS "$API/health"; echo
```
Expected: deploy run 성공(`api` job의 "Sync INTAKE_TOKEN Worker secret" step 포함). 토큰 없는 요청은 `404`. 토큰을 붙인 요청은 `{"errors":[],"feedback":[]}`(빈 목록이 오면 마이그레이션 0003이 프로덕션 D1에 적용된 것이다). `/health`는 `{"status":"ok"}`.

- [ ] **Step 4: 배포된 웹에 대한 스모크 재확인**

```bash
for i in $(seq 1 30); do curl -fsS https://roboco.io/the-software-factory-demo/ | grep -q Conduit && break; sleep 10; done
E2E_BASE_URL=https://roboco.io/the-software-factory-demo/ pnpm --filter web exec playwright test -c e2e-smoke/playwright.config.ts
```
Expected: 통과("피드백" 버튼 단언 포함). Pages 반영이 늦으면 5분 뒤 다시 실행한다.

- [ ] **Step 5: bootstrap(라벨)과 워크플로 1회 실행**

```bash
git switch main && git pull
FACTORY_TOKEN="$(gh auth token)" GITHUB_REPOSITORY="$R" pnpm -s factory bootstrap
gh label list -R "$R" --limit 100 --json name --jq '[.[].name | select(startswith("source:"))] | sort'
gh workflow run factory-intake.yml -R "$R"
gh workflow run factory-smoke.yml -R "$R"
sleep 15
for w in factory-intake factory-smoke; do
  RUN=$(gh run list -R "$R" -w "$w" --limit 1 --json databaseId --jq '.[0].databaseId')
  gh run watch -R "$R" "$RUN" --exit-status
done
```
Expected: bootstrap 출력 `{"labels":27,"branch":"factory-data"}`. 라벨 목록 `["source:deploy","source:error","source:feedback","source:smoke"]`. 두 run 모두 성공한다. intake 로그의 요약은 `{"created":[],"updated":[],"acked":{"errors":0,"feedback":0},"failed":0}`이고, smoke `report` job 로그는 `{"action":"none","issue":null}`이다.

### Task 14: evidence 게이트 활성화(PR #2)와 필수 체크 등록

PR #1이 main에 병합된 뒤 시작한다(`evidence-plan` job이 base 커밋의 `evidence` 명령을 쓰므로).

**Files:**
- Modify: `.github/workflows/ci.yml`(`evidence-plan`, `evidence` job 추가), `factory/risk-policy.yml`(`requiredChecks`), `packages/factory/src/report/pr.ts`(PR 본문 문장), `AGENTS.md`
- Test: `packages/factory/test/workflows.test.ts`, `packages/factory/test/risk.test.ts`, `packages/factory/test/gate.test.ts`, `packages/factory/test/scenario.test.ts`

**Interfaces:**
- Consumes: CLI `evidence`, `evidence-run` (Task 2, 3), `loadRiskPolicy` (`src/policy/risk.ts`)
- Produces: 필수 체크 `evidence`(ci.yml job 이름), `requiredChecks: [typecheck, lint, unit, realworld-api, e2e, risk-tier, evidence]`. gate는 `evidence`까지 통과해야 병합한다.

- [ ] **Step 1: 브랜치와 실패하는 테스트 작성**

```bash
git switch -c p3-evidence-gate main
```
`packages/factory/test/workflows.test.ts` 맨 위 import에 `import { loadRiskPolicy } from "../src/policy/risk";`를 더하고, 파일 끝에 추가한다:
```ts
describe("evidence gate (P3)", () => {
  const BASE_SHA = "${{ github.event.pull_request.base.sha }}";

  it("plans evidence with the base commit's CLI and a read-only token, without checking out PR code", () => {
    const job = load("ci.yml").jobs["evidence-plan"]!;
    expect(job.if).toBe("github.event_name == 'pull_request'");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read", issues: "read" });
    expect(checkouts(job)).toHaveLength(1);
    expect(checkouts(job)[0]!.with).toMatchObject({
      ref: BASE_SHA,
      path: "base",
      "persist-credentials": false,
    });
    const step = job.steps.find((s) => s.run?.includes("pnpm -s factory evidence --pr"))!;
    expect(step["working-directory"]).toBe("base");
    expect(step.run).toContain('--sha "$HEAD_SHA" --base "$BASE_SHA" --json');
    expect(step.env?.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(step.env?.BASE_SHA).toBe(BASE_SHA);
    expect(job.outputs?.plan).toBe("${{ steps.plan.outputs.plan }}");
  });

  it("runs PR tests in a job with no secrets or tokens, and fails instead of skipping when planning failed", () => {
    const job = load("ci.yml").jobs.evidence!;
    expect(job.needs).toBe("evidence-plan");
    expect(job.if).toContain("!cancelled()");
    expect(job.if).toContain("github.event_name == 'pull_request'");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(
      /secrets\.|GITHUB_TOKEN|GH_TOKEN|FACTORY_TOKEN|create-github-app-token/,
    );
    for (const s of checkouts(job)) expect(s.with?.["persist-credentials"]).toBe(false);
    const base = checkouts(job).find((s) => s.with?.path === "base")!;
    const head = checkouts(job).find((s) => s.with?.path === "head")!;
    expect(base.with?.ref).toBe(BASE_SHA);
    expect(head.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(head.with?.["fetch-depth"]).toBe(0);
    const run = job.steps.find((s) => s.run?.includes("pnpm -s factory evidence-run"))!;
    expect(run["working-directory"]).toBe("base");
    expect(run.env).toEqual({
      EVIDENCE_PLAN: "${{ needs.evidence-plan.outputs.plan }}",
      FACTORY_WORKDIR: "${{ github.workspace }}/head",
    });
    // PR 코드가 있는 head/에서는 의존성을 설치하지 않는다. 설치는 evidence-run이 scrubEnv로 한다.
    for (const s of job.steps.filter((x) => x.run?.includes("pnpm install"))) {
      expect(s["working-directory"]).toBe("base");
    }
  });

  it("produces every required check of factory/risk-policy.yml as a ci.yml job that runs on pull requests", () => {
    const jobs = load("ci.yml").jobs;
    const required = loadRiskPolicy().requiredChecks;
    expect(required).toContain("evidence");
    for (const name of required) {
      expect(jobs[name], name).toBeDefined();
      expect(jobs[name]!.if ?? "", name).not.toMatch(/event_name == 'push'/);
    }
  });
});
```
`packages/factory/test/risk.test.ts`의 `it("lists required checks including risk-tier", ...)` 기대 배열 끝에 `"evidence",`를 더하고 테스트 이름을 `"lists required checks including risk-tier and evidence"`로 바꾼다.
`packages/factory/test/gate.test.ts`의 `GREEN`과 `packages/factory/test/scenario.test.ts`의 `GREEN`에 각각 `evidence: "success",`를 `"risk-tier": "success",` 아래에 더한다.
`packages/factory/test/gate.test.ts`의 `describe("runGate", ...)` 안에 추가한다:
```ts
  it("waits for evidence and dispatches a ci fix when evidence fails", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    await verdict(h, pr, "sha-a", "APPROVE");
    const { evidence: _e, ...withoutEvidence } = GREEN;
    h.gh.setChecks("sha-a", withoutEvidence);
    expect(await runGate(h.deps, { pr })).toBe("pending");
    h.gh.setChecks("sha-a", { ...GREEN, evidence: "failure" });
    expect(await runGate(h.deps, { pr })).toBe("fix-dispatched");
    expect(h.gh.merges).toEqual([]);
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm --filter factory exec vitest run test/workflows.test.ts test/risk.test.ts test/gate.test.ts test/scenario.test.ts`
Expected: FAIL — `evidence-plan`·`evidence` job이 없고, `requiredChecks`에 `evidence`가 없어 "waits for evidence" 테스트가 `merged`를 돌려준다.

- [ ] **Step 3: 구현**

`.github/workflows/ci.yml` 끝(`risk-tier` job 뒤)에 추가한다:
```yaml
  evidence-plan:
    # 버그 PR인지, PR이 추가·수정한 테스트 파일이 무엇인지 base 커밋의 팩토리 코드로 정한다(spec 7.1.2).
    # 변경 파일과 이슈 라벨은 API로 읽으므로 PR 코드는 체크아웃하지 않는다.
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: read
      issues: read
    outputs:
      plan: ${{ steps.plan.outputs.plan }}
    steps:
      - uses: actions/checkout@v7
        with:
          {
            ref: "${{ github.event.pull_request.base.sha }}",
            path: base,
            persist-credentials: false,
          }
      - uses: pnpm/action-setup@v6
        with: { package_json_file: base/package.json }
      - uses: actions/setup-node@v7
        with:
          node-version-file: base/.nvmrc
          cache: pnpm
          cache-dependency-path: base/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
        working-directory: base
      - id: plan
        working-directory: base
        run: |
          pnpm -s factory evidence --pr "$PR" --sha "$HEAD_SHA" --base "$BASE_SHA" --json > "$RUNNER_TEMP/evidence.json"
          echo "plan=$(jq -c . "$RUNNER_TEMP/evidence.json")" >> "$GITHUB_OUTPUT"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
  evidence:
    # 필수 체크. PR 코드(테스트)를 실행하므로 시크릿·GitHub 토큰을 주지 않는다. 판정은 base 커밋의 CLI가 한다.
    # evidence-plan이 실패해도 건너뛰지 않는다. 건너뛴(skipped) 필수 체크는 통과로 취급되기 때문이다.
    # 계획이 없으면 evidence-run이 실패로 끝난다.
    needs: evidence-plan
    if: ${{ !cancelled() && github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          {
            ref: "${{ github.event.pull_request.base.sha }}",
            path: base,
            persist-credentials: false,
          }
      # base 커밋 객체가 필요하므로 전체 이력을 받는다(git worktree로 base 트리를 만든다).
      - uses: actions/checkout@v7
        with:
          {
            ref: "${{ github.event.pull_request.head.sha }}",
            path: head,
            fetch-depth: 0,
            persist-credentials: false,
          }
      - uses: pnpm/action-setup@v6
        with: { package_json_file: base/package.json }
      - uses: actions/setup-node@v7
        with:
          node-version-file: base/.nvmrc
          cache: pnpm
          cache-dependency-path: base/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
        working-directory: base
      - name: evidence (시크릿·GitHub 토큰 없음)
        working-directory: base
        run: pnpm -s factory evidence-run
        env:
          EVIDENCE_PLAN: ${{ needs.evidence-plan.outputs.plan }}
          FACTORY_WORKDIR: ${{ github.workspace }}/head
```
`factory/risk-policy.yml`의 `requiredChecks`를 `[typecheck, lint, unit, realworld-api, e2e, risk-tier, evidence]`로 바꾼다.
`packages/factory/src/report/pr.ts`의 `"필수 CI 체크(typecheck, lint, unit, realworld-api, e2e, risk-tier)는 이 PR에서 다시 실행된다.",` 줄을 다음으로 바꾼다:
```ts
    "필수 CI 체크(typecheck, lint, unit, realworld-api, e2e, risk-tier, evidence)는 이 PR에서 다시 실행된다. evidence는 연결 이슈가 type:bug일 때 재현 테스트가 수정 전 코드에서 실패하고 이 PR에서 통과하는지 검사한다.",
```
`AGENTS.md`를 고친다.
- "## 구조"의 `packages/factory` 줄 아래에 추가: `- \`tests/smoke/\`, \`apps/web/e2e-smoke/\`: 프로덕션 읽기 전용 스모크. T3이며 구현 에이전트는 수정하지 않는다.`
- "## 규칙"의 `- 테스트를 먼저 쓴다. ...` 줄 아래에 추가: `` - 버그 이슈(`type:bug`) PR은 필수 체크 `evidence`가 PR이 추가·수정한 테스트를 수정 전 코드에서 실행해 실패하고 수정 후 코드에서 통과하는지 확인한다. 재현 테스트는 Vitest(`apps/api/test/*.test.ts`, `apps/web/src/**/*.test.tsx`)로 쓴다. Playwright E2E만으로는 통과하지 못한다. ``

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS(전체).

- [ ] **Step 5: 커밋, PR #2, 병합**

```bash
pnpm exec prettier --write .github/workflows/ci.yml factory/risk-policy.yml packages/factory/src/report/pr.ts AGENTS.md packages/factory/test/workflows.test.ts packages/factory/test/risk.test.ts packages/factory/test/gate.test.ts packages/factory/test/scenario.test.ts
git add .github/workflows/ci.yml factory/risk-policy.yml packages/factory/src/report/pr.ts AGENTS.md packages/factory/test/workflows.test.ts packages/factory/test/risk.test.ts packages/factory/test/gate.test.ts packages/factory/test/scenario.test.ts
git commit -m "feat(ci): evidence 필수 체크 — base 트리+head 테스트 실패, head 통과

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin p3-evidence-gate
gh pr create -R "$R" --base main --head p3-evidence-gate --title "P3 증거·유입 확장(2/2): evidence 필수 체크" --body "ci.yml에 evidence-plan(base CLI, 읽기 토큰)과 evidence(시크릿 없음, PR 테스트 실행) job을 추가하고, 팩토리 gate의 필수 체크에 evidence를 넣는다. 사람 PR이므로 이 PR의 evidence는 '검사하지 않음'으로 통과한다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr checks -R "$R" --watch
```
Expected: 기존 6개 체크와 `evidence-plan`, `evidence`가 성공한다. `evidence` 로그 첫 줄이 `evidence 통과(PR #<번호>): PR 본문에 팩토리 표식이 없다(사람이 연 PR 등). ...`이다. 사용자가 검토하고 병합한다.

- [ ] **Step 6: 브랜치 보호에 evidence 등록**

```bash
RID=$(gh api "repos/$R/rulesets" --jq '.[] | select(.name=="main-protection") | .id')
gh api "repos/$R/rulesets/$RID" \
  | jq '{name, target, enforcement, conditions, bypass_actors: (.bypass_actors // []), rules: [.rules[] | if .type == "required_status_checks" then .parameters.required_status_checks += [{"context":"evidence"}] else . end]}' \
  | gh api -X PUT "repos/$R/rulesets/$RID" --input - --jq '[.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
```
Expected: `["typecheck","lint","unit","realworld-api","e2e","risk-tier","evidence"]`(필수 체크 7개, spec 7.1.2).

### Task 15: 라이브 검증 — evidence(음성 대조, 심은 버그의 무개입 수정)

**Files:** 없음(검증용 브랜치와 PR은 검증 뒤 닫거나 병합한다)

**Interfaces:**
- Consumes: Task 13-14의 배포와 필수 체크
- Produces: 음성 대조 PR 번호 `NEG_PR`, 심은 버그 PR 번호 `SEED_PR`, 버그 이슈 번호 `BUG`, 수정 PR 번호 `FIX_PR`. 값은 `$SCRATCH/p3-evidence.env`에 기록해 Task 16에서 쓴다.

심은 버그(판정 후보 9): `apps/web/src/components/ArticleList.tsx`의 페이지 수 계산 `Math.ceil(data.articlesCount / PAGE)`를 `Math.floor(...)`로 바꾼다. 이 버그는 (1) 단위 테스트가 잡지 못한다(`ArticleList` 테스트가 없다), (2) RealWorld Hurl 스위트가 잡지 못한다(API만 검사한다), (3) 기존 E2E가 잡지 못한다(페이지를 넘기지 않는다), (4) 사용자가 관찰할 수 있다(글이 11-19개면 페이지 버튼이 사라지고 11번째 이후 글에 갈 수 없다), (5) 데이터를 바꾸지 않는다(화면 계산만 틀린다). 재현 테스트는 fetch를 가짜로 바꾼 Vitest 컴포넌트 테스트로 쓸 수 있으므로 evidence가 판정할 수 있다.

- [ ] **Step 1: 준비 — 프로덕션 글 수 확인(11개 이상이어야 관찰 가능)**

```bash
SCRATCH=$(mktemp -d); echo "SCRATCH=$SCRATCH"
API=https://sfd-api.roboco.workers.dev/api
COUNT=$(curl -fsS "$API/articles?limit=1" | jq .articlesCount); echo "articlesCount=$COUNT"
```
`COUNT`가 11 미만이면, 데모 계정으로 부족한 수만큼 글을 만든다(프로덕션에 데모용 글이 추가된다. 기존 데이터는 바꾸지 않는다):
```bash
DEMO_PW=$(openssl rand -hex 12)
DEMO=$(curl -fsS -X POST "$API/users" -H 'content-type: application/json' \
  -d "{\"user\":{\"username\":\"sfd-demo-$(date +%s)\",\"email\":\"sfd-demo-$(date +%s)@example.com\",\"password\":\"$DEMO_PW\"}}" | jq -r .user.token)
for i in $(seq 1 $((11 - COUNT))); do
  curl -fsS -o /dev/null -X POST "$API/articles" -H 'content-type: application/json' -H "authorization: Token $DEMO" \
    -d "{\"article\":{\"title\":\"데모 글 $i\",\"description\":\"페이지네이션 리허설용\",\"body\":\"리허설용 글이다.\"}}"
done
curl -fsS "$API/articles?limit=1" | jq .articlesCount
```
Expected: 마지막 출력이 11 이상이다.

페이지 버튼 수를 세는 스크립트를 만든다(프로덕션 웹을 읽기만 한다):
```bash
cat > "$SCRATCH/pages.mjs" <<'EOF'
import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require("@playwright/test");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.argv[2]);
await page.waitForSelector(".article-preview .preview-link", { timeout: 30000 });
console.log(await page.locator(".pagination .page-item").count());
await browser.close();
EOF
pnpm --filter web exec node "$SCRATCH/pages.mjs" https://roboco.io/the-software-factory-demo/
```
Expected: `ceil(COUNT/10)`(예: 11개면 `2`).

- [ ] **Step 2: 음성 대조 — base에서도 통과하는 테스트만 가진 버그 PR은 evidence가 실패한다**

```bash
R=roboco-io/the-software-factory-demo
NEG_ISSUE=$(gh issue create -R "$R" --label type:bug --title "[검증] evidence 음성 대조" --body "evidence 필수 체크가 수정 전 코드에서도 통과하는 테스트만 가진 버그 PR을 거부하는지 확인하는 검증 이슈다. 구현하지 않는다." | grep -oE '[0-9]+$')
git switch -c verify/evidence-negative main
cat > apps/web/src/components/Noop.test.ts <<'EOF'
import { expect, it } from "vitest";

it("passes on any code (negative control for evidence)", () => {
  expect(1 + 1).toBe(2);
});
EOF
git add apps/web/src/components/Noop.test.ts
git commit -m "test: evidence 음성 대조용 테스트(병합하지 않는다)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin verify/evidence-negative
NEG_PR=$(gh pr create -R "$R" --base main --head verify/evidence-negative --title "[검증] evidence 음성 대조(병합 금지)" --body "버그 이슈 #$NEG_ISSUE를 가리키는 팩토리 표식을 넣어 evidence 판정 대상으로 만든다. 테스트가 수정 전 코드에서도 통과하므로 evidence는 실패해야 한다.

<!-- factory:meta {\"issue\":$NEG_ISSUE,\"role\":\"implement\",\"implementEngine\":\"claude\",\"implementModel\":\"manual\",\"round\":0} -->" | grep -oE '[0-9]+$')
gh pr checks -R "$R" "$NEG_PR" --watch; true
RUN=$(gh run list -R "$R" -w ci --branch verify/evidence-negative --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view -R "$R" "$RUN" --log | grep -E "evidence (통과|실패)" | head -n 3
```
Expected: `evidence` 체크가 실패하고 로그에 `evidence 실패(PR #<NEG_PR>): 재현 테스트가 수정 전(base) 코드에서도 통과했다. 버그를 재현하지 못하는 테스트다.`가 있다. 나머지 체크는 성공한다. 확인 뒤 정리한다:
```bash
gh pr close -R "$R" "$NEG_PR" --delete-branch --comment "evidence 음성 대조 확인 완료. 병합하지 않는다."
gh issue close -R "$R" "$NEG_ISSUE" --comment "evidence 음성 대조 확인 완료(PR #$NEG_PR)."
git switch main && git branch -D verify/evidence-negative
echo "NEG_PR=$NEG_PR" >> "$SCRATCH/p3-evidence.env"
```

- [ ] **Step 3: 버그 심기(사람 PR)**

```bash
git switch -c demo/seed-pagination-bug main
sed -i.bak 's|Math.ceil(data.articlesCount / PAGE)|Math.floor(data.articlesCount / PAGE)|' apps/web/src/components/ArticleList.tsx && rm apps/web/src/components/ArticleList.tsx.bak
git diff --stat
pnpm --filter web test
git commit -am "chore(demo): 리허설용 버그 — 글 목록 페이지 수를 내림으로 계산

데모 리허설(spec 7.1.4)을 위해 사람이 의도적으로 심은 버그다. 수정은 팩토리가 버그 이슈로 한다.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin demo/seed-pagination-bug
SEED_PR=$(gh pr create -R "$R" --base main --head demo/seed-pagination-bug --title "chore(demo): 리허설용 버그 심기(글 목록 페이지 수)" --body "spec 7.1.4의 라이브 검증 재료다. ArticleList의 페이지 수 계산을 Math.ceil에서 Math.floor로 바꿔, 글이 11-19개면 페이지 버튼이 사라지게 한다. 단위 테스트·RealWorld Hurl·기존 E2E는 이 버그를 잡지 못한다. 데이터는 바뀌지 않는다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)" | grep -oE '[0-9]+$')
gh pr checks -R "$R" "$SEED_PR" --watch
gh pr merge -R "$R" "$SEED_PR" --squash --delete-branch
echo "SEED_PR=$SEED_PR" >> "$SCRATCH/p3-evidence.env"
```
Expected: `git diff --stat`이 `ArticleList.tsx` 한 파일 1줄 변경, `pnpm --filter web test` 통과(버그를 잡는 테스트가 없음을 확인), 필수 체크 7개 성공(`evidence`는 사람 PR이라 "검사하지 않음"). 병합 뒤 deploy가 끝나면 Step 1의 스크립트를 다시 실행한다:
```bash
RUN=$(gh run list -R "$R" -w deploy --limit 1 --json databaseId --jq '.[0].databaseId'); gh run watch -R "$R" "$RUN" --exit-status
sleep 60; pnpm --filter web exec node "$SCRATCH/pages.mjs" https://roboco.io/the-software-factory-demo/
```
Expected: `floor(COUNT/10)`가 1 이하이면 `0`(버튼 없음), 2 이상이면 그 값. Step 1의 값보다 작다.

- [ ] **Step 4: 버그 이슈와 무개입 수정**

```bash
BUG=$(gh issue create -R "$R" --label type:bug --title "글 목록에서 마지막 페이지로 갈 수 없다" --body "### 재현 절차
1. https://roboco.io/the-software-factory-demo/ 홈을 연다(글이 11개 이상 있을 때).
2. 글 목록 아래의 페이지 버튼을 본다.

### 기대한 결과와 실제 결과
- 기대: 페이지 버튼 수가 글 수를 10으로 나눠 올림한 값이다(예: 11개면 2개). 마지막 페이지에서 나머지 글을 볼 수 있다.
- 실제: 버튼 수가 내림한 값이다. 글이 11-19개면 버튼이 아예 없고 11번째 이후 글로 갈 수 없다." | grep -oE '[0-9]+$')
echo "BUG=$BUG" >> "$SCRATCH/p3-evidence.env"
sleep 120; gh issue view -R "$R" "$BUG" --json labels --jq '[.labels[].name]'
gh issue comment -R "$R" "$BUG" --body "@factory go"
```
이후 사람은 아무것도 하지 않는다. 진행을 관찰한다:
```bash
for i in $(seq 1 90); do gh issue view -R "$R" "$BUG" --json labels,state --jq '{state, labels: [.labels[].name | select(startswith("factory:"))]}'; sleep 60; done
FIX_PR=$(gh pr list -R "$R" --state all --head "factory/issue-$BUG" --json number --jq '.[0].number'); echo "FIX_PR=$FIX_PR" >> "$SCRATCH/p3-evidence.env"
gh pr view -R "$R" "$FIX_PR" --json state,mergedBy,labels,files --jq '{state, mergedBy: .mergedBy.login, labels: [.labels[].name], files: [.files[].path]}'
SHA=$(gh pr view -R "$R" "$FIX_PR" --json headRefOid --jq .headRefOid)
RUN=$(gh run list -R "$R" -w ci --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view -R "$R" "$RUN" --log | grep -E "evidence (통과|실패)|base 종료 코드" | head -n 5
pnpm --filter web exec node "$SCRATCH/pages.mjs" https://roboco.io/the-software-factory-demo/
```
Expected:
- 이슈 라벨이 `factory:triaged` → `factory:approved` → `factory:in-progress` → `factory:in-review` → `factory:merged` → `factory:deployed`로 바뀌고 이슈가 닫힌다(사람 개입 없음).
- 수정 PR은 `mergedBy`가 `roboco-software-factory-bot[bot]`, 라벨 `risk:T1`, 파일에 `apps/web/src/components/ArticleList.tsx`와 `*.test.tsx`(예: `apps/web/src/components/ArticleList.test.tsx`)가 있다.
- evidence 로그에 `evidence 통과(PR #<FIX_PR>): 재현 테스트가 수정 전(base) 코드에서 실패하고 수정 후(head) 코드에서 통과했다.`와 `- web ...: base 종료 코드 1, head 종료 코드 0`이 있다.
- 마지막 출력이 Step 1의 값(`ceil(COUNT/10)`)으로 돌아온다. 즉 배포 뒤 버그가 프로덕션에서 사라졌다.
- 리뷰 변경 요청이나 evidence 실패로 fix 라운드가 돌아도 사람 개입 없이 끝나면 통과다. `factory:needs-human`이 되면 실패로 기록하고, 이슈 코멘트·`factory-data` 기록·evidence 로그로 원인을 분석한 뒤 사람이 프롬프트(T3)를 고쳐 다시 시도한다.

### Task 16: 라이브 검증 — 유입 3종, spec·런북 갱신, P3 완료 대조

**Files:**
- Modify: `README.md`("데모 리허설: 심은 버그" 절), `docs/superpowers/specs/2026-10-11-software-factory-design.md`

**Interfaces:**
- Consumes: Task 13의 `INTAKE_TOKEN` 로컬 사본, Task 15의 `$SCRATCH/p3-evidence.env`
- Produces: 에러·피드백·스모크 유입 이슈와 근거, spec 9장 P3 체크 항목의 근거 링크

- [ ] **Step 1: 프로덕션 에러 → `source:error` 이슈(30분 안), 반복은 코멘트**

```bash
R=roboco-io/the-software-factory-demo; API=https://sfd-api.roboco.workers.dev/api
probe() { curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.config/sfd/intake-token)") "$API/_factory/intake/probe"; }
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$API/_factory/intake/probe"
date -u +%FT%TZ; probe
```
Expected: 토큰 없는 요청 `404`, 토큰 요청 `500`. 출력된 UTC 시각을 `T0`로 기록한다. 다음 예약 실행(매시 7분·37분)을 기다린 뒤:
```bash
for i in $(seq 1 45); do gh issue list -R "$R" --label source:error --state open --json number,title,createdAt --jq '.[] | select(.title | contains("factory intake probe"))' | grep -q . && break; sleep 60; done
ERR=$(gh issue list -R "$R" --label source:error --state open --json number,title --jq '.[] | select(.title | contains("factory intake probe")) | .number')
gh issue view -R "$R" "$ERR" --json createdAt,author,labels --jq '{createdAt, author: .author.login, labels: [.labels[].name]}'
gh run list -R "$R" -w factory-intake --limit 3 --json event,createdAt,conclusion
```
Expected: 이슈 1개, 작성자 `app/roboco-software-factory-bot`, 라벨 `source:error`·`type:bug`·`factory:triaged`(트리아지가 타입을 바꿨으면 `type:bug` 대신 다른 `type:*`), `createdAt - T0`가 30분 이하이다. 예약 실행이 GitHub 스케줄 지연으로 30분을 넘기면 그 사실(지연된 run의 `createdAt`)을 기록하고 미충족으로 보고한다. 이어서 반복 확인:
```bash
probe
for i in $(seq 1 45); do gh issue view -R "$R" "$ERR" --json comments --jq '.comments[].body' | grep -q "누적 2회" && break; sleep 60; done
gh issue view -R "$R" "$ERR" --json comments --jq '[.comments[].body | select(contains("누적"))]'
gh issue list -R "$R" --label source:error --state open --json number --jq 'length'
```
Expected: `누적 2회` 코멘트가 있고, `source:error` 열린 이슈 수는 그대로 1이다.

- [ ] **Step 2: 익명 피드백 → `source:feedback` 이슈, 같은 IP 4번째 요청은 429**

```bash
for i in 1 2 3 4; do curl -sS -o /dev/null -w '%{http_code} ' -X POST "$API/feedback" -H 'content-type: application/json' -d "{\"feedback\":{\"body\":\"[검증] 피드백 레이트 리밋 $i/4\",\"path\":\"/#/\"}}"; done; echo
gh workflow run factory-intake.yml -R "$R"; sleep 90
gh issue list -R "$R" --label source:feedback --state open --json number,title,labels --jq '.[] | select(.title | contains("[검증] 피드백")) | {number, title, labels: [.labels[].name]}'
```
Expected: 첫 줄 `201 201 201 429 `. 피드백 이슈 3개(1/4, 2/4, 3/4)가 `source:feedback`으로 열리고, 몇 분 안에 `factory:triaged`가 붙는다. 이슈 본문에 IP가 없다.

- [ ] **Step 3: 스모크 실패 → `source:smoke` 이슈, 복구 → "복구됨"**

```bash
gh workflow run factory-smoke.yml -R "$R" -f api_base=https://sfd-api.roboco.workers.dev/api/__smoke_injected_failure
sleep 20; RUN=$(gh run list -R "$R" -w factory-smoke --limit 1 --json databaseId --jq '.[0].databaseId'); gh run watch -R "$R" "$RUN"; true
SMOKE=$(gh issue list -R "$R" --label source:smoke --state open --json number --jq '.[0].number'); echo "SMOKE=$SMOKE"
gh workflow run factory-smoke.yml -R "$R"
sleep 20; RUN=$(gh run list -R "$R" -w factory-smoke --limit 1 --json databaseId --jq '.[0].databaseId'); gh run watch -R "$R" "$RUN" --exit-status
gh issue view -R "$R" "$SMOKE" --json comments,labels --jq '{labels: [.labels[].name], last: .comments[-1].body}'
```
Expected: 첫 run은 `checks` 실패, `report` 성공(`{"action":"created",...}`). `source:smoke` 이슈 본문에 주입 대상 URL이 적혀 있다. 두 번째 run은 성공하고, 이슈 마지막 코멘트가 `복구됨:`으로 시작한다(트리아지 코멘트가 그 뒤에 달렸으면 `comments` 전체에서 `복구됨`을 찾는다).

- [ ] **Step 4: 유입 이슈 3종이 트리아지되고 `@factory go` 없이는 구현되지 않음**

```bash
for n in $ERR $SMOKE $(gh issue list -R "$R" --label source:feedback --state open --json number --jq '.[].number'); do
  echo "#$n $(gh issue view -R "$R" "$n" --json labels --jq '[.labels[].name | select(startswith("factory:"))] | join(",")') PR=$(gh pr list -R "$R" --state all --head "factory/issue-$n" --json number --jq 'length')"
done
```
Expected: 모든 줄이 `factory:triaged`이고 `PR=0`이다. 확인 뒤 검증 이슈를 닫는다:
```bash
for n in $ERR $SMOKE $(gh issue list -R "$R" --label source:feedback --state open --json number,title --jq '.[] | select(.title | contains("[검증] 피드백")) | .number'); do
  gh issue close -R "$R" "$n" --comment "P3 유입 라이브 검증 완료. 구현하지 않는다."
done
```

- [ ] **Step 5: 런북·spec 갱신 PR**

`README.md`의 "## 유입과 증거(P3)" 절 끝에 다음 절을 넣는다(`<SEED_PR>`, `<BUG>`, `<FIX_PR>`, `<NEG_PR>`은 `$SCRATCH/p3-evidence.env`의 값으로 바꾼다):
```markdown
## 데모 리허설: 심은 버그

- 버그: `apps/web/src/components/ArticleList.tsx`의 페이지 수 계산을 `Math.ceil`에서 `Math.floor`로 바꾼다. 글이 11-19개면 페이지 버튼이 사라지고 11번째 이후 글에 갈 수 없다. 단위 테스트·RealWorld Hurl·기존 E2E는 이 버그를 잡지 못하고, 데이터는 바뀌지 않는다.
- 2026-10 검증 기록: 버그를 심은 PR #<SEED_PR>, 버그 이슈 #<BUG>, 팩토리 수정 PR #<FIX_PR>, evidence 음성 대조 PR #<NEG_PR>.
- 리허설 순서: (1) 프로덕션 글이 11개 이상인지 확인한다. (2) 위 한 줄을 되돌리는 사람 PR을 병합한다. (3) 버그 템플릿으로 이슈를 연다. (4) 트리아지 뒤 `@factory go`를 남긴다. (5) 수정 PR의 `evidence` 로그에서 "base 종료 코드 1, head 종료 코드 0"을 보여 준다.
```
spec을 고친다. 각 항목은 이 계획의 판정과 라이브 검증 결과를 사실로 기록하는 것이다.
- 4.3 표: T2에 `apps/api/src/middleware/intake.ts`, `apps/api/src/routes/intake.ts`, T3에 `tests/smoke/**`, `apps/web/e2e-smoke/**`를 더한다.
- 4.4: 필수 체크에 `evidence`를 등록한 날짜(Task 14 Step 6)를 적는다.
- 5.1 표: `factory-intake.yml`(schedule 매시 7분·37분, environment `production`), `factory-smoke.yml`(6시간, `checks`·`report` job)을 더하고, `ci.yml`의 `evidence-plan`·`evidence` job 분리를 적는다.
- 6.4 표 `evidence` 행: 실행 대상은 Vitest(`*.test.ts`, `*.test.tsx`), Playwright E2E 제외, `!cancelled()`로 건너뛰지 않음을 적는다.
- 7.1.2·7.1.3: 이 계획 "판정 후보" 절에서 사용자가 확정한 값(테스트 파일 정의, E2E 제외, probe 경로, 정규화 토큰과 정규화 저장, 프레임 위치 제거, 25+25 페이지, `INTAKE_TOKEN` 동기화 방식)을 적는다.
- 9장 P3: 각 항목을 `[x]`로 바꾸고 근거(PR·이슈·run 링크, Step 출력)를 단다. 근거가 없는 항목은 `[ ]`로 두고 이유를 적는다.
- 10.1: 마지막 항목(T2 PR의 리뷰 판정 누락)은 7.1.1에서 해소했다고 바꾸고, README "팩토리 보안 한계"에 더한 P3 항목(evidence의 PR 코드 실행, 레이트 리밋 경합, probe 경로, 배포 기록)을 수용한 잔여 위험으로 옮긴다.
```bash
git switch -c p3-spec-sync main
# 위 수정 적용
pnpm exec prettier --write README.md docs/superpowers/specs/2026-10-11-software-factory-design.md
git add README.md docs/superpowers/specs/2026-10-11-software-factory-design.md
git commit -m "docs: P3 확정 사항·라이브 검증 근거와 데모 리허설 런북

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin p3-spec-sync
gh pr create -R "$R" --base main --head p3-spec-sync --title "docs: P3 확정 사항과 검증 근거" --body "P3 구현 중 확정된 판정과 라이브 검증 근거를 spec에 반영하고, 심은 버그 리허설 절차를 README에 기록한다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: 변경 파일이 모두 T0(`README.md`, `docs/**`)이다. 사람 PR이므로 사용자가 검토·병합한다.

- [ ] **Step 6: P3 완료 조건 대조**

spec 9장 "P3 증거·유입 확장 — 완료 조건" 8개 항목과 근거를 PR #1에 코멘트로 남긴다:

| 완료 조건 | 근거 |
|---|---|
| 7.1.1 임시 분기 제거, T2 PR에도 교차 리뷰 판정 | Task 1 커밋, `workflows.test.ts` "ci.yml judges risk-tier", `review.test.ts` "risk hold" 4개, 다음 T2 봇 PR의 `factory:verdict` 리뷰 |
| `evidence`가 필수 체크로 등록 | Task 14 Step 6 출력(7개) |
| 심은 버그 이슈가 `@factory go` 이후 무개입으로 재현 테스트 → evidence 통과 → 교차 리뷰 → 병합 → 배포, 배포 후 버그 사라짐 | Task 15 Step 4 라벨 전이, 수정 PR, evidence 로그, 페이지 버튼 수 |
| 수정 전 코드에서도 통과하는 테스트만 가진 버그 PR은 evidence 실패 | `evidence-run.test.ts` "fails when the reproduction test also passes on the base tree", Task 15 Step 2 음성 대조 PR 로그 |
| 의도적 에러가 30분 안에 `source:error` 이슈, 반복은 코멘트 | Task 16 Step 1 `T0`와 `createdAt`, "누적 2회" 코멘트 |
| 익명 피드백이 `source:feedback` 이슈, 같은 IP 해시 4번째는 429 | Task 16 Step 2 출력 |
| 스모크 실패가 `source:smoke` 이슈, 복구 후 "복구됨" | Task 16 Step 3 run과 코멘트 |
| 유입 이슈 3종 트리아지, `@factory go` 없이는 구현 안 됨 | Task 16 Step 4 출력, `triage.test.ts` "triages bot-opened intake issues" |

Expected: 모든 행에 근거가 있다. 근거가 없는 행은 미완료로 보고한다.
