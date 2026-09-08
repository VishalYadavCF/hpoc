import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { Db, Executor, Tx } from './database.js';
import { DB } from './tokens.js';

const txStorage = new AsyncLocalStorage<Tx>();

/**
 * Joins the ambient transaction if one is open, otherwise opens one.
 *
 * Every write path takes an Executor. A repository that opens its own transaction breaks
 * the rule that an event is appended in the SAME transaction as the state change it
 * records -- which is what §4.5's guarantees rest on.
 */
@Injectable()
export class UnitOfWork {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The ambient transaction if inside one, else the pool. */
  current(): Executor {
    return txStorage.getStore() ?? this.db;
  }

  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ambient = txStorage.getStore();
    if (ambient) return fn(ambient);
    return this.db.transaction().execute((tx) => txStorage.run(tx, () => fn(tx)));
  }
}
