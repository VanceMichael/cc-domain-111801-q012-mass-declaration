import { browse, retrieve, retrieveRelations } from './source.mjs';
import { interpret } from './interpret.mjs';
import { interpretRelations } from './relations.mjs';
import { planShipment, normalizeContainers } from './shipment.mjs';
import { assess, summarize, verifyPortal, inScope, declarationKey } from './receiving.mjs';

async function loadRecords(client, archive, references, observations, failures) {
  const records = [];
  for (const reference of references) {
    try {
      const document = await retrieve(client, reference);
      const digest = await archive.preserve(document);
      const record = interpret(document.raw);
      observations.push({
        reference: reference.identity,
        digest,
        location: document.location,
        observedAt: document.observedAt,
        raw: document.raw,
        record,
      });
      records.push({ reference: reference.identity, digest, record, document });
    } catch (error) {
      failures.push({ reference: reference.identity, status: 'error', reason: error.message });
    }
  }
  return records;
}

async function loadRelations(client, archive, references, observations, failures) {
  const relationDocuments = [];
  for (const reference of references) {
    try {
      const document = await retrieveRelations(client, reference);
      const digest = await archive.preserve(document);
      const relation = interpretRelations(document.raw);
      observations.push({ reference: reference.identity, digest, location: document.location, observedAt: document.observedAt, raw: document.raw });
      relationDocuments.push({ identity: reference.identity, digest, document: relation, reference: reference.identity });
    } catch (error) {
      failures.push({ reference: reference.identity, status: 'error', reason: '关联资料未取得：' + error.message });
    }
  }
  return relationDocuments;
}

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  const relations = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  for (const ref of manifest.relationReferences ?? []) {
    const document = await retrieveRelations(client, ref);
    relations.push(interpretRelations(document.raw));
  }
  return { context: manifest.context, entries, relations };
}

function collides(record, accepted) {
  const key = declarationKey(record);
  const identity = record.weighing ?? record.portal ?? record.container;
  return accepted.some(item => item.key !== identity && declarationKey(item.record) === key);
}

function originated(record, items) {
  return items.some(item => item.record.weighing === record.weighing && item.record.container === record.container);
}

/**
 * 领取来源资料、保存原文，再按拆装关系为有依据的箱办理门户录入。
 *
 * 每个结果都回到该箱实际收到的原文与门户回执；部分箱不能办理时其余箱仍按
 * 各自依据办理，complete 只有在全部箱都受理时才为 true。被换下或拆开的
 * 旧箱保留原文收据，但标记为 superseded，不再作为有效申报留存。
 */
export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const failures = [];
  const observations = [];
  const records = await loadRecords(client, archive, manifest.references, observations, failures);
  const relationDocuments = await loadRelations(client, archive, manifest.relationReferences ?? [], observations, failures);

  // 关联资料取得失败时，无法判断现有称重是否已经被换箱/拆箱；把待办箱标为
  // 复查，不替人认可可能已过时的旧箱资料。失败本身也留在结果里。
  const relationFailure = failures.some(item => item.reason.startsWith('关联资料未取得'));
  const blocked = new Map(records.map(item => [item.record.weighing,
    relationFailure ? '关联资料未取得，不能确认是否已换箱或拆箱' : null]).filter(([, reason]) => reason));
  const plan = planShipment({ records, relationDocuments, scope, blocked });
  const requested = normalizeContainers(scope);
  // 换箱/拆箱后的目标箱属于同一票货：来源关系一旦把原箱引向新箱，新箱就在
  // 本次办理范围内，但仍按各自实际的称重、皮重与核准依据逐只判断。
  const effectiveScope = requested === null ? scope : [...new Set([...requested, ...plan.containers])];
  const outcomes = [...failures];

  for (const item of plan.superseded) {
    const changed = archive.supersede(scope, item.key, item.decision);
    if (changed === 0) archive.put(scope, item.key, item.digest, item.record, item.decision);
    if (!item.inScope) continue;
    outcomes.push({
      reference: item.reference,
      digest: item.digest,
      kind: 'origin',
      ...item.decision,
      facts: { container: item.record.container, weighing: item.record.weighing },
    });
  }

  const supersededKeys = new Set(plan.superseded.map(item => item.key));
  const existing = archive.records(scope)
    .filter(row => row.decision.status === 'accepted' && !supersededKeys.has(row.business_key))
    .map(row => row.record);
  const accepted = [];

  for (const task of plan.tasks) {
    let decision;
    try {
      decision = assess(task.record, [...existing, ...accepted.map(item => item.record)], effectiveScope);
      if (decision.status === 'accepted' && collides(task.record, accepted)) {
        decision = { status: 'conflict', reason: '同一箱、同一装箱与核准依据已存在另一份有效申报', key: task.key };
      }
      if (decision.status === 'accepted' && operator) {
        let portal;
        try {
          portal = await operator(task.record);
        } catch (error) {
          decision = { status: 'review', reason: '门户办理未完成：' + error.message, key: task.key };
        }
        if (portal) {
          const confirmation = verifyPortal(task.record, portal);
          decision = confirmation.accepted
            ? { ...decision, portal, receipt: confirmation.receipt }
            : { status: 'review', reason: confirmation.reason, key: task.key, portal };
        }
      }
      archive.put(scope, decision.key ?? task.key, task.digest, task.record, decision);
      if (decision.status === 'accepted') {
        // 同一箱只保留这一份有效申报；被替代的旧结论仍可追溯。
        archive.supersedeContainer(scope, task.record.container, decision.key ?? task.key, {
          status: 'superseded',
          reason: '同一箱已按更新的装箱与核准依据受理，原确认失效',
        });
        accepted.push({ key: decision.key, record: task.record });
      }
      outcomes.push({
        reference: task.reference,
        digest: task.digest,
        kind: task.kind,
        ...decision,
        ...(task.relation ? { relation: task.relation } : {}),
        ...(task.parent ? { parent: task.parent } : {}),
      });
    } catch (error) {
      outcomes.push({ reference: task.reference, digest: task.digest, kind: task.kind, status: 'error', reason: error.message });
    }
  }

  for (const container of plan.missing) {
    outcomes.push({ reference: container, status: 'review', reason: '没有覆盖该箱的称重或拆装依据' });
  }

  // 已收到却没有进入本次办理范围的原文仍保留收据，但不声明完成。
  for (const item of records) {
    const planned = plan.tasks.some(task => task.reference === item.reference) ||
      originated(item.record, plan.superseded);
    if (planned) continue;
    const decision = { status: 'outside', reason: '不是本次办理箱号' };
    archive.put(scope, item.record.weighing, item.digest, item.record, decision);
    outcomes.push({ reference: item.reference, digest: item.digest, ...decision });
  }

  return {
    context: manifest.context,
    observations,
    ...summarize(outcomes, { terminal: ['superseded'] }),
  };
}
