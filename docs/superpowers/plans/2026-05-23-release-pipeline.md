# CI/CD Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable one-command installation via npm and downloadable platform-specific tarballs on GitHub Releases.

**Architecture:** A single GitHub Actions workflow triggered by `v*` tags. Job 1 publishes to npm. Job 2 builds platform tarballs with pre-compiled native modules. The final create-release job uploads tarballs to the tag release.

**Tech Stack:** GitHub Actions, Node.js 20, npm, tar

---

### Task 1: Update package.json with bin and files

**Files:**
- Modify: `package.json`

- [ ] **Add bin and files fields to package.json**

Insert after the `"type": "module"` line:

```json
  "bin": {
    "preflight-mcp": "dist/mcp/cli.js"
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
```

- [ ] **Verify the bin entry works**

```bash
node -e "const p = require('./package.json'); console.log('bin:', JSON.stringify(p.bin)); console.log('files:', JSON.stringify(p.files))"
```

Expected: `bin: {"preflight-mcp":"dist/mcp/cli.js"}` and `files: ["dist/","README.md","LICENSE"]`

---

### Task 2: Create release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Write the release.yml workflow**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  npm-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org/
      - run: npm ci
      - run: npm test
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  platform-builds:
    needs: npm-publish
    strategy:
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
          - macos-13
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - run: npm ci --production
      - name: Package tarball
        run: |
          OS_NAME="${{ matrix.os }}"
          case "$OS_NAME" in
            ubuntu-latest) PLATFORM="linux-x64" ;;
            macos-latest)  PLATFORM="macos-arm64" ;;
            macos-13)      PLATFORM="macos-x64" ;;
          esac
          tar -czf "preflight-${PLATFORM}.tar.gz" dist/ node_modules/ package.json
          echo "PACKAGE_NAME=preflight-${PLATFORM}.tar.gz" >> "$GITHUB_ENV"
      - name: Upload to Release
        uses: softprops/action-gh-release@v2
        with:
          files: preflight-*.tar.gz
          generate_release_notes: true
```

- [ ] **Verify the workflow file is valid YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('Valid YAML')"
```

Expected: `Valid YAML`

---

### Task 3: Commit and push

**Files:**
- Modified: `package.json`
- Created: `.github/workflows/release.yml`

- [ ] **Stage, commit, and push**

```bash
git add package.json .github/workflows/release.yml
git commit -m "ci: add release pipeline (npm publish + platform tarballs)

- Add bin field (preflight-mcp) and files to package.json
- Create GitHub Actions workflow triggered by v* tags
- Job 1: build and publish to npm
- Job 2: build platform-specific tarballs with pre-compiled native modules
- Upload tarballs to GitHub Release with auto-generated release notes"
git push origin main
```

---

### Task 4: Trigger v1.0.0 release

- [ ] **Create and push v1.0.0 tag**

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the `release.yml` workflow. The npm publish step requires `NPM_TOKEN` secret to be set in the repository — if not configured, that job will fail but the tarball build and Release creation will still proceed.
