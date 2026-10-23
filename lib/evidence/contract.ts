import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 64, pattern: "\\S", description: "Exact immutable evidence ID." });
export const evidenceTools = [
  { name: "evidence_capture", action: "capture", parameters: object({ id, title: Type.String({ minLength: 1, maxLength: 240, description: "Caller interpretation, not a verified conclusion." }), kind: StringEnum(["source-observation", "test-contract-inspected"] as const), path: Type.String({ minLength: 1, maxLength: 4096, description: "Source file inside canonical project cwd." }), start: Type.Integer({ minimum: 1, description: "Inclusive 1-based first line." }), end: Type.Integer({ minimum: 1, description: "Inclusive 1-based last line." }) }), description: "Capture immutable project source evidence: UTF-8 file up to 1 MiB, span up to 160 lines/12 KiB. IDs cannot be overwritten. Inspected tests are not test runs. All evidence outputs are capped at 48 KiB; no automatic context injection.", promptSnippet: "Capture source excerpts and explicitly check their freshness, separate from claims and test execution.", promptGuidelines: ["Use evidence to retain source observations or inspected test contracts with immutable excerpts; never describe an inspected test as a passed test. Evidence titles are caller interpretations, not verification. Check freshness explicitly before relying on an old excerpt."] as string[] },
  { name: "evidence_list", action: "list", parameters: object({ offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based page offset; default 0." })) }), description: "List up to 20 evidence summaries; freshness is not checked." },
  { name: "evidence_read", action: "read", parameters: object({ id }), description: "Read the immutable captured excerpt; does not check current source." },
  { name: "evidence_check", action: "check", parameters: object({ id }), description: "Compare current whole-file bytes with captured hash; no truth or test verdict." },
  { name: "evidence_compare", action: "compare", parameters: object({ id }), description: "Read captured excerpt and current same-line positions; no symbol relocation." },
] as const;
export interface NextCall { tool: string; arguments: Record<string, unknown> }
export function evidenceNext(action: string, result: any): NextCall[] {
  if (action === "list" && result.nextOffset !== null) return [{ tool: "evidence_list", arguments: { offset: result.nextOffset } }];
  if (action === "capture") return [{ tool: "evidence_read", arguments: { id: result.id } }];
  return [];
}
export function evidenceFailure(error: unknown, tool: string, effect: string): Error {
  const message = String(error instanceof Error ? error.message : error).slice(0, 1200);
  let code = "operation_failed", repair = "Inspect the error and correct the call; do not repeat unchanged.", nextCalls: NextCall[] = [];
  if (/already exists/.test(message)) { code = "immutable_id_exists"; repair = "Read the existing evidence before deciding whether a separately intended capture needs a new ID. Never replace it or blindly bypass an uncertain capture with another ID."; }
  else if (/not found|ENOENT/i.test(message)) { code = "evidence_not_found"; repair = "List records or use an exact existing evidence ID."; nextCalls = [{ tool: "evidence_list", arguments: {} }]; }
  else if (/inside|symlink|canonical project/i.test(message)) { code = "source_out_of_scope"; repair = "Use a regular source file resolving inside canonical project cwd."; }
  else if (/range|line|Excerpt exceeds/i.test(message)) { code = "invalid_range"; repair = "Inspect the source and choose an existing inclusive range within 160 lines and 12 KiB."; }
  return new Error(JSON.stringify({ code, message, tool, effect, retryUnchanged: false, repair, nextCalls }));
}
