import { randomBytes } from 'node:crypto';
import type { HiddenThread, MarginComment, SpecDocument } from '../shared/types.js';
import { hunkFor, parseUnifiedDiff } from './diff.js';

/**
 * A pre-baked PR so the full UI and Sync flow work without a repo, `gh`, or
 * an API key. The diff is real `git diff` output; anchors point at its
 * new-side line numbers.
 */
export const DEMO_DIFF = `
diff --git a/migrations/0042_ingest_jobs.sql b/migrations/0042_ingest_jobs.sql
new file mode 100644
index 0000000..3237402
--- /dev/null
+++ b/migrations/0042_ingest_jobs.sql
@@ -0,0 +1,8 @@
+ALTER TABLE ingest_jobs
+    ADD COLUMN worker_id TEXT,
+    ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
+    ADD COLUMN last_error TEXT;
+
+CREATE INDEX ingest_jobs_pending_idx
+    ON ingest_jobs (status, created_at)
+    WHERE status = 'pending';
diff --git a/services/ingest/handler.py b/services/ingest/handler.py
new file mode 100644
index 0000000..aef567b
--- /dev/null
+++ b/services/ingest/handler.py
@@ -0,0 +1,52 @@
+"""HTTP entrypoint: POST /ingest with an S3 event notification."""
+import csv
+import io
+import json
+import logging
+
+import boto3
+from botocore.exceptions import ClientError
+
+from services.ingest.jobs import enqueue_job
+from services.ingest.store import insert_rows
+
+log = logging.getLogger(__name__)
+s3 = boto3.client("s3")
+
+MAX_OBJECT_BYTES = 50 * 1024 * 1024
+REQUIRED_COLUMNS = {"account_id", "amount", "currency", "booked_at"}
+
+
+def handle_ingest(request):
+    event = json.loads(request.body)
+    results = []
+
+    for record in event.get("Records", []):
+        bucket = record["s3"]["bucket"]["name"]
+        key = record["s3"]["object"]["key"]
+        size = record["s3"]["object"].get("size", 0)
+
+        if size > MAX_OBJECT_BYTES:
+            log.warning("skipping %s/%s: %d bytes exceeds limit", bucket, key, size)
+            continue
+
+        try:
+            obj = s3.get_object(Bucket=bucket, Key=key)
+            body = obj["Body"].read().decode("utf-8")
+            reader = csv.DictReader(io.StringIO(body))
+
+            missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
+            if missing:
+                log.error("missing columns %s in %s", sorted(missing), key)
+                continue
+
+            rows = [r for r in reader if r["amount"]]
+            inserted = insert_rows(rows)
+            job_id = enqueue_job(bucket, key)
+            results.append({"key": key, "rows": inserted, "job_id": job_id})
+        except ClientError as exc:
+            log.error("s3 read failed for %s: %s", key, exc)
+        except Exception:
+            log.exception("ingest failed for %s", key)
+
+    return {"status": 200, "body": json.dumps({"ingested": results})}
diff --git a/services/ingest/jobs.py b/services/ingest/jobs.py
index 22cdfa3..92c6221 100644
--- a/services/ingest/jobs.py
+++ b/services/ingest/jobs.py
@@ -4,6 +4,8 @@ from typing import Optional
 
 from services.db import get_conn
 
+MAX_ATTEMPTS = 3
+
 
 @dataclass
 class IngestJob:
@@ -23,6 +25,33 @@ def enqueue_job(bucket: str, key: str) -> int:
         return row[0]
 
 
+def claim_next_job(worker_id: str) -> Optional[IngestJob]:
+    """Pick the oldest pending job and assign it to this worker."""
+    with get_conn() as conn:
+        row = conn.execute(
+            "SELECT id, bucket, key, status, attempts FROM ingest_jobs "
+            "WHERE status = 'pending' AND attempts < %s "
+            "ORDER BY created_at LIMIT 1",
+            (MAX_ATTEMPTS,),
+        ).fetchone()
+        if row is None:
+            return None
+        conn.execute(
+            "UPDATE ingest_jobs SET status = 'running', worker_id = %s, "
+            "attempts = attempts + 1 WHERE id = %s",
+            (worker_id, row[0]),
+        )
+        return IngestJob(*row)
+
+
 def mark_done(job_id: int) -> None:
     with get_conn() as conn:
         conn.execute("UPDATE ingest_jobs SET status = 'done' WHERE id = %s", (job_id,))
+
+
+def mark_failed(job_id: int, error: str) -> None:
+    with get_conn() as conn:
+        conn.execute(
+            "UPDATE ingest_jobs SET status = 'pending', last_error = %s WHERE id = %s",
+            (error[:500], job_id),
+        )
`;

