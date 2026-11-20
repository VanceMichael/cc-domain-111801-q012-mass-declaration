import { text, decimal, positiveInteger } from './validation.mjs';

const OPTIONAL_TEXT = ['packing', 'origin'];

/**
 * 解释来源给出的称重声明。
 *
 * 必需字段保持单箱称重的原有含义；换箱、拆箱资料可以额外给出 packing
 * （哪次装箱）、approvalVersion（该组核准依据的修订号）与 origin
 * （由哪一次原称重产生）。可选字段只在来源确实提供时保留，绝不补默认值，
 * 以免把旧箱、旧封志或旧皮重带进新箱。
 */
export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const cargoKg = decimal(raw.cargoKg, 'cargoKg');
  const tareKg = decimal(raw.tareKg, 'tareKg');
  if (cargoKg < 0 || tareKg <= 0 || typeof raw.approved !== 'boolean') throw new Error('称重资料无效');
  const record = {
    weighing: text(raw.weighing, 'weighing'),
    approval: text(raw.approval, 'approval'),
    container: text(raw.container, 'container'),
    seal: text(raw.seal, 'seal'),
    cargoKg,
    tareKg,
    approved: raw.approved,
  };
  if (raw.packing !== undefined) record.packing = text(raw.packing, 'packing');
  if (raw.approvalVersion !== undefined) record.approvalVersion = positiveInteger(raw.approvalVersion, 'approvalVersion');
  if (raw.replacement !== undefined) {
    if (typeof raw.replacement !== 'boolean') throw new Error('字段缺失或无效：replacement');
    record.replacement = raw.replacement;
  }
  for (const name of OPTIONAL_TEXT) {
    if (raw[name] !== undefined) record[name] = text(raw[name], name);
  }
  if (raw.originApproval !== undefined) record.originApproval = text(raw.originApproval, 'originApproval');
  if (raw.originApprovalVersion !== undefined) {
    record.originApprovalVersion = positiveInteger(raw.originApprovalVersion, 'originApprovalVersion');
  }
  return record;
}
