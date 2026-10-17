# Session startup and recovery

`src/container/session.ts` keeps the public `startSession()` entry point. It supplies record storage, name reservations, resource cleanup, and container argument construction to `src/container/session-start.ts`.

`session-start.ts` controls startup and recovery. `src/container/owned-container.ts` checks container ownership and status. Inspection returns a verified identity without changing the session record. The caller decides when to adopt that identity.

## Startup phases

| Phase | Meaning | Failure cleanup |
| --- | --- | --- |
| `reserved` | The session name is reserved. Workspace preparation has not returned. | Delete any startup record and release the name. Workspace preparation handles its own partial failures. |
| `workspace-ready` | The workspace and its session record are available. Handoff preparation can be incomplete. | Remove registered resources and an owned clone. No container create was attempted. |
| `resources-ready` | Handoff staging and container arguments are ready. | Same as `workspace-ready`. |
| `create-attempted` | The pending record was saved before the create call. The container identity can be uncertain. | Verify ownership, remove the container if present, then verify absence. |
| `container-created` | Podman returned a valid container ID. | Verify ownership and absence before resource deletion. A returned ID alone does not prove ownership. |
| `results-retained` | An attached launch was interrupted, and the workload was verified stopped or missing. | Remove secrets only. Keep results, the session record, and the name reservation. |
| `container-absent` | Recovery verified container absence. | Remove registered resources and an owned clone. |

`RollbackSafeState` permits resource cleanup only before a create attempt or after verified absence. Engine errors, malformed inspection data, foreign ownership labels, and a container that remains present do not produce this state.

The pending record uses a zero-filled container ID. Recovery locates that container by its generated name. It adopts the immutable ID only after the ownership labels match.

## Recovery rules

- Save the pending record before the first create call.
- Treat a failed create call as an uncertain outcome, not proof of absence.
- Verify absence after removal. A successful remove command is not sufficient.
- Set result retention before secret cleanup. A secret-cleanup failure must not delete retained results.
- Remove temporary preparation inputs separately from mounted session resources.
- Release the name only after resource cleanup and record deletion succeed.
- If recovery fails, attempt to save the current record. Report the original failure and all recovery failures in an `AggregateError` cause.

A nonzero attached workload exit remains a workload result. It does not request startup rollback.

## Failure-check helpers

Startup keeps request checks, engine invocation, outcome handling, and error reporting separate:

- `validateStartupRequest()` checks the request and resolves runtime mounts before Podman access.
- `requireLocalImage()` rejects a missing image with the correct build instruction. It does not pull an image.
- `assertDisjointMountDestinations()` rejects overlapping runtime and handoff mounts before container creation.
- `invokeContainerStart()` runs the start command and checks cancellation. On an invocation failure, `recoverAndRethrowStartError()` applies attached-session recovery and preserves both errors if recovery also fails.
- `resolveStartOutcome()` inspects ownership and status. It distinguishes a missing container, an attached transport failure, a failed start, and a workload result.
- `reportStartupRecoveryFailure()` saves available recovery metadata and reports combined failures.

Cleanup permissions remain in `verifyRollbackPermission()`. The error helpers do not grant permission to delete resources.

## Call flow

```text
startSession(options)                         # public entry point
└─ startSessionWithServices(options, services)
   ├─ reserveStartup()
   │  └─ validateStartupRequest → preflight → requireLocalImage → reserve name
   ├─ prepareStartupWorkspace()
   │  └─ prepare workspace → construct pending record
   ├─ prepareStartupResources()
   │  └─ stage and register → assertDisjointMountDestinations → clean temporary inputs
   ├─ createStartupContainer()
   │  └─ save pending record → mark create-attempted → create → save ID
   ├─ startCreatedContainer()
   │  ├─ invokeContainerStart()
   │  │  └─ on failure: recoverAndRethrowStartError()
   │  ├─ resolveStartOutcome()
   │  │  └─ attached transport failure → verify stop → retain results
   │  └─ clean secrets if stopped → return result
   └─ on failure: recoverFailedStartup()
      ├─ results-retained → report interruption without rollback
      ├─ verifyRollbackPermission()
      │  ├─ no create attempt → permit cleanup
      │  └─ create attempted → verify owner → remove → verify absence
      ├─ clean temporary inputs
      ├─ if permitted: cleanRollbackResources()
      ├─ all cleanup succeeded → delete record → release name
      └─ recovery failed: reportStartupRecoveryFailure()
         └─ save recovery record → report all errors
```

`src/container/session-start.test.ts` tests the failure paths with a simulated engine and injected storage failures. `src/container/session.test.ts` also tests real local record storage, owned clones, staged resources, and startup cancellation. These tests do not need a live Podman engine.