type DemoAnchor = [file: string, start: number, end: number];

interface DemoClause {
  id: string;
  text: string;
  anchors: DemoAnchor[];
  riskFlag?: string;
}

const HANDLER = 'services/ingest/handler.py';
const JOBS = 'services/ingest/jobs.py';
const MIGRATION = 'migrations/0042_ingest_jobs.sql';

const SECTIONS: { title: string; clauses: DemoClause[] }[] = [
  {
    title: 'Request Intake',
    clauses: [
      {
        id: 's1-c1',
        text: '`handle_ingest` parses the request body as JSON and processes every S3 record in `Records`; a body without `Records` returns 200 with an empty `ingested` list.',
        anchors: [[HANDLER, 20, 24]],
      },
      {
        id: 's1-c2',
        text: 'Objects whose event-reported size exceeds 50 MB are skipped with a warning log and are left out of the response without any error.',
        anchors: [[HANDLER, 16, 16], [HANDLER, 27, 31]],
        riskFlag: 'oversized files dropped silently',
      },
      {
        id: 's1-c3',
        text: 'Object size is read from the event payload and defaults to 0 when absent, so objects with no size field are always downloaded regardless of size.',
        anchors: [[HANDLER, 27, 27]],
      },
    ],
  },
  {
    title: 'File Ingestion Flow',
    clauses: [
      {
        id: 's2-c1',
        text: 'Each object is read fully into memory with a single `read()` call and decoded as UTF-8 before CSV parsing begins.',
        anchors: [[HANDLER, 34, 36]],
      },
      {
        id: 's2-c2',
        text: 'If the CSV header is missing any of `account_id`, `amount`, `currency`, or `booked_at`, the file is logged and skipped; no job is enqueued and the caller is not told.',
        anchors: [[HANDLER, 17, 17], [HANDLER, 38, 41]],
        riskFlag: 'schema errors swallowed',
      },
      {
        id: 's2-c3',
        text: 'Rows with an empty `amount` are dropped before insert without being counted or logged.',
        anchors: [[HANDLER, 43, 43]],
      },
      {
        id: 's2-c4',
        text: 'Rows are inserted before the job is enqueued, in separate calls with no shared transaction, so an enqueue failure leaves inserted rows with no job.',
        anchors: [[HANDLER, 44, 45]],
        riskFlag: 'partial write on failure',
      },
      {
        id: 's2-c5',
        text: 'A redelivered S3 event for the same bucket and key inserts its rows again and enqueues a second job; nothing de-duplicates by object.',
        anchors: [[HANDLER, 43, 46]],
        riskFlag: 'duplicate ingest on retry',
      },
    ],
  },
  {
    title: 'Failure Reporting',
    clauses: [
      {
        id: 's3-c1',
        text: 'S3 read errors (`ClientError`) are logged at error level and the record is skipped.',
        anchors: [[HANDLER, 47, 48]],
      },
      {
        id: 's3-c2',
        text: 'Any other exception during download, parsing, insert, or enqueue is logged with a stack trace and swallowed, and processing moves on to the next record.',
        anchors: [[HANDLER, 49, 50]],
        riskFlag: 'silent error swallow',
      },
      {
        id: 's3-c3',
        text: 'The handler always returns HTTP 200 OK, even when every record failed; failed records are simply absent from `ingested`.',
        anchors: [[HANDLER, 52, 52]],
        riskFlag: '200 OK on failure',
      },
    ],
  },
  {
    title: 'Job Claiming',
    clauses: [
      {
        id: 's4-c1',
        text: '`claim_next_job` selects the oldest pending job with fewer than 3 attempts, then marks it running and assigns the worker in a separate UPDATE.',
        anchors: [[JOBS, 28, 44]],
      },
      {
        id: 's4-c2',
        text: 'The SELECT takes no row lock and the UPDATE does not re-check `status`, so two workers polling at the same time can claim and run the same job.',
        anchors: [[JOBS, 31, 43]],
        riskFlag: 'check-then-act race',
      },
      {
        id: 's4-c3',
        text: 'The attempt counter is incremented when a job is claimed rather than when it fails, so a job stops being retried after its third claim regardless of outcome.',
        anchors: [[JOBS, 8, 8], [JOBS, 41, 41]],
      },
      {
        id: 's4-c4',
        text: '`mark_failed` returns a job to `pending` with the first 500 characters of the error, making it immediately eligible for another claim with no backoff.',
        anchors: [[JOBS, 52, 57]],
      },
      {
        id: 's4-c5',
        text: 'Jobs that reach 3 attempts stay in `pending` indefinitely; nothing moves them to a terminal failed state or alerts anyone.',
        anchors: [[JOBS, 33, 33], [JOBS, 55, 55]],
        riskFlag: 'stuck jobs never surface',
      },
    ],
  },
  {
    title: 'Schema Changes',
    clauses: [
      {
        id: 's5-c1',
        text: 'Migration 0042 adds nullable `worker_id` and `last_error` columns and a non-null `attempts` column defaulting to 0 on `ingest_jobs`.',
        anchors: [[MIGRATION, 1, 4]],
      },
      {
        id: 's5-c2',
        text: 'A partial index on `(status, created_at)` covers only pending rows, matching the claim query’s filter and sort order.',
        anchors: [[MIGRATION, 6, 8]],
      },
    ],
  },
];

