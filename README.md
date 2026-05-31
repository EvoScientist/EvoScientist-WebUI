# EvoScientist WebUI

Web UI for **EvoScientist** — a self-evolving AI scientist built on DeepAgents/LangGraph.

The browser connects directly to a running EvoScientist deployment and gives you a
chat interface with streaming responses, tool calls, sub-agent activity, files, and tasks.

## Prerequisites

- **Node.js 20+**
- A running **EvoScientist backend** (the LangGraph deployment). From your EvoScientist
  install, start it with:

  ```bash
  EvoSci deploy        # serves the LangGraph API at http://127.0.0.1:6174
  ```

  Keep this running in its own terminal.

## Quick start (development)

```bash
npm install
npm run dev
```

Open <http://localhost:4716>. In the configuration dialog, enter your **Deployment URL**
(default `http://127.0.0.1:6174`) and click **Save**. That's it — start chatting.

> You need two things running: the EvoScientist backend (`EvoSci deploy`, port 6174)
> and this UI (`npm run dev`, port 4716).

## Production build

```bash
npm run build        # outputs the optimized app
npm start            # serves it on http://localhost:4716
```

## Configuration

- **Deployment URL** — the EvoScientist LangGraph endpoint (default `http://127.0.0.1:6174`,
  the `EvoSci deploy` default port). Saved in your browser's local storage.
- The UI always talks to the **EvoScientist** main agent; its sub-agents
  (`writing-agent`, `data-analysis-agent`) are internal and not user-selectable.
- _(Optional, advanced)_ Set `NEXT_PUBLIC_LANGSMITH_API_KEY` if you connect to a
  deployment that requires LangSmith authentication.

## Scripts

| Command                | Description                             |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | Start the dev server on port 4716       |
| `npm run build`        | Production build                        |
| `npm start`            | Serve the production build on port 4716 |
| `npm run lint`         | Lint with ESLint                        |
| `npm run format`       | Format with Prettier                    |
| `npm run format:check` | Check formatting (used in CI)           |

## Tech stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS · `@langchain/langgraph-sdk`.

## License

Apache-2.0 — see [LICENSE](LICENSE).
