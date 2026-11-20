import { chromium } from 'playwright';

const FIELD_ORDER = ['weighing', 'approval', 'container', 'seal', 'cargoKg', 'tareKg', 'packing', 'approvalVersion', 'approved'];
const ACTION_TIMEOUT = 5000;

function expectedValues(record) {
  const values = {};
  for (const name of FIELD_ORDER) {
    if (record[name] !== undefined && record[name] !== null) values[name] = String(record[name]);
  }
  return values;
}

function pageBasis(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function stateOf(page) {
  const node = page.locator('[data-state]');
  if (await node.count() === 0) return null;
  return (await node.first().textContent()).trim();
}

async function describeFailure(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return body.trim().split('\n').filter(Boolean).slice(0, 3).join(' / ');
}

async function act(page, buttonName, expected) {
  const button = page.getByRole('button', { name: buttonName, exact: true });
  if (await button.count() === 0) throw new Error('门户页面没有“' + buttonName + '”操作');
  const [response] = await Promise.all([
    page.waitForResponse(res => res.url().includes('/portal/'), { timeout: ACTION_TIMEOUT }).catch(() => null),
    button.click(),
  ]);
  if (response && response.status() >= 400) {
    const body = await response.text().catch(() => '');
    throw new Error('门户拒绝' + buttonName + '（' + response.status() + '）：' + (body || '无说明'));
  }
  const state = await page.waitForFunction(
    expectedState => document.querySelector('[data-state]')?.textContent.includes(expectedState),
    expected,
    { timeout: ACTION_TIMEOUT },
  ).then(() => stateOf(page)).catch(() => null);
  if (state === null || !state.includes(expected)) {
    throw new Error('门户未进入“' + expected + '”：' + (state ?? await describeFailure(page)));
  }
}

/**
 * 通过门户可见表单办理一只箱的资料。
 *
 * 只填写来源确实给出的字段；页面缺少待办理字段、页面依据在操作中变化、
 * 或提交后回读的受理对象与依据不一致时，都会以失败返回，不会把点击成功
 * 当作受理成功。返回的 receipt 仍要经过 verifyPortal 复核。
 */
export async function operate(base, record, options = {}) {
  const identity = record.portal ?? record.weighing;
  if (!identity) throw new Error('没有可在门户受理的箱资料身份');
  const expected = expectedValues(record);
  const timeout = options.timeoutMs ?? 10000;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const response = await page.goto(base + '/portal/' + encodeURIComponent(identity), {
      waitUntil: 'domcontentloaded',
      timeout,
    });
    if (!response || response.status() !== 200) throw new Error('门户没有该箱的受理对象：' + identity);

    const before = pageBasis(await page.locator('[data-basis]').textContent());

    for (const [name, value] of Object.entries(expected)) {
      const input = page.getByRole('textbox', { name, exact: true });
      if (await input.count() === 0) throw new Error('门户页面没有可填写的 ' + name + '，不能据此办理');
      await input.fill(value);
    }

    await act(page, '保存草稿', '草稿已保存');
    if (options.afterDraft) await options.afterDraft({ identity, values: { ...expected } });
    await act(page, '确认提交', '已受理');

    const after = pageBasis(await page.locator('[data-basis]').textContent());
    if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('办理过程中核准依据发生变化，回读结果不再有效');
    }

    const text = await page.locator('[data-receipt]').textContent();
    if (!text.trim()) throw new Error('门户没有给出回执');
    const receipt = JSON.parse(text);
    if (receipt.identity !== identity) throw new Error('门户回执业务身份不匹配');
    for (const [name, value] of Object.entries(expected)) {
      if (receipt.values?.[name] !== value) throw new Error('门户回读与提交内容不一致：' + name);
    }
    return receipt;
  } finally {
    await browser.close();
  }
}