const COMMENTS: MarginComment[] = [
  {
    id: 'rc-1001',
    author: 'maya-chen',
    body: 'If every record fails we still return 200, so S3 notifications never retry and the file is lost without a trace. Can this be a 5xx when nothing was ingested, or at least 207 with the failures listed?',
    file: HANDLER,
    line: 52,
    replies: [
      {
        author: 'sam-okafor',
        body: 'Agreed. 502 when nothing was ingested, so S3 retries, and 207 with the failed keys for partial failures. Will update.',
      },
    ],
    replied: true,
    clauseId: 's3-c3',
    status: 'open',
  },
  {
    id: 'rc-1002',
    author: 'dkowalski',
    body: 'This SELECT-then-UPDATE will double-claim as soon as we run more than one worker. `SELECT ... FOR UPDATE SKIP LOCKED` inside the same transaction fixes it.',
    file: JOBS,
    line: 31,
    replies: [
      { author: 'sam-okafor', body: 'We only run one worker today, so I left it for a follow-up.' },
      {
        author: 'dkowalski',
        body: 'Autoscaling is enabled for this queue next sprint, so that won’t hold for long. I’d rather not merge a known double-claim; it’s a two-line change.',
      },
    ],
    clauseId: 's4-c2',
    status: 'open',
  },
  {
    id: 'rc-1003',
    author: 'priya-r',
    body: 'The monthly ledger exports are ~120 MB, so the 50 MB cap will skip them. Could we stream the body instead of read() and drop the cap?',
    file: HANDLER,
    line: 29,
    clauseId: 's1-c2',
    status: 'open',
  },
];

/** Threads GitHub marks resolved or outdated: hidden from the margin and the prompt by default. */
const HIDDEN: HiddenThread[] = [
  {
    id: 'rc-990',
    author: 'maya-chen',
    body: 'Typo in the log message: "ingets".',
    file: HANDLER,
    reason: 'resolved',
    replyCount: 1,
  },
  {
    id: 'rc-991',
    author: 'dkowalski',
    body: 'Pull the 50 MB limit into a named constant instead of a magic number.',
    file: HANDLER,
    reason: 'outdated',
    replyCount: 0,
  },
];

export function demoDocument(): SpecDocument {
  const files = parseUnifiedDiff(DEMO_DIFF);
  return {
    id: randomBytes(8).toString('hex'),
    prTitle: 'Add S3 CSV ingestion endpoint and Postgres job queue',
    prNumber: 1287,
    branch: 'feat/s3-ingest-pipeline',
    baseBranch: 'main',
    sections: SECTIONS.map((section, i) => ({
      id: `s${i + 1}`,
      title: section.title,
      clauses: section.clauses.map((clause) => ({
        id: clause.id,
        originalText: clause.text,
        currentText: clause.text,
        anchors: clause.anchors.map(([file, startLine, endLine]) => ({
          file,
          startLine,
          endLine,
          hunk: hunkFor(files, file, startLine, endLine),
        })),
        ...(clause.riskFlag ? { riskFlag: clause.riskFlag } : {}),
      })),
    })),
    comments: COMMENTS.map((c) => ({ ...c })),
    hiddenThreads: HIDDEN.map((t) => ({ ...t })),
  };
}
