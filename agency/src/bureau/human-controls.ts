import { absolutePath } from "../catalog/types.js"
import { boundedArray, enumValue } from "../orchestration/types.js"
import { gitOid } from "./git-identity.js"
import { parseEntryRef, type EntryRef } from "./entry.js"
import { hash, id, keys, object, text } from "../catalog/types.js"
import { fail } from "../orchestration/types.js"
import { parsePermissionRef, type PermissionRef } from "../orchestration/permission-routing.js"

export type HumanControl = { op: "git_configure"; destinationCwd: string; remote: string; validations: string[][] } | { op: "git_verify"; reportId: string; destinationCwd: string } | { op: "git_proposal"; proposalId: string } | { op: "git_integrate"; commandId: string; proposalId: string; expectedHead: string; strategy: "merge" | "cherry-pick" } | { op: "git_inspect"; commandId: string } | { op: "entry_prepare" | "entry_inspect"; commandId: string; ref: EntryRef } | { op: "entry_consume"; commandId: string; digest: string; hostId: string; inventoryId: string } | { op: "permission_snapshot" | "roster_snapshot" } | { op: "permission_decide"; commandId: string; ref: PermissionRef; optionId: string } | { op: "permission_inspect"; commandId: string }
export function parseHumanControl(raw: unknown): HumanControl {
  const v = object(raw)
  switch (v.op) {
    case "git_configure": keys(v, ["op", "destinationCwd", "remote", "validations"]); return { op: v.op, destinationCwd: absolutePath(v.destinationCwd), remote: text(v.remote, 4096), validations: boundedArray(v.validations, raw => { const argv = boundedArray(raw, value => text(value, 4096), 128); if (!argv.length) fail("INVALID_VALIDATION"); return argv }, 128) }
    case "git_verify": keys(v, ["op", "reportId", "destinationCwd"]); return { op: v.op, reportId: id(v.reportId), destinationCwd: absolutePath(v.destinationCwd) }
    case "git_proposal": keys(v, ["op", "proposalId"]); return { op: v.op, proposalId: hash(v.proposalId) }
    case "git_integrate": keys(v, ["op", "commandId", "proposalId", "expectedHead", "strategy"]); return { op: v.op, commandId: id(v.commandId), proposalId: hash(v.proposalId), expectedHead: gitOid(v.expectedHead), strategy: enumValue(v.strategy, ["merge", "cherry-pick"]) }
    case "git_inspect": keys(v, ["op", "commandId"]); return { op: v.op, commandId: id(v.commandId) }
    case "entry_prepare": case "entry_inspect": keys(v, ["op", "commandId", "ref"]); return { op: v.op, commandId: id(v.commandId), ref: parseEntryRef(v.ref) }
    case "entry_consume": keys(v, ["op", "commandId", "digest", "hostId", "inventoryId"]); return { op: v.op, commandId: id(v.commandId), digest: hash(v.digest), hostId: hash(v.hostId), inventoryId: id(v.inventoryId) }
    case "permission_snapshot": case "roster_snapshot": keys(v, ["op"]); return { op: v.op }
    case "permission_decide": keys(v, ["op", "commandId", "ref", "optionId"]); return { op: v.op, commandId: id(v.commandId), ref: parsePermissionRef(v.ref), optionId: text(v.optionId) }
    case "permission_inspect": keys(v, ["op", "commandId"]); return { op: v.op, commandId: id(v.commandId) }
    default: return fail("UNSUPPORTED_HUMAN_CONTROL")
  }
}