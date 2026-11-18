import type { HostEnrollment } from "./inventory.js"

export const HOST_PROTOCOL = "agency-host/1" as const
export type HostResult = { state: "hosts"; hosts: HostEnrollment[] } | { state: "enrolled"; enrollment: HostEnrollment }
export type HostReply = { protocol: typeof HOST_PROTOCOL; requestId: string; hostId: null; handlerGeneration: null } & ({ ok: true; result: HostResult } | { ok: false; error: { code: string; message: string } })