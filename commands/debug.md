---
description: Start a runtime debugging session to capture data from code execution
---

# Runtime Debug Session

Start or continue a runtime debugging session using the runtime-debugging skill.

## What this does

1. Starts a local HTTP server to capture debug data
2. Guides you through instrumenting code with fetch calls
3. Captures runtime data when the user reproduces the issue
4. Helps analyze the captured logs to identify problems

## Usage

Just run `/debug` and describe what you're trying to debug. For example:

- "/debug the login function is returning undefined"
- "/debug async race condition in order processing"
- "/debug state isn't updating correctly after API call"

The runtime-debugging skill will guide you through the complete debugging workflow.
