# Review of changes built without a plan

## Round 1: hidden browser tied to its run (c7b38d6..6de1260, branch close-hidden-browser)

Reviewer: helper started as job-review-fable; it ran as claude-opus-5-5, not Fable. Read in full: `git diff c7b38d6..6de1260`, `scripts/browser.mjs` lines 1-330 and 530-563, `scripts/jev.mjs` lines 270-300. The project has no `docs/work/`, `goal.md`, `decisions.md` or `docs/features/`, so goal drift, decision drift, state conflict and completion claims had nothing to check against, and `work.py review-pack` was not run.

Ran:
- `npm test` at 6de1260 on Windows 11: 120 tests, 120 pass, 0 skipped (both new `hidden.test.mjs` tests ran against real Chrome).
- Live probes with real Chrome, through a small script in the scratchpad that calls `Chrome.launch({ headless: true, profile })` and then waits (results below).
- Did not run: `jev.mjs` itself against Jev (no key used), and anything on macOS or Linux.

### Finding 1 (fault): a leftover whose port file an older run already deleted is not closed, and every hidden run then fails

The SKILL.md line added in 6de1260 says "a leftover from an older version is closed first with a warning", and `closeLeftover` (scripts/browser.mjs:143) finds the leftover only through `DevToolsActivePort` in the profile. The old version's `launch` deletes that file before it starts a browser (c7b38d6 scripts/browser.mjs, "never trust a file left by a crashed run"). So once one old run was killed and the person retried once on the old version (that retry is what fails with "did not start in 20 seconds"), the leftover keeps running with no port file. The new version then finds nothing to close, its own browser hands the profile to the leftover and quits, and every `--headless` run fails with "The hidden browser quit.", which does not tell the person what to do.

Command (scratchpad probe, profile `prof_seq`): old run, killed; old retry; then a new run, on one profile.

Output:
```
1 old run: ok pid undefined eval 1
   killed; leftover procs 13; port file: prof_seq/DevToolsActivePort
2 old retry: ERR The browser did not start in 20 seconds.
   port file: ls: cannot access 'prof_seq/DevToolsActivePort': No such file or directory
3 new run: ERR The hidden browser quit.
   leftover procs 11
```

Output the intent needs: step 3 prints the leftover warning, then `ok`, and leftover procs ends at 0 (as it does when the port file is still there, which `hidden.test.mjs` test 2 covers and which passes). Hidden runs on this profile were broken before the change too (step 2), so this is the change's clean-up not reaching the case it most likely meets, not a new breakage.

Verdict: fixed in eea08d8. Re-ran the case live on the real hidden profile: an old-style leftover with its port file deleted, then `jev.mjs --headless` on example.com printed `warning: another browser is using ~\.jev-browser\headless (another hidden run, or one left open by an older version); using a fresh profile for this run` and `"status": "done"`. The leftover is not closed: without the port file it cannot be told apart from another hidden run in progress, and closing that would break the other run. SKILL.md now says this instead of "closed first". New test `a hidden run whose profile another browser holds runs on a fresh profile of its own` fails with the fallback removed and passes with it; `npm test` 121 pass.

Note: this review ran on Opus at high effort because Fable was out of usage.

### Checked and found sound (no finding)

- A run stopped from outside no longer leaves its hidden browser: `taskkill /F` on the node process only took the profile's Chrome processes from 12 to 0. Under c7b38d6 the same kill left 8 Chrome processes running.
- Normal close: launch then `close()` took 108 ms, Chrome exit code 0, 0 Chrome processes left, and node exited 0 on its own.
- Two hidden runs at once on one profile: the second now fails at once with "The hidden browser quit." (under c7b38d6 it failed after 21 s with "did not start in 20 seconds"); the first run keeps working. Same outcome as before, faster.
- The Jev window (no `--headless`) path still launches on a port and is unchanged apart from sharing `browserFlags`.

### The safety fact

The hidden browser is now a non-detached child of the run, reached only over a pipe, so it ends when the run ends however the run ends. Reproduced on Windows (kill of the node process alone: 12 Chrome processes to 0). On Windows, Node (libuv) also puts non-detached children in a job object that ends them with the parent (known behaviour, not checked here), so that result does not by itself show the pipe-close path that macOS and Linux depend on; that path was said (code comment) and walked through, not run.
