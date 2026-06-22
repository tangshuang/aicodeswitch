# Codex SDK

If you use Codex through the Codex CLI, the IDE extension, or Codex Web, you can also control it programmatically.

Use the SDK when you need to:

- Control Codex as part of your CI/CD pipeline
- Create your own agent that can engage with Codex to perform complex engineering tasks
- Build Codex into your own internal tools and workflows
- Integrate Codex within your own application

## TypeScript library

The TypeScript library provides a way to control Codex from within your application that's more comprehensive and flexible than non-interactive mode.

Use the library server-side; it requires Node.js 18 or later.

### Installation

To get started, install the Codex SDK using `npm`:

```bash
npm install @openai/codex-sdk
```

### Usage

Start a thread with Codex and run it with your prompt.

```ts


const codex = new Codex();
const thread = codex.startThread();
const result = await thread.run(
  "Make a plan to diagnose and fix the CI failures"
);

console.log(result);
```

Call `run()` again to continue on the same thread, or resume a past thread by providing a thread ID.

```ts
// running the same thread
const result = await thread.run("Implement the plan");

console.log(result);

// resuming past thread

const threadId = "<thread-id>";
const thread2 = codex.resumeThread(threadId);
const result2 = await thread2.run("Pick up where you left off");

console.log(result2);
```

For more details, check out the [TypeScript repo](https://github.com/openai/codex/tree/main/sdk/typescript).

## Python library

The Python SDK controls the local Codex app-server over JSON-RPC. It requires Python 3.10 or later. Published SDK builds include a pinned Codex CLI runtime dependency.

### Installation

To install the SDK run:

```bash
pip install openai-codex
```

Published SDK builds automatically use their pinned runtime. Pass `CodexConfig(codex_bin=...)` only when you intentionally want to run against a specific local Codex executable.

While the Python SDK is in beta, `pip install openai-codex` selects the latest
published beta build. After a stable SDK release exists, use
`pip install --pre openai-codex` to opt in to newer prerelease builds.

### Usage

Start Codex, create a thread, and run a prompt:

```python
from openai_codex import Codex, Sandbox

with Codex() as codex:
    thread = codex.thread_start(
        model="gpt-5.4",
        sandbox=Sandbox.workspace_write,
    )
    result = thread.run("Make a plan to diagnose and fix the CI failures")
    print(result.final_response)
```

Use `AsyncCodex` when your application is already asynchronous:

```python
import asyncio

from openai_codex import AsyncCodex


async def main() -> None:
    async with AsyncCodex() as codex:
        thread = await codex.thread_start(model="gpt-5.4")
        result = await thread.run("Implement the plan")
        print(result.final_response)


asyncio.run(main())
```

### Sandbox presets

Use the same `Sandbox` presets when creating a thread or changing its filesystem
access for a later turn:

```python
from openai_codex import Codex, Sandbox

with Codex() as codex:
    thread = codex.thread_start(sandbox=Sandbox.workspace_write)
    thread.run("Make the requested change.")
    review = thread.run("Review the diff only.", sandbox=Sandbox.read_only)
```

Available presets:

- `Sandbox.read_only`: Read files without allowing writes.
- `Sandbox.workspace_write`: Read files and write inside the workspace and configured writable roots.
- `Sandbox.full_access`: Run without filesystem access restrictions.

When you omit `sandbox=`, app-server uses its configured default. A sandbox
passed to `run(...)` or `turn(...)` applies to that turn and later turns
on the thread.

For more details, check out the [Python repo](https://github.com/openai/codex/tree/main/sdk/python).