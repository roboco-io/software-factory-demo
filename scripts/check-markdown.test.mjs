import assert from "node:assert/strict";
import { test } from "node:test";
import { checkText, chunks } from "./check-markdown.mjs";

const kinds = (src) => checkText(src).map((p) => `${p.line}:${p.kind}`);

test("flags a Korean strong span whose closing ** follows punctuation and precedes a letter", () => {
  assert.deepEqual(kinds("첫 줄\n\n고치는 **자가 개선의 개념 검증(PoC)**도 수행한다."), [
    "3:unclosed-strong",
  ]);
});

test("accepts the fixed forms", () => {
  assert.deepEqual(kinds("**자가 개선의 개념 검증**(PoC)도 수행한다."), []);
  assert.deepEqual(kinds("**자가 개선의 개념 검증(PoC)** 도 수행한다."), []);
  assert.deepEqual(kinds("**비개발자도 볼 수 있습니다.** 사람이"), []);
});

test("ignores ** inside code spans and fenced code", () => {
  assert.deepEqual(kinds("`a ** b`\n\n```\nx **y)**z\n\nmore\n```"), []);
});

test("flags tilde pairs that render as strikethrough but not paths in code", () => {
  assert.deepEqual(kinds("3~4시간이 걸리고 5~6개가 필요하다."), ["1:strikethrough"]);
  assert.deepEqual(kinds("키는 `~/.config/x`에 둔다. 3-4시간."), []);
});

test("keeps blank lines inside a fence in the same chunk", () => {
  assert.deepEqual(
    chunks("a\n\n```\nb\n\nc\n```\n\nd").map((c) => c.line),
    [1, 3, 9],
  );
});
