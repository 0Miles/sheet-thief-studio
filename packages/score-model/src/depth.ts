// How deep the JSON values of the document may nest (#102, docs/spec/schema.md section 9). lib0's
// readAny, which decodes them, follows a value down one call per level: a value nested some
// thousands deep is one its writer holds and the others cannot decode (`Y.applyUpdate` throws a
// RangeError), each at a depth of its own browser. So no value deeper than `MAX_VALUE_DEPTH` is
// read, written by a command, let in by the server or sent to a member. No DOM here.
import * as Y from "yjs";

/**
 * The deepest a JSON value of the document nests: each list or object is one level, a number, a
 * string or bytes none (`{"a":[1]}` is two). The deepest legal value is two (a note with a bend);
 * the rest is room for the fields of later versions.
 */
export const MAX_VALUE_DEPTH = 64;

/** What a value nested deeper than it may be is copied as: the whole of it, no part kept. */
export const TOO_DEEP = Symbol("nested too deep");

/** What a shared type stands as among the fields of a value: it is not one, and no schema reads it. */
export const SHARED_TYPE = Symbol("a shared type");

/** Whether a value of the document is an object of fields: not a list, nor bytes, nor a shared type. */
export function isFieldObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value) && !(value instanceof Y.AbstractType);
}

/** The fields a value has of its own but __proto__, each as stored; none when it is not an object of fields. */
export function ownEntries(value: unknown): [string, unknown][] {
  return isFieldObject(value) ? Object.entries(value).filter(([name]) => name !== "__proto__") : [];
}

/**
 * A copy of a value as every member holds it (#78): every object in it with the fields it has of
 * its own but one named __proto__, at every level. The member who writes such a field holds it as
 * a field; the others decode it (lib0's readAny) as the prototype of the value, and do not have
 * it. `TOO_DEEP` when it nests more than `levels` deep; a shared type is `SHARED_TYPE`. Follows
 * the value down `levels` deep at most, so that a value nested without end costs little and
 * cannot overflow the stack.
 */
export function ownCopy(value: unknown, levels: number = MAX_VALUE_DEPTH): unknown {
  if (value instanceof Y.AbstractType) return SHARED_TYPE;
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return value;
  if (levels === 0) return TOO_DEEP;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const copy = ownCopy(item, levels - 1);
      if (copy === TOO_DEEP) return TOO_DEEP;
      items.push(copy);
    }
    return items;
  }
  const fields: [string, unknown][] = [];
  for (const [name, field] of ownEntries(value)) {
    const copy = ownCopy(field, levels - 1);
    if (copy === TOO_DEEP) return TOO_DEEP;
    fields.push([name, copy]);
  }
  // Built from entries: a field named __proto__ is never among them, and none becomes a prototype.
  return Object.fromEntries(fields);
}

/** Whether a copy (`ownCopy`) holds a shared type anywhere: a value of the document never does. */
function holdsSharedType(copy: unknown): boolean {
  if (copy === SHARED_TYPE) return true;
  if (Array.isArray(copy)) return copy.some(holdsSharedType);
  return isFieldObject(copy) && Object.values(copy).some(holdsSharedType);
}

/**
 * What a command writes for a value its caller gives it (#102): its own copy (`ownCopy`), so that
 * no __proto__ is written; undefined, and the command writes nothing, when it nests deeper than
 * `MAX_VALUE_DEPTH` or holds a shared type.
 */
export function writableCopy<T>(value: T): T | undefined {
  const copy = ownCopy(value);
  return copy === TOO_DEEP || holdsSharedType(copy) ? undefined : (copy as T);
}

/**
 * What a command that rewrites a value of the document starts from (#103): a note's fields. It is
 * a new object of the fields the value has of its own, each copied as `ownCopy` copies it (no
 * __proto__ at any level, #78). Fields reading does not know are kept, but not one nested so deep
 * that the value would be deeper than `MAX_VALUE_DEPTH`, nor one holding a shared type: no command
 * writes such a value (#102). So every member decides from the same fields and writes the same
 * value. A value that is not an object of fields (a list, a shared type, a string) has none.
 */
export function ownFields(value: unknown): Record<string, unknown> {
  const fields: [string, unknown][] = [];
  for (const [name, field] of ownEntries(value)) {
    const copy = ownCopy(field, MAX_VALUE_DEPTH - 1);
    if (copy !== TOO_DEEP && !holdsSharedType(copy)) fields.push([name, copy]);
  }
  return Object.fromEntries(fields);
}

/** Whether a value nests `levels` deep at most, every field counted, one named __proto__ too: as lib0 writes it. */
function nestsWithin(value: unknown, levels: number): boolean {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || value instanceof Y.AbstractType) return true;
  if (levels === 0) return false;
  for (const item of Array.isArray(value) ? value : Object.values(value)) if (!nestsWithin(item, levels - 1)) return false;
  return true;
}

