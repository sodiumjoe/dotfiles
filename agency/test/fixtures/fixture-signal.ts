import { constants } from "node:os"
import { sameProcess, type PlatformAdapter, type ProcessIdentity } from "../../src/platform/types.js"

export type OwnedSignal = { identity: ProcessIdentity; ownerIdentity?: ProcessIdentity; knownMembers: ProcessIdentity[]; signal: NodeJS.Signals; group: boolean; parentPid?: number | null }
function valid(value: ProcessIdentity): boolean {
  return typeof value.bootId === "string" && value.bootId.length > 0 && typeof value.birth === "string" && sameProcess(value, value)
    && [value.pid, value.parentPid, value.processGroupId, value.sessionId, value.uid, value.gid].every(Number.isSafeInteger)
    && value.pid > 1 && value.parentPid > 0 && value.processGroupId > 0 && value.sessionId > 0 && value.uid >= 0 && value.gid >= 0
    && !/:unmarked:(?:\([^)]*\)|<defunct>)$/.test(value.birth)
}
export async function captureOwnedProcess(adapter: PlatformAdapter, pid: number, parentPid: number, ownGroup: boolean): Promise<{ identity: ProcessIdentity; ownerIdentity: ProcessIdentity }> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(parentPid) || parentPid <= 1) throw new Error("Invalid fixture capture")
  const ownerIdentity = await adapter.readProcess(parentPid), identity = await adapter.readProcess(pid)
  if (!identity || !ownerIdentity || !valid(identity) || !valid(ownerIdentity) || identity.pid !== pid || ownerIdentity.pid !== parentPid
    || identity.parentPid !== parentPid || identity.bootId !== ownerIdentity.bootId || identity.uid !== ownerIdentity.uid || identity.gid !== ownerIdentity.gid
    || ownGroup && (identity.processGroupId !== pid || identity.sessionId !== pid)) throw new Error("Fixture launch capture unavailable or mismatched")
  return { identity: structuredClone(identity), ownerIdentity: structuredClone(ownerIdentity) }
}
export async function signalOwnedProcess(adapter: PlatformAdapter, request: OwnedSignal, send: (pid: number, signal: NodeJS.Signals) => void, live: () => boolean = () => true, authorize: () => Promise<boolean> = async () => true, terminal: () => boolean = () => false): Promise<"delivered" | "already-absent" | "already-terminal"> {
  const { identity: expected, ownerIdentity: owner, knownMembers, signal, group } = request
  const parentPid = owner ? owner.pid : request.parentPid === null ? null : request.parentPid ?? expected.parentPid
  if (!valid(expected) || owner && (!valid(owner) || owner.bootId !== expected.bootId || expected.parentPid !== owner.pid)
    || !Object.hasOwn(constants.signals, signal)
    || group && (expected.processGroupId !== expected.pid || expected.sessionId !== expected.pid)) throw new Error("Fixture missing identity")
  const checkOwner = async () => {
    if (!live()) throw new Error("Fixture terminal identity")
    if (owner) {
      const current = await adapter.readProcess(owner.pid)
      if (!current || !valid(current) || !sameProcess(owner, current) || current.parentPid !== owner.parentPid) throw new Error("Fixture owner identity mismatch")
    }
  }
  await checkOwner()
  if (await adapter.bootId() !== expected.bootId) throw new Error("Fixture identity boot mismatch")
  const checkTarget = async () => {
    const current = await adapter.readProcess(expected.pid)
    if (current !== null && (!valid(current) || !sameProcess(expected, current) || parentPid !== null && current.parentPid !== parentPid)) throw new Error("Fixture identity mismatch")
    if (!live()) throw new Error("Fixture terminal identity")
    if (terminal()) return "already-terminal" as const
    return current === null ? "already-absent" as const : "present" as const
  }
  const first = await checkTarget()
  if (first === "already-absent") return first
  if (group) {
    const members = await adapter.readGroup(expected.processGroupId)
    if (new Set(members.map(member => member.pid)).size !== members.length || !members.some(member => sameProcess(expected, member))
      || members.some(member => !valid(member) || member.bootId !== expected.bootId || member.processGroupId !== expected.processGroupId
        || member.sessionId !== expected.sessionId || member.uid !== expected.uid || member.gid !== expected.gid)) throw new Error("Fixture group identity mismatch")
    if (members.some(member => !knownMembers.some(known => sameProcess(known, member) && (parentPid === null || known.parentPid === member.parentPid)))) throw new Error("Unregistered fixture group member")
  }
  await checkOwner()
  if (!await authorize()) throw new Error("Fixture source authority lost")
  const last = await checkTarget()
  if (last !== "present") return last
  if (!live()) throw new Error("Fixture terminal identity")
  if (terminal()) return "already-terminal"
  send(group ? -expected.processGroupId : expected.pid, signal)
  return "delivered"
}