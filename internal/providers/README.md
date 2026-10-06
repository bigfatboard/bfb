# Native telemetry normalization

Provider manifests retain their pinned tested versions. Lifecycle hooks expose only their verified stable activity IDs; absent IDs remain legacy lower-confidence events. Tool starts and ends retain separate phase identities in the daemon journal, including after acknowledgement and restart.

The pinned Codex exec parser preserves reported input, output, cached-input and reasoning counters. Its current production stream does not establish a durable usage-unit ID and certified delta basis for A04 upload. It therefore does not fabricate typed `turn_delta` telemetry from these counters. The pinned Claude hooks expose no certified token-usage source. Missing token measurements remain unavailable, not zero or exact usage.

The synthetic provider can report explicitly identified, bounded token deltas through the same production hook, journal, uploader and cloud-ingestion boundaries. That connected fixture proves this path, not live Codex/Claude token-usage certification. A future provider source must establish both stable unit identity and delta semantics before emitting typed token telemetry.
