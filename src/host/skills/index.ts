/**
 * host/skills — 列表/resolve 注册表 + 磁盘 ops + create-skill 路径覆盖。
 */
export {
  SkillRegistry,
  type SkillListFn,
  type SkillsResolveMode,
  type SkillsResolveResult,
} from "./registry.js";
export { appendCreateSkillDesktopPathOverride } from "./create-skill-prompt.js";
export { SkillsOps, type SkillsOpsDeps } from "./ops.js";
