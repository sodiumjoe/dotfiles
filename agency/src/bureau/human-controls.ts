import { parseEntryRef, type EntryRef } from "./entry.js"
import { hash, id, keys, object, text } from "../catalog/types.js"
import { fail } from "../orchestration/types.js"
import { parsePermissionRef, type PermissionRef } from "../orchestration/permission-routing.js"

export type HumanControl = { op: "entry_prepare" | "entry_inspect"; commandId: string; ref: EntryRef } | { op: "entry_consume"; commandId: string; digest: string; hostId: string; inventoryId: string } | { op: "permission_snapshot" | "roster_snapshot" } | { op: "permission_decide"; commandId: string; ref: PermissionRef; optionId: string } | { op: "permission_inspect"; commandId: string }
export function parseHumanControl(raw: unknown): HumanControl {
  const v = object(raw)
  switch (v.op) {
    case "entry_prepare": case "entry_inspect": keys(v, ["op", "commandId", "ref"]); return { op: v.op, commandId: id(v.commandId), ref: parseEntryRef(v.ref) }
    case "entry_consume": keys(v, ["op", "commandId", "digest", "hostId", "inventoryId"]); return { op: v.op, commandId: id(v.commandId), digest: hash(v.digest), hostId: hash(v.hostId), inventoryId: id(v.inventoryId) }
    case "permission_snapshot": case "roster_snapshot": keys(v, ["op"]); return { op: v.op }
    case "permission_decide": keys(v, ["op", "commandId", "ref", "optionId"]); return { op: v.op, commandId: id(v.commandId), ref: parsePermissionRef(v.ref), optionId: text(v.optionId) }
    case "permission_inspect": keys(v, ["op", "commandId"]); return { op: v.op, commandId: id(v.commandId) }
    default: return fail("UNSUPPORTED_HUMAN_CONTROL")
  }
}