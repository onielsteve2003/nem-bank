import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { SnapshotStore } from './types';

const DATABASE = 'nem-mock-bank.db';

let database: Promise<SQLiteDatabase> | null = null;

function open(): Promise<SQLiteDatabase> {
  database ??= openDatabaseAsync(DATABASE).then(async (db) => {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS snapshots (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return db;
  });
  return database;
}

/** expo-sqlite (bundled in Expo Go): one row per snapshot key. */
export function createDeviceStore(): SnapshotStore {
  return {
    async read(key) {
      const db = await open();
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM snapshots WHERE key = ?',
        key,
      );
      return row?.value ?? null;
    },
    async write(key, value) {
      const db = await open();
      await db.runAsync(
        `INSERT INTO snapshots (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        value,
        new Date().toISOString(),
      );
    },
    async remove(key) {
      const db = await open();
      await db.runAsync('DELETE FROM snapshots WHERE key = ?', key);
    },
  };
}
