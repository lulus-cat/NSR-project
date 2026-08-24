// 모노레포에서 packages/core를 심볼릭 링크로 참조하므로
// Metro에게 워크스페이스 루트를 감시 대상으로 알려줘야 한다.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// 워크스페이스 밖의 중복 react 인스턴스를 막는다.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
