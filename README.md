# software-factory-demo

GitHub Issues/Actions 위에 구현한 소프트웨어 팩토리 데모. 애플리케이션은 [RealWorld](https://github.com/realworld-apps/realworld)(Conduit)이며, 프론트엔드는 GitHub Pages, 백엔드는 Cloudflare Workers + D1에 배포한다.

- 설계: [docs/superpowers/specs/2026-10-11-software-factory-design.md](docs/superpowers/specs/2026-10-11-software-factory-design.md)
- 개발 지침: [AGENTS.md](AGENTS.md)

## 배포 URL

- 웹: https://roboco.io/software-factory-demo/
- API: https://sfd-api.roboco.workers.dev/api

## 보안

- CI의 Cloudflare 토큰(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)은 워크플로 전체가 아니라 wrangler 또는 Cloudflare API를 호출하는 단계에만 `env`로 전달한다. 의존성 설치, 웹 빌드, Playwright 단계는 이 토큰을 받지 않는다.
- Cloudflare 토큰은 `production`·`preview` environment 시크릿으로만 둔다. 팩토리 워크플로(`factory-*.yml`)는 Cloudflare 토큰을 받지 않는다. 봇 PR이 T2·T3 경로를 바꾸면 `preview.yml`의 `policy` job이 프리뷰 배포를 생략한다.
- 팩토리의 에이전트는 GitHub 토큰이 없는 별도 job(VM)에서 실행되고, prepare job이 배정한 엔진의 API 키 하나만 받는다. push·PR·라벨은 에이전트가 실행된 적 없는 publish job이 새로 발급한 App 토큰으로 한다. publish job은 main을 체크아웃한 별도 디렉토리의 팩토리 CLI를 실행하고, 에이전트가 만든 작업 트리의 코드는 실행하지 않는다.

## 프리뷰 보안 한계

- 프리뷰 웹은 프로덕션 웹과 같은 오리진(`https://roboco.io`)에서 서빙된다. 같은 오리진의 JavaScript는 `localStorage`를 읽을 수 있으므로, PR 코드가 다른 경로의 로그인 토큰을 읽을 수 있다.
- 완화책으로 토큰 키를 API 주소별(`jwt:<API_BASE>`)로 나누고, 프리뷰 Worker마다 PR 번호에서 파생한 별도 `JWT_SECRET`을 쓴다. 프로덕션 토큰은 프리뷰 API에서 검증되지 않는다. 그러나 프리뷰 JS가 프로덕션 토큰을 읽는 것 자체는 막지 못한다.
- 데모 범위에서 수용한 위험이다. 같은 리포 브랜치 PR만 프리뷰를 만들기 때문이다.

## 소프트웨어 팩토리

- 이슈를 열면 트리아지 코멘트가 달린다. 리포 쓰기 권한자가 `@factory go`를 남기면 구현 → 교차 리뷰 → 체크 → 병합 → 배포가 진행된다. `@factory stop`은 진행 중인 run을 취소하고 사람에게 넘긴다.
- 자동 병합은 위험 등급 T0·T1만 한다. T2·T3 PR은 CODEOWNERS 승인 후 사람이 병합한다.
- 런 기록: `factory-data` 브랜치의 `runs/YYYY-MM.jsonl`. 실패율 차단기가 작동하면 리포 변수 `FACTORY_PAUSED`가 `true`가 되고 `factory:alert` 이슈가 열린다. 원인을 확인한 뒤 변수를 `false`로 바꾸면 재개한다.
- 처음 설정: 시크릿 `FACTORY_APP_ID`, `FACTORY_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `DEEPSEEK_API_KEY`와 리포 변수 `FACTORY_BOT_USER_ID`, `CODEX_MODEL`(필수), `CLAUDE_MODEL`, `PI_MODEL`, `FACTORY_DAILY_LIMIT`, `FACTORY_PAUSED`를 둔다. 그다음 App 토큰을 `FACTORY_TOKEN`에 넣고 `pnpm -s factory bootstrap`을 한 번 실행해 라벨과 `factory-data` 브랜치를 만든다(다시 실행해도 결과가 같다).
- 연속 병합으로 대기 중이던 `deploy` run이 취소되면 그 커밋의 이슈가 `factory:merged`에 남는다. 이후 배포가 성공했는지 확인한 뒤 `pnpm -s factory deployed --sha <sha>`로 반영한다(`FACTORY_TOKEN` 필요).

## 배포 롤백

프로덕션 배포·스모크가 실패하면 해당 이슈가 `factory:needs-human` + `source:deploy`가 된다.

1. 이전 Worker 버전을 확인한다: `cd apps/api && pnpm exec wrangler deployments list --name sfd-api`
2. 이전 버전으로 되돌린다: `pnpm exec wrangler rollback <version-id> --name sfd-api -m "<사유>"`
3. D1 마이그레이션은 자동으로 되돌리지 않는다. 되돌려야 하면 역방향 마이그레이션을 사람이 새로 작성해 PR로 병합한다.
4. 웹은 문제 커밋을 revert하는 PR을 병합하면 `deploy` 워크플로가 다시 배포한다.
