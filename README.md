# 🌐 EvoScientist WebUI

**The desktop-level browser workspace for [EvoScientist](https://github.com/EvoScientist/EvoScientist), designed to make Vibe Research feel natural. By bringing evolving memory, research skills, multi-agent workflows, and workspace management together in one place, it helps researchers spend less time managing information and more time exploring ideas — so scientific discovery can move faster.**

<div align="center">

<a href="https://www.npmjs.com/package/@evoscientist/webui"><img alt="npm" src="https://img.shields.io/npm/v/@evoscientist/webui?color=00BCD4&label=npm" height="28"></a>
<a href="https://github.com/EvoScientist/EvoScientist"><img alt="Powered by EvoScientist" src="https://img.shields.io/badge/powered%20by-EvoScientist-066679" height="28"></a>
<a href="https://nextjs.org/"><img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-black" height="28"></a>
<a href="./LICENSE"><img alt="License Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue" height="28"></a>

</div>

---

<table>
  <tr>
    <td align="center">
      <video src="https://github.com/user-attachments/assets/b977f2d5-488a-428d-9c02-b6b27c1521f8" autoplay loop muted playsinline width="100%">
        <a href="https://github.com/user-attachments/assets/b977f2d5-488a-428d-9c02-b6b27c1521f8">View WebUI demo</a>
      </video>
    </td>
  </tr>
</table>

> [!TIP]
> Looking for the engine behind this UI? Check out [**EvoScientist**](https://github.com/EvoScientist/EvoScientist) — the multi-agent AI scientist — and [**EvoSkills**](https://github.com/EvoScientist/EvoSkills), its ready-to-use research skill packs. This WebUI is a thin, zero-touch client: it talks to a running EvoScientist deployment over the LangGraph SDK and adds **nothing** to your backend.

## ✨ Features

- **💬 Streaming Chat** — Real-time responses with Markdown, GFM tables, code highlighting, and collapsible thinking/reasoning blocks.
- **👋 Human-in-the-Loop** — Approve / reject / edit tool calls, and answer the agent's structured questions (text + multiple-choice) inline.
- **⚡ Per-Thread Auto-Approve** — Persisted per conversation; survives view and thread switches and reloads.
- **🤖 Sub-Agent Activity** — Live step tracking for sub-agents, rendered exactly like the main agent (tool calls + paired results + tables).
- **🗂️ Workspace Browser** — Tree and by-type (Papers / Figures / Data / Code) views with preview, edit, download, and zip-all.
- **🧠 Memory Browser** — View, edit, and manage EvoScientist's global cross-session memory, with "recently updated" highlights and a nav badge.
- **🔌 Skills Marketplace** — Install, update, and uninstall the official [EvoSkills](https://github.com/EvoScientist/EvoSkills) catalog with version detection and a detail dialog.
- **📡 Agents Monitor Board** — Watch async background agents (writing / data-analysis) with real run status, live duration, and a side-chat for direct worker debugging.
- **🔁 Async Agent Communication** — Optional per-thread auto-report loops finished background results back to the main agent.
- **🪄 Compaction Summary** — When the backend compacts a long conversation, the summary is shown as a clean collapsible block instead of flashing by.
- **🩺 Connection Health & Resilience** — Health light, stale-URL one-click reconnect, and refresh-resumable streams.
- **🎨 Themed & Responsive** — Light/dark warm "paper" theme with EvoScientist cyan accent; desktop split panes and mobile drawers.

## 📖 Table of Contents

- [📦 Prerequisites](#-prerequisites)
- [⚡ Quick Start](#-quick-start)
- [🔑 Configuration](#-configuration)
- [🎨 Designed By](#-designed-by)
- [🤝 Contributing](#-contributing)
- [📚 Acknowledgments](#-acknowledgments)
- [📜 License](#-license)

## 📦 Prerequisites

- [**EvoScientist**](https://github.com/EvoScientist/EvoScientist) installed and configured (`EvoSci onboard`).
- **Node.js 20+** — the WebUI mode launches the front-end for you.

## ⚡ Quick Start

### Option A — via EvoScientist (recommended)

The WebUI ships with EvoScientist — just pick it during setup. Run the onboarding wizard and choose **WebUI** as your UI mode:

```bash
EvoSci onboard        # select "WebUI" when asked for the UI mode
```

Then launch EvoScientist as usual — it starts the backend and the WebUI together and opens your browser:

```bash
EvoSci                # opens http://localhost:4716
```

That's it — start chatting.

### Option B — standalone

Start the EvoScientist backend in one terminal:

```bash
EvoSci deploy         # serves the LangGraph API at http://127.0.0.1:6174
```

Then launch the WebUI in another (no install required):

```bash
npx @evoscientist/webui@latest                  # opens http://localhost:4716
npx @evoscientist/webui@latest --port 5000      # or pick a custom front-end port
```

Open the URL, confirm the prefilled **Deployment URL** (auto-detected, default `http://127.0.0.1:6174`), click **Save**, and start chatting.

<p align="right"><a href="#top">🔝Back to top</a></p>

## 🔑 Configuration

- **Deployment URL** — the EvoScientist LangGraph endpoint (default `http://127.0.0.1:6174`, the `EvoSci deploy` default port). Saved in your browser's local storage.
- The UI always talks to the **EvoScientist** main agent; its sub-agents (`writing-agent`, `data-analysis-agent`) are internal and not user-selectable.
- _(Optional, advanced)_ Set `NEXT_PUBLIC_LANGSMITH_API_KEY` if you connect to a deployment that requires LangSmith authentication.

> [!TIP]
> If the backend changes ports, the health light detects the dead connection and offers a one-click **Reconnect** to the newly detected port.

<p align="right"><a href="#top">🔝Back to top</a></p>

## 🎨 Designed By

<table>
  <tbody>
    <tr>
      <td align="center">
        <a href="https://x-izhang.github.io/">
          <img src="https://x-izhang.github.io/author/xi-zhang/avatar_hu13660783057866068725.jpg"
               width="100" height="100"
               style="object-fit: cover; border-radius: 20%;" alt="Xi Zhang"/>
          <br />
          <sub><b>Xi Zhang</b></sub>
        </a>
      </td>
    </tr>
  </tbody>
</table>

<p align="right"><a href="#top">🔝Back to top</a></p>

## 🤝 Contributing

We welcome contributions! See the [Contributing Guidelines](./CONTRIBUTING.md) for development setup, project structure, the zero-touch-backend principle, scripts, and the release flow.

Every contribution brings us one step closer to a future where AI accelerates scientific breakthroughs for all of humanity.

<p align="right"><a href="#top">🔝Back to top</a></p>

## 📚 Acknowledgments

This project builds upon the following outstanding open-source work:

- [**LangGraph**](https://github.com/langchain-ai/langgraph) — A low-level orchestration framework for building, managing, and deploying long-running, stateful agents.
- [**deep-agents-ui**](https://github.com/langchain-ai/deep-agents-ui) — The LangChain reference UI for deep agents, which this project builds upon.

We thank the authors for their valuable contributions to the open-source community.

<p align="right"><a href="#top">🔝Back to top</a></p>

## 📜 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](./LICENSE) file for details.

<p align="right"><a href="#top">🔝Back to top</a></p>
