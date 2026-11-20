import { inScope } from './receiving.mjs';

export function normalizeContainers(scope) {
  if (scope === undefined || scope === null || scope === '*') return null;
  if (typeof scope === 'string') return [scope];
  if (Array.isArray(scope) || scope instanceof Set) return [...scope];
  if (typeof scope === 'object' && typeof scope[Symbol.iterator] === 'function') return [...scope];
  return null;
}

export function isCollectionScope(scope) {
  return Array.isArray(scope) || scope instanceof Set ||
    (scope !== null && typeof scope === 'object' && typeof scope[Symbol.iterator] === 'function');
}

function sameNumber(left, right) {
  return typeof left === 'number' && typeof right === 'number' && Math.abs(left - right) <= 1e-9;
}

function pick(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function mergeNumber(issues, name, relationValue, directValue) {
  if (relationValue !== undefined && directValue !== undefined && !sameNumber(relationValue, directValue)) {
    issues.push({ status: 'conflict', reason: '关联资料与来源称重的 ' + name + ' 不一致，质量分配冲突' });
    return directValue;
  }
  return pick(directValue, relationValue);
}

function mergeText(issues, name, relationValue, directValue) {
  if (relationValue !== undefined && directValue !== undefined && relationValue !== directValue) {
    issues.push({ status: 'conflict', reason: '关联资料与来源称重的 ' + name + ' 不一致' });
    return directValue;
  }
  return pick(directValue, relationValue);
}

function findOrigin(edge, document, records) {
  if (document.origin !== undefined) {
    const direct = records.find(item => item.record.weighing === document.origin);
    if (direct) return { record: direct.record, entry: direct, issue: null };
    return { record: null, entry: null, issue: '找不到关联资料声明的原称重 ' + document.origin };
  }
  const candidates = records.filter(item => item.record.container === edge.from);
  if (candidates.length === 1) return { record: candidates[0].record, entry: candidates[0], issue: null };
  if (candidates.length === 0) return { record: null, entry: null, issue: '找不到原箱 ' + edge.from + ' 的称重原件' };
  return { record: null, entry: null, issue: '原箱 ' + edge.from + ' 存在多次称重，不能确定本次拆装依据' };
}

/**
 * 同一原箱可能收到多份拆装资料。只采用核准修订最新的一份；同版本存在互相
 * 排斥的内容时，相关目标箱标为冲突，不挑选其中一份。
 */
function selectEdges(relationDocuments, records) {
  const groups = new Map();
  for (const entry of relationDocuments) {
    for (const edge of entry.document.restuffings) {
      const origin = findOrigin(edge, entry.document, records);
      const key = (entry.document.origin ?? '') + '\u0000' + edge.from;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ entry, edge, origin });
    }
  }
  const selected = [];
  for (const candidates of groups.values()) {
    const version = (item) => item.entry.document.approvalVersion ?? item.edge.approvalVersion ?? 0;
    const highest = Math.max(...candidates.map(version));
    const latest = candidates.filter(item => version(item) === highest);
    const signature = (item) => JSON.stringify(item.edge);
    const contested = new Set(latest.map(signature)).size > 1;
    for (const item of contested ? latest : [latest[0]]) {
      selected.push({ ...item, contested });
    }
  }
  return selected;
}

/**
 * 依据来源目录中的称重记录与发布出来的拆装关系，为每只箱形成一条待办。
 *
 * 目标箱的重量、封志与装箱号只取来源确实给出的值；缺失就是缺失，绝不用原
 * 总重差额补齐。目标箱货物重量合计超过原称重时标为质量分配冲突；但同组中
 * 没有缺重、没有冲突的箱仍可单独办理，不会被整票拖成成功或失败。
 * 被换下或拆开的旧箱保留原文收据，但不再作为有效申报。
 */
