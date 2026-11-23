# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/memelljk/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/memelljk/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free, drop-in reimplementation of makefun-site 1.0.0's `build()` that returns the identical output tree — every page, index and tag page, `build-report.txt` and static file, byte for byte — in a fraction of the CPU time. It fuses Markdown lexing and rendering into a single pass with no token objects, escapes HTML in one scan per plain-text run instead of one regex replace per character, gives slugify an ASCII fast path (NFKD is the identity there) plus a per-build cache, resolves repeated link targets through a per-build cache, and computes each page's card, link record and long date exactly once. Measured on the kit's practice set (3 cases, median CPU of 7 runs): ~2.6× faster than the house baseline. No state survives a `run()` call: every cache is created inside the build, so cases never leak into each other.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json`, answers each with `run(input)` from `solve.js`, and writes `/output/answers.json` (outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=a92hvn26&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
