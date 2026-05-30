#!/usr/bin/env bash

set -euo pipefail

# 0. auto-commit uncommitted package.json changes
if ! git diff --quiet package.json; then
    echo "detected uncommitted changes in package.json, auto-committing..."
    git add package.json
    git commit -m "chore: update package.json" || true
fi

# 1. read local version from package.json
version=$(node -p "require('./package.json').version")
tag_name="v${version}"

# 2. check if the tag reference already exists on remote
# query the exact tag ref directly from remote to avoid grep mismatch
if [ -n "$(git ls-remote --tags origin "refs/tags/${tag_name}")" ]; then
    echo "warning: tag ${tag_name} already exists on remote repository!"
    read -p "do you want to bump the patch version and continue? (y/n): " choice

    if [[ "$choice" =~ ^[Yy]$ ]]; then
        echo "bumping patch version..."
        # manually bump 4-part version (a.b.c.d → a.b.c.d+1)
        version=$(node -p "
          const v = require('./package.json').version.split('.');
          v[v.length - 1] = String(Number(v[v.length - 1]) + 1);
          v.join('.')
        ")
        node -e "
          const pkg = require('./package.json');
          pkg.version = '${version}';
          require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
        "

        tag_name="v${version}"

        # commit version changes and push to remote (with tags)
        git add package.json
        git commit -m "chore: bump version to ${version}"
        git push --follow-tags origin HEAD
    else
        echo "release cancelled."
        exit 0
    fi
else
    echo "no remote conflict found for ${tag_name}, continuing release process..."
fi

# 3. tag the latest commit locally
# remove existing local tag if it conflicts to prevent fatal error
if git rev-parse "${tag_name}" >/dev/null 2>&1; then
    echo "local tag ${tag_name} already exists, overwriting it..."
    git tag -d "${tag_name}"
fi
git tag -a "${tag_name}" -m "release version ${version}"

# 4. push commits + tag to remote
git push --follow-tags origin HEAD
git push origin "${tag_name}" 2>/dev/null || true  # ensure tag is pushed even if branch is up-to-date

# 5. invoke the build script to generate artifacts
echo "starting build process..."
pnpm build
node ./scripts/build-all.js

# 6. create github release and upload all matching files
echo "creating github release and uploading artifacts..."
gh release create "${tag_name}" \
    ./release/UNO-"${tag_name}"_* \
    --title "${tag_name}" \
    --generate-notes

echo "release successful! current online version is ${tag_name}"
