import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const cargoKg = decimal(raw.cargoKg, 'cargoKg');
           const tareKg = decimal(raw.tareKg, 'tareKg');
           if (cargoKg < 0 || tareKg <= 0 || typeof raw.approved !== 'boolean') throw new Error('称重资料无效');
           return { weighing: text(raw.weighing, 'weighing'), approval: text(raw.approval, 'approval'), container: text(raw.container, 'container'), seal: text(raw.seal, 'seal'), cargoKg, tareKg, approved: raw.approved };
}
