const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../lib/migrations");

const root = path.join(__dirname, "..");
const dbPath = path.resolve(root, process.env.DATABASE_PATH || "data/app.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
applyMigrations(db, path.join(root, "migrations"));
db.close();
console.log("Migrations applied.");
