# Reservation Trigger

Generic cloud trigger for a private automation repository.

This repository contains no account credentials, venue names, class names, or
target schedule data. The target repository, event type, timezone, and schedule
targets are stored as encrypted GitHub Actions secrets.

The workflow runs staggered checkpoints around configured opening windows. An
early checkpoint waits until 75 minutes before opening, dispatches the private
target, and exits immediately. Queued checkpoints provide failover if GitHub
reclaims that runner. A checkpoint delivered late can recover for up to 12
hours after opening. Successful target runs suppress duplicates for 15 hours;
failed target runs remain eligible for retry. The cron schedule is limited to
the configured booking-open days instead of running every day.

GitHub automatically disables scheduled workflows in inactive public
repositories. A separate keepalive checks twice monthly and creates a small
activity marker commit only when the latest repository commit is at least 30
days old. It does not read booking secrets or dispatch the private automation.

## Required Secrets

- `DISPATCH_TOKEN`: token that can create repository dispatch events in the target repository
- `TARGET_REPO`: private repository to dispatch, in `owner/name` form
- `TARGET_WORKFLOW_FILE`: workflow file to inspect for active/recent runs
- `DISPATCH_EVENT_TYPE`: repository dispatch event type expected by the target repository
- `TRIGGER_TIMEZONE`: IANA timezone for target windows
- `TRIGGER_TARGETS_JSON`: JSON array of target windows

Example target shape:

```json
[
  { "id": "target-a", "openDayOfWeek": 1, "openTime": "18:00" }
]
```

`openDayOfWeek` uses `0=Sunday` through `6=Saturday`.
