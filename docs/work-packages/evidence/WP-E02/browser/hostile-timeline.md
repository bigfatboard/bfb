# Hostile timeline report (E02 browser E2E)

- Provider session id committed: `<img src=x onerror=alert(document.domain)>`
- Rendered session text is escaped (`&lt;img` present, no `<img` element).
- Image/script elements under the timeline section: 0.
- Result: hostile event strings stay data and never execute on the app origin.