export function planShipment({ records, relationDocuments = [], scope, blocked = new Map() }) {
  const tasks = [];
  const superseded = [];
  const targetedReferences = new Set();
  const requested = normalizeContainers(scope);
  const reachable = new Set(requested ?? []);
  const handledTargets = new Set();

  const edges = selectEdges(relationDocuments, records);
  for (const { edge } of edges) {
    for (const target of edge.to) reachable.add(target.container);
  }

  const wanted = (container) => requested === null || reachable.has(container);
  const originWanted = (container) => requested === null || requested.includes(container);

  for (const { entry, edge, origin, contested } of edges) {
    const document = entry.document;
    const resolved = edge.to.map(target => {
      const byIdentity = target.weighing === undefined
        ? undefined
        : records.find(item => item.record.weighing === target.weighing);
      const byContainer = records.filter(item => item.record.container === target.container);
      const direct = byIdentity ?? (byContainer.length === 1 ? byContainer[0] : null);
      const issues = [];
      if (origin.issue) issues.push({ status: 'review', reason: origin.issue });
      if (contested) issues.push({ status: 'conflict', reason: '同一原箱存在互相排斥的拆装关系，不能挑选其中一份' });
      const cargoKg = mergeNumber(issues, 'cargoKg', target.cargoKg, direct?.record.cargoKg);
      const tareKg = mergeNumber(issues, 'tareKg', target.tareKg, direct?.record.tareKg);
      const seal = mergeText(issues, 'seal', target.seal, direct?.record.seal);
      const weighing = pick(direct?.record.weighing, target.weighing, target.identity);
      const approval = pick(direct?.record.approval, target.approval, edge.approval, document.approval);
      const approved = pick(direct?.record.approved, target.approved, edge.approved, document.approved);
      const approvalVersion = pick(direct?.record.approvalVersion, target.approvalVersion,
        edge.approvalVersion, document.approvalVersion);
      return {
        container: target.container,
        seal,
        cargoKg,
        tareKg,
        packing: pick(direct?.record.packing, target.packing, edge.packing),
        weighing,
        approval,
        approved,
        approvalVersion,
        direct,
        issues,
      };
    });

    const identities = resolved.map(item => item.weighing).filter(identity => identity !== undefined);
    if (new Set(identities).size !== identities.length) {
      for (const item of resolved) {
        item.issues.push({ status: 'conflict', reason: '同一拆装关系中多次使用同一称重身份' });
      }
    }

    const knownCargo = resolved.map(item => item.cargoKg).filter(value => typeof value === 'number');
    const allocated = knownCargo.reduce((sum, value) => sum + value, 0);
    if (origin.record && typeof origin.record.cargoKg === 'number' && allocated > origin.record.cargoKg + 1e-9) {
      for (const item of resolved) {
        item.issues.unshift({
          status: 'conflict',
          reason: '目标箱货物重量合计 ' + allocated + 'kg 超过原称重 ' + origin.record.cargoKg + 'kg，不按差额重新分配',
        });
      }
    }
    if (origin.record && typeof origin.record.cargoKg === 'number' && allocated < origin.record.cargoKg - 1e-9 &&
        resolved.some(item => item.cargoKg === undefined)) {
      for (const item of resolved.filter(candidate => candidate.cargoKg === undefined)) {
        item.issues.push({ status: 'review', reason: '货物重量未确认，不能为凑平原总重随意分配' });
      }
    }

    for (const item of resolved) {
      if (item.direct) targetedReferences.add(item.direct.reference);
      if (!wanted(item.container)) continue;
      const identity = item.container + '\u0000' + String(item.packing ?? '');
      if (handledTargets.has(identity)) continue;
      handledTargets.add(identity);
      if (item.weighing === undefined) item.issues.push({ status: 'review', reason: '缺少称重身份，不能形成受理对象' });
      if (item.approved === undefined) item.issues.push({ status: 'review', reason: '缺少核准状态，不可办理' });
      else if (item.approved !== true) item.issues.push({ status: 'review', reason: '新箱称重尚未核准，不可办理' });
      if (item.weighing !== undefined && origin.record && item.weighing === origin.record.weighing) {
        item.issues.push({ status: 'review', reason: '沿用原称重的业务身份，不能支撑新箱的已核准状态' });
      }
      if (item.weighing !== undefined) {
        const prior = records.find(record => record.record.weighing === item.weighing);
        if (prior && prior.record.container !== item.container) {
          item.issues.push({ status: 'conflict', reason: '称重身份已用于另一只箱 ' + prior.record.container });
        }
        if (blocked.has(item.weighing)) item.issues.push({ status: 'review', reason: blocked.get(item.weighing) });
      }
      const record = {
        weighing: item.weighing,
        approval: item.approval,
        container: item.container,
        seal: item.seal,
        cargoKg: item.cargoKg,
        tareKg: item.tareKg,
        approved: item.approved,
      };
      if (item.packing !== undefined) record.packing = item.packing;
      if (item.approvalVersion !== undefined) record.approvalVersion = item.approvalVersion;
      record.replacement = true;
      if (origin.record) {
        record.origin = origin.record.weighing;
        record.originApproval = origin.record.approval;
        record.originApprovalVersion = origin.record.approvalVersion ?? 1;
      }
      if (item.issues.length > 0) record.declarationIssues = item.issues;
      tasks.push({
        kind: 'replacement',
        reference: item.direct?.reference ?? item.weighing ?? item.container,
        key: item.direct?.record.weighing ?? item.weighing ?? item.container,
        digest: item.direct?.digest ?? entry.digest,
        record,
        relation: { identity: entry.identity, digest: entry.digest },
        parent: origin.entry?.reference ?? null,
      });
    }

    if (origin.entry) {
      superseded.push({
        reference: origin.entry.reference,
        key: origin.entry.record.weighing,
        digest: origin.entry.digest,
        record: origin.entry.record,
        inScope: originWanted(origin.record.container),
        decision: {
          status: 'superseded',
          reason: '原箱 ' + origin.record.container + ' 已' + (edge.to.length === 1 ? '换箱为 ' : '拆分为 ') +
            edge.to.map(target => target.container).join('、') + '，旧称重原件仅留作追溯',
        },
      });
      targetedReferences.add(origin.entry.reference);
    }
  }

  for (const item of records) {
    if (targetedReferences.has(item.reference)) continue;
    if (requested !== null && !reachable.has(item.record.container)) continue;
    const record = { ...item.record };
    if (blocked.has(record.weighing)) {
      record.declarationIssues = [{ status: 'review', reason: blocked.get(record.weighing) }];
    }
    tasks.push({
      kind: 'direct',
      reference: item.reference,
      key: record.weighing,
      digest: item.digest,
      record,
    });
  }

  const represented = new Set([...tasks.map(task => task.record.container), ...superseded.map(item => item.record.container)]);
  const missing = (requested ?? []).filter(container => !represented.has(container));
  const containers = [...new Set([...reachable, ...tasks.map(task => task.record.container)])];

  return { tasks, superseded, missing, containers };
}
