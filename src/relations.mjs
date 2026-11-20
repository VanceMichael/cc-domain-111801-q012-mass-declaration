import { text, decimal, positiveInteger } from './validation.mjs';

function optionalDecimal(value, name) {
  if (value === undefined || value === null) return undefined;
  return decimal(value, name);
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('字段缺失或无效：' + name);
  return value;
}

function targetOf(value, index, owner) {
  if (typeof value === 'string') return { container: text(value, 'restuffing.to') };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('拆装关系目标无效：' + owner + '[' + index + ']');
  }
  const target = { container: text(value.container ?? value.to ?? value.id, 'restuffing.to.container') };
  if (value.seal !== undefined) target.seal = text(value.seal, 'restuffing.to.seal');
  if (value.packing !== undefined) target.packing = text(value.packing, 'restuffing.to.packing');
  if (value.weighing !== undefined) target.weighing = text(value.weighing, 'restuffing.to.weighing');
  if (value.identity !== undefined) target.identity = text(value.identity, 'restuffing.to.identity');
  if (value.approval !== undefined) target.approval = text(value.approval, 'restuffing.to.approval');
  if (value.approvalVersion !== undefined) target.approvalVersion = positiveInteger(value.approvalVersion, 'restuffing.to.approvalVersion');
  const approved = optionalBoolean(value.approved, 'restuffing.to.approved');
  if (approved !== undefined) target.approved = approved;
  const cargoKg = optionalDecimal(value.cargoKg, 'restuffing.to.cargoKg');
  const tareKg = optionalDecimal(value.tareKg, 'restuffing.to.tareKg');
  if (cargoKg !== undefined) target.cargoKg = cargoKg;
  if (tareKg !== undefined) target.tareKg = tareKg;
  return target;
}

/**
 * 解释一份拆装关系资料。`to` 只有一个成员表示换箱，多个成员表示拆成多只箱。
 * 每个目标箱的货物重量、皮重、封志与装箱号只在来源确实给出时保留；未给出的
 * 重量保持未知，绝不用原总重差额补齐。
 */
export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('关联资料不是对象');
  const entries = raw.restuffings ?? raw.restuffing ?? raw.restuff ?? raw.split;
  if (entries === undefined) throw new Error('关联资料没有拆装关系');
  if (!Array.isArray(entries)) throw new Error('拆装关系结构无效');
  const restuffings = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('拆装关系成员无效');
    const from = text(entry.from, 'restuffing.from');
    const rawTargets = Array.isArray(entry.to) ? entry.to : typeof entry.to === 'string' ? [entry.to] : null;
    if (!rawTargets || rawTargets.length === 0) throw new Error('拆装关系缺少目标箱');
    const to = rawTargets.map((value, position) => targetOf(value, position, from));
    if (new Set(to.map(target => target.container)).size !== to.length) throw new Error('拆装关系目标箱重复：' + from);
    const relation = { from, to, kind: to.length === 1 ? 'restuff' : 'split' };
    if (entry.packing !== undefined) relation.packing = text(entry.packing, 'restuffing.packing');
    if (entry.approval !== undefined) relation.approval = text(entry.approval, 'restuffing.approval');
    if (entry.approvalVersion !== undefined) relation.approvalVersion = positiveInteger(entry.approvalVersion, 'restuffing.approvalVersion');
    const approved = optionalBoolean(entry.approved, 'restuffing.approved');
    if (approved !== undefined) relation.approved = approved;
    const cargoKg = optionalDecimal(entry.cargoKg, 'restuffing.cargoKg');
    const tareKg = optionalDecimal(entry.tareKg, 'restuffing.tareKg');
    const pendingKg = optionalDecimal(entry.pendingKg, 'restuffing.pendingKg');
    if (cargoKg !== undefined) relation.cargoKg = cargoKg;
    if (tareKg !== undefined) relation.tareKg = tareKg;
    if (pendingKg !== undefined) relation.pendingKg = pendingKg;
    return relation;
  });
  const document = { restuffings };
  const origin = raw.origin ?? raw.weighing;
  if (origin !== undefined) document.origin = text(origin, 'relations.origin');
  if (raw.approval !== undefined) document.approval = text(raw.approval, 'relations.approval');
  if (raw.approvalVersion !== undefined) document.approvalVersion = positiveInteger(raw.approvalVersion, 'approvalVersion');
  const approved = optionalBoolean(raw.approved, 'relations.approved');
  if (approved !== undefined) document.approved = approved;
  const pendingKg = optionalDecimal(raw.pendingKg, 'relations.pendingKg');
  if (pendingKg !== undefined) document.pendingKg = pendingKg;
  return document;
}
