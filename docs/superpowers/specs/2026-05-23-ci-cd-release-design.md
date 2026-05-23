# CI/CD Release Pipeline Design

## Overview

Automate the release process for preflite so users can install and run it with a single command. Two distribution channels:

1. **npm** — `npx preflite` or `npm install -g preflite`
2. **GitHub Release** — downloadable pre-built tarballs per platform

## package.json Changes

```json
{
  "bin": {
    "preflite": "dist/mcp/cli.js"
  },
  "files": ["dist/", "README.md", "LICENSE"]
}
```

- `bin` enables `npx preflite` / `npm install -g preflite`
- `files` restricts npm publish to only built output and docs (node_modules excluded)
- No changes to existing `scripts` or `dependencies`

## Release Workflow

**Single workflow file:** `.github/workflows/release.yml`

**Trigger:** Push tag matching `v*.*.*`

### Job 1: npm-publish

| Step | Action |
|------|--------|
| Checkout | `actions/checkout` |
| Setup Node | Node.js 20, `actions/setup-node` with npm registry auth |
| Install | `npm ci` |
| Test | `npm test` |
| Build | `npm run build` |
| Publish | `npm publish` (requires `NPM_TOKEN` secret) |

### Job 2: platform-builds (needs: npm-publish)

| Step | Action |
|------|--------|
| Checkout | `actions/checkout` |
| Setup Node | Node.js 20 |
| Install + compile native deps | `npm ci` |
| Build | `npm run build` |
| Prune dev deps | `npm ci --production` |
| Package | `tar -czf preflight-<os>.tar.gz dist/ node_modules/ package.json` |
| Upload | Attach to GitHub Release via `softprops/action-gh-release` |

**Matrix:**

| Runner | OS | Arch |
|--------|----|------|
| `ubuntu-latest` | Linux | x86_64 |
| `macos-latest` | macOS | ARM64 (Apple Silicon) |
| `macos-13` | macOS | x86_64 (Intel) |

Windows excluded: toolchain (adb/hdc/WDA) targets are macOS/Linux.

### Job 3: create-release (needs: platform-builds)

Creates the GitHub Release with release notes (generated from git tags) and attaches the platform tarballs.

## User Experience

**npm route:**
```bash
npx preflite serve
# or
npm install -g preflite
preflite serve
```

**Release route:**
```bash
curl -L https://github.com/zifengjiang/Preflight/releases/latest/download/preflight-macos-arm64.tar.gz
node dist/mcp/cli.js serve
```

## Security

- `NPM_TOKEN` stored as GitHub Actions secret, scoped to publish-only
- No sensitive config in workflow YAML
- Sign releases with GPG key if desired (future enhancement)

## Future Considerations (out of scope for v1)

- Automated version bump / changelog generation
- Docker image for CI runner environments
- Code signing for macOS releases
- Windows support if demand arises
