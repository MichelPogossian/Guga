-- Guga — schéma initial (CDC technique §5). Identifiants internes : ULID.

CREATE TABLE mailbox (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('primary','shared')),
  address TEXT NOT NULL UNIQUE,
  connector TEXT NOT NULL,
  default_column TEXT,
  delta_state TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  last_error TEXT
);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id),
  ext_id TEXT NOT NULL,
  internet_message_id TEXT,
  conversation_id TEXT,
  from_addr TEXT NOT NULL,
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  body_hash TEXT,
  headers_json TEXT NOT NULL DEFAULT '{}',
  links_json TEXT NOT NULL DEFAULT '[]',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT NOT NULL DEFAULT '',
  folder_ext_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_deleted_remote INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  UNIQUE (mailbox_id, ext_id)
);
CREATE INDEX idx_message_received ON message(received_at DESC);
CREATE INDEX idx_message_conv ON message(conversation_id);
CREATE INDEX idx_message_imid ON message(internet_message_id);

CREATE VIRTUAL TABLE message_fts USING fts5(
  subject, body_text, from_addr, attachment_names, case_label,
  content='', tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE message_vec (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL
);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES attachment(id),
  ext_id TEXT,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  cache_path TEXT,
  ocr_done INTEGER NOT NULL DEFAULT 0,
  piece_number INTEGER,
  piece_title TEXT,
  cached_at TEXT
);
CREATE INDEX idx_attachment_msg ON attachment(message_id);

CREATE TABLE column_def (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  ord INTEGER NOT NULL,
  allows_delete INTEGER NOT NULL DEFAULT 0,
  status_schema TEXT NOT NULL DEFAULT '[]',
  color TEXT
);

CREATE TABLE placement (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  column_code TEXT NOT NULL REFERENCES column_def(code),
  status TEXT,
  is_urgent INTEGER NOT NULL DEFAULT 0,
  deadline_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('ai','user','rule')),
  confidence REAL NOT NULL DEFAULT 0,
  to_confirm INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  case_id TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_placement_col ON placement(column_code, processed, updated_at DESC);

CREATE TABLE placement_history (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  from_column TEXT, to_column TEXT,
  from_status TEXT, to_status TEXT,
  actor TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_ph_msg ON placement_history(message_id, at);

CREATE TABLE case_ref (
  id TEXT PRIMARY KEY,
  secib_ref TEXT UNIQUE,
  label TEXT NOT NULL,
  parties_json TEXT NOT NULL DEFAULT '[]',
  counsel_json TEXT NOT NULL DEFAULT '[]',
  court TEXT,
  hearing_dates_json TEXT NOT NULL DEFAULT '[]',
  last_synced_at TEXT
);

CREATE TABLE case_link (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES case_ref(id),
  source TEXT NOT NULL CHECK (source IN ('ai','user','rule')),
  confidence REAL NOT NULL DEFAULT 0,
  validated_by_user INTEGER NOT NULL DEFAULT 0,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (message_id, case_id)
);

CREATE TABLE contact (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emails_json TEXT NOT NULL DEFAULT '[]',
  role TEXT NOT NULL CHECK (role IN ('partner','associate','opponent','expert','client','clerk','accounting','other')),
  bar_id TEXT,
  firm TEXT,
  phone TEXT
);

CREATE TABLE rib_request (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  instructed_by TEXT,
  recipient_kind TEXT CHECK (recipient_kind IN ('internal','opponent','other')),
  recipient_contact TEXT,
  case_id TEXT,
  ecarpa_created INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'A_EDITER',
  status_since TEXT NOT NULL,
  protocol_doc_id TEXT
);

CREATE TABLE hearing_pack (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  hearing_at TEXT,
  court TEXT,
  send_status TEXT,
  last_conclusions_att_id TEXT,
  bordereau_att_id TEXT,
  print_profile_json TEXT NOT NULL DEFAULT '{}',
  generated_paths_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE new_case_check (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  extracted_json TEXT NOT NULL DEFAULT '{}',
  checks_json TEXT NOT NULL DEFAULT '[]',
  verdict TEXT NOT NULL DEFAULT 'PENDING' CHECK (verdict IN ('VERIFIE','INCOHERENCE','PENDING')),
  discrepancies_json TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT
);

CREATE TABLE procedural_alert (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  due_at TEXT,
  legal_basis TEXT,
  evidence TEXT,
  case_id TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE expertise_item (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('simple','dire','dates','accedit','rapport')),
  represents_party TEXT,
  notified_to_json TEXT NOT NULL DEFAULT '[]',
  notified_at TEXT,
  draft_id TEXT
);

CREATE TABLE call_note (
  id TEXT PRIMARY KEY,
  caller TEXT NOT NULL,
  phone TEXT,
  case_id TEXT,
  subject TEXT,
  forwarded_to TEXT,
  draft_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  predicted_column TEXT,
  corrected_column TEXT NOT NULL,
  features_snapshot_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX idx_feedback_msg ON ai_feedback(message_id);

-- Journal d'audit en ajout seul, chaîné par hachage (§11)
CREATE TABLE action_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log est en ajout seul'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log est en ajout seul'); END;

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 5,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX idx_job_pick ON job(state, run_after, priority);

CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE column_filter (
  column_code TEXT PRIMARY KEY,
  filter_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_trace (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  output_json TEXT NOT NULL,
  at TEXT NOT NULL
);

-- Colonnes métier de base (F§5)
INSERT INTO column_def(code,label,ord,allows_delete,status_schema,color) VALUES
 ('PUBS','Pubs / Newsletters',1,1,'[]','#8b5cf6'),
 ('CC','En simple copie',2,1,'["RATTACHE","NON_RATTACHE"]','#64748b'),
 ('RIB','RIB CARPA',3,0,'["A_EDITER","A_VERIFIER","A_FAIRE_VERIFIER","EN_ATTENTE","A_ENVOYER_AVEC_PROTOCOLE","ENVOYE"]','#f59e0b'),
 ('PLAIDOIRIE','Dossiers de plaidoirie',4,0,'["A_PREPARER","GENERE","IMPRIME"]','#0ea5e9'),
 ('INSTR_ASSOC','Instructions associés',5,0,'["A_TRAITER","EN_COURS","FAIT"]','#ef4444'),
 ('INSTR_COLLAB','Instructions collaborateurs',6,0,'["A_TRAITER","EN_COURS","FAIT"]','#f97316'),
 ('NOUVEAUX','Nouveaux dossiers',7,0,'["PENDING","VERIFIE","INCOHERENCE","SAISI"]','#10b981'),
 ('PROCEDURE','Procédure',8,0,'["A_ACCUSER","ACCUSE","AGENDA"]','#dc2626'),
 ('PIECES','Pièces à télécharger',9,0,'["A_TELECHARGER","TELECHARGE","DECOUPE","RATTACHE"]','#14b8a6'),
 ('EXPERTISE','Expertise',10,0,'["A_QUALIFIER","DATES_PROPOSEES","NOTIFIE"]','#a855f7'),
 ('CONTACT','Boîte CONTACT',11,0,'["A_TRAITER","TRAITE"]','#3b82f6'),
 ('CLAIRE','Claire',12,0,'["A_TRAITER","TRANSFERE_COMPTA","TRAITE"]','#ec4899');

INSERT INTO action_log(at,actor,action,target_kind,target_id,payload_json,result,prev_hash,hash)
VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','audit.genesis',NULL,NULL,'{}','ok','0000000000000000000000000000000000000000000000000000000000000000','genesis');
