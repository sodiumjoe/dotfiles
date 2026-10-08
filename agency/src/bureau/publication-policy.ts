import { absolutePath, hash, keys, object, text } from "../catalog/types.js"
import { boundedArray, fail } from "../orchestration/types.js"

export type PublicationDestination = { hostId: string; repository: string; remote: string }
export type PublicationPolicy = { destinations: PublicationDestination[] }
export function parsePublicationDestination(raw: unknown): PublicationDestination {
  const v = object(raw); keys(v, ["hostId", "repository", "remote"])
  const remote = text(v.remote, 4096)
  if (remote.startsWith("-") || remote.startsWith("ext::") || /[\x00-\x1f\x7f]/u.test(remote)) fail("GIT_REMOTE_INVALID")
  return { hostId: hash(v.hostId), repository: absolutePath(v.repository), remote }
}
export function parsePublicationPolicy(raw: unknown): PublicationPolicy {
  const v = object(raw); keys(v, ["destinations"])
  return { destinations: boundedArray(v.destinations, parsePublicationDestination, 128) }
}