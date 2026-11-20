import { createServer } from 'node:http';

function escape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function scalarEntries(record) {
  return Object.entries(record).filter(([name, value]) =>
    name !== 'associations' && value !== null && typeof value !== 'object');
}

function dispositionOf(values, index) {
  return values['disposition-' + index] ?? '待确认';
}

/**
 * 本机合作门户。受理对象由箱号与封志确定，页面修订号代表当前的核准依据。
 * 保存草稿与确认提交是不同操作；修订号变化后旧页面、旧草稿和旧回执都失效。
 */
export async function portalServer(configuration) {
  const records = structuredClone(configuration.records);
  const versions = new Map(Object.keys(records).map(identity => [identity, configuration.version ?? 1]));
  const drafts = new Map();
  const receipts = new Map();
  const history = [];
  const accesses = [];

  function currentBasis(identity) {
    const record = records[identity];
    const basis = {};
    for (const name of ['container', 'seal', 'approval', 'approvalVersion', 'packing', 'cargoKg', 'tareKg']) {
      if (record[name] !== undefined) basis[name] = String(record[name]);
    }
    if (record.approved !== undefined) basis.approved = String(record.approved);
    return basis;
  }

  /**
   * 页面表单是当前受理对象与依据的投影。提交内容与页面依据不一致时，
   * 说明页面已过期或客户端绕过界面改写存储，直接拒绝。
   */
  function basisMismatch(record, values) {
    const checks = ['container', 'seal', 'approval', 'approvalVersion', 'packing', 'cargoKg', 'tareKg'];
    for (const name of checks) {
      if (record[name] !== undefined && values[name] !== String(record[name])) {
        return (name === 'container' || name === 'seal' ? '箱号或封志' : '核准依据') + '与当前受理对象不符';
      }
    }
    if (record.approved !== undefined && values.approved !== undefined && values.approved !== String(record.approved)) {
      return '核准状态与当前受理对象不符';
    }
    return null;
  }

  function supersedeReceipts(identity) {
    for (const [key, receipt] of receipts) {
      if (receipt.identity === identity && receipt.version !== versions.get(identity)) {
        receipts.set(key, { ...receipt, state: 'superseded' });
      }
    }
  }

  const server = createServer(async (request, response) => {
    try {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const path = new URL(request.url, 'http://localhost').pathname;
      const match = /^\/portal\/([^/]+)(?:\/(draft|submit))?$/.exec(path);
      if (!match || !Object.hasOwn(records, decodeURIComponent(match[1]))) {
        response.writeHead(404); response.end('资料不存在'); return;
      }
      const identity = decodeURIComponent(match[1]);
      const record = records[identity];
      accesses.push({ method: request.method, identity, operation: match[2] ?? 'view' });
      const version = versions.get(identity);
      if (request.method === 'POST') {
        let body = '';
        for await (const part of request) { body += part; if (body.length > 65536) throw new Error('表单过大'); }
        const input = new URLSearchParams(body);
        if (Number(input.get('version')) !== version) {
          response.writeHead(409); response.end('页面依据已变化，请重新核对'); return;
        }
        const submitted = Object.fromEntries(input);
        const draft = drafts.get(identity);
        // 草稿带有全部可见字段；确认提交只引用已保存的草稿。两者都不能绕过
        // 当前受理对象与核准依据。
        const values = match[2] === 'submit' ? draft?.values : submitted;
        if (match[2] === 'submit' && (!draft || draft.version !== version)) {
          response.writeHead(409); response.end('尚无与当前依据一致的草稿'); return;
        }
        const mismatch = basisMismatch(record, values ?? {});
        if (mismatch) { response.writeHead(409); response.end(mismatch + '，请重新核对'); return; }
        if (match[2] === 'draft') {
          drafts.set(identity, { version, values });
          history.push({ identity, operation: 'draft', version, values: structuredClone(values) });
        } else if (match[2] === 'submit') {
          if (record.approved === false) {
            response.writeHead(409); response.end('当前依据尚未核准，不能提交'); return;
          }
          const associations = Array.isArray(record.associations) ? record.associations.map((item, index) => ({
            id: item.id,
            owner: draft.values['relation-' + index] ?? '',
            disposition: dispositionOf(draft.values, index),
          })) : [];
          const receipt = {
            id: 'RC-' + identity + '-' + version,
            identity,
            version,
            container: draft.values.container,
            seal: draft.values.seal,
            packing: draft.values.packing,
            approval: draft.values.approval,
            approvalVersion: draft.values.approvalVersion,
            values: draft.values,
            associations,
            state: 'received',
          };
          for (const [key, before] of receipts) {
            if (before.identity === identity && before.version !== version) receipts.set(key, { ...before, state: 'superseded' });
          }
          receipts.set(identity, receipt);
          drafts.delete(identity);
          history.push({ identity, operation: 'submit', version, receipt: structuredClone(receipt) });
        } else { response.writeHead(405); response.end('操作不支持'); return; }
        response.writeHead(303, { location: '/portal/' + encodeURIComponent(identity) }); response.end(); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const draft = drafts.get(identity);
      const values = draft?.version === version ? draft.values : record;
      const inputs = scalarEntries(record).map(([name, value]) =>
        '<label>' + escape(name) + '<input name="' + escape(name) + '" aria-label="' + escape(name) + '" value="' +
        escape(values[name] ?? value) + '"></label>').join('');
      const relations = Array.isArray(record.associations) ? record.associations.map((item, index) => {
        const current = draft?.version === version ? draft.values : {};
        const owner = current['relation-' + index] ?? item.owner ?? '';
        const disposition = current['disposition-' + index] ?? item.disposition ?? '待确认';
        const options = ['待确认', '接纳', '消耗', '留样', '回收'].map(option =>
          '<option' + (option === disposition ? ' selected' : '') + '>' + option + '</option>').join('');
        return '<fieldset><legend>关联实物 ' + escape(item.id) + '</legend><label>关联归属<input name="relation-' +
          index + '" value="' + escape(owner) + '"></label><label>去向<select name="disposition-' + index + '">' +
          options + '</select></label></fieldset>';
      }).join('') : '';
      const receipt = receipts.get(identity);
      const valid = receipt?.version === version && receipt.state === 'received';
      const state = draft?.version === version
        ? '草稿已保存'
        : valid ? '已受理' : receipt ? '依据变化，原确认失效' : '未办理';
      const basis = JSON.stringify(currentBasis(identity));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>合作资料门户</title></head><body>' +
        '<h1>资料办理</h1><p data-state>' + state + '</p>' +
        '<p data-basis>' + escape(basis) + '</p>' +
        '<form method="post" action="/portal/' + encodeURIComponent(identity) + '/draft">' +
        '<input type="hidden" name="version" value="' + version + '">' + inputs + relations +
        '<button>保存草稿</button></form>' +
        '<form method="post" action="/portal/' + encodeURIComponent(identity) + '/submit">' +
        '<input type="hidden" name="version" value="' + version + '">' +
        '<button>确认提交</button></form>' +
        '<pre data-receipt>' + escape(valid ? JSON.stringify(receipt) : '') + '</pre></body></html>');
    } catch (error) {
      response.writeHead(400); response.end('页面请求失败：' + error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    accesses,
    history,
    basis(identity) { return versions.has(identity) ? { version: versions.get(identity), ...currentBasis(identity) } : undefined; },
    revise(identity, changes) {
      if (!Object.hasOwn(records, identity)) throw new Error('资料不存在');
      Object.assign(records[identity], structuredClone(changes));
      versions.set(identity, versions.get(identity) + 1);
      supersedeReceipts(identity);
    },
    receipt(identity) { return structuredClone(receipts.get(identity)); },
    close() { return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); },
  };
}
