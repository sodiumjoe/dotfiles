# Private qualification

The private launcher runs the ordinary Handler, bridge, task tools and ACP endpoint against explicit private persistent and runtime roots. It does not install or restart the ordinary Handler. Configuration binds the host, Node executable, declared build manifest and current Handler generation. Build hashes are captured once by `npm run build`; ordinary commands compare that small manifest without recursively hashing the repository.

## Invocation

Use Node 24.13.0. Build the candidate once from the intended revision, allocate fresh private roots outside the checkout and ordinary Agency paths, and write a mode-0600 `PrivateConfig` from `config.ts`. Its `packageRoot` points to the built `agency` directory. `persistentRoot` and `runtimeRoot` must be distinct canonical private directories. `launcherPath` and `configPath` belong under the private persistent root. Create the launcher from `launcherText(config)` with executable mode. The tests in `test/qualification-support.ts` provide a complete synthetic setup.

Invoke the private launcher directly:

```sh
PRIVATE_AGY status --json
PRIVATE_AGY doctor --json
PRIVATE_AGY task inspect TASK_ID --local --json
PRIVATE_AGY shutdown --stop-agents --handler-generation GENERATION --command-id COMMAND_ID --json
```

Replace each placeholder with the exact private launcher path or original operation reference. `status` may start that private Handler. Other session, task, attachment and permission operations use the ordinary CLI grammar. The optional editor shim supplies a private init and launcher, while `internal-task-tools` exposes the ordinary task MCP tools.

Manual configuration edits apply to the next launch or explicit catalog refresh. Stop the Handler before manually editing retained runtime records. A source edit requires an explicit rebuild when the run is intended to test those bytes.

## Finite runs

Before a real-provider or remote run, record the exact targets, private roots, operation IDs, submitted texts, discovery count, prompt count, spend budget and deadline. A synthetic local run does not authorize a real provider, paid prompt, SSH, installation or cleanup of older resources.

Task creation requires an exact `TaskAllowance` in `task-guard.ts`, bound to its host, Handler generation, complete task input, candidate binding and finite time window. The first forwarding attempt consumes the allowance. Worker tools cannot create further tasks. A lost reply requires inspection of the original reference; it never authorizes another submission. Permission decisions use the current offered owner tuple and option.

Use one compact result per run containing the revision, commands and outcomes, admitted launches, terminal results, unresolved cleanup and retained artifact locations. Keep failed output and private roots even when physical cleanup succeeds. The local qualification fixtures retain their small roots after verified cleanup, so a test-body failure cannot erase diagnostics. They do not infer test success from cleanup success.

## Cleanup and limits

Stop only the run's exact sessions and shut down its exact Handler generation. Wait for admitted children and streams, then check the run's registered processes and groups for absence. Unknown cleanup remains incomplete and keeps its diagnostics. Retain reports and provider-native history. Ambiguous ownership does not authorize signaling a replacement process or deleting a historical root.

There is no phase freezer, recursive predecessor verification, remote collector bootstrap or automatic execution gate. Native Darwin, native Linux, synthetic fixtures, cross-host routing and real-provider results remain separate claims.