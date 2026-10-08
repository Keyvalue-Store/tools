# Releasing KeyValueStore Tools

Releases go out on their own. Nobody clicks Publish. This file is the record of
how that works, for whoever (person or Claude session) works on this repo next.

## The short version

1. Raise `"version": "X.Y.Z"` in `package.json`.
2. Write what changed into the commit message. The release notes describe the
   package; the site's posts carry the story.
3. Push the commit to `main`.

That's it. When the `test` workflow passes on that commit, the `release`
workflow packs every tool, checks the package on Linux, macOS and Windows, then
tags the commit `vX.Y.Z` and publishes the release "KeyValueStore Tools
vX.Y.Z" with the package and SHA256SUMS attached. If the pack or any check
fails, nothing is tagged and nothing goes public. Fix it, push again, and the
next green run picks it up.

Pushing without raising the version is fine. The release workflow sees that the
version already has a tag and stops quietly.

## What it does, step by step

The `release` workflow ([.github/workflows/release.yml](.github/workflows/release.yml))
is started by a finished `test` run, not by the push itself. The `test` run is
`node --test` on Linux and macOS, with Node.js 20 and 24.

- **plan.** Goes on only if the `test` run passed, came from a push to `main`
  in this repo, and `main` still points at that commit (if `main` moved on, the
  run for the newer commit decides). Reads the version from `package.json`.
  Stops quietly if `vX.Y.Z` is already a tag. Fails loudly if the version is
  lower than the newest tag, or isn't of the form X.Y.Z.
- **pack.** Runs `scripts/package.sh` from that exact commit. Every folder
  with a `cli.js` is a tool and goes in, without its `test/` folder, together
  with `common/`, LICENSE, NOTICE, README.md and package.json, in one folder
  named `keyvaluestore-tools`. Out come `keyvaluestore-tools.tar.gz` and
  `keyvaluestore-tools.zip`.
- **check.** Unpacks the package and runs `scripts/smoke.js` against it on
  Linux x86-64 (Node.js 20), Linux ARM, macOS and Windows (Node.js 24). The
  smoke test comes from the commit, but the tools come only from the package,
  so what's checked is what ships. Every tool's command line has to start and
  print its help, and the tools that take text get real work with known
  answers. Windows checks the zip; the others check both archives.
- **release.** Runs only after the pack and every check passed. Creates the
  tag and the release in one step with `gh release create --target <commit>`,
  on the repo's own `GITHUB_TOKEN` (`contents: write` on this job only). A
  `concurrency` group per tag means two runs for the same version can't
  publish twice.

The release notes are the fixed text in the workflow's "Checksums and notes"
step.

## Files that go out

| File | For |
|---|---|
| keyvaluestore-tools.tar.gz | Linux and macOS |
| keyvaluestore-tools.zip | Windows, or anywhere zip is handier |
| SHA256SUMS | Checksums of both |

There are no binaries: the tools are plain JavaScript with no dependencies,
and they run with Node.js 20 or newer. Archive names carry no version on
purpose. Links like
`https://github.com/Keyvalue-Store/tools/releases/latest/download/keyvaluestore-tools.tar.gz`
keep working from one release to the next, so the README and the site never
need editing for a release.

## After pushing: checking it went out

Claude's cloud sessions can't create tags or releases themselves, and the
`gh` GraphQL calls (`gh release list`, `gh run list`) are blocked there. The
REST API works:

```sh
# the test run, then the release run, for the commit just pushed
gh api "repos/Keyvalue-Store/tools/actions/workflows/test.yml/runs?per_page=1" \
  --jq '.workflow_runs[0] | "\(.status) \(.conclusion) \(.head_sha[0:7])"'
gh api "repos/Keyvalue-Store/tools/actions/workflows/release.yml/runs?per_page=1" \
  --jq '.workflow_runs[0] | "\(.status) \(.conclusion) \(.head_sha[0:7])"'

# the release and its files
gh api repos/Keyvalue-Store/tools/releases/latest \
  --jq '.tag_name, .name, (.assets[].name)'
```

Then download the tar.gz, check it against SHA256SUMS, unpack it and run
`node scripts/smoke.js keyvaluestore-tools` from a clone. Only then is the
release done. (Release files download through the API, `gh api -H "Accept:
application/octet-stream" repos/Keyvalue-Store/tools/releases/assets/<id>`,
when the session can't reach github.com download links directly.)

If the release run failed: read its log
(`gh api repos/Keyvalue-Store/tools/actions/runs/<id>/jobs`), fix the cause on
`main`, and push. Don't change the version unless the fix needs it; the tag was
never made, so the same version goes out on the next green run.

## Other ways in

- **A release published by hand** on GitHub still works. The workflow packs
  that tag and attaches the package.
- **Repacking an existing tag:** run the `release` workflow by hand (Actions,
  release, Run workflow) with the tag, such as `v0.1.0`. It repacks and
  replaces the files on that release.
- Releases made by the workflow don't start the workflow again, because
  events from `GITHUB_TOKEN` don't trigger other runs. No loop.

## Rules that don't change

- The owner doesn't publish releases, interim or final. Never ask him to. If
  something blocks a release, fix it in the repo.
- Every release is a full release ("KeyValueStore Tools vX.Y.Z"), not a
  pre-release.
- Versions only go up. The plan step refuses a version below the newest tag.
- The CI workflow must keep the name `test`, because `release.yml` listens for
  `workflows: [test]`. Renaming one means renaming the other.
- `workflow_run` only fires for workflow files on the default branch, so
  changes to either workflow take effect once they're on `main`.
- A new tool is picked up by the pack on its own, as long as its folder has a
  `cli.js`. Give it a case in `scripts/smoke.js` too, so the release checks it
  does real work and not only that it starts.
- The tools stay dependency-free. A tool that needed a third-party package
  would need its license in the package and in `NOTICE` before it ships.

## Bringing this to another project

This is the Node.js version of the workflow. For another Node project, copy
`release.yml`, `test.yml`, `scripts/package.sh` and `scripts/smoke.js`, then
change:

- what `package.sh` packs and the package name,
- the checks in `smoke.js`,
- the release title and the notes,
- the file list in `gh release create` and `gh release upload`.

Then push to `main`, watch the first run, and check the release as above.
