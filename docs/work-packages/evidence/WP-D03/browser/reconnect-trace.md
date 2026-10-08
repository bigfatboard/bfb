# D03 reconnect trace (browser)

- socket: bfb.browser.v1 subscription with subscribe-first buffering
- refresh count before invalidation: 0
- refresh count after cursor invalidation: 1
- committed messages before: 27
- committed messages after: 27 (identical, no duplicates)
- connectivity: Discussion live
- conclusion: close and reopen renders the same committed state (see timeline test)
