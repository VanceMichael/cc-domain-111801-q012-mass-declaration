import { text } from './validation.mjs';

export const collectionPath = '/yard/weighings';

function referencesFrom(value, context, kind) {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('目录关联资料引用无效');
    return {
      identity: text(entry.id, 'id'),
      href: text(entry.href, 'href'),
      context: entry.approval === undefined ? context : text(entry.approval, 'approval'),
      kind,
    };
  });
}

export async function browse(client) {
  const document = await client.get(collectionPath);
  const raw = document.raw;
  const context = text(raw.approval, 'approval');
  if (!Array.isArray(raw.weighings)) throw new Error('来源目录结构无效');
  // 目录成员可以整体沿用目录上下文；一票货物里新核准的箱也可以显式给出
  // 自己的 approval，仍须逐条与对应原文一致。
  const references = raw.weighings.map(entry => ({
    identity: text(entry.id, 'id'),
    href: text(entry.href, 'href'),
    context: entry.approval === undefined ? context : text(entry.approval, 'approval'),
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  // 关联资料可以挂在目录上，也可以挂在单条称重上；它必须来自同一来源，
  // 但目录不承诺所有关联资料与当前目录同时发布。
  const relationReferences = [
    ...referencesFrom(raw.relations, context, 'relations'),
    ...raw.weighings.flatMap(entry => referencesFrom(entry.relations,
      entry.approval === undefined ? context : text(entry.approval, 'approval'), 'relations')),
  ];
  if (new Set(relationReferences.map(entry => entry.identity)).size !== relationReferences.length) throw new Error('目录包含重复关联资料身份');
  return { context, references, relationReferences };
}

export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.weighing !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.approval !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}

export async function retrieveRelation(client, reference) {
  const document = await client.get(reference.href);
  const raw = document.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('关联资料不是对象');
  if (raw.approval !== undefined && raw.approval !== reference.context) throw new Error('关联资料上下文与目录不符');
  return { ...document, identity: reference.identity };
}

export const retrieveRelations = retrieveRelation;

