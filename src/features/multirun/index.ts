// "Ejecutar un comando en varios servidores a la vez".
//   openMultiRun()                                   → abre con lo último preparado
//   openMultiRun({ projectId })                      → preselecciona un proyecto entero
//   openMultiRun({ profileIds: [id] })               → preselecciona servidores
//   openMultiRun({ command, label, dangerous })      → precarga un comando (p. ej. de la biblioteca)
// La interfaz la monta <MultiRunHost /> (components/MultiRun).
export {
  openMultiRun,
  closeMultiRun,
  multiRunBusy,
  useMultiRun,
  setMultiRunDeps,
  type MultiRunPreset,
} from "./store";
export type { TargetState, TargetStatus, RunSpec } from "./types";
