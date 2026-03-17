---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled"]
polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000
workspace:
  root: /tmp/symphony_workspaces
  hooks:
    after_create: |
      git init
codex:
  command: claude
server:
  port: 8080
  enabled: false
---
You are working on {{ issue.identifier }}: {{ issue.title }}

## Description
{{ issue.description }}

## Labels
{% for label in issue.labels %}- {{ label }}
{% endfor %}

## Instructions
1. Read the codebase to understand the current state
2. Implement the changes described above
3. Write tests if applicable
4. Commit your changes with a descriptive message
{% if attempt %}
Note: This is retry attempt #{{ attempt }}. Review previous work and continue from where you left off.
{% endif %}
