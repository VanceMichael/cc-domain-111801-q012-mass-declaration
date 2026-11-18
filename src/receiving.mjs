export function assess(record, previous, scope) {
  if (record.container !== scope) return { status: 'outside', reason: '不是本次办理箱号' };
           if (!record.approved) return { status: 'review', reason: '称重尚未核准，不可办理' };
           const prior = previous.find(item => item.container === record.container && item.approval === record.approval && item.cargoKg + item.tareKg !== record.cargoKg + record.tareKg);
           if (prior) return { status: 'conflict', reason: '同一核准依据存在不同总重' };
           return { status: 'accepted', key: record.weighing, facts: { container: record.container, seal: record.seal, approval: record.approval, massKg: record.cargoKg + record.tareKg } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}

export function verifyPortal(record, receipt) {
  if (!receipt || receipt.state !== 'received' || !receipt.values || !Number.isInteger(receipt.version)) {
    return { accepted: false, reason: '门户没有给出可核对的受理依据' };
  }
  if (receipt.values.container !== String(record.container)) return { accepted: false, reason: '受理依据中的 container 不一致' };
  if (receipt.values.seal !== String(record.seal)) return { accepted: false, reason: '受理依据中的 seal 不一致' };
  if (receipt.values.approval !== String(record.approval)) return { accepted: false, reason: '受理依据中的 approval 不一致' };
  if (receipt.values.cargoKg !== String(record.cargoKg)) return { accepted: false, reason: '受理依据中的 cargoKg 不一致' };
  if (receipt.values.tareKg !== String(record.tareKg)) return { accepted: false, reason: '受理依据中的 tareKg 不一致' };
  return { accepted: true, receipt: receipt.id };
}
