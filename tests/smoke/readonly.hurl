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
