/**
 * Starts the AWS Emulator (aws/aws-emulator) for the tests that prove the ledger, the freeze flag
 * and the settings against DynamoDB and SSM, as longplay's tests do.
 *
 * Needs the binary: set AWS_EMULATOR_BIN, or have `aws-emulator` on the PATH, or install the package
 * under /opt/aws-emulator. Without it `findEmulator()` returns undefined and the tests that use it are
 * skipped (CI has no emulator). The emulator runs on 127.0.0.1 with request signing on, a new
 * certificate and new keys every start, and keeps state in memory only, so each run starts empty. It
 * writes its files under $HOME, so it gets a temporary one. Telemetry is off.
 *
 * It is no test of IAM: it never denies a request signed with its own keys. Permissions are proven
 * with IAM's policy simulator in each project.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent } from "node:https";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export function findEmulator(): string | undefined {
  const candidates = [
    process.env.AWS_EMULATOR_BIN,
    "/opt/aws-emulator/bin/aws-emulator",
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "aws-emulator")),
  ];
  return candidates.find(
    (c): c is string => typeof c === "string" && c.length > 0 && existsSync(c),
  );
}

export interface EmulatorClientConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: { accessKeyId: string; secretAccessKey: string };
  readonly requestHandler: { httpsAgent: Agent };
  readonly maxAttempts: number;
}

export interface RunningEmulator {
  readonly endpoint: string;
  readonly caFile: string;
  readonly credentialsFile: string;
  readonly clientConfig: EmulatorClientConfig;
  readonly dynamodb: DynamoDBClient;
  readonly documents: DynamoDBDocumentClient;
  readonly ssm: SSMClient;
  /** The environment that points the AWS CLI and SDKs at the emulator, with no real credentials. */
  env(): Record<string, string>;
  stop(): Promise<void>;
}

function credentials(file: string): { accessKeyId: string; secretAccessKey: string } {
  const text = readFileSync(file, "utf8");
  const value = (key: string): string => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "mi").exec(text);
    if (!m?.[1]) throw new Error(`no ${key} in the emulator credentials file`);
    return m[1];
  };
  return {
    accessKeyId: value("aws_access_key_id"),
    secretAccessKey: value("aws_secret_access_key"),
  };
}

export async function startEmulator(bin: string): Promise<RunningEmulator> {
  const home = mkdtempSync(path.join(tmpdir(), "aws-emulator-"));
  const child: ChildProcess = spawn(bin, ["-p", "0", "-t", "off"], {
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let info: { endpoint_url: string; ca_file: string; credentials_file: string } | undefined;
  let credentialsFile: string | undefined;
  let log = "";
  const onData = (chunk: Buffer): void => {
    for (const line of chunk.toString().split("\n")) {
      log += `${line}\n`;
      try {
        const fields = (JSON.parse(line) as { fields?: Record<string, string> }).fields ?? {};
        if (fields.credentials_file) credentialsFile = fields.credentials_file;
        if (fields.endpoint_url && fields.ca_file) {
          info = {
            endpoint_url: fields.endpoint_url,
            ca_file: fields.ca_file,
            credentials_file:
              credentialsFile ?? path.join(path.dirname(fields.ca_file), "emulator_credentials"),
          };
        }
      } catch {
        // not a JSON line (the telemetry notice)
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  for (let i = 0; i < 300 && !info; i++) {
    if (child.exitCode !== null)
      throw new Error(`aws-emulator exited with ${child.exitCode}:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!info) {
    child.kill();
    throw new Error(`aws-emulator did not report an endpoint:\n${log}`);
  }
  const found = info;
  const ca = readFileSync(found.ca_file);
  const keys = credentials(found.credentials_file);
  const common: EmulatorClientConfig = {
    endpoint: found.endpoint_url,
    region: "us-east-1",
    credentials: keys,
    // The emulator's certificate is new every start; trust it for these clients only (never disable verification).
    requestHandler: { httpsAgent: new Agent({ ca, keepAlive: false }) },
    maxAttempts: 1,
  };
  const dynamodb = new DynamoDBClient(common);
  const ssm = new SSMClient(common);
  return {
    endpoint: found.endpoint_url,
    caFile: found.ca_file,
    credentialsFile: found.credentials_file,
    clientConfig: common,
    dynamodb,
    documents: DynamoDBDocumentClient.from(dynamodb, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    ssm,
    env: () => ({
      AWS_ENDPOINT_URL: found.endpoint_url,
      AWS_CA_BUNDLE: found.ca_file,
      AWS_ACCESS_KEY_ID: keys.accessKeyId,
      AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_EC2_METADATA_DISABLED: "true",
    }),
    async stop() {
      dynamodb.destroy();
      ssm.destroy();
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once("exit", r)));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Creates a ledger table shaped like longplay's (pk, sk, on demand) and waits until it is active. */
export async function createLedgerTable(dynamodb: DynamoDBClient, table: string): Promise<void> {
  await dynamodb.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  for (let i = 0; i < 100; i++) {
    const t = (await dynamodb.send(new DescribeTableCommand({ TableName: table }))).Table;
    if (t?.TableStatus === "ACTIVE") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`table ${table} did not become active`);
}
