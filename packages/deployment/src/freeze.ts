/**
 * The freeze flag: one SSM parameter. Absent = the pipeline may deploy. Present = it stopped itself (a
 * failed deploy, smoke check or task) or a person froze it, and it deploys nothing until a person
 * clears it with `deploy unfreeze`.
 *
 * Reading fails closed: a parameter that cannot be read for any reason but "it does not exist" counts
 * as frozen, and so does a value that is not a freeze record, so a permissions mistake stops deploys
 * instead of letting them through.
 */
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { FREEZE_SCHEMA, type FreezeRecord, parseFreezeRecord } from "./records.js";

/** What the store needs of an SSM client. A real `SSMClient` is one. */
export type SsmPort = Pick<SSMClient, "send">;

export type FreezeState =
  | { readonly frozen: false }
  | {
      readonly frozen: true;
      readonly record: FreezeRecord | undefined;
      /** Why the flag counts as set when it holds no freeze record. */
      readonly note?: string;
    };

/** A freeze record without its schema, which the store adds. */
export type FreezeInput = Omit<FreezeRecord, "schema">;

/** What the run needs of the freeze flag. `FreezeStore` is the real one. */
export interface Freeze {
  read(): Promise<FreezeState>;
  set(record: FreezeInput): Promise<void>;
  clear(): Promise<boolean>;
}

export function isNotFoundError(err: unknown): boolean {
  return (err as { name?: unknown } | undefined)?.name === "ParameterNotFound";
}

export class FreezeStore implements Freeze {
  private readonly ssm: SsmPort;
  private readonly parameter: string;
  private readonly unfreezeHint: string;

  constructor(ssm: SsmPort, parameter: string, unfreezeHint = "deploy unfreeze") {
    this.ssm = ssm;
    this.parameter = parameter;
    this.unfreezeHint = unfreezeHint;
  }

  async read(): Promise<FreezeState> {
    let text: string;
    try {
      const out = await this.ssm.send(new GetParameterCommand({ Name: this.parameter }));
      text = out.Parameter?.Value ?? "";
    } catch (err) {
      if (isNotFoundError(err)) return { frozen: false };
      const name = (err as { name?: string }).name ?? "error";
      return {
        frozen: true,
        record: undefined,
        note: `the flag could not be read (${name}): treated as frozen`,
      };
    }
    const record = parseFreezeRecord(text);
    if (record) return { frozen: true, record };
    return { frozen: true, record: undefined, note: `the flag holds: ${text.slice(0, 200)}` };
  }

  async set(record: FreezeInput): Promise<void> {
    const value: FreezeRecord = { schema: FREEZE_SCHEMA, ...record };
    await this.ssm.send(
      new PutParameterCommand({
        Name: this.parameter,
        Value: JSON.stringify(value),
        Type: "String",
        Overwrite: true,
        Description: `The deploy pipeline is frozen. Clear it with ${this.unfreezeHint}.`,
      }),
    );
  }

  async clear(): Promise<boolean> {
    try {
      await this.ssm.send(new DeleteParameterCommand({ Name: this.parameter }));
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }
}

/** What the run prints (and exits with) when it stops at the flag. */
export function frozenMessage(
  state: FreezeState & { frozen: true },
  unfreezeHint = "deploy unfreeze",
): string {
  const lines = ["PIPELINE FROZEN: nothing was deployed, checked or run."];
  if (state.record) {
    const r = state.record;
    lines.push(
      `  since ${r.at}: ${r.reason}`,
      `  commit ${r.commit}${r.rolledBackTo ? `, rolled back to ${r.rolledBackTo}` : ""}`,
      `  output: ${r.logs}`,
    );
  } else if (state.note) {
    lines.push(`  ${state.note}`);
  }
  lines.push(`  After fixing it, clear the flag with: ${unfreezeHint}`);
  return lines.join("\n");
}
