import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collect } from '../src/app.mjs';
import { portalServer } from '../src/portal.mjs';
import { operate } from '../src/operator.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));

function summary(name, result) {
  console.log('\n## ' + name);
  console.log('complete=' + result.complete, JSON.stringify(result.counts));
  for (const outcome of result.outcomes) {
    const facts = outcome.facts ? ' ' + JSON.stringify(outcome.facts) : '';
    console.log('- ' + outcome.reference + ' [' + outcome.status + '] ' + (outcome.reason ?? '') + facts);
  }
}

async function runFixture(name, fixture, scope) {
  const source = await fixtureSource(fixture);
  const portal = await portalServer(fixture.portal);
  const directory = await mkdtemp(join(tmpdir(), 'mass-declaration-'));
  const archive = await new Archive(directory).start();
  try {
    const result = await collect(new SourceClient(source.url), archive, scope, record => operate(portal.url, record));
    summary(name, result);
    console.log('已保存原文与收件记录：' + archive.records(scope).map(row =>
      row.business_key + '=' + row.decision.status).join(' '));
    return result;
  } finally {
    archive.close();
    await source.close();
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * 一票换箱/拆箱演示：原箱 W100/BOX1 拆成 BOX2 与 BOX3。BOX2 有完整的新称重
 * 资料，BOX3 缺货物重量与包装封志，因此只有 BOX2 会被门户受理，BOX3 停住等待
 * 现场确认；旧箱称重只留作追溯。
 */
function restuffingFixture() {
  const derived = structuredClone(fixture);
  const list = derived.resources['/yard/weighings'].body;
  list.relations = [{ id: 'R100', href: '/yard/weighings/relations/W100', approval: 'AP2' }];
  derived.resources['/yard/weighings/relations/W100'] = {
    body: {
      origin: 'W100',
      approval: 'AP2',
      approvalVersion: 2,
      restuffings: [{
        from: 'BOX1',
        to: [
          { container: 'BOX2', weighing: 'W200', seal: 'SEAL2', packing: 'PK2' },
          { container: 'BOX3', weighing: 'W300', seal: 'SEAL3', packing: 'PK3', tareKg: '2300' },
        ],
      }],
    },
  };
  const box2 = { weighing: 'W200', approval: 'AP2', approvalVersion: 2, container: 'BOX2', seal: 'SEAL2', packing: 'PK2', cargoKg: '10000', tareKg: '2400', approved: true };
  const box3 = { weighing: 'W300', approval: 'AP2', approvalVersion: 2, container: 'BOX3', seal: 'SEAL3', packing: 'PK3', cargoKg: '8000', tareKg: '2300', approved: true };
  for (const record of [box2, box3]) {
    list.weighings.push({ id: record.weighing, href: '/yard/weighings/records/' + record.weighing, approval: record.approval });
    derived.resources['/yard/weighings/records/' + record.weighing] = { body: record };
    derived.portal.records[record.weighing] = structuredClone(record);
  }
  // 门户上的 BOX3 少了现场还没补正的封志，回读核对会停住而不是强行提交。
  delete derived.portal.records.W300.seal;
  return derived;
}

let failed = false;
try {
  const single = await runFixture('单箱称重录入', fixture, fixture.scope);
  if (!single.complete) failed = true;
  const split = await runFixture('拆箱后逐箱录入', restuffingFixture(), ['BOX1']);
  if (split.complete) failed = true;
} catch (error) {
  console.error(error);
  failed = true;
}
if (failed) process.exitCode = 1;
