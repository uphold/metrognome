module.exports = {
  git: {
    changelog: 'echo "## Changelog\\n\\n$(github-changelog-generator -f unreleased | tail -n +4)"',
    commitMessage: 'Release ${version}',
    requireBranch: 'master',
    requireCommits: true,
    tagName: 'v${version}'
  },
  github: {
    release: true,
    releaseName: 'v${version}'
  },
  // No npm publish in CI: the `metrognome` package is still owned by the
  // pre-move personal npm account, not Uphold — publish stays manual until
  // ownership/token is sorted.
  npm: {
    publish: false
  },
  hooks: {
    'after:bump': [
      'node scripts/sync-plugin-version.mjs ${version}',
      'echo "$(github-changelog-generator -f v${version})\\n$(tail -n +2 CHANGELOG.md)" > CHANGELOG.md',
      'git add CHANGELOG.md .claude-plugin/plugin.json .claude-plugin/marketplace.json --all'
    ].join(' && ')
  }
};
