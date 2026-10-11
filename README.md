# software-factory-demo

GitHub Issues/Actions 위에 구현한 소프트웨어 팩토리 데모. 애플리케이션은 [RealWorld](https://github.com/realworld-apps/realworld)(Conduit)이며, 프론트엔드는 GitHub Pages, 백엔드는 Cloudflare Workers + D1에 배포한다.

- 설계: [docs/superpowers/specs/2026-10-11-software-factory-design.md](docs/superpowers/specs/2026-10-11-software-factory-design.md)
- 개발 지침: [AGENTS.md](AGENTS.md)

## 배포 URL

- 웹: https://roboco.io/software-factory-demo/
- API: https://sfd-api.roboco.workers.dev/api

## 보안

- CI의 Cloudflare 토큰(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)은 워크플로 전체가 아니라 wrangler 또는 Cloudflare API를 호출하는 단계에만 `env`로 전달한다. 의존성 설치, 웹 빌드, Playwright 단계는 이 토큰을 받지 않는다.
- P1의 프리뷰와 프로덕션은 같은 토큰을 쓴다. P2에서 에이전트가 브랜치를 푸시하기 전에 두 가지를 먼저 도입해야 한다. 첫째, 프리뷰 전용 최소 권한 토큰이다. 둘째, `production` 환경에 한정한 프로덕션 시크릿이다.

## 프리뷰 보안 한계

- 프리뷰 웹은 프로덕션 웹과 같은 오리진(`https://roboco.io`)에서 서빙된다. 같은 오리진의 JavaScript는 `localStorage`를 읽을 수 있으므로, PR 코드가 다른 경로의 로그인 토큰을 읽을 수 있다.
- 완화책으로 토큰 키를 API 주소별(`jwt:<API_BASE>`)로 나누고, 프리뷰 Worker마다 PR 번호에서 파생한 별도 `JWT_SECRET`을 쓴다. 프로덕션 토큰은 프리뷰 API에서 검증되지 않는다. 그러나 프리뷰 JS가 프로덕션 토큰을 읽는 것 자체는 막지 못한다.
- 데모 범위에서 수용한 위험이다. 같은 리포 브랜치 PR만 프리뷰를 만들기 때문이다.
