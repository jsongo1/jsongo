import { AJsongoDB, JsongoFSDB } from "./JsongoDB";

const ObjectID = require("bson-objectid");
import mingo from "mingo";
import { Cursor } from "mingo/cursor";
import { Query } from "mingo/query";
const sortKeys = require("sort-keys");
const valueOrJson = require("value-or-json");

import path from "path";
import fs from "fs";
import { assert } from "mingo/util";

//
// AJsongoCollection
//

export abstract class AJsongoCollection {
  protected _name: string;
  protected _db: AJsongoDB;
  protected _docs: Docs | null;
  protected _isDirty: boolean;

  constructor(args: AJsongoCollectionCtr) {
    this._name = args.name;
    this._db = args.db;

    this._docs = null;
    this._isDirty = false;
  }

  find(criteria: object): Cursor {
    return mingo.find(this.docs(), criteria);
  }

  findOne(criteria: object): GenericDoc | null {
    const cursor = this.find(criteria);
    if (cursor.hasNext()) {
      return cursor.next();
    } else {
      return null;
    }
  }

  docs(): Docs {
    if (this._docs === null) {
      this._readAndParseJson();
    }
    return this._docs as Docs;
  }

  count(): number {
    return this.docs().length;
  }

  save(doc: GenericDoc): GenericDoc {
    const docs = this.docs();
    if ((doc as any)._id === undefined) {
      // Doesn't have an _id, it's an insert.
      (doc as any)._id = ObjectID().toHexString();
    } else {
      // Has an _id, probably an update but may be an insert with a custom _id.
      const docIdx = this._findDocumentIndex(
        new Query({ _id: (doc as any)._id })
      );

      if (docIdx === null) {
        // Didn't find an existing document with the same _id, so it's an insert.
      } else {
        // It's an update, delete the original.
        docs.splice(docIdx, 1);
      }
    }
    docs.push(doc);
    return doc;
  }

  upsert(doc: GenericDoc): GenericDoc | null {
    let matchCount = 0;
    const query = new mingo.Query(doc);
    for (const docItr of this.docs()) {
      if (query.test(docItr)) {
        if (matchCount === 0) {
          (doc as any)._id = (doc as any)._id;
        }
        matchCount++;
      }
    }

    if (matchCount > 1) {
      return null;
    } else {
      return this.save(doc);
    }
  }

  deleteOne(criteria: object): { deletedCount: number } {
    const query = new Query(criteria);
    const docIdx = this._findDocumentIndex(query);
    if (docIdx === null) {
      return { deletedCount: 0 };
    } else {
      this.docs().splice(docIdx, 1);
      return { deletedCount: 1 };
    }
  }

  isDirty() {
    return this._isDirty;
  }

  toJsonObj() {
    const docs = this.docs();
    const sortedDocs = docs.sort(function (a: any, b: any) {
      const nameA = valueOrJson(a._id).toUpperCase(); // ignore upper and lowercase
      const nameB = valueOrJson(b._id).toUpperCase();
      if (nameA < nameB) {
        return -1;
      }
      if (nameA > nameB) {
        return 1;
      }
      // names must be equal
      return 0;
    });
    return sortedDocs.map((doc: any) => sortKeys(doc, { deep: true }));
  }

  toJson() {
    return JSON.stringify(this.toJsonObj(), null, 2);
  }

  fsck() {
    const thisCollectionName = this._name;
    const thisDB = this._db;
    const errors: object[] = [];

    for (const docItr of this.docs()) {
    }
    function fsckDoc(doc: GenericDoc) {
      for (const [key, value] of Object.entries(doc)) {
        const relationName = parseJsongoRelationName(key);
        if (relationName !== null) {
          if (Array.isArray(value)) {
            // TODO
            assert(false, "TODO615");
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

  abstract saveFile(): void;

  protected _findDocumentIndex(query: Query) {
    const docs = this.docs();
    for (let docIdx = 0; docIdx < docs.length; docIdx++) {
      if (query.test(docs[docIdx])) {
        return docIdx;
      }
    }
    return null;
  }

  abstract _readAndParseJson(): void;
}

interface AJsongoCollectionCtr {
  name: string;
  db: AJsongoDB;
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

//
// JsongoMemCollection
//

export class JsongoMemCollection extends AJsongoCollection {
  _readAndParseJson(): void {
    this._docs = [];
  }
  saveFile(): void {
    // No-op since the docs are already in memory.
  }
}

//
// JsongoFSCollection
//

export class JsongoFSCollection extends AJsongoCollection {
  _readAndParseJson(): void {
    try {
      const jsonBuf = this._fs().readFileSync(this._filePath());
      this._docs = JSON.parse(jsonBuf as any);
    } catch (ex) {
      if (ex.code === "ENOENT") {
        this._docs = [];
        this._isDirty = true;
        // console.log("ENOENT", this);
      } else {
        throw ex;
      }
    }
  }
  saveFile(): void {
    this._fs().writeFileSync(this._filePath(), this.toJson() + "\n");
  }
  _filePath() {
    // Note: path.format({dir:"/", name:"uno", ext:".json"}) returns "//uno.json", which is weird but seemingly harmless.
    return path.format({
      dir: this._fsdb()._dirPath,
      name: this._name,
      ext: ".json",
    });
  }
  _fsdb(): JsongoFSDB {
    return this._db as JsongoFSDB;
  }
  _fs(): typeof fs {
    return this._fsdb()._fs;
  }
}

export type GenericDoc = object;
export type Docs = Array<GenericDoc>;
