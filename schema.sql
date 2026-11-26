-- Baseline SQLite schema. database.cjs applies the version-2 role migration within the same transaction.
CREATE TABLE workspace (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    clock_at INTEGER NOT NULL
) STRICT;
INSERT INTO workspace VALUES (1, 0, 0);

CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'reader')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    must_change INTEGER NOT NULL CHECK (must_change IN (0, 1))
) STRICT;

CREATE TABLE sessions (
    digest TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_by_account ON sessions(account_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

CREATE TABLE account_history (
    sequence INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
    subject_json TEXT NOT NULL CHECK (json_valid(subject_json)),
    action TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json))
) STRICT;

CREATE TABLE tickets (
    uid TEXT PRIMARY KEY,
    sort_key INTEGER NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('pd', 'hybrid', 'gpu')),
    event_id TEXT NOT NULL,
    fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'verify', 'closed')),
    owner TEXT REFERENCES accounts(id),
    priority TEXT NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
    impact TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    cycle_at INTEGER NOT NULL,
    UNIQUE (source, event_id)
) STRICT;

CREATE TABLE timeline (
    uid TEXT NOT NULL REFERENCES tickets(uid),
    ordinal INTEGER NOT NULL,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    PRIMARY KEY (uid, ordinal)
) STRICT;

CREATE TABLE links (
    sequence INTEGER PRIMARY KEY,
    left_uid TEXT NOT NULL REFERENCES tickets(uid),
    right_uid TEXT NOT NULL REFERENCES tickets(uid),
    linked_at INTEGER NOT NULL,
    CHECK (left_uid < right_uid),
    UNIQUE (left_uid, right_uid)
) STRICT;

CREATE TABLE batches (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    batch_json TEXT NOT NULL CHECK (json_valid(batch_json))
) STRICT;

PRAGMA application_id = 0x49445031;
PRAGMA user_version = 1;