/** The JSON values the content of an item holds; none for a shared type, text, bytes or a deletion. */
function valuesOf(content: unknown): unknown[] {
  if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON) return content.arr;
  if (content instanceof Y.ContentEmbed) return [content.embed];
  if (content instanceof Y.ContentFormat) return [content.value];
  if (content instanceof Y.ContentDoc) return [content.opts];
  return [];
}

/**
 * Whether every value an update holds nests `MAX_VALUE_DEPTH` deep at most (#102): the server lets
 * in no other (docs/spec/collab.md, section 9). False, never throwing, for an update that cannot
 * even be decoded: lib0's readAny overflows the stack on a value nested some thousands deep.
 */
export function updateWithinDepth(update: Uint8Array): boolean {
  let structs: (Y.Item | Y.GC | Y.Skip)[];
  try {
    ({ structs } = Y.decodeUpdate(update));
  } catch {
    return false;
  }
  return structs.every((struct) => !(struct instanceof Y.Item) || valuesOf(struct.content).every((value) => nestsWithin(value, MAX_VALUE_DEPTH)));
}

/** A shared type of any kind, as its items are reached: its fields, and its list. */
type SharedType = Pick<Y.AbstractType<unknown>, "_map" | "_start">;

/** A value an item of the document holds that nests too deep: where it is, to take it away. */
interface TooDeep {
  item: Y.Item;
  /** Its place among the values of the item. */
  offset: number;
  value: unknown;
}

/** The values nested too deep in a shared type and in those it holds, down to the last. */
function tooDeepIn(type: SharedType, found: TooDeep[]): void {
  for (const item of [...type._map.values(), ...itemsOf(type)]) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentType) tooDeepIn(item.content.type, found);
    valuesOf(item.content).forEach((value, offset) => {
      if (!nestsWithin(value, MAX_VALUE_DEPTH)) found.push({ item, offset, value });
    });
  }
}

/** The items of a list, in its order, deleted ones too. */
function itemsOf(type: SharedType): Y.Item[] {
  const items: Y.Item[] = [];
  for (let item = type._start; item !== null; item = item.right) items.push(item);
  return items;
}

/** What the items of a list of values hold (`Y.Array`), unlike those of a text. */
const LIST_CONTENTS = [Y.ContentAny, Y.ContentJSON, Y.ContentBinary, Y.ContentType, Y.ContentDoc, Y.ContentDeleted];

/** The index of a value of a list: the values before it in the items that are not deleted, and its place in its own. */
function indexIn(list: Y.Array<unknown>, item: Y.Item, offset: number): number {
  let index = 0;
  for (let at = list._start; at !== null && at !== item; at = at.right) if (!at.deleted && at.countable) index += at.length;
  return index + offset;
}

/**
 * Take out of a document every value nested deeper than `MAX_VALUE_DEPTH` (#102), in one
 * transaction: what the server does to a score it loads that holds some, written before there was
 * a limit, before any member is sent it (docs/spec/collab.md, section 2). A field of a map holding
 * an object of fields keeps its fields within the limit (`ownFields`, as a command rewriting it
 * would); any other value nested too deep is removed. True when anything changed.
 */
export function dropTooDeep(doc: Y.Doc): boolean {
  // A top-level type nobody asked for yet is a placeholder: one with fields only is a map, one
  // with a list of values (not text) a list, so that a value is taken out of it alone.
  for (const [name, type] of [...doc.share]) {
    if (Object.getPrototypeOf(type) !== Y.AbstractType.prototype) continue;
    if (type._start === null) doc.getMap(name);
    else if (type._map.size === 0 && itemsOf(type).every((item) => LIST_CONTENTS.some((kind) => item.content instanceof kind))) doc.getArray(name);
  }
  const found: TooDeep[] = [];
  for (const type of doc.share.values()) tooDeepIn(type, found);
  if (found.length === 0) return false;
  doc.transact((transaction) => {
    const inLists: { list: Y.Array<unknown>; index: number }[] = [];
    for (const { item, offset, value } of found) {
      const parent = item.parent;
      if (parent instanceof Y.Map && item.parentSub !== null && item.content instanceof Y.ContentAny && isFieldObject(value)) parent.set(item.parentSub, ownFields(value));
      else if (parent instanceof Y.Array) inLists.push({ list: parent, index: indexIn(parent, item, offset) });
      else item.delete(transaction);
    }
    // The last first: the indexes before it stay where they are.
    for (const { list, index } of inLists.sort((a, b) => b.index - a.index)) list.delete(index, 1);
  });
  return true;
}
