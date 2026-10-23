# kalshi-public-market-data-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Red Cup Financial Engineering market-data supplier; Kalshi bounded public API, historical candlesticks, joint-observability and source-latency sentries, milestone-first capture, evidence-tape and audit.

## Provider attention metering recovered from historical source

The original October 3, 2026 archive-tagged Kalshi research implementation
carried per-REST-read attention evidence. That functionality was missing from
this maintained supplier after repository extraction. The source-owned
`publicGet` now returns `result.attention` for accepted responses and HTTP
or transport refusals. Composite market and milestone captures aggregate the
**attempted** REST read count, elapsed time and estimated response JSON bytes;
this does not establish an actual monetary or energy cost. Skipping game stats
removes one attempted endpoint read from that composite.

The original market snapshot `object` and semantic content ID remain independent
of volatile transport timing. The actual `capture-tape` and
`capture-watchset-sample` consumers record the attention evidence on the
existing content-addressed `KalshiResearchTapeRecord` carrier. The original
tape audit now reports `meteredRecordedRequests`,
`meteredResponseBytesEstimate`, `meteredRecordCount` and
`unmeteredRecordCount`, distinguishing older unmetered records and refused
polls that are not retained in the successful tape. Cash cost remains unknown.
The measurement can drive subsequent real attention-allocation decisions;
it does not itself prove reduced API calls or better trading outcomes.

Source ancestry: `emsenn/561-group` ref
`archive/chatgpt/sports-attention-meter-20261003` and its historical
`kalshi-public-market-data-service/src/public-market-data.mjs` behavior and
`test/attention-meter.test.mjs` cases, adapted to the currently maintained
retrieval timestamps and payload identity.
