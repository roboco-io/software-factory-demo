# 평가 케이스

이 디렉토리는 팩토리 자기개선 PR이 실제로 검출 능력을 높였는지 확인하는 평가 케이스를 둔다.
케이스 하나는 `factory/evals/<slug>/` 디렉토리 하나다. slug는 `[a-z0-9-]`만 쓰고 64자 이하다.
디렉토리 안에 `case.yml`을 둔다. `lint` 종류는 픽스처 파일도 함께 둔다.

## case.yml 종류

`lint`: 픽스처 코드를 지정한 경로에 있는 것처럼 lint한다. 지정한 규칙이 보고되면 검출한 것이다.

- `category`: 개선 후보의 범주(예: `review:error-format`)
- `fixture`: 케이스 디렉토리 안의 파일 이름. 20KB 이하의 일반 파일이어야 한다. 심볼릭 링크는 거부한다.
- `asPath`: 이 경로에 있는 것처럼 lint한다. 작업 트리 안의 안전한 상대 경로여야 한다.
- `rule`: 위반으로 보고되어야 하는 ESLint ruleId

`prompt-contains`: 지정한 파일에 지정한 문장이 들어 있으면 검출한 것이다. NFKC 정규화와 공백 정리 후 비교한다.

- `category`: 개선 후보의 범주
- `file`: `AGENTS.md` 또는 `factory/prompts/<이름>.md`
- `text`: 10자 이상 500자 이하의 문장

## 판정 방법

- 개선 PR에서 새로 추가한 케이스는 base에서 검출되지 않고 head에서 검출되어야 한다.
- 모든 PR에서 head에 있는 모든 케이스는 검출되어야 한다.

픽스처는 일부러 규칙을 어기는 코드이므로 repo의 ESLint와 Prettier 대상에서 제외한다.

## 예시

```yaml
# factory/evals/error-format/case.yml
kind: lint
category: review:error-format
fixture: fixture.ts
asPath: apps/api/src/routes/__eval__.ts
rule: no-restricted-syntax
```
