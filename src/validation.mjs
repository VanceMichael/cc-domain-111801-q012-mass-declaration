export function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('字段缺失或无效：' + name);
  return value;
}

export function decimal(value, name) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('十进制字段无效：' + name);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('数值超出范围：' + name);
  return result;
}

export function positiveInteger(value, name) {
  const result = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(result) || result < 1) throw new Error('正整数字段无效：' + name);
  return result;
}

export function sameNumber(left, right, tolerance = 1e-9) {
  return Math.abs(left - right) <= tolerance;
}
