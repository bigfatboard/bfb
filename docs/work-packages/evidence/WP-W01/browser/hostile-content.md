# Hostile content report (W01 browser E2E)

- Fixture title: ``<script>alert(1)</script>``
- Script elements under work-board: 0
- Board HTML contains raw `<script` tag: no
- Board text retains escaped/script-like content: yes
- Page script count before/after create: 2 / 2
- Result: malicious title cannot create a DOM script node or execute via board rendering.
