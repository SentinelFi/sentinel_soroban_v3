# Executor Tooling

The protocol's cron jobs run as Vercel serverless functions in [`dapp/api/cron/`](../dapp/api/cron/) (schedules in [`dapp/vercel.json`](../dapp/vercel.json); job overview in the root [README](../README.md#cron-jobs)). This folder holds the supporting test fixture.

A legacy long-running node-cron executor (`centralized_cron/`) used to live here as the reference implementation; it was removed once the Vercel port became the sole deployment. Its history is available in git.

## Contents

| Directory | Purpose |
| --- | --- |
| [mock-api/](mock-api/) | Local Express server returning FlightAware AeroAPI-shaped responses, so the fetcher and sale-authorizer jobs can be exercised without an API key or credits. See its [README](mock-api/README.md). |

## Usage

Start the fixture and point the crons at it:

```sh
cd executor/mock-api
npm install && npm start          # serves AeroAPI-shaped responses on :3001

# in the dapp env (.env / Vercel):
AEROAPI_BASE_URL=http://localhost:3001
```

The fixture serves scripted scenarios (on-time, delayed, cancelled, ambiguous) for demos and for testing the oracle pipeline end to end without touching FlightAware.
