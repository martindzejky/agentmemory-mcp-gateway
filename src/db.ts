import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export function openSqlite(databasePath: string): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
}

export interface UserRow {
  id: string;
  email: string;
}

export function listUsers(db: Database.Database): UserRow[] {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'`)
    .all() as Array<{ name: string }>;
  if (tables.length === 0) {
    return [];
  }
  return db.prepare(`SELECT id, email FROM user ORDER BY createdAt ASC`).all() as UserRow[];
}

export function closeSqlite(db: Database.Database): void {
  db.close();
}
