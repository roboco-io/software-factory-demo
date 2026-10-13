# 변경 기록

사용자·운영자·책 독자가 알아야 할 의미 있는 변경을 기록합니다. 기준과 작성 절차는 [project-changelog 스킬](.agents/skills/project-changelog/SKILL.md)에 있습니다. 버전 번호를 임의로 부여하지 않고, 통합·배포를 확인한 한국시간 날짜로 정리합니다.

아래 과거 항목은 확인 가능한 PR의 주요 이력을 요약한 것이며, 모든 커밋이나 릴리스를 나열한 목록은 아닙니다.

## 미출시 (Unreleased)

### 변경

- 저장소 이름과 공개 링크를 `the-software-factory-demo`로 변경하고, 책 집필 프로젝트에서 참조하는 데모의 새 주소를 정리합니다.
- README에 로보코가 제안하는 소프트웨어 팩토리의 구현체라는 이름의 의미와 책 『The Software Factory』와의 관계를 설명합니다. 개발자·운영자 상세 안내를 [별도 문서](docs/operations.md)로 분리합니다.

### 추가

- 변경 기록 파일과 기록·제외 기준을 적용하는 프로젝트 스킬을 추가합니다.

## 2026-10-13

### 추가

- 요청별 처리 타임라인, 자가 개선의 관찰 근거, 에이전트 도구·실제 모델별 실행 결과를 대시보드에 제공합니다. 비용 누락, 표본 부족, 관찰 범위 밖의 데이터를 구분하고 체험·리포지토리 링크를 안내합니다. [PR #60](https://github.com/roboco-io/the-software-factory-demo/pull/60)
- 병렬 로컬 작업에 별도 브랜치와 워크트리를 사용하도록 개발 지침을 명시합니다. [PR #57](https://github.com/roboco-io/the-software-factory-demo/pull/57)

### 변경

- 비개발자가 개념을 이해하고 직접 체험하도록 README에 실행 절차, 권한과 자가 개선 PoC를 안내합니다. [PR #57](https://github.com/roboco-io/the-software-factory-demo/pull/57), [PR #58](https://github.com/roboco-io/the-software-factory-demo/pull/58)
- 프로젝트 자체 코드·문서·설정에 Apache-2.0을 적용하고, RealWorld의 MIT 고지를 보존합니다. [PR #56](https://github.com/roboco-io/the-software-factory-demo/pull/56)

## 2026-10-12

### 추가

- 반복되는 오류 응답 형식 지적을 자동 검사 규칙과 평가 케이스로 전환하는 자가 개선 실험을 검증했습니다. [PR #47](https://github.com/roboco-io/the-software-factory-demo/pull/47)

### 수정

- 이미 개선 규칙으로 처리한 과거 실패가 같은 개선 후보로 다시 선정되지 않게 합니다. [PR #51](https://github.com/roboco-io/the-software-factory-demo/pull/51)
- 후속 배포가 성공하면 대체된 배포 실행에 연결된 이슈의 완료 상태도 반영합니다. [PR #52](https://github.com/roboco-io/the-software-factory-demo/pull/52)
