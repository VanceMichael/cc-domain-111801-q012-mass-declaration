import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { assess, summarize } from '../src/receiving.mjs';
const raw = {"weighing": "W100", "approval": "AP1", "container": "BOX1", "seal": "SEAL1", "cargoKg": "18000", "tareKg": "2200", "approved": true};
const scope = "BOX1";

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.approval, raw.approval);
  assert.equal(assess(actual, [actual], scope).status, 'accepted');
});
test('同一业务依据发生矛盾时不能覆盖接收', () => {
  const first = interpret(raw);
  const changed = interpret({"weighing": "W100", "approval": "AP1", "container": "BOX1", "seal": "SEAL1", "cargoKg": "19000", "tareKg": "2200", "approved": true});
  assert.equal(assess(changed, [first], scope).status, 'conflict');
});
test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assess(interpret(raw), [], 'other-scope');
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});
test('未知数值不得转为零或可接收记录', () => {
  assert.throws(() => interpret({ ...raw, cargoKg: "unknown" }));
  assert.throws(() => interpret({ ...raw, cargoKg: "" }));
  assert.throws(() => interpret({ ...raw, cargoKg: "NaN" }));
  assert.throws(() => interpret({ ...raw, cargoKg: "Infinity" }));
  assert.throws(() => interpret({ ...raw, tareKg: "unknown" }));
  assert.throws(() => interpret({ ...raw, tareKg: "" }));
  assert.throws(() => interpret({ ...raw, tareKg: "NaN" }));
  assert.throws(() => interpret({ ...raw, tareKg: "Infinity" }));
});
test('缺少领域核准或接纳依据时保留待处理', () => {
  assert.notEqual(assess(interpret({"weighing": "W100", "approval": "AP1", "container": "BOX1", "seal": "SEAL1", "cargoKg": "18000", "tareKg": "2200", "approved": false}), [], scope).status, 'accepted');
});
