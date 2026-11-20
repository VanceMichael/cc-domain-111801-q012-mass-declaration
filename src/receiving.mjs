/**
 * 领域收件判断。
 *
 * `scope` 保持原有的单箱字符串用法，也接受箱号集合，供一票货物换箱或拆箱后
 * 按可达箱范围统一办理。判断只依据来源声明的字段，不推断、不补零、不按总重
 * 差额分摊。
 */
function scopeSet(scope) {
  if (scope === undefined || scope === null || scope === '*') return null;
  if (Array.isArray(scope) || scope instanceof Set) return new Set(scope);
  if (typeof scope === 'object') {
    if (typeof scope[Symbol.iterator] === 'function') return new Set(scope);
  }
  return null;
}

export function inScope(container, scope) {
  if (scope === undefined || scope === null || scope === '*') return true;
  const set = scopeSet(scope);
  return set ? set.has(container) : container === scope;
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function amount(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sameNumber(left, right) {
  return Math.abs(left - right) <= 1e-9;
}

function totalOf(record) {
  return record.cargoKg + record.tareKg;
}

/**
 * 单条箱资料的收件判断。换箱或拆箱生成的目标箱会带有 `replacement`、
 * `origin` 与 `originApproval`：旧称重原件只能追溯，不能直接支撑新箱的
 * 已核准状态。质量分配问题标为 conflict，缺字段标为 review，两者都不会
 * 被写成 accepted。
 */
export function assess(record, previous = [], scope) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { status: 'error', reason: '领域记录无效' };
  }
  if (!present(record.container)) return { status: 'review', reason: '缺少箱号，不能形成受理对象' };
  if (!inScope(record.container, scope)) return { status: 'outside', reason: '不是本次办理箱号' };

  const declared = Array.isArray(record.declarationIssues) ? record.declarationIssues : [];
  if (declared.length > 0) {
    const blocking = declared.find(issue => issue.status === 'conflict') ?? declared[0];
    return { status: blocking.status ?? 'review', reason: blocking.reason ?? '资料分配未确认' };
  }

  if (!present(record.seal)) return { status: 'review', reason: '缺少封志，不能形成受理对象' };
  if (!present(record.approval)) return { status: 'review', reason: '缺少核准依据，不能办理' };
  if (!present(record.weighing) && !present(record.portal)) return { status: 'review', reason: '缺少称重身份，不能办理' };
  if (record.approved !== true) return { status: 'review', reason: '称重尚未核准，不可办理' };
  if (!amount(record.cargoKg)) return { status: 'review', reason: '缺少货物重量，不能按总重差额推算分配' };
  if (record.cargoKg < 0) return { status: 'conflict', reason: '货物重量为负，质量分配冲突' };
  if (!amount(record.tareKg)) return { status: 'review', reason: '缺少箱体自重' };
  if (record.tareKg <= 0) return { status: 'conflict', reason: '箱体自重无效，质量分配冲突' };

  if (record.replacement) {
    // 换箱或拆箱形成的新箱必须有自己的称重身份与核准依据；沿用原称重原件
    // 的业务身份或同一组依据只能用于追溯，不能支撑新箱的已核准状态。
    if (!present(record.origin) && !present(record.originApproval)) {
      return { status: 'review', reason: '缺少原称重来源，不能确认为新箱依据' };
    }
    if (record.weighing === record.origin) {
      return { status: 'review', reason: '沿用原称重的业务身份，不能支撑新箱的已核准状态' };
    }
    const version = record.approvalVersion ?? 1;
    const originVersion = record.originApprovalVersion ?? 0;
    if (present(record.originApproval) && record.approval === record.originApproval && version <= originVersion) {
      return { status: 'review', reason: '沿用旧称重核准依据，不能支撑新箱的已核准状态' };
    }
  }

  const priorConflict = previous.find(item =>
    item && item.container === record.container &&
    item.approval === record.approval &&
    (item.approvalVersion ?? 1) === (record.approvalVersion ?? 1) &&
    (!sameNumber(totalOf(item), totalOf(record)) ||
      (item.packing !== undefined && record.packing !== undefined && item.packing !== record.packing)));
  if (priorConflict) return { status: 'conflict', reason: '同一核准依据存在不同总重或装箱' };

  const facts = {
    container: record.container,
    seal: record.seal,
    packing: record.packing ?? null,
    approval: record.approval,
    approvalVersion: record.approvalVersion ?? 1,
    weighing: record.weighing ?? null,
    origin: record.origin ?? null,
    massKg: totalOf(record),
  };
  const key = record.weighing ?? record.portal ?? record.container;
  return { status: 'accepted', key, facts };
}

