// Privilegios del usuario remoto (root / sudo / usuario normal). Base de la pestaña "Administración".
export {
  ADMIN_GROUPS,
  DETECT_COMMAND,
  DETECT_TIMEOUT_SECS,
  canElevate,
  parsePrivilegeOutput,
  privilegeDescription,
  type ElevationTool,
  type PrivilegeInfo,
  type PrivilegeLevel,
} from "./detect";
export {
  detectPrivilege,
  getPrivilege,
  initPrivileges,
  refreshPrivilege,
  usePrivilege,
  usePrivileges,
} from "./store";
export {
  computeElevation,
  confirmSudo,
  forgetSudo,
  getSudoPassword,
  useElevation,
  useHasSudoPassword,
  useSudo,
  type ElevationState,
  type SudoConfirmResult,
} from "./sudo";
export {
  buildExec,
  elevationFailure,
  elevationFailureMessage,
  wrapScript,
  type Elevation,
  type ElevationFailure,
  type ExecRequest,
} from "./elevate";
