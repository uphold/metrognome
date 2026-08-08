#!/usr/bin/env node
// Release tooling only — not shipped in the npm package.
// Keeps .claude-plugin/plugin.json and .claude-plugin/marketplace.json in
// lockstep with the package.json version bumped by release-it.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];

if (!version) {
  console.error('Usage: sync-plugin-version.mjs <version>');
  process.exit(1);
}

const pluginPath = '.claude-plugin/plugin.json';
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
plugin.version = version;
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');

const marketplacePath = '.claude-plugin/marketplace.json';
const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
marketplace.plugins[0].version = version;
writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');

console.log(`Synced plugin.json + marketplace.json to ${version}`);