/**
 * 汇总办理结果。`complete` 只有在本次全部箱都被门户受理时才为 true；
 * 被换箱/拆箱替代的旧称重属于可追溯的终态，不计为本次待办理箱。
 */
export function summarize(outcomes, options = {}) {
  const terminal = new Set(options.terminal ?? []);
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  const pending = outcomes.filter(outcome => !terminal.has(outcome.status));
  return {
    complete: pending.length > 0 && pending.every(outcome => outcome.status === 'accepted'),
    counts,
    outcomes,
  };
}

function scalar(record, name) {
  return record[name] === undefined || record[name] === null ? undefined : String(record[name]);
}

/** 同一箱、同一装箱、同一核准修订只能保留一份有效申报。 */
export function declarationKey(record) {
  return [record.container, record.packing ?? '', record.approval, record.approvalVersion ?? 1].join('\u0000');
}

/**
 * 门户回读核对。核对的是受理的是哪只箱、哪次装箱与哪组依据；点击成功或
 * 页面提示不能替代这里的结果。
 */
export function verifyPortal(record, receipt) {
  if (!receipt || receipt.state !== 'received' || !receipt.values || !Number.isInteger(receipt.version)) {
    return { accepted: false, reason: receipt?.reason ?? '门户没有给出可核对的受理依据' };
  }
  if (receipt.identity !== undefined && record.weighing !== undefined && receipt.identity !== String(record.weighing)) {
    return { accepted: false, reason: '受理对象不是本次要办理的箱资料' };
  }
  for (const field of ['container', 'seal', 'approval', 'cargoKg', 'tareKg']) {
    const expected = scalar(record, field);
    if (expected === undefined) return { accepted: false, reason: '待办理资料缺少 ' + field };
    if (receipt.values[field] !== expected) return { accepted: false, reason: '受理依据中的 ' + field + ' 不一致' };
  }
  if (record.packing !== undefined) {
    if (receipt.values.packing !== String(record.packing)) return { accepted: false, reason: '受理依据中的 packing 不一致' };
    if (receipt.packing !== undefined && receipt.packing !== String(record.packing)) return { accepted: false, reason: '回执装箱标识不一致' };
  } else if (receipt.values.packing !== undefined) {
    return { accepted: false, reason: '受理依据包含未能对照的 packing' };
  }
  if (record.approvalVersion !== undefined) {
    if (receipt.values.approvalVersion !== String(record.approvalVersion)) return { accepted: false, reason: '受理依据中的 approvalVersion 不一致' };
  } else if (receipt.values.approvalVersion !== undefined) {
    return { accepted: false, reason: '受理依据包含未能对照的 approvalVersion' };
  }
  if (receipt.values.approved !== undefined && receipt.values.approved !== 'true') {
    return { accepted: false, reason: '门户受理的并不是已核准资料' };
  }
  if (receipt.values.weighing !== undefined && record.weighing !== undefined && receipt.values.weighing !== String(record.weighing)) {
    return { accepted: false, reason: '受理依据中的 weighing 不一致' };
  }
  if (receipt.container !== undefined && receipt.container !== String(record.container)) {
    return { accepted: false, reason: '回执箱号不一致' };
  }
  return { accepted: true, receipt: receipt.id };
}
