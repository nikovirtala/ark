/**
 * The ledger: what the pipeline has done, in one DynamoDB table per project that outlives the
 * deployed stack. The keys are longplay's, with the task prefix as config (`TASK#` by default,
 * `RELEASE#` for longplay):
 *
 *   pk = <prefix><id>   sk = DONE              the task succeeded once; a task with this item never runs again
 *   pk = <prefix><id>   sk = ATTEMPT#<time>    every dry run or run, whatever the outcome (the history)
 *   pk = DEPLOY         sk = LAST_GOOD         the commit whose deploy, smoke checks and tasks all passed
 *   pk = DEPLOY         sk = RUN#<time>        the outcome of every pipeline run
 *
 * The records hold ids, commits, times, an outcome and a one-line summary. Never data: a task
 * summarises counts, not rows.
 */
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  clip,
  type LastGood,
  parseRunRecord,
  parseTaskRecord,
  phaseOf,
  RUN_SCHEMA,
  type RunRecord,
  TASK_SCHEMA,
  type TaskRecord,
} from "./records.js";

/** What the ledger needs of a DynamoDB document client. A real `DynamoDBDocumentClient` is one. */
export type DocumentsPort = Pick<DynamoDBDocumentClient, "send">;

/** A run record without the fields the ledger derives (schema, phase). */
export type RunInput = Omit<RunRecord, "schema" | "phase">;

/** What the run and the task runner need of the ledger. `Ledger` is the real one. */
export interface LedgerStore {
  doneIds(): Promise<Set<string>>;
  getDone(id: string): Promise<TaskRecord | undefined>;
  recordAttempt(rec: TaskRecord): Promise<void>;
  markDone(rec: TaskRecord): Promise<void>;
  attempts(id: string): Promise<TaskRecord[]>;
  forget(id: string, at: string): Promise<boolean>;
  lastGood(): Promise<LastGood | undefined>;
  setLastGood(good: LastGood): Promise<void>;
  recordRun(rec: RunInput): Promise<void>;
  recentRuns(limit?: number): Promise<RunRecord[]>;
}

export interface LedgerOptions {
  readonly table: string;
  /** The partition key prefix of a task's items. Default `TASK#`. */
  readonly taskKeyPrefix?: string;
}

export const DEFAULT_TASK_KEY_PREFIX = "TASK#";
const DEPLOY = "DEPLOY";

export class Ledger implements LedgerStore {
  private readonly documents: DocumentsPort;
  private readonly table: string;
  private readonly prefix: string;

  constructor(documents: DocumentsPort, options: LedgerOptions) {
    this.documents = documents;
    this.table = options.table;
    this.prefix = options.taskKeyPrefix ?? DEFAULT_TASK_KEY_PREFIX;
  }

  /** The ids of every task that has succeeded. */
  async doneIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let key: Record<string, unknown> | undefined;
    do {
      const page = await this.documents.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "sk = :done AND begins_with(pk, :prefix)",
          ExpressionAttributeValues: { ":done": "DONE", ":prefix": this.prefix },
          ...(key ? { ExclusiveStartKey: key } : {}),
        }),
      );
      for (const item of page.Items ?? []) ids.add(String(item.id));
      key = page.LastEvaluatedKey;
    } while (key);
    return ids;
  }

  async getDone(id: string): Promise<TaskRecord | undefined> {
    const out = await this.documents.send(
      new GetCommand({ TableName: this.table, Key: { pk: `${this.prefix}${id}`, sk: "DONE" } }),
    );
    return out.Item ? parseTaskRecord(out.Item) : undefined;
  }

  async recordAttempt(rec: TaskRecord): Promise<void> {
    await this.documents.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: `${this.prefix}${rec.id}`,
          sk: `ATTEMPT#${rec.at}`,
          schema: TASK_SCHEMA,
          ...rec,
          summary: clip(rec.summary),
        },
      }),
    );
  }

  /** Marks the task done. Refuses to overwrite: a task that is in the ledger is never recorded twice. */
  async markDone(rec: TaskRecord): Promise<void> {
    await this.documents.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: `${this.prefix}${rec.id}`,
          sk: "DONE",
          schema: TASK_SCHEMA,
          ...rec,
          summary: clip(rec.summary),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async attempts(id: string): Promise<TaskRecord[]> {
    const out = await this.documents.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :a)",
        ExpressionAttributeValues: { ":pk": `${this.prefix}${id}`, ":a": "ATTEMPT#" },
      }),
    );
    return (out.Items ?? []).flatMap((item) => parseTaskRecord(item) ?? []);
  }

  /** Puts a task back to pending (after the stack was destroyed and redeployed, or to run a repaired task again). The history stays. */
  async forget(id: string, at: string): Promise<boolean> {
    const had = await this.getDone(id);
    if (!had) return false;
    await this.documents.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `${this.prefix}${id}`, sk: "DONE" } }),
    );
    await this.recordAttempt({
      id,
      commit: had.commit,
      at,
      outcome: "failed",
      summary: `forgotten by hand: it will run again (it had succeeded at ${had.at})`,
    });
    return true;
  }

  async lastGood(): Promise<LastGood | undefined> {
    const out = await this.documents.send(
      new GetCommand({ TableName: this.table, Key: { pk: DEPLOY, sk: "LAST_GOOD" } }),
    );
    return out.Item
      ? {
          commit: String(out.Item.commit),
          at: String(out.Item.at),
          execution: String(out.Item.execution),
        }
      : undefined;
  }

  async setLastGood(good: LastGood): Promise<void> {
    await this.documents.send(
      new PutCommand({ TableName: this.table, Item: { pk: DEPLOY, sk: "LAST_GOOD", ...good } }),
    );
  }

  async recordRun(rec: RunInput): Promise<void> {
    await this.documents.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: DEPLOY,
          sk: `RUN#${rec.at}`,
          schema: RUN_SCHEMA,
          ...rec,
          phase: phaseOf(rec.outcome),
          summary: clip(rec.summary),
        },
      }),
    );
  }

  /** The newest runs first. An item that is not a run record is left out. */
  async recentRuns(limit = 5): Promise<RunRecord[]> {
    const out = await this.documents.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :r)",
        ExpressionAttributeValues: { ":pk": DEPLOY, ":r": "RUN#" },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).flatMap((item) => parseRunRecord(item) ?? []);
  }
}
