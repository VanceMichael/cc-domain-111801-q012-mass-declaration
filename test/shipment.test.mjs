import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { collect } from '../src/app.mjs';
import { portalServer } from '../src/portal.mjs';
import { operate } from '../src/operator.mjs';
import { interpret } from '../src/interpret.mjs';
import { assess, verifyPortal, declarationKey } from '../src/receiving.mjs';

const base = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const W100 = base.resources['/yard/weighings/records/W100'].body;

function record(id, container, seal, cargoKg, tareKg, extra = {}) {
  return { weighing: id, approval: 'AP2', approvalVersion: 2, container, seal, cargoKg, tareKg, approved: true, ...extra };
}

/**
 * 一票货物：原箱 W100/BOX1，加关联资料与目标箱称重。目标箱的称重既可能作为
 * 独立称重原文出现，也可能只写在拆装关系里。
 */
function shipment({ targets, relations, portalTargets = targets }) {
  const fixture = structuredClone(base);
  const list = fixture.resources['/yard/weighings'].body;
  list.relations = [{ id: 'R100', href: '/yard/weighings/relations/W100', approval: 'AP2' }];
  fixture.resources['/yard/weighings/relations/W100'] = {
    body: { origin: 'W100', approval: 'AP2', approvalVersion: 2, restuffings: relations },
  };
  for (const target of targets) {
    list.weighings.push({ id: target.weighing, href: '/yard/weighings/records/' + target.weighing, approval: target.approval });
    fixture.resources['/yard/weighings/records/' + target.weighing] = { body: target };
    fixture.portal.records[target.weighing] = structuredClone(target);
  }
  for (const target of portalTargets) {
    if (!target?.weighing) continue;
    fixture.portal.records[target.weighing] = { ...fixture.portal.records[target.weighing], ...structuredClone(target) };
  }
  return fixture;
}

