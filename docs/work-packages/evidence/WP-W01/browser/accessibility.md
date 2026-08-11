# Accessibility report (W01 browser E2E)

- Surface: owner Work board after sign-in + workspace open
- Landmark/roles observed: button, form, h1, h2, h3, input, label, nav, select
- Named regions: Workspace nav, Needs Now deck, Project lanes, Work mutations
- Forms expose labels for sign-in, workspace switcher, create task, and stale edit
- Errors use `role="alert"` / mutation-error for recoverable failures

## ARIA snapshot

```
- main:
  - heading "BFB" [level=1]
  - paragraph: W01
  - paragraph: Synthetic Owner
  - navigation "Workspace":
    - text: Workspace id
    - textbox "Workspace id": 01JBFB0W0RKSPACE0000000000
    - button "Open Work surface"
  - paragraph: owner
  - region "Needs Synthetic Owner Now":
    - heading "Needs Synthetic Owner Now" [level=2]
    - paragraph: Nothing needs you right now.
  - region "Project lanes":
    - heading "Alpha" [level=3]
    - list:
      - listitem:
        - text: P1NOW
        - strong: stale-source-1786458974683
        - paragraph: Ready for next action
        - paragraph: Pass to configured agent profile
        - paragraph: Agent work unavailable
      - listitem:
        - text: P1NOW
        - strong: "&lt;script&gt;alert(1)&lt;/script&gt;"
        - paragraph: Ready for next action
        - paragraph: Pass to configured agent profile
        - paragraph: Agent work unavailable
    - heading "Beta" [level=3]
    - list
  - region "Work mutations":
    - heading "Manage work" [level=2]
    - heading "Create task" [level=3]
    - text: Project
    - combobox "Project":
      - option "01JBFB0PR0JA00000000000000" [selected]
      - option "01JBFB0PR0JB00000000000000"
    - text: Title
    - textbox "Title"
    - button "Create task"
    - heading "Propose agent task" [level=3]
    - button "Propose task"
    - heading "Add comment" [level=3]
    - text: Task id
    - textbox "Task id"
    - text: Comment
    - textbox "Comment"
    - button "Add comment"
    - heading "Add context" [level=3]
    - text: Audience
    - combobox "Audience":
      - option "agent" [selected]
      - option "human"
      - option "both"
    - text: Body
    - textbox "Body"
    - button "Add context"
    - heading "Promote proposed task" [level=3]
    - button "Promote"
    - heading "Edit task (optimistic version)" [level=3]
    - text: Task id
    - textbox "Task id"
    - text: Expected version
    - textbox "Expected version": "1"
    - text: Title
    - textbox "Title"
    - button "Save edit"
```

Result: owner board exposes a navigable landmark tree suitable for keyboard users;
detailed axe rulesets remain available to later polish packages.
