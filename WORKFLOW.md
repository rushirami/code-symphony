---
tracker:
  kind: sqlite
  db_path: ./tasks.db
  identifier_prefix: TASK
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
runner:
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
5. When the work is complete, run: `symphony done {{ issue.identifier }} --note "<markdown summary of what you did>"`
6. If you are blocked, run: `symphony comment {{ issue.identifier }} "<what is blocking you>"` then `symphony state {{ issue.identifier }} "In Review"`
{% if attempt %}
Note: This is retry attempt #{{ attempt }}. Review previous work and continue from where you left off.
{% endif %}
