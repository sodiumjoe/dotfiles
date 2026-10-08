import { id, keys, object, text } from "../catalog/types.js"
import { fail } from "../orchestration/types.js"
import { parsePermissionRef, type PermissionRef } from "../orchestration/permission-routing.js"

export type HumanControl = { op: "permission_snapshot" } | { op: "permission_decide"; commandId: string; ref: PermissionRef; optionId: string } | { op: "permission_inspect"; commandId: string }
export function parseHumanControl(raw: unknown): HumanControl {
  const v = object(raw)
  switch (v.op) {
    case "permission_snapshot": keys(v, ["op"]); return { op: v.op }
    case "permission_decide": keys(v, ["op", "commandId", "ref", "optionId"]); return { op: v.op, commandId: id(v.commandId), ref: parsePermissionRef(v.ref), optionId: text(v.optionId) }
    case "permission_inspect": keys(v, ["op", "commandId"]); return { op: v.op, commandId: id(v.commandId) }
    default: return fail("UNSUPPORTED_HUMAN_CONTROL")
  }
}