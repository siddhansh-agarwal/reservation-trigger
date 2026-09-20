# Reservation Trigger

Generic cloud trigger for a private automation repository.

This repository contains no account credentials, venue names, class names, or
target schedule data. The target repository, event type, timezone, and schedule
targets are stored as encrypted GitHub Actions secrets.

The workflow runs short, staggered checkpoints around configured opening
windows. A checkpoint dispatches the private target only from 80 minutes before
through 90 minutes after an opening. It suppresses later retries for two hours
after a successful target run, so the usual path is one private run per target
window. If a target run fails, a later checkpoint can retry without depending
on a long-lived public runner. The cron schedule is limited to the configured
booking-open days instead of running every day.

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
