# Solisk launch kit

This file is the repeatable launch plan for Solisk PC Control MCP. It is written
for a real first task, not a feature-count announcement.

## Positioning

**One sentence:** Solisk gives MCP-compatible AI clients local access to files,
shell and desktop tools, with a Windows control app and an optional self-hosted
relay.

**Lead use case:** Let an AI inspect a project file or Git diff, then create a
small report in an allowed folder—without giving it an unbounded public endpoint.

**Proof:** `node examples/first-win.js` runs a deterministic, synthetic local
workflow using real MCP stdio calls, verifies the written report, and proves a
file outside the allowed folder is denied. It needs Node 22.5+, but no account,
model API key, relay or network.

## Demo recording

The selected interactive brand film is available at
`assets/launch/solisk-brand-film.html`. It is the newer, richer variant from
Downloads (`PC Control MCP - Brand Film (3).html`) with chat/tool-call scenes,
the PC/client/relay relationship, pause, restart, timeline scrubbing,
highlights mode, fullscreen and generated sound. Open it directly in a browser
for a polished product overview; use `examples/first-win.js` for the technical
proof demo.

Record a 45–75 second terminal capture from a clean checkout:

```text
0–05s  Show: “AI client → read project data → write a report → deny outside path”.
05–12s  Run: node examples/first-win.js
12–25s  Show tools discovered and the read_file step.
25–40s  Show the generated Markdown report (synthetic data clearly labeled).
40–52s  Show the write + verify step.
52–62s  Show the outside-path denial.
62–75s  End with: npm install -g solisk; README link; “local first / self-hostable”.
```

Do not show API keys, real paths, relay credentials, private files, or an
unverified remote dashboard. A terminal demo is honest and portable; add the
Windows GUI only after recording it from a fresh install.

## Announcement copy

### GitHub release discussion / social post

> I built Solisk: an open-source MCP runtime that lets AI clients work with
> files, Git and desktop tools on your own machine.
>
> The first demo is intentionally small: read a synthetic CSV, write a Markdown
> summary, verify it, then prove a path outside the allowed folder is denied.
> It runs locally over MCP stdio—no account, relay or model API key needed.
>
> `npm install -g solisk`
>
> The Windows control app and optional self-hosted relay are included for people
> who need remote connectors. I’m looking for feedback on the first successful
> task: where does setup still feel unclear?

### Show HN draft

**Title:** Show HN: Solisk – open-source MCP control for local files and desktop tools

**Body:**

> Hi HN, I built Solisk because I wanted an MCP client to work with a real
> project directory without turning “connect my AI to my computer” into an
> opaque hosted service.
>
> Solisk is a Node CLI/runtime with local stdio and HTTP modes, a Windows control
> app, scoped keys, file-path rules, and an optional self-hosted relay. The
> runtime executes tools on the PC; a relay, when enabled, transports the
> authenticated request and result.
>
> The smallest demo is intentionally boring and reproducible:
>
> ```bash
> node examples/first-win.js
> ```
>
> It uses synthetic data, reads a CSV through an actual MCP tool, writes and
> verifies a Markdown report, and then attempts a read outside the allowed folder
> to show the denial. No signup, model API key or relay is required.
>
> Install: `npm install -g solisk`
> Source: https://github.com/Kyzenkms/solisk-pc-mcp
>
> I’m especially interested in whether the security model and first-run setup
> are understandable to people who have not built an MCP server before.

HN note: submit only when the demo is runnable from the public repository. Do not
ask friends to upvote or coordinate comments.

### Reddit / MCP community draft

> Solisk is an open-source local-first MCP runtime for files, Git, shell and
> desktop tools. I added a no-account demo that uses real MCP stdio calls with
> synthetic data, writes a report, verifies it, and demonstrates an allowed-path
> denial:
>
> `node examples/first-win.js`
>
> Windows has a control app; Linux/macOS use the CLI with platform-specific tools;
> an optional relay supports remote connectors. Feedback welcome on setup and
> trust boundaries, not just feature requests.

## Distribution sequence

1. Merge the directory-list PR after refreshing its conflict and correcting its
   description. Do not claim the unsigned installer is signed.
2. Publish the MCP Registry/npm metadata only after the matching package version
   is actually available. The current public Registry record is stale.
3. Record and publish the first-win demo with the repository link.
4. Post the Show HN draft only after a clean public checkout runs the demo.
5. Share the Reddit draft in one relevant community, then answer setup questions.
6. Ask three target users to complete the demo while you observe. Record where
   they stop; do not optimize for stars alone.

## Metrics for the first week

- Demo starts successfully from a clean checkout.
- Public README visits → first successful tool call.
- Number of people who complete the demo without private help.
- Repeat use within seven days.
- Setup failures grouped by client, OS and connection mode.

Stars, likes and impressions are secondary until the first-task conversion works.