async function withShipment(fixture, scope, body) {
  const source = await fixtureSource(fixture);
  const portal = await portalServer(fixture.portal);
  const directory = await mkdtemp(join(tmpdir(), 'shipment-'));
  const archive = await new Archive(directory).start();
  try {
    const result = await collect(new SourceClient(source.url), archive, scope, record => operate(portal.url, record));
    return await body({ result, archive, portal, source });
  } finally {
    archive.close();
    await source.close();
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('换箱后新箱按自己的称重与核准依据受理，旧原件只留追溯', async () => {
  const target = record('W200', 'BOX2', 'SEAL2', '18000', '2300', { packing: 'PK2' });
  const fixture = shipment({
    targets: [target],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W200', seal: 'SEAL2', packing: 'PK2' }] }],
  });
  await withShipment(fixture, ['BOX1'], async ({ result, archive }) => {
    assert.equal(result.complete, true);
    const byReference = new Map(result.outcomes.map(item => [item.reference, item]));
    assert.equal(byReference.get('W100').status, 'superseded');
    const accepted = byReference.get('W200');
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.facts.container, 'BOX2');
    assert.equal(accepted.facts.packing, 'PK2');
    assert.equal(accepted.facts.origin, 'W100');
    assert.equal(accepted.portal.values.container, 'BOX2');
    assert.equal(accepted.portal.values.packing, 'PK2');
    assert.equal(accepted.portal.values.approvalVersion, '2');
    const receipts = archive.records(['BOX1']);
    assert.equal(receipts.filter(row => row.decision.status === 'accepted').length, 1);
    assert.equal(receipts.find(row => row.business_key === 'W100').decision.status, 'superseded');
    // 旧称重原文仍可取回。
    assert.deepEqual(JSON.parse((await archive.original(byReference.get('W100').digest)).toString()), W100);
  });
});

test('拆箱时缺重的箱明确停住，其余箱照常受理且不凑平总重', async () => {
  const fixture = shipment({
    targets: [record('W200', 'BOX2', 'SEAL2', '10000', '2400', { packing: 'PK2' })],
    relations: [{ from: 'BOX1', to: [
      { container: 'BOX2', weighing: 'W200', seal: 'SEAL2', packing: 'PK2' },
      { container: 'BOX3', weighing: 'W300', seal: 'SEAL3', packing: 'PK3', tareKg: '2300' },
    ] }],
  });
  await withShipment(fixture, ['BOX1'], async ({ result, archive }) => {
    assert.equal(result.complete, false);
    assert.equal(result.counts.accepted, 1);
    assert.equal(result.counts.review, 1);
    const box3 = result.outcomes.find(item => item.reference === 'W300');
    assert.equal(box3.status, 'review');
    assert.match(box3.reason, /重量/);
    // 缺重的箱没有得到基于差额推算出来的重量。
    assert.equal(box3.facts, undefined);
    assert.equal(archive.records(['BOX1']).filter(row => row.decision.status === 'accepted').length, 1);
  });
});

test('拆箱质量分配超过原称重时整组停住，不按差额重分', async () => {
  const fixture = shipment({
    targets: [
      record('W200', 'BOX2', 'SEAL2', '10000', '2400'),
      record('W300', 'BOX3', 'SEAL3', '9000', '2300'),
    ],
    relations: [{ from: 'BOX1', to: [
      { container: 'BOX2', weighing: 'W200', seal: 'SEAL2', cargoKg: '10000', tareKg: '2400' },
      { container: 'BOX3', weighing: 'W300', seal: 'SEAL3', cargoKg: '9000', tareKg: '2300' },
    ] }],
  });
  await withShipment(fixture, ['BOX1'], async ({ result }) => {
    assert.equal(result.complete, false);
    assert.equal(result.counts.conflict, 2);
    assert.equal(result.counts.accepted ?? 0, 0);
    for (const outcome of result.outcomes.filter(item => item.kind === 'replacement')) {
      assert.match(outcome.reason, /超过原称重/);
    }
  });
});

test('沿用原箱称重身份或未核准状态不能支撑新箱', async () => {
  const unapproved = record('W200', 'BOX2', 'SEAL2', '18000', '2300', { approved: false });
  const fixture = shipment({
    targets: [unapproved],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W200', seal: 'SEAL2' }] }],
  });
  await withShipment(fixture, ['BOX1'], async ({ result }) => {
    const box2 = result.outcomes.find(item => item.reference === 'W200');
    assert.equal(box2.status, 'review');
    assert.match(box2.reason, /尚未核准/);
  });

  const reused = shipment({
    targets: [],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W100', seal: 'SEAL1', cargoKg: '18000', tareKg: '2200' }] }],
  });
  await withShipment(reused, ['BOX1'], async ({ result }) => {
    const outcome = result.outcomes.find(item => item.kind === 'replacement');
    assert.notEqual(outcome.status, 'accepted');
    assert.match(outcome.reason, /原称重|已用于/);
  });
});

test('重复办理不产生第二份有效申报', async () => {
  const target = record('W200', 'BOX2', 'SEAL2', '18000', '2300', { packing: 'PK2' });
  const fixture = shipment({
    targets: [target],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W200', seal: 'SEAL2', packing: 'PK2' }] }],
  });
  const source = await fixtureSource(fixture);
  const portal = await portalServer(fixture.portal);
  const directory = await mkdtemp(join(tmpdir(), 'repeat-'));
  const archive = await new Archive(directory).start();
  try {
    const client = new SourceClient(source.url);
    const first = await collect(client, archive, ['BOX1'], record => operate(portal.url, record));
    const second = await collect(client, archive, ['BOX1'], record => operate(portal.url, record));
    assert.equal(first.complete, true);
    assert.equal(second.complete, true);
    const rows = archive.records(['BOX1']);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.decision.status === 'accepted').length, 1);
    assert.equal(rows.filter(row => row.decision.status === 'superseded').length, 1);
    assert.equal(declarationKey(rows.find(row => row.decision.status === 'accepted').record), declarationKey(target));
  } finally {
    archive.close();
    await source.close();
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('门户受理对象与依据必须回读一致', () => {
  const target = interpret({ ...record('W200', 'BOX2', 'SEAL2', '18000', '2300', { packing: 'PK2' }) });
  const values = Object.fromEntries(Object.entries(target).map(([name, value]) => [name, String(value)]));
  const receipt = { id: 'RC', identity: 'W200', version: 1, state: 'received', values };
  assert.equal(verifyPortal(target, receipt).accepted, true);
  assert.equal(verifyPortal(target, { ...receipt, identity: 'W999' }).accepted, false);
  assert.equal(verifyPortal(target, { ...receipt, values: { ...values, container: 'BOX1' } }).accepted, false);
  assert.equal(verifyPortal(target, { ...receipt, values: { ...values, packing: 'PK1' } }).accepted, false);
  assert.equal(verifyPortal(target, { ...receipt, values: { ...values, approvalVersion: '1' } }).accepted, false);
  assert.equal(verifyPortal(target, { ...receipt, values: { ...values, approved: 'false' } }).accepted, false);
  assert.equal(verifyPortal(target, { ...receipt, state: 'superseded' }).accepted, false);
});

test('领域判断仍接受原有单箱记录并拒绝重复有效声明', () => {
  const single = interpret(W100);
  assert.equal(assess(single, [], 'BOX1').status, 'accepted');
  const other = interpret({ ...W100, weighing: 'W101', approvalVersion: 1, cargoKg: '19000' });
  assert.equal(assess(other, [single], 'BOX1').status, 'conflict');
  const replacement = interpret({
    ...record('W200', 'BOX2', 'SEAL2', '18000', '2300', { packing: 'PK2' }),
    replacement: true, origin: 'W100', originApproval: 'AP1', originApprovalVersion: 1,
  });
  assert.equal(assess(replacement, [], 'BOX2').status, 'accepted');
  const stale = interpret({
    ...record('W100', 'BOX2', 'SEAL2', '18000', '2300'),
    replacement: true, origin: 'W100', originApproval: 'AP2', originApprovalVersion: 2,
  });
  assert.equal(assess(stale, [], 'BOX2').status, 'review');
});

test('目录列出的关联资料在预览中可见', async () => {
  const target = record('W200', 'BOX2', 'SEAL2', '18000', '2300');
  const fixture = shipment({
    targets: [target],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W200' }] }],
  });
  const source = await fixtureSource(fixture);
  try {
    const client = new SourceClient(source.url);
    const document = await client.get('/yard/weighings/relations/W100');
    assert.equal(document.raw.restuffings[0].from, 'BOX1');
    assert.ok(document.raw.approvalVersion >= 2);
  } finally {
    await source.close();
  }
});

test('保存草稿后人工补正皮重，旧页面不能自行认可未核准数据', async () => {
  const target = record('W200', 'BOX2', 'SEAL2', '18000', '2300', { packing: 'PK2' });
  const fixture = shipment({
    targets: [target],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W200', seal: 'SEAL2', packing: 'PK2' }] }],
  });
  const source = await fixtureSource(fixture);
  const portal = await portalServer(fixture.portal);
  const directory = await mkdtemp(join(tmpdir(), 'revise-'));
  const archive = await new Archive(directory).start();
  try {
    const result = await collect(new SourceClient(source.url), archive, ['BOX1'], record => operate(portal.url, record, {
      afterDraft: () => portal.revise('W200', { tareKg: '2450', operatorNote: '现场补正皮重' }),
    }));
    const box2 = result.outcomes.find(item => item.reference === 'W200');
    assert.equal(box2.status, 'review');
    assert.match(box2.reason, /核准依据|页面依据/);
    assert.equal(result.complete, false);
    const receipts = portal.receipt('W200');
    assert.equal(receipts, undefined);
    // 原提交没有把旧皮重写成有效申报；保存的仍是待复查结论。
    const rows = archive.records(['BOX1']);
    assert.equal(rows.find(row => row.business_key === 'W200').decision.status, 'review');
  } finally {
    archive.close();
    await source.close();
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('关联资料暂时缺失时不替人认可旧箱，明确缺件也不虚报完成', async () => {
  const fixture = shipment({
    targets: [record('W200', 'BOX2', 'SEAL2', '18000', '2300')],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W200' }] }],
  });
  const source = await fixtureSource(fixture);
  const portal = await portalServer(fixture.portal);
  const directory = await mkdtemp(join(tmpdir(), 'relations-'));
  const archive = await new Archive(directory).start();
  try {
    source.replace('/yard/weighings/relations/W100', { status: 404, body: { error: '关联资料暂不存在' } });
    const result = await collect(new SourceClient(source.url), archive, ['BOX1'], record => operate(portal.url, record));
    assert.equal(result.complete, false);
    assert.ok(result.outcomes.some(item => item.reference === 'R100' && item.status === 'error'));
    assert.equal(result.outcomes.find(item => item.reference === 'W100').status, 'review');
    // 门户没有收到任何基于旧箱的申报。
    assert.equal(portal.accesses.filter(entry => entry.operation === 'submit').length, 0);
  } finally {
    archive.close();
    await source.close();
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('门户按受理对象回读箱号、装箱与依据，不靠点击提示', async () => {
  const target = record('W200', 'BOX2', 'SEAL2', '18000', '2300', { packing: 'PK2' });
  const fixture = shipment({
    targets: [target],
    relations: [{ from: 'BOX1', to: [{ container: 'BOX2', weighing: 'W200', seal: 'SEAL2', packing: 'PK2' }] }],
  });
  const portal = await portalServer(fixture.portal);
  try {
    const receipt = await operate(portal.url, target);
    assert.equal(receipt.identity, 'W200');
    assert.equal(receipt.container, 'BOX2');
    assert.equal(receipt.packing, 'PK2');
    assert.equal(receipt.approval, 'AP2');
    assert.equal(receipt.approvalVersion, '2');
    assert.equal(portal.basis('W200').version, 1);
    assert.ok(portal.history.some(item => item.operation === 'draft'));
    assert.ok(portal.history.some(item => item.operation === 'submit'));
  } finally {
    await portal.close();
  }
});
