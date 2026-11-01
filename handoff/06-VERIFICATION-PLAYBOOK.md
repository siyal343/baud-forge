# 06 — Verification playbook

A change is not finished when it compiles. It is finished when you can show it working and you
have said what you could not show.

## The loop

```text
1. Write the spec section you are about to satisfy          specs/NNNN-*.md
2. Write the test, watch it fail                            cargo test -p <crate> <name>
3. Make it pass                                             cargo test
4. Prove it live, if it has a user-visible surface           run it, screenshot it
5. Record what is still not true                            DEFERRED.md, spec "Limits, recorded"
6. Green the whole tree                                     fmt, clippy, test
7. Commit with what was wrong, what changed, how it was shown
8. Push, then wait for CI and read the result
```

## The three gates

```sh
export PATH="$PATH:/c/Users/mushii/.cargo/bin"
cargo fmt --all                                                          # silent is green
cargo clippy --workspace --exclude bforge-gui --all-targets -- -D warnings
cargo test --workspace --exclude bforge-gui
```

Never push with a warning you decided not to fix. The CI job `format and lints` runs the same two
commands and will fail.

## Proving a change live

Three levels, in order of strength:

1. **A measurement.** Export a real vault and time it. Run the mock at a rate and read the
   counters. Compare before and after on the same input, and say whether the output is
   byte-identical (`cmp`, not a glance).
2. **A capture of the running application.** Start the window with the demo, wait for it to
   settle, screenshot with `handoff/tools/shot.ps1`, crop, read the value, and quote it in the
   spec.
3. **A request against the engine.** `curl` the route and paste the answer:

```sh
curl -s http://127.0.0.1:<port>/api/health
curl -s -X POST http://127.0.0.1:<port>/api/pins -H 'Content-Type: application/json' -d '{"port":"obc","dtr":true}'
curl -s "http://127.0.0.1:<port>/api/vault/export?format=csv" -o "$TEMP/v.csv" -D -
```

If a behaviour needs hardware you do not have, say it in three places: the test comment, the
spec's limits, and the commit message. The repository does this consistently and it is why the
claims are believable.

## Reading a screenshot without fooling yourself

- Crop to the region, then **resize up** before you read a number. A downscaled 55 reads as 95.
- If a value contradicts the API, trust the API first and re-check the crop second.
- If the window shows an old value, confirm you are running the binary you built: check the
  build finished, kill the process, relaunch. An `Access is denied` build failure leaves the old
  binary running.

## Reviewing your own diff

Before committing, read `git diff` as though someone else wrote it.

- Does every changed file serve the one purpose in the subject line?
- Did you leave a debug `println!` or `eprintln!`? (`grep -n "eprintln\|println" <files>`)
- Did a test name stop being true? Rename it.
- Is there an `unwrap()` in a path that can receive bad data?
- Does the spec still describe the code you just wrote?

## The release procedure

Only when the user asks. The steps, in order:

```sh
# 1. version in three places
#    Cargo.toml [workspace.package] version = "0.X.0"
#    crates/bforge-gui/src-tauri/tauri.conf.json "version"
#    ui/package.json "version"

# 2. release notes at the top of RELEASE-NOTES.md: what is new, what was measured, what is still
#    recorded as a gap

# 3. prove the binary reports the new version
CARGO_TARGET_DIR=/tmp/bf-msvc cargo +stable-x86_64-pc-windows-msvc build -p bforge-cli
/tmp/bf-msvc/debug/bforge.exe version

# 4. commit, tag annotated, push both
git commit -am "Release 0.X.0: <what the release is>"
git tag -a v0.X.0 -m "BaudForge 0.X.0"
git push origin main && git push origin v0.X.0

# 5. watch the release workflow, then confirm the assets
gh release view v0.X.0 --json tagName,assets --jq '.tagName, (.assets[].name)'
```

The release workflow builds seven binaries plus the Windows installer, writes
`SHA256SUMS.txt`, and publishes. A failed release run can be re-run with
`gh run rerun <id> --failed`.

## Force-push policy

`main` is the user's trunk. Amend and force-push **only** to fix a commit message you just wrote,
with `--force-with-lease`, and say so in the next message. Never rewrite history that is older
than your current turn.

## When CI fails

1. `gh run view <id> --log-failed | head -40` — read the actual assertion.
2. If it is macOS or Linux only, suspect platform assumptions: sockets, paths, clock resolution.
   One real bug came from this: a socket accepted from a non-blocking listener inherits
   non-blocking on macOS (fixed in `crates/bforge-core/src/control.rs`).
3. If it is flaky, prove it: run the same test 20 times locally. A flake that is not explained is
   a bug you have not found yet.
4. Do not disable a test to green a branch. Fix it or record why it cannot be fixed.
