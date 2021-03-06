import { JsongoDB } from "./JsongoDB";
import {
  DocumentNotFound,
  DuplicateDocumentID,
  DuplicateInputID,
} from "./JsongoError";
import { JsongoID } from "../shared";

import ObjectID from "bson-objectid";
import mingo from "mingo";
import { Cursor } from "mingo/cursor";
import { Query } from "mingo/query";
import sortKeys from "sort-keys";
import valueOrJson from "value-or-json";

//
// JsongoCollection
//

export abstract class JsongoCollection<
  AJsongoDB extends JsongoDB<JsongoCollection> = JsongoDB
> {
  protected _docs: Array<JsongoDoc> | null = null;
  protected _isDirty: boolean = false;

  constructor(protected _name: string, protected _db: AJsongoDB) {}

  //
  // Getters
  //

  count(): number {
    return this.docs().length;
  }

  docs(): Array<JsongoDoc> {
    if (this._docs === null) {
      this._readAndParseJson();
    }
    return this._docs as Array<JsongoDoc>;
  }

  isDirty() {
    return this._isDirty;
  }

  name() {
    return this._name;
  }

  //
  // Queries
  //

  find(criteria: object): Cursor {
    return mingo.find(this.docs(), criteria);
  }

  findOne(criteria: object): JsongoDoc | null {
    const cursor = this.find(criteria);
    if (cursor.hasNext()) {
      return cursor.next();
    } else {
      return null;
    }
  }

  findOneOrFail(criteria: object): JsongoDoc {
    const doc = this.findOne(criteria);
    if (doc === null) {
      throw new DocumentNotFound(criteria);
    }
    return doc;
  }

  exists(criteria: object): boolean {
    return this.find(criteria).hasNext();
  }

  insertOne(doc: InputDoc): JsongoDoc {
    if (doc._id === undefined) {
      // Doesn't have an _id, generate one.
      doc._id = new ObjectID().toHexString();
    } else {
      // Has an _id, probably a duplicate but could be a custom _id.
      if (this.exists({ _id: doc._id })) {
        // Duplicates not allowed, abort.
        throw new DuplicateDocumentID(doc._id, this._name);
      }
    }
    // At this point, doc has an _id.
    const newDoc = doc as JsongoDoc;
    this.docs().push(newDoc);
    return newDoc;
  }

  insertMany(docs: Array<InputDoc>): Array<JsongoDoc> {
    // Perform mass validation.
    const usedIds: Record<string, boolean> = {};
    for (const doc of docs) {
      if (doc._id !== undefined) {
        const key = JSON.stringify(doc._id); // handle composite _id
        // _id may not appear twice.
        if (usedIds[key] === true) {
          throw new DuplicateInputID(doc._id);
        }
        usedIds[key] = true;

        // _id must be vacant.
        if (this.exists({ _id: doc._id })) {
          throw new DuplicateDocumentID(doc._id, this._name);
        }
      }
    }

    // Generate any missing _id's.
    for (const doc of docs) {
      if (doc._id === undefined) {
        doc._id = new ObjectID().toHexString();
      }
    }

    // Batch insert.
    const newDocs = docs as Array<JsongoDoc>;
    this.docs().push(...newDocs);

    return newDocs;
  }

  upsertOne(doc: InputDoc): JsongoDoc {
    if (doc._id !== undefined) {
      // Has an _id, probably an update but could be a custom _id.
      const docIdx = this._findDocumentIndex({ _id: doc._id });
      if (docIdx !== null) {
        // Found the match, replace.
        const newDoc = doc as JsongoDoc;
        this.docs()[docIdx] = newDoc;
        return newDoc;
      }
    }

    return this.insertOne(doc);
  }

  upsertMany(docs: Array<InputDoc>): Array<JsongoDoc> {
    // Perform mass validation.
    const usedIds: Record<string, boolean> = {};
    for (const doc of docs) {
      if (doc._id !== undefined) {
        const key = JSON.stringify(doc._id); // handle composite _id
        // _id may not appear twice.
        if (usedIds[key] === true) {
          throw new DuplicateInputID(doc._id);
        }
        usedIds[key] = true;
      }
    }

    // Filter out docs that need to be batch-inserted.
    const newDocs = docs.filter((doc) => {
      if (doc._id === undefined) {
        // Doesn't have an _id, generate one.
        doc._id = new ObjectID().toHexString();
      } else {
        // Has an _id, probably an update but could be a custom _id.
        const docIdx = this._findDocumentIndex({ _id: doc._id });
        if (docIdx !== null) {
          // Found the match, replace.
          const newDoc = doc as JsongoDoc;
          this.docs()[docIdx] = newDoc;
          // Doesn't qualify for insert.
          return false;
        }
      }
      return true;
    }) as Array<JsongoDoc>;

    this.docs().push(...newDocs);

    return docs as Array<JsongoDoc>;
  }

  deleteOne(criteria: object): { deletedCount: number } {
    const docIdx = this._findDocumentIndex(criteria);
    if (docIdx === null) {
      return { deletedCount: 0 };
    } else {
      this.docs().splice(docIdx, 1);
      return { deletedCount: 1 };
    }
  }

  deleteMany(criteria: object): { deletedCount: number } {
    const docs = this.docs();
    const oldCount = docs.length;
    const query = new Query(criteria);

    this._docs = docs.filter((doc) => !query.test(doc));

    return { deletedCount: oldCount - this._docs.length };
  }

  toJsonObj() {
    const docs = this.docs();
    const sortedDocs = docs.sort((a, b) => {
      let nameA = valueOrJson(a._id);
      if (typeof nameA === "string") nameA = nameA.toUpperCase(); // ignore upper and lowercase
      let nameB = valueOrJson(b._id);
      if (typeof nameB === "string") nameB = nameB.toUpperCase();

      if (nameA < nameB) {
        return -1;
      }
      if (nameA > nameB) {
        return 1;
      }
      // names must be equal
      return 0;
    });
    return sortedDocs.map((doc) => sortKeys(doc, { deep: true }));
  }

  toJson() {
    return JSON.stringify(this.toJsonObj(), null, 2);
  }

  fsck() {
    const thisCollectionName = this._name;
    const thisDB = this._db;
    const errors: object[] = [];

    for (const docItr of this.docs()) {
      // TODO
    }
    function fsckDoc(doc: JsongoDoc) {
      for (const [key, value] of Object.entries(doc)) {
        const relationName = parseJsongoRelationName(key);
        if (relationName !== null) {
          if (Array.isArray(value)) {
            // TODO
            throw new Error("TODO615");
          } else {
            const relatedDocs = thisDB
              .collectionWithName(relationName)
              .find({ _id: value })
              .all();
            if (relatedDocs.length < 1) {
              errors.push({
                error: "No matching related document",
                offending: {
                  collection: thisCollectionName,
                  doc,
                  key,
                },
              });
            } else if (relatedDocs.length > 1) {
              errors.push({
                error: "More than one related document",
                offending: {
                  collection: thisCollectionName,
                  doc,
                  key,
                },
              });
            }
          }
        }
      }
    }
  }

  protected _findDocumentIndex(criteria: object) {
    const query = new Query(criteria);
    const docs = this.docs();
    for (let docIdx = 0; docIdx < docs.length; docIdx++) {
      if (query.test(docs[docIdx])) {
        return docIdx;
      }
    }
    return null;
  }

  protected abstract _readAndParseJson(): void;
}

export function parseJsongoRelationName(fieldName: string): null | string {
  if (fieldName.length > 3 && fieldName.endsWith("_id")) {
    return fieldName.substring(0, fieldName.length - 3);
  } else if (fieldName.length > 5 && fieldName.endsWith("_id)")) {
    const lastOpenParenIdx = fieldName.lastIndexOf("(");
    return fieldName.substring(lastOpenParenIdx + 1, fieldName.length - 4);
  } else {
    return null;
  }
}

// POJO with an obligatory _id key
export interface JsongoDoc extends Record<string, any> {
  _id: JsongoID;
}

// User-supplied POJO with an optional _id key
export interface InputDoc extends Record<string, any> {
  _id?: JsongoID;
}
