import { describe, expect, test } from "bun:test";
import { parsePluginArgs } from "../parseArgs";

describe("parsePluginArgs", () => {
  // 无参数
  test("对于 undefined 返回 { type: 'menu' }", () => {
    expect(parsePluginArgs(undefined)).toEqual({ type: "menu" });
  });

  test("对于空字符串返回 { type: 'menu' }", () => {
    expect(parsePluginArgs("")).toEqual({ type: "menu" });
  });

  test("对于仅包含空白字符的字符串返回 { type: 'menu' }", () => {
    expect(parsePluginArgs("   ")).toEqual({ type: "menu" });
  });

  // 帮助
  test("对于 'help' 返回 { type: 'help' }", () => {
    expect(parsePluginArgs("help")).toEqual({ type: "help" });
  });

  test("对于 '--help' 返回 { type: 'help' }", () => {
    expect(parsePluginArgs("--help")).toEqual({ type: "help" });
  });

  test("对于 '-h' 返回 { type: 'help' }", () => {
    expect(parsePluginArgs("-h")).toEqual({ type: "help" });
  });

  // 安装
  test("解析 'install my-plugin' -> { type: 'install', plugin: 'my-plugin' }", () => {
    expect(parsePluginArgs("install my-plugin")).toEqual({
      type: "install",
      plugin: "my-plugin",
    });
  });

  test("使用 marketplace 解析 'install my-plugin@github'", () => {
    expect(parsePluginArgs("install my-plugin@github")).toEqual({
      type: "install",
      plugin: "my-plugin",
      marketplace: "github",
    });
  });

  test("将 'install https://github.com/...' 解析为 URL marketplace", () => {
    expect(parsePluginArgs("install https://github.com/plugins/my-plugin")).toEqual({
      type: "install",
      marketplace: "https://github.com/plugins/my-plugin",
    });
  });

  test("将 'i plugin' 解析为 install 的简写", () => {
    expect(parsePluginArgs("i plugin")).toEqual({
      type: "install",
      plugin: "plugin",
    });
  });

  test("不带目标的 install 仅返回 type", () => {
    expect(parsePluginArgs("install")).toEqual({ type: "install" });
  });

  // 卸载
  test("返回 { type: 'uninstall', plugin: '...' }", () => {
    expect(parsePluginArgs("uninstall my-plugin")).toEqual({
      type: "uninstall",
      plugin: "my-plugin",
    });
  });

  // 启用/禁用
  test("返回 { type: 'enable', plugin: '...' }", () => {
    expect(parsePluginArgs("enable my-plugin")).toEqual({
      type: "enable",
      plugin: "my-plugin",
    });
  });

  test("返回 { type: 'disable', plugin: '...' }", () => {
    expect(parsePluginArgs("disable my-plugin")).toEqual({
      type: "disable",
      plugin: "my-plugin",
    });
  });

  // 验证
  test("返回 { type: 'validate', path: '...' }", () => {
    expect(parsePluginArgs("validate /path/to/plugin")).toEqual({
      type: "validate",
      path: "/path/to/plugin",
    });
  });

  // 管理
  test("返回 { type: 'manage' }", () => {
    expect(parsePluginArgs("manage")).toEqual({ type: "manage" });
  });

  // Marketplace
  test("解析 'marketplace add ...'", () => {
    expect(parsePluginArgs("marketplace add https://example.com")).toEqual({
      type: "marketplace",
      action: "add",
      target: "https://example.com",
    });
  });

  test("解析 'marketplace remove ...'", () => {
    expect(parsePluginArgs("marketplace remove my-source")).toEqual({
      type: "marketplace",
      action: "remove",
      target: "my-source",
    });
  });

  test("解析 'marketplace list'", () => {
    expect(parsePluginArgs("marketplace list")).toEqual({
      type: "marketplace",
      action: "list",
    });
  });

  test("将 'market' 解析为 'marketplace' 的别名", () => {
    expect(parsePluginArgs("market list")).toEqual({
      type: "marketplace",
      action: "list",
    });
  });

  // Boundary
  test("处理多余的空格", () => {
    expect(parsePluginArgs("  install   my-plugin  ")).toEqual({
      type: "install",
      plugin: "my-plugin",
    });
  });

  test("优雅地处理未知子命令", () => {
    expect(parsePluginArgs("foobar")).toEqual({ type: "menu" });
  });

  test("marketplace 不带操作时仅返回类型", () => {
    expect(parsePluginArgs("marketplace")).toEqual({ type: "marketplace" });
  });
});
